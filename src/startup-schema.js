import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readWorldMigrationPlan } from './database-migrations.js';

function incompatible(detail) {
  const error = new Error(`Startup schema validation failed: ${detail}`);
  error.code = 'STARTUP_SCHEMA_INCOMPATIBLE';
  return error;
}

export function runtimeSelectRequiredTables(tables, contract) {
  return tables.filter((name) => contract[name]?.runtimeSelect !== false);
}

// Object-level requirements mirror the numbered migrations; these checks never grant privileges.
const issuanceWrites = {
  'INSERT,UPDATE': ['arc_currency_genesis_requirements', 'arc_token_pilot_capabilities',
    'arc_token_issuance_intents', 'arc_token_issuance_responses', 'arc_token_issuance_issuer_candidates',
    'arc_agent_tokens', 'arc_agent_token_responses', 'arc_mainnet_pilot_cost_reservations',
    'arc_infrastructure_nonce_cursors', 'arc_infrastructure_nonce_reservations'],
  INSERT: ['arc_token_issuance_decisions', 'arc_agent_token_uses', 'world_infrastructure_usage_events'],
  UPDATE: ['arc_mainnet_pilot_budget']
};

const coreWrites = {
  'INSERT,UPDATE': ['world_runtime_state', 'world_agent_states', 'world_social_profiles',
    'world_agent_goals', 'world_agent_self_models', 'world_agent_decision_policies', 'world_epochs', 'agent_memories',
    'world_genesis_token_balance_snapshots', 'world_business_service_token_terms', 'world_business_job_token_terms',
    'arc_genesis_token_settlement_outbox', 'world_genesis_token_business_orders'],
  INSERT: ['world_events', 'world_history', 'world_decision_traces', 'world_v7_events',
    'world_capability_events', 'world_agent_self_model_history', 'world_genesis_currency_activations',
    'world_infrastructure_usage_events'],
  DELETE: ['agent_memories', 'world_decision_traces']
};

const syncLedgerWrites = [
  ['arc_sync_tokenomics_deployments', ['SELECT']],
  ['arc_sync_ledger_accounts', ['SELECT','INSERT']],
  ['arc_sync_ledger_transactions', ['SELECT','INSERT']],
  ['arc_sync_ledger_postings', ['SELECT','INSERT']],
  ['arc_sync_payout_outbox', ['SELECT','INSERT']],
  ['world_sync_cleanup_targets', ['SELECT','INSERT']],
  ['world_sync_work_orders', ['SELECT','INSERT']],
  ['world_sync_work_order_batches', ['SELECT','INSERT']],
  ['world_sync_work_order_batch_items', ['SELECT','INSERT']]
];

const syncLedgerColumnUpdates = {
  arc_sync_ledger_transactions: ['status','committed_at'],
  arc_sync_payout_outbox: ['status','transaction_hash','transaction_sender','transaction_nonce','gas_limit',
    'max_fee_per_gas','start_block','block_number','failure_code','updated_at'],
  world_sync_cleanup_targets: ['status','cleared_world_minute','cleared_at','cleared_by_agent_id'],
  world_sync_work_orders: ['status','accepted_agent_id','accepted_world_minute','accepted_at','evidence_event_id',
    'verified_world_minute','evidence','updated_at']
};

const openCognitionWrites = [
  ['world_agent_cognition_state', ['SELECT','INSERT','UPDATE']],
  ['world_agent_cognition_turns', ['SELECT','INSERT']],
  ['world_agent_cognition_memories', ['SELECT','INSERT']],
  ['world_agent_cognition_tool_attempts', ['SELECT','INSERT','UPDATE']],
  ['world_agent_cognition_model_calls', ['SELECT','INSERT','UPDATE']]
];
const openCognitionColumns = {
  world_agent_cognition_state: ['revision','goals','plans','pending_action',
    'available_affordances','affordances_world_minute','next_review_world_minute','lease_token',
    'last_context_event_id','last_context_tool_sequence'],
  world_agent_cognition_turns: ['trigger_key','base_revision','result_revision','intent','usage'],
  world_agent_cognition_memories: ['memory_key','memory_type','summary','evidence'],
  world_agent_cognition_tool_attempts: ['cognition_sequence','intent_key','capability_key','status','request','result','lease_until'],
  world_agent_cognition_model_calls: ['correlation_id','tier','model','trigger','goal_id','plan_id','step_id',
    'status','input_tokens','output_tokens','total_tokens','cache_hit','memory_candidates',
    'memory_prefiltered','memory_selected','grounding_result','execution_result','failure_code',
    'created_at','completed_at']
};

export async function prepareStartupSchema(pool, { rootDirectory, mode = 'apply' }) {
  if (!['apply', 'validate'].includes(mode)) throw incompatible('MIRRORTERRA_SCHEMA_MODE (legacy SYNTERRA_SCHEMA_MODE) must be apply or validate');
  if (mode === 'apply') {
    // Preserve legacy bootstrap semantics; numbered migrations remain an explicit operator action.
    await pool.query(await readFile(path.join(rootDirectory, 'schema.sql'), 'utf8'));
    return { mode, validated: false };
  }

  const migrations = await readWorldMigrationPlan(rootDirectory);
  const requiredMigrations = ['0001_arc_mainnet.sql', '0002_world_environment.sql',
    '0002_arc_agent_token_issuance.sql', '0003_arc_agent_token_issuance_runtime_privileges.sql',
    '0004_genesis_token_economy.sql', '0005_rea_research_jobs.sql', '0006_research_artifact_relations.sql',
    '0007_mirrorterra_brand_identity.sql', '0008_turnkey_agent_wallets.sql',
    '0009_arc_mainnet_pilot_funding_ledger.sql', '0010_sync_tokenomics_v1.sql',
    '0011_sync_economy_settlement.sql', '0012_rea_research_job_claim_privilege.sql',
    '0013_open_cognition.sql', '0014_open_cognition_runtime.sql'];
  for (const name of requiredMigrations) {
    if (!migrations.some((migration) => migration.name === name)) throw incompatible(`missing migration source ${name}`);
  }
  const contract = JSON.parse(await readFile(path.join(rootDirectory, 'src/runtime-schema-contract.json'), 'utf8'));
  for (const [table, expected] of Object.entries(contract)) {
    if (!expected || !expected.columns || !expected.constraints
        || !Array.isArray(expected.notNullColumns) || !expected.uniqueIndexes) {
      throw incompatible(`invalid runtime schema contract for ${table}`);
    }
  }
  // Read source names only. No SQL from schema.sql or a migration is executed in validate mode.
  const schema = await readFile(path.join(rootDirectory, 'schema.sql'), 'utf8');
  const tables = [...new Set([...schema.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*)/g)]
    .map((match) => match[1]).concat(Object.keys(contract), openCognitionWrites.map(([table]) => table),
      'synterra_schema_migrations'))].sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '10s'");
    const relations = await client.query(`SELECT name,to_regclass('public.' || name) IS NOT NULL AS present
      FROM unnest($1::text[]) AS name`, [tables]);
    for (const row of relations.rows) if (!row.present) throw incompatible(`missing table ${row.name}`);
    const ledger = await client.query('SELECT version,checksum FROM public.synterra_schema_migrations');
    for (const migration of migrations) {
      const entry = ledger.rows.find((row) => row.version === migration.name);
      if (!entry) throw incompatible(`missing migration ${migration.name}`);
      if (entry.checksum !== migration.checksum) throw incompatible(`checksum mismatch ${migration.name}`);
    }
    const columns = await client.query(`SELECT c.relname AS table_name,a.attname AS name,
        format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped`, [Object.keys(contract)]);
    const constraints = await client.query(`SELECT c.relname AS table_name,k.conname AS name,
        pg_get_constraintdef(k.oid,true) AS definition,k.convalidated AS validated
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])`, [Object.keys(contract)]);
    const indexes = await client.query(`SELECT c.relname AS table_name,idx.relname AS name,
        pg_get_indexdef(i.indexrelid) AS definition,i.indisvalid AS valid,i.indisready AS ready
      FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_class idx ON idx.oid=i.indexrelid
      WHERE n.nspname='public' AND c.relname=ANY($1::text[])`, [Object.keys(contract)]);
    const requiredSyncTriggers = [
      ['world_sync_cleanup_targets', 'world_sync_cleanup_target_validity'],
      ['world_sync_work_orders', 'world_sync_work_order_validity'],
      ['arc_sync_ledger_transactions', 'arc_sync_ledger_committed_double_entry_check']
    ];
    const syncTriggers = await client.query(`SELECT c.relname AS table_name,t.tgname AS name,
        t.tgenabled AS enabled
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal
        AND c.relname=ANY($1::text[])`, [requiredSyncTriggers.map(([table]) => table)]);
    for (const [table, name] of requiredSyncTriggers) {
      if (!syncTriggers.rows.some((row) => row.table_name === table && row.name === name
          && ['O', 'A'].includes(row.enabled))) {
        throw incompatible(`missing or disabled trigger ${table}.${name}`);
      }
    }
    for (const [table, expected] of Object.entries(contract)) {
      for (const [name, type] of Object.entries(expected.columns)) {
        if (!columns.rows.some((row) => row.table_name === table && row.name === name && row.type === type)) {
          throw incompatible(`missing or incompatible column ${table}.${name}`);
        }
      }
      for (const [name, definition] of Object.entries(expected.constraints)) {
        const compatible = expected.compatibleConstraintDefinitions?.[name] || [];
        const acceptedDefinitions = [definition, ...compatible];
        if (!constraints.rows.some((row) => row.table_name === table && row.name === name
            && acceptedDefinitions.includes(row.definition) && row.validated)) {
          throw incompatible(`missing or incompatible constraint ${table}.${name}`);
        }
      }
      for (const name of expected.notNullColumns) {
        if (!columns.rows.some((row) => row.table_name === table && row.name === name && row.not_null)) {
          throw incompatible(`missing NOT NULL ${table}.${name}`);
        }
      }
      for (const [name, definition] of Object.entries(expected.uniqueIndexes)) {
        if (!indexes.rows.some((row) => row.table_name === table && row.name === name
            && row.definition === definition && row.valid && row.ready)) throw incompatible(`missing or incompatible index ${table}.${name}`);
      }
    }
    const roles = await client.query("SELECT current_user AS runtime_role,EXISTS(SELECT 1 FROM pg_roles WHERE rolname='synterra_app') AS app_exists");
    if (!roles.rows[0].app_exists) throw incompatible('missing role synterra_app');
    const currentRole = roles.rows[0].runtime_role;
    const reads = await client.query(`SELECT name,has_table_privilege(current_user,'public.' || name,'SELECT') AS allowed
      FROM unnest($1::text[]) AS name`, [runtimeSelectRequiredTables(tables, contract)]);
    for (const row of reads.rows) if (!row.allowed) throw incompatible(`runtime SELECT missing on ${row.name}`);
    for (const role of new Set([currentRole, 'synterra_app'])) {
      for (const [privileges, names] of Object.entries(issuanceWrites)) {
        // PostgreSQL comma-separated privilege strings mean ANY, so check every privilege separately.
        const grants = await client.query(`SELECT name,privilege,
            has_table_privilege($1,'public.' || name,privilege) AS allowed
          FROM unnest($2::text[]) AS name CROSS JOIN unnest($3::text[]) AS privilege`,
        [role, names, ['SELECT', ...privileges.split(',')]]);
        for (const row of grants.rows) if (!row.allowed) throw incompatible(`${role} ${row.privilege} missing on ${row.name}`);
      }
    }
    for (const [table, requiredColumns] of Object.entries(openCognitionColumns)) {
      const result = await client.query(`SELECT attname FROM pg_attribute
        WHERE attrelid=to_regclass('public.' || $1) AND attnum>0 AND NOT attisdropped
          AND attname=ANY($2::text[])`, [table, requiredColumns]);
      const found = new Set(result.rows.map((row) => row.attname));
      for (const name of requiredColumns) if (!found.has(name)) {
        throw incompatible(`missing cognition column ${table}.${name}`);
      }
    }
    for (const role of new Set([currentRole, 'synterra_app'])) {
      for (const [table, privileges] of syncLedgerWrites) {
        const grants = await client.query(`SELECT privilege,has_table_privilege($1,'public.' || $2,privilege) AS allowed
          FROM unnest($3::text[]) AS privilege`, [role, table, privileges]);
        for (const row of grants.rows) if (!row.allowed) throw incompatible(`${role} ${row.privilege} missing on ${table}`);
      }
      for (const [table, columnsForUpdate] of Object.entries(syncLedgerColumnUpdates)) {
        const grants = await client.query(`SELECT column_name,has_column_privilege($1,'public.' || $2,column_name,'UPDATE') AS allowed
          FROM unnest($3::text[]) AS column_name`, [role, table, columnsForUpdate]);
        for (const row of grants.rows) if (!row.allowed) throw incompatible(`${role} UPDATE missing on ${table}.${row.column_name}`);
      }
      const sequence = await client.query(`SELECT has_sequence_privilege($1,'public.arc_sync_ledger_postings_id_seq','USAGE') AS allowed`, [role]);
      if (!sequence.rows[0]?.allowed) throw incompatible(`${role} USAGE missing on arc_sync_ledger_postings_id_seq`);
    }
    for (const role of new Set([currentRole, 'synterra_app'])) {
      for (const [table, privileges] of openCognitionWrites) {
        const grants = await client.query(`SELECT privilege,has_table_privilege($1,'public.' || $2,privilege) AS allowed
          FROM unnest($3::text[]) AS privilege`, [role, table, privileges]);
        for (const row of grants.rows) if (!row.allowed) throw incompatible(`${role} ${row.privilege} missing on ${table}`);
      }
      for (const name of ['world_agent_cognition_turns_id_seq','world_agent_cognition_memories_id_seq',
        'world_agent_cognition_tool_attempts_cognition_sequence_seq']) {
        const sequence = await client.query(`SELECT has_sequence_privilege($1,'public.' || $2,'USAGE') AS allowed`,
          [role, name]);
        if (!sequence.rows[0]?.allowed) throw incompatible(`${role} USAGE missing on ${name}`);
      }
    }
    const forbiddenCognitionDeletes = await client.query(`SELECT name,
        has_table_privilege('synterra_app','public.' || name,'DELETE') AS allowed
      FROM unnest($1::text[]) AS name`, [openCognitionWrites.map(([name]) => name)]);
    for (const row of forbiddenCognitionDeletes.rows) if (row.allowed) {
      throw incompatible(`synterra_app has forbidden DELETE on ${row.name}`);
    }
    const forbiddenSyncGrants = await client.query(`SELECT table_name,privilege,
        has_table_privilege('synterra_app','public.' || table_name,privilege) AS allowed
      FROM (VALUES ('arc_sync_tokenomics_deployments','INSERT'),('arc_sync_tokenomics_deployments','UPDATE'),
        ('arc_sync_tokenomics_deployments','DELETE'),('arc_sync_ledger_accounts','UPDATE'),
        ('arc_sync_ledger_accounts','DELETE'),('arc_sync_ledger_transactions','DELETE'),
        ('arc_sync_ledger_postings','UPDATE'),('arc_sync_ledger_postings','DELETE'),
        ('arc_sync_payout_outbox','DELETE')) AS grants(table_name,privilege)`);
    for (const row of forbiddenSyncGrants.rows) if (row.allowed) {
      throw incompatible(`synterra_app has forbidden ${row.privilege} on ${row.table_name}`);
    }
    const forbiddenSyncTableUpdates = await client.query(`SELECT table_name,
        has_table_privilege('synterra_app','public.' || table_name,'UPDATE') AS allowed
      FROM (VALUES ('arc_sync_ledger_transactions'),('arc_sync_payout_outbox')) AS grants(table_name)`);
    for (const row of forbiddenSyncTableUpdates.rows) if (row.allowed) {
      throw incompatible(`synterra_app has table-level UPDATE on ${row.table_name}; only specified columns are allowed`);
    }
    const researchTableGrants = [
      ['world_research_artifacts', ['SELECT','INSERT']],
      ['world_research_artifact_grants', ['SELECT','INSERT']],
      ['world_research_artifact_relations', ['SELECT','INSERT']],
      ['world_research_jobs', ['SELECT','INSERT']],
      ['world_research_runtime_status', ['SELECT','INSERT','UPDATE']],
      ['world_capability_uses', ['SELECT','INSERT']],
      ['world_capabilities', ['SELECT']]
    ];
    const researchColumnUpdates = {
      world_research_jobs: ['status','worker_id','started_at','started_world_minute','lease_expires_at','attempt_count','external_call_started_at',
        'completed_at','completed_world_minute','evidence_reference','evidence_sha256','evidence_bytes','normalized_findings',
        'selected_providers','tool_sequence','tool_calls','infrastructure_usage_event_id','failure_code','failure_diagnostic','updated_at'],
      world_capability_uses: ['status','success','costs','effects','side_effects','result'],
      world_capabilities: ['usage_count','success_count','failure_count','updated_at']
    };
    for (const role of new Set([currentRole, 'synterra_app'])) {
      for (const [table, privileges] of researchTableGrants) {
        const grants = await client.query(`SELECT privilege,has_table_privilege($1,'public.' || $2,privilege) AS allowed
          FROM unnest($3::text[]) AS privilege`, [role, table, privileges]);
        for (const row of grants.rows) if (!row.allowed) throw incompatible(`${role} ${row.privilege} missing on ${table}`);
      }
      for (const [table, columnsForUpdate] of Object.entries(researchColumnUpdates)) {
        const grants = await client.query(`SELECT column_name,has_column_privilege($1,'public.' || $2,column_name,'UPDATE') AS allowed
          FROM unnest($3::text[]) AS column_name`, [role, table, columnsForUpdate]);
        for (const row of grants.rows) if (!row.allowed) throw incompatible(`${role} UPDATE missing on ${table}.${row.column_name}`);
      }
      const sequence = await client.query(`SELECT has_sequence_privilege($1,'public.world_capability_uses_id_seq','USAGE') AS allowed`, [role]);
      if (!sequence.rows[0]?.allowed) throw incompatible(`${role} USAGE missing on world_capability_uses_id_seq`);
    }
    for (const [privileges, names] of Object.entries(coreWrites)) {
      const grants = await client.query(`SELECT name,privilege,
          has_table_privilege(current_user,'public.' || name,privilege) AS allowed
        FROM unnest($1::text[]) AS name CROSS JOIN unnest($2::text[]) AS privilege`, [names, privileges.split(',')]);
      for (const row of grants.rows) if (!row.allowed) throw incompatible(`runtime ${row.privilege} missing on ${row.name}`);
    }
    const sequences = await client.query(`SELECT seq.relname AS name,has_sequence_privilege(current_user,seq.oid,'USAGE') AS allowed
      FROM pg_class seq JOIN pg_depend d ON d.objid=seq.oid AND d.classid='pg_class'::regclass
      JOIN pg_class tbl ON tbl.oid=d.refobjid JOIN pg_namespace n ON n.oid=tbl.relnamespace
      WHERE seq.relkind='S' AND d.deptype IN ('a','i') AND n.nspname='public' AND tbl.relname=ANY($1::text[])`,
    [Object.entries(coreWrites).filter(([privileges]) => privileges.includes('INSERT')).flatMap(([, names]) => names)]);
    for (const row of sequences.rows) if (!row.allowed) throw incompatible(`runtime sequence USAGE missing on ${row.name}`);
    await client.query('COMMIT');
    console.log(JSON.stringify({ event: 'startup_schema_validation', mode: 'validate',
      migrationValidation: 'passed', checksumValidation: 'passed', requiredObjects: 'passed',
      runtimeGrants: 'passed', schemaSql: 'not_executed' }));
    return { mode, validated: true, migrations: migrations.map(({ name }) => name), tables: tables.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
