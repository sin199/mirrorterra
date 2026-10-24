import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { Pool } from 'pg';
import { prepareStartupSchema } from '../src/startup-schema.js';
import { applyWorldSchemaAndMigrations } from '../src/database-migrations.js';
import { startWorldEngine } from '../src/world-engine.js';
import { readCognitionContext } from '../src/agent-runtime/open-cognition/context.js';
import { startOpenCognitionWorker } from '../src/agent-runtime/open-cognition/worker.js';
import { arcNetworkConfig } from '../src/arc/config.js';

const databaseUrl = process.env.SYNTERRA_SCHEMA_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_SCHEMA_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';
const oldEquivalentHistoryConstraint = `CHECK (entity_type ~ '^[a-z][a-z0-9_.-]{1,79}$'::text OR
  (entity_type = ANY (ARRAY['opportunity'::text, 'project'::text, 'organization'::text, 'place'::text,
    'cooperation'::text, 'world'::text, 'business'::text, 'job'::text, 'order'::text,
    'agreement'::text, 'norm'::text, 'capability'::text, 'capability_proposal'::text, 'agent_goal'::text])))`;

async function snapshot(client) {
  const tables = (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const data = {};
  for (const { tablename } of tables) {
    const rows = (await client.query(`SELECT xmin::text AS version,to_jsonb(t) AS data FROM public.${quote(tablename)} t`)).rows;
    data[tablename] = createHash('sha256').update(rows.map(row => JSON.stringify(row)).sort().join('\n')).digest('hex');
  }
  const triggers = (await client.query(`SELECT t.oid,t.xmin::text,pg_get_triggerdef(t.oid) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY t.oid`)).rows;
  const columns = (await client.query(`SELECT c.relname,a.attname,a.atttypid,a.atttypmod,a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid) AS default_expression
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`)).rows;
  return { data, triggers, columns };
}

function serverFailure(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/server.js'], { cwd: rootDirectory, env, stdio: ['ignore','pipe','pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('invalid schema server did not exit')); }, 10_000);
    child.on('error', reject);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test('startup schema apply/validate and fail-closed checks on isolated PostgreSQL', { skip: !enabled, timeout: 120_000 }, async (t) => {
  const url = new URL(databaseUrl);
  assert.ok(['localhost','127.0.0.1','::1'].includes(url.hostname));
  assert.ok(url.port && url.port !== '5432');
  assert.ok(url.pathname.endsWith('_test'));
  assert.ok(process.env.SYNTERRA_STATE_DIR, 'requires independent runtime directory');
  const pool = new Pool({ connectionString: databaseUrl });
  let engine;
  try {
    const hadLedger = (await pool.query("SELECT to_regclass('public.synterra_schema_migrations') AS name")).rows[0].name;
    await t.test('apply retains baseline bootstrap and does not apply numbered migrations', async () => {
      const applied = await prepareStartupSchema(pool, { rootDirectory, mode: 'apply' });
      assert.equal(applied.mode, 'apply');
      if (!hadLedger) assert.equal((await pool.query("SELECT to_regclass('public.synterra_schema_migrations') AS name")).rows[0].name, null);
      assert.ok((await pool.query("SELECT to_regclass('public.world_agent_states') AS table_name")).rows[0].table_name);
    });
    await applyWorldSchemaAndMigrations(pool, { rootDirectory });
    // Fixture-only read grants; production validation never grants anything.
    await pool.query('GRANT SELECT ON ALL TABLES IN SCHEMA public TO synterra_app');
    await pool.query('REVOKE SELECT ON arc_turnkey_agent_wallet_provisioning FROM synterra_app');
    await pool.query(`GRANT INSERT,UPDATE ON world_runtime_state,world_agent_states,world_social_profiles,
      world_agent_goals,world_agent_self_models,world_agent_decision_policies,world_epochs,agent_memories TO synterra_app`);
    await pool.query(`GRANT INSERT ON world_events,world_history,world_decision_traces,world_v7_events,
      world_capability_events,world_agent_self_model_history TO synterra_app`);
    await pool.query('GRANT DELETE ON agent_memories,world_decision_traces TO synterra_app');
    await pool.query('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO synterra_app');
    const worldId = randomUUID();
    const ownerId = randomUUID();
    await pool.query('INSERT INTO agents(id,name,public_key) VALUES($1,$2,$3)', [ownerId,'Schema Fixture',ownerId]);
    await pool.query('INSERT INTO worlds(id,owner_agent_id,name) VALUES($1,$2,$3)', [worldId,ownerId,'Schema Fixture']);
    await pool.query(`INSERT INTO world_economic_accounts(world_id,account_type,account_key,asset_symbol,balance)
      VALUES($1,'system','system:schema-test','USDC',123)`, [worldId]);
    const account = (await pool.query("SELECT id FROM world_economic_accounts WHERE world_id=$1", [worldId])).rows[0];
    // Deliberately retain a balance different from postings: bootstrap normalization would change it.
    const peer = (await pool.query(`INSERT INTO world_economic_accounts(world_id,account_type,account_key,asset_symbol,balance)
      VALUES($1,'system','system:schema-peer','USDC',0) RETURNING id`, [worldId])).rows[0];
    const fixture = await pool.connect();
    try {
      await fixture.query('BEGIN');
      const tx = (await fixture.query(`INSERT INTO world_economic_transactions(world_id,action_id,transaction_type,
        source_account_id,destination_account_id,asset_symbol,amount,reason,world_time)
        VALUES($1,'schema-fixture','opening_balance',$2,$3,'USDC',1,'fixture',0) RETURNING id`, [worldId,account.id,peer.id])).rows[0];
      await fixture.query('INSERT INTO world_economic_postings(transaction_id,account_id,amount) VALUES($1,$2,-1),($1,$3,1)',[tx.id,account.id,peer.id]);
      await fixture.query('COMMIT');
    } finally { fixture.release(); }

    await t.test('validate accepts legacy equivalent history constraint and preserves every business row and trigger', async () => {
      await pool.query('ALTER TABLE world_history DROP CONSTRAINT world_history_entity_type_check');
      await pool.query(`ALTER TABLE world_history ADD CONSTRAINT world_history_entity_type_check ${oldEquivalentHistoryConstraint}`);
      const appPool = new Pool({ connectionString: databaseUrl });
      const before = await snapshot(pool);
      assert.equal((await pool.query(`SELECT has_table_privilege('synterra_app',
        'public.arc_turnkey_agent_wallet_provisioning','SELECT') AS allowed`)).rows[0].allowed, false);
      const sql = [];
      const guardedPool = { async connect() {
        const client = await appPool.connect();
        await client.query('SET ROLE synterra_app');
        return { release: () => client.release(), query: async (text, values) => {
          sql.push(text);
          assert.match(text.trim(), /^(SELECT|BEGIN .*READ ONLY|SET LOCAL statement_timeout|COMMIT|ROLLBACK)/);
          return client.query(text, values);
        } };
      } };
      try {
        const log = console.log;
        const messages = [];
        console.log = message => messages.push(String(message));
        try { assert.equal((await prepareStartupSchema(guardedPool, { rootDirectory, mode: 'validate' })).validated, true); }
        finally { console.log = log; }
        assert.equal(JSON.parse(messages[0]).migrationValidation, 'passed');
        assert.equal(JSON.parse(messages[0]).checksumValidation, 'passed');
        assert.equal(JSON.parse(messages[0]).requiredObjects, 'passed');
        assert.equal(JSON.parse(messages[0]).runtimeGrants, 'passed');
        assert.equal(JSON.parse(messages[0]).schemaSql, 'not_executed');
        assert.ok(sql[0].includes('READ ONLY'));
        assert.deepEqual(await snapshot(pool), before);
        assert.equal((await pool.query('SELECT balance::text FROM world_economic_accounts WHERE id=$1',[account.id])).rows[0].balance, '123.00000000');
      } finally { await appPool.end(); }
    });

    await t.test('validate rejects a non-equivalent history constraint without altering it', async () => {
      await pool.query('ALTER TABLE world_history DROP CONSTRAINT world_history_entity_type_check');
      await pool.query(`ALTER TABLE world_history ADD CONSTRAINT world_history_entity_type_check CHECK (char_length(entity_type) > 1)`);
      const before = (await pool.query(`SELECT pg_get_constraintdef(oid,true) AS definition FROM pg_constraint
        WHERE conrelid='public.world_history'::regclass AND conname='world_history_entity_type_check'`)).rows[0].definition;
      await assert.rejects(prepareStartupSchema(pool,{rootDirectory,mode:'validate'}), /constraint world_history\.world_history_entity_type_check/);
      const after = (await pool.query(`SELECT pg_get_constraintdef(oid,true) AS definition FROM pg_constraint
        WHERE conrelid='public.world_history'::regclass AND conname='world_history_entity_type_check'`)).rows[0].definition;
      assert.equal(after, before);
      await pool.query('ALTER TABLE world_history DROP CONSTRAINT world_history_entity_type_check');
      await pool.query(`ALTER TABLE world_history ADD CONSTRAINT world_history_entity_type_check ${oldEquivalentHistoryConstraint}`);
    });

    async function rejectMutation(name, sql, reason) {
      await t.test(name, async () => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('COMMIT');
          await assert.rejects(prepareStartupSchema(pool,{rootDirectory,mode:'validate'}), reason);
        } finally {
          client.release();
          // Test cases are restored by their explicit inverse below, never by validator.
        }
      });
    }
    const ledger = (await pool.query("SELECT * FROM synterra_schema_migrations WHERE version='0003_arc_agent_token_issuance_runtime_privileges.sql'")).rows[0];
    await rejectMutation('missing migration rejects startup', "DELETE FROM synterra_schema_migrations WHERE version='0003_arc_agent_token_issuance_runtime_privileges.sql'", /missing migration/);
    await pool.query('INSERT INTO synterra_schema_migrations(version,checksum,applied_at) VALUES($1,$2,$3)',[ledger.version,ledger.checksum,ledger.applied_at]);
    await rejectMutation('checksum mismatch rejects startup', "UPDATE synterra_schema_migrations SET checksum=repeat('0',64) WHERE version='0003_arc_agent_token_issuance_runtime_privileges.sql'", /checksum mismatch/);
    await pool.query('UPDATE synterra_schema_migrations SET checksum=$1 WHERE version=$2',[ledger.checksum,ledger.version]);
    await rejectMutation('missing environment column rejects startup', 'ALTER TABLE world_agent_states RENAME COLUMN hygiene TO missing_hygiene', /column world_agent_states.hygiene/);
    await pool.query('ALTER TABLE world_agent_states RENAME COLUMN missing_hygiene TO hygiene');
    await rejectMutation('missing constraint rejects startup', 'ALTER TABLE arc_currency_genesis_requirements RENAME CONSTRAINT arc_currency_genesis_requirements_pkey TO missing_requirement_pkey', /constraint arc_currency_genesis_requirements/);
    await pool.query('ALTER TABLE arc_currency_genesis_requirements RENAME CONSTRAINT missing_requirement_pkey TO arc_currency_genesis_requirements_pkey');
    await rejectMutation('missing table rejects startup', 'ALTER TABLE arc_agent_token_uses RENAME TO missing_token_uses', /missing table arc_agent_token_uses/);
    await pool.query('ALTER TABLE missing_token_uses RENAME TO arc_agent_token_uses');
    await rejectMutation('missing runtime UPDATE privilege rejects startup even when SELECT is granted', 'REVOKE UPDATE ON arc_token_issuance_intents FROM synterra_app', /synterra_app UPDATE missing/);
    await pool.query('GRANT UPDATE ON arc_token_issuance_intents TO synterra_app');
    await t.test('invalid mode fails before touching database', async () => {
      await assert.rejects(prepareStartupSchema({}, { rootDirectory, mode: 'skip' }), /must be apply or validate/);
    });
    await t.test('server rejects bad migration before listener or World Engine writes', async () => {
      await pool.query('UPDATE synterra_schema_migrations SET checksum=$1 WHERE version=$2',['0'.repeat(64),ledger.version]);
      const before = await snapshot(pool);
      const env = { PATH: process.env.PATH, PGUSER: (await pool.query('SELECT current_user AS name')).rows[0].name, DATABASE_URL: databaseUrl, PORT: '0', HOST: '127.0.0.1',
        SYNTERRA_SCHEMA_MODE: 'validate', SYNTERRA_STATE_DIR: process.env.SYNTERRA_STATE_DIR };
      const failed = await serverFailure(env);
      assert.notEqual(failed.code, 0);
      assert.match(failed.output, /checksum mismatch/);
      assert.doesNotMatch(failed.output, /MirrorTerra listening/);
      assert.deepEqual(await snapshot(pool), before);
      await pool.query('UPDATE synterra_schema_migrations SET checksum=$1 WHERE version=$2',[ledger.checksum,ledger.version]);
    });
    await t.test('validated schema permits World Engine startup and closed gate remains unchanged', async () => {
      assert.equal((await prepareStartupSchema(pool,{rootDirectory,mode:'validate'})).validated,true);
      await pool.query(`INSERT INTO world_members(world_id,agent_id,role,location) VALUES($1,$2,'owner','home')`,[worldId,ownerId]);
      engine = await startWorldEngine(pool,{worldId,schedule:false,currencyGenesisEnabled:true,emergencySink:{write(){}}});
      assert.equal(engine.running,true);
      assert.equal(engine.worldLockOwned,true);
      assert.equal(engine.getLiveness().openCognitionEnabled, false);
      await pool.query(`INSERT INTO world_agent_cognition_state(world_id,agent_id)
        VALUES($1,$2) ON CONFLICT DO NOTHING`, [worldId, ownerId]);
      const cognition = await readCognitionContext(pool, { worldId, agentId: ownerId });
      assert.equal(cognition.context.world.id, worldId);
      assert.equal(cognition.context.resident.id, ownerId);
      assert.ok(Array.isArray(cognition.context.capabilities));
      const gapId = randomUUID();
      await pool.query(`INSERT INTO world_capability_gaps(id,world_id,gap_key,category,
        problem_statement,first_observed_world_minute,last_observed_world_minute,evidence)
        VALUES($1,$2,'fixture-observed-gap','world.research',
          'Residents need a reusable observation practice.',0,0,'{}'::jsonb)`, [gapId, worldId]);
      await pool.query(`INSERT INTO world_capability_observations(world_id,gap_id,agent_id,
        observed_world_day,observed_world_minute,observation_path,evidence)
        VALUES($1,$2,$3,0,0,'resident_context','{}'::jsonb)`, [worldId, gapId, ownerId]);
      let cognitionCalls = 0;
      let modelSubtasks = 0;
      let githubCalls = 0;
      const providerIds = ['claude-haiku-5.5','claude-sonnet-5.5','claude-opus-5.5'];
      const fetchImpl = async (url, options) => {
        if (url.endsWith('/models')) return new Response(JSON.stringify({ data: providerIds.map((id) => ({
          id, supported_endpoint_types: ['openai'] })) }), { status: 200 });
        if (url.startsWith('https://api.github.com/')) {
          githubCalls += 1;
          return new Response(JSON.stringify({ full_name: 'example/research', description: 'Public source',
            html_url: 'https://github.com/example/research', default_branch: 'main' }), { status: 200 });
        }
        assert.ok(url.endsWith('/chat/completions'));
        const request = JSON.parse(options.body);
        const context = JSON.parse(request.messages[1].content).context;
        if (request.messages[0].content.includes('advisory analysis subtask')) {
          modelSubtasks += 1;
          return new Response(JSON.stringify({ model: request.model,
            choices: [{ message: { content: JSON.stringify({ summary: 'The current facts support research.',
              uncertainty: 'More evidence is needed.', suggestedNextSteps: ['Read the public source'],
              evidenceRefs: [`world:${context.world.minute}`] }) } }], usage: {} }), { status: 200 });
        }
        cognitionCalls += 1;
        const result = { selfModelUpdate: null, goalUpdates: [], planUpdates: [],
          beliefUpdates: [], valueUpdates: [], policyExperimentUpdates: [], questionUpdates: [], memoryUpdates: [], nextAction: null,
          toolRequests: [], capabilityDecisions: [], reviewAfterWorldMinutes: 1800, requestModel: null,
          reasonSummary: 'Study public information.', uncertainty: 'Further evidence is needed.' };
        if (cognitionCalls === 1) result.toolRequests = [{ id: 'repo-read', capability: 'github_public_read',
          operation: 'repository', owner: 'example', repo: 'research' },
        { id: 'parallel-analysis', capability: 'model_analysis', tier: 'haiku',
          question: 'What does the current evidence suggest?', objective: 'Check the available World facts.' }];
        if (cognitionCalls === 1) {
          const observed = context.capabilityGaps.find((row) => row.id === gapId);
          const primitive = context.capabilities.find((row) => row.specification?.kind === 'primitive');
          assert.ok(observed && primitive, 'resident sees observed gap and executable primitive');
          result.capabilityDecisions = [{ type: 'propose', gapId,
            evidenceRefs: [`capability_gap:${gapId}`], proposal: {
              name: 'Shared observation', category: 'world.research',
              problemStatement: observed.problemStatement,
              expectedBenefit: 'Residents can practice a bounded observation method.',
              expectedCost: {}, requiredResources: {}, affectedSystems: [],
              specification: { schemaVersion: 1, kind: 'composition',
                composition: [{ capabilityId: primitive.key.slice('world-capability:'.length), parameters: {} }],
                requirements: {} } } }];
        }
        else {
          const evidenceRef = context.evidenceRefs.find((ref) => ref.startsWith('tool:'));
          assert.ok(evidenceRef, 'completed tool evidence must reach the next cognition turn');
          result.memoryUpdates = [{ id: 'github-research', type: 'tool',
            summary: 'The public repository has a documented research purpose.', evidenceRefs: [evidenceRef] }];
        }
        return new Response(JSON.stringify({ model: request.model,
          choices: [{ message: { content: JSON.stringify(result) } }], usage: {} }), { status: 200 });
      };
      const errors = [];
      // This fixture exercises schema/runtime integration, not the paid-call rate gate.
      // Two cognition turns plus model_analysis intentionally exceed one Agent's hourly cap.
      const budgetGateway = { runRequest: async (input, send) => {
        // Persist the mocked provider call so attribution effects keep their real FK.
        // This fixture bypasses admission limits, never the schema's evidence integrity.
        await pool.query(`INSERT INTO bai_model_budget_calls(id,world_id,agent_id,source,tier,model,status,
            request_bytes,estimated_input_tokens,max_output_tokens,reserved_cost_nano_usd,
            effective_cost_nano_usd,cost_source,rolling24h_cost_nano_usd,correlation_id)
          VALUES($1,$2,$3,$4,$5,$6,'reserved',$7,0,$8,0,0,'reservation',0,$9)`,
        [input.callId, input.worldId, input.agentId, input.source, input.tier, input.model,
          Buffer.byteLength(input.body), input.maxTokens, input.correlationId]);
        try {
          const result = await send();
          await pool.query(`UPDATE bai_model_budget_calls SET status='succeeded',input_tokens=0,
            output_tokens=0,cost_source='usage_priced',completed_at=now() WHERE id=$1`, [input.callId]);
          return result;
        } catch (error) {
          await pool.query(`UPDATE bai_model_budget_calls SET status='failed',completed_at=now() WHERE id=$1`, [input.callId]);
          throw error;
        }
      },
        recordApplicationResult: async () => {},
        availability: async () => ({ budgetAvailable: true, rateAvailable: true,
          nextAdmissionPossibleAt: null, nextRateSlotAt: null }) };
      const worker = await startOpenCognitionWorker(pool, { worldId, apiKey: 'fixture', fetchImpl,
        budgetGateway,
        intervalMs: 20, onError: (error) => errors.push(error?.code || error?.message) });
      engine.setOpenCognitionEnabled(worker.running);
      assert.equal(engine.getLiveness().openCognitionEnabled, true);
      try {
        const until = Date.now() + 5_000;
        while (Date.now() < until) {
          const count = await pool.query(`SELECT count(*)::int AS count FROM world_agent_cognition_turns
            WHERE world_id=$1 AND agent_id=$2`, [worldId, ownerId]);
          if (count.rows[0].count >= 2) break;
          await delay(25);
        }
        assert.deepEqual(errors, []);
        assert.equal(cognitionCalls, 2);
        assert.equal(modelSubtasks, 1);
        assert.equal(githubCalls, 1);
        const tool = await pool.query(`SELECT status,result FROM world_agent_cognition_tool_attempts
          WHERE world_id=$1 AND agent_id=$2`, [worldId, ownerId]);
        assert.equal(tool.rowCount, 2);
        assert.ok(tool.rows.every((row) => row.status === 'succeeded'));
        assert.ok(tool.rows.some((row) => row.result.data?.fullName === 'example/research'));
        assert.ok(tool.rows.some((row) => row.result.summary === 'The current facts support research.'));
        const memory = await pool.query(`SELECT evidence FROM world_agent_cognition_memories
          WHERE world_id=$1 AND agent_id=$2 AND memory_key='github-research'`, [worldId, ownerId]);
        assert.equal(memory.rowCount, 1);
        assert.match(memory.rows[0].evidence.refs[0], /^tool:/);
        const proposal = await pool.query(`SELECT creator_agent_id,proposed_capability,status
          FROM world_capability_proposals WHERE world_id=$1 AND gap_id=$2`, [worldId, gapId]);
        assert.equal(proposal.rowCount, 1);
        assert.equal(proposal.rows[0].creator_agent_id, ownerId);
        assert.equal(proposal.rows[0].proposed_capability.kind, 'composition');
      } finally { await worker.stop(); engine.setOpenCognitionEnabled(false); }
      await pool.query(`INSERT INTO world_agent_cognition_tool_attempts(world_id,agent_id,intent_key,
          capability_key,status,request,created_world_minute,updated_world_minute,lease_token,lease_until)
        VALUES($1,$2,'restart-recovery','github_public_read','running',$3::jsonb,0,0,$4,
          now()-interval '1 second')`, [worldId, ownerId, JSON.stringify({ id: 'recovered',
        capability: 'github_public_read', operation: 'repository', owner: 'example', repo: 'research' }), randomUUID()]);
      const restarted = await startOpenCognitionWorker(pool, { worldId, apiKey: 'fixture', fetchImpl,
        intervalMs: 20, onError: (error) => errors.push(error?.code || error?.message) });
      try {
        const until = Date.now() + 5_000;
        while (Date.now() < until) {
          const recovery = await pool.query(`SELECT status FROM world_agent_cognition_tool_attempts
            WHERE world_id=$1 AND agent_id=$2 AND intent_key='restart-recovery'`, [worldId, ownerId]);
          if (recovery.rows[0].status === 'succeeded') break;
          await delay(25);
        }
        assert.equal(githubCalls, 2, 'expired read-only tool lease is recovered once after restart');
        assert.deepEqual(errors, []);
      } finally { await restarted.stop(); }
      assert.equal(arcNetworkConfig({}).writesEnabled,false);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM arc_token_issuance_intents WHERE world_id=$1',[worldId])).rows[0].count,0);
      await engine.stop(); engine=null;
    });
  } finally { await engine?.stop(); await pool.end(); }
});
