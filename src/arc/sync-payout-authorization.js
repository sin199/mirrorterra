import { getAddress, Interface, keccak256, toUtf8Bytes, TypedDataEncoder } from 'ethers';
import { TOKENOMICS_MANIFEST_HASH } from './sync-tokenomics.js';
import { normalizeSyncRewardWeight, syncRewardRawForWeight } from './sync-resident-rewards.js';

export const SYNC_SETTLEMENT_EXECUTOR_INTERFACE = new Interface([
  'function ledgerSigner() view returns (address)', 'function asset() view returns (address)',
  'function operatingPool() view returns (address)',
  'function executedPayouts(bytes32 payoutId) view returns (bool)',
  'function executePayout(bytes32 payoutId,address recipient,uint256 amount,address asset,bytes authorization)',
  'event LedgerPayoutExecuted(bytes32 indexed payoutId,address indexed recipient,uint256 amount,address asset)'
]);
export const SYNC_PAYOUT_TYPES = Object.freeze({ Payout: [
  { name: 'payoutId', type: 'bytes32' }, { name: 'recipient', type: 'address' },
  { name: 'amount', type: 'uint256' }, { name: 'asset', type: 'address' }
] });
export function syncPayoutAuthorization(executor, payout) {
  const domain = { name: 'MirrorTerra SYNC Settlement', version: '1', chainId: 5042, verifyingContract: getAddress(executor) };
  const message = { payoutId: keccak256(toUtf8Bytes(payout.action_id)), recipient: getAddress(payout.recipient_address),
    amount: BigInt(payout.amount_raw), asset: getAddress(payout.token_address) };
  return { domain, message, digest: TypedDataEncoder.hash(domain, SYNC_PAYOUT_TYPES, message) };
}
function fail(code) { throw Object.assign(new Error(code), { code }); }
function same(a, b) { return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase(); }
function sameWeight(left, right) {
  try { return normalizeSyncRewardWeight(left).milli === normalizeSyncRewardWeight(right).milli; }
  catch { return false; }
}
function atOrAfter(value, boundary) {
  const time = Date.parse(value);
  const start = Date.parse(boundary);
  return Number.isFinite(time) && Number.isFinite(start) && time >= start;
}

async function validateResidentRewardBatch(pool, { worldId, actionId, agentId, recipient, amountRaw }) {
  const result = await pool.query(`SELECT batch.id AS batch_id,batch.agent_id AS batch_agent_id,
      batch.amount_raw::text AS batch_amount_raw,batch.recipient_address AS batch_recipient,batch.status AS batch_status,
      entitlement.id AS entitlement_id,entitlement.agent_id AS entitlement_agent_id,
      entitlement.contribution_id,entitlement.epoch_index,entitlement.policy_version AS entitlement_policy_version,
      entitlement.policy_hash AS entitlement_policy_hash,entitlement.sync_amount_raw::text AS entitlement_amount_raw,
      entitlement.status AS entitlement_status,entitlement.batch_id AS entitlement_batch_id,
      contribution.agent_id AS contribution_agent_id,contribution.source_type,contribution.source_event_id,
      contribution.source_entity_id,contribution.reward_weight::text AS reward_weight,
      contribution.epoch_index AS contribution_epoch_index,contribution.policy_version,
      contribution.policy_hash,contribution.status AS contribution_status,
      policy.activated_at,policy.policy->'conversion'->>'syncRawPerRewardWeightUnit' AS raw_per_weight,
      policy.policy->'commit'->>'minimumPendingSyncRawPerAgent' AS minimum_batch_raw,
      evidence.world_id AS evidence_world_id,evidence.actor_id AS evidence_actor_id,
      evidence.event_type AS evidence_event_type,evidence.action_id AS evidence_action_id,
      evidence.created_at AS evidence_created_at,evidence.data AS evidence_data,
      project_contribution.id::text AS project_contribution_id,
      project_contribution.agent_id AS project_agent_id,
      project_contribution.contribution_type,project_contribution.effort_points::text AS project_effort,
      project_contribution.created_at AS project_contribution_created_at,
      project_contribution.action_id AS project_action_id,
      project.id::text AS project_id,project.status AS project_status,project.project_type,project.result AS project_result,
      (SELECT count(DISTINCT actual_contribution.agent_id)::int FROM world_project_contributions actual_contribution
        WHERE actual_contribution.world_id=project_contribution.world_id
          AND actual_contribution.project_id=project_contribution.project_id) AS project_contributor_count,
      production.id::text AS production_id,production.agent_id AS production_agent_id,
      production.business_id::text AS production_business_id,production.service_id::text AS production_service_id,
      production.units::text AS production_units,production.created_at AS production_created_at
    FROM arc_sync_resident_reward_batches batch
    JOIN arc_sync_resident_reward_batch_items item ON item.world_id=batch.world_id AND item.batch_id=batch.id
    JOIN arc_sync_resident_reward_entitlements entitlement
      ON entitlement.world_id=item.world_id AND entitlement.id=item.entitlement_id
    JOIN arc_sync_resident_reward_contributions contribution
      ON contribution.world_id=entitlement.world_id AND contribution.id=entitlement.contribution_id
    JOIN arc_sync_resident_reward_policies policy
      ON policy.version=contribution.policy_version AND policy.policy_hash=contribution.policy_hash
    JOIN world_events evidence ON evidence.id=contribution.source_event_id
    LEFT JOIN world_project_contributions project_contribution
      ON contribution.source_type IN ('research_project','shared_project_cooperation')
      AND project_contribution.world_id=contribution.world_id
      AND project_contribution.id::text=contribution.source_entity_id
    LEFT JOIN world_projects project ON project.world_id=project_contribution.world_id
      AND project.id=project_contribution.project_id
    LEFT JOIN world_business_production production
      ON contribution.source_type='business_production' AND production.world_id=contribution.world_id
      AND production.id::text=contribution.source_entity_id
    WHERE batch.world_id=$1 AND batch.action_id=$2 AND batch.status='committed'
    ORDER BY entitlement.id`, [worldId, actionId]);
  if (!result.rowCount) fail('SYNC_PAYOUT_RESIDENT_REWARD_BATCH_MISSING');
  const first = result.rows[0];
  if (first.batch_agent_id !== agentId || !same(first.batch_recipient, recipient)
      || BigInt(first.batch_amount_raw) !== amountRaw) fail('SYNC_PAYOUT_RESIDENT_REWARD_BATCH_MISMATCH');
  let sum = 0n;
  let minimumBatchRaw = null;
  for (const item of result.rows) {
    const evidence = item.evidence_data && typeof item.evidence_data === 'object' ? item.evidence_data : {};
    const initiative = evidence.initiative && typeof evidence.initiative === 'object' ? evidence.initiative : {};
    const weightMatches = sameWeight(item.reward_weight, item.source_type === 'business_production'
      ? item.production_units : item.project_effort);
    const commonMatches = item.entitlement_status === 'committed'
      && item.entitlement_batch_id === item.batch_id
      && item.entitlement_agent_id === first.batch_agent_id
      && item.contribution_agent_id === first.batch_agent_id
      && item.contribution_status === 'accrued'
      && item.contribution_epoch_index === item.epoch_index
      && Number(item.entitlement_policy_version) === Number(item.policy_version)
      && item.entitlement_policy_hash === item.policy_hash
      && item.evidence_world_id === worldId && item.evidence_actor_id === first.batch_agent_id
      && atOrAfter(item.evidence_created_at, item.activated_at) && weightMatches;
    let sourceMatches = false;
    if (commonMatches && item.source_type === 'research_project') {
      sourceMatches = item.project_contribution_id === item.source_entity_id
        && item.project_agent_id === first.batch_agent_id
        && atOrAfter(item.project_contribution_created_at, item.activated_at)
        && (['RESEARCH','LEARNING'].includes(item.project_type)
          || ['research','learning'].includes(item.contribution_type))
        && item.evidence_event_type === 'world.project_contribution'
        && item.evidence_action_id === item.project_action_id
        && evidence.projectId === item.project_id
        && sameWeight(evidence.effortPoints, item.reward_weight);
    } else if (commonMatches && item.source_type === 'shared_project_cooperation') {
      sourceMatches = item.project_contribution_id === item.source_entity_id
        && item.project_agent_id === first.batch_agent_id
        && atOrAfter(item.project_contribution_created_at, item.activated_at)
        && item.project_status === 'completed'
        && Number(item.project_contributor_count || 0) >= 2
        && !['RESEARCH','LEARNING'].includes(item.project_type)
        && !['research','learning'].includes(item.contribution_type)
        && item.evidence_event_type === 'world.project_contribution'
        && item.evidence_action_id === item.project_action_id
        && evidence.projectId === item.project_id
        && sameWeight(evidence.effortPoints, item.reward_weight);
    } else if (commonMatches && item.source_type === 'business_production') {
      sourceMatches = item.production_id === item.source_entity_id
        && item.production_agent_id === first.batch_agent_id
        && atOrAfter(item.production_created_at, item.activated_at)
        && item.evidence_event_type === 'world.action_completed'
        && evidence.action === 'business_work' && evidence.initiativeAction === 'business_work'
        && evidence.status === 'completed' && initiative.productionId === item.production_id
        && initiative.producerAgentId === first.batch_agent_id
        && initiative.businessId === item.production_business_id
        && initiative.serviceId === item.production_service_id;
    }
    const expectedAmount = syncRewardRawForWeight(item.reward_weight, BigInt(item.raw_per_weight));
    if (!sourceMatches || expectedAmount !== BigInt(item.entitlement_amount_raw)) {
      fail('SYNC_PAYOUT_RESIDENT_REWARD_SOURCE_INVALID');
    }
    sum += expectedAmount;
    const threshold = BigInt(item.minimum_batch_raw);
    minimumBatchRaw = minimumBatchRaw === null || threshold < minimumBatchRaw ? threshold : minimumBatchRaw;
  }
  if (sum !== BigInt(first.batch_amount_raw) || minimumBatchRaw === null || sum < minimumBatchRaw) {
    fail('SYNC_PAYOUT_RESIDENT_REWARD_CONSERVATION_INVALID');
  }
  return { batchId: first.batch_id, amountRaw: sum.toString(), entitlementCount: result.rowCount };
}

// All authorization comes from a committed source-backed reward batch or the existing storm path.
export async function readValidatedSyncPayout(pool, { worldId, outboxId, status = 'committed' }) {
  if (!['committed','submitting'].includes(status)) fail('SYNC_PAYOUT_STATE_INVALID');
  const selected = await pool.query(`SELECT outbox.*,ledger.status AS "transactionStatus",
      ledger.action_id AS "transactionActionId",ledger.id AS "transactionId",
      ledger.source_economic_action_id AS "sourceEconomicActionId",deployment.token_address,
      deployment.operating_pool_address,deployment.settlement_worker_address,deployment.manifest_hash
    FROM arc_sync_payout_outbox outbox JOIN arc_sync_ledger_transactions ledger
      ON ledger.world_id=outbox.world_id AND ledger.id=outbox.transaction_id
    JOIN arc_sync_tokenomics_deployments deployment ON deployment.world_id=outbox.world_id
    WHERE outbox.world_id=$1 AND outbox.id=$2`, [worldId, outboxId]);
  if (selected.rowCount !== 1) fail('SYNC_PAYOUT_OUTBOX_MISSING');
  const row = selected.rows[0];
  if (row.status !== status || row.transactionStatus !== 'committed' || row.transactionActionId !== row.action_id
      || row.transactionId !== row.transaction_id || row.manifest_hash !== TOKENOMICS_MANIFEST_HASH) fail('SYNC_PAYOUT_OUTBOX_NOT_COMMITTED');
  const amount = BigInt(row.amount_raw);
  if (amount <= 0n) fail('SYNC_PAYOUT_AMOUNT_INVALID');
  const source = await pool.query(`SELECT batch.id,batch.agent_id AS "agentId",
      batch.amount_raw::text AS amount,batch.recipient_address AS recipient,
      count(item.work_order_id)::int AS "workOrderCount",
      COALESCE(sum(work_order.raw_sync_reward),0)::text AS "verifiedAmount",
      count(*) FILTER (WHERE work_order.status='batched' AND work_order.accepted_agent_id=batch.agent_id
        AND target.status='cleared' AND target.cleared_by_agent_id=batch.agent_id
        AND target.cleared_world_minute=work_order.verified_world_minute
        AND target.cleared_at>work_order.accepted_at
        AND evidence.world_id=work_order.world_id AND evidence.actor_id=batch.agent_id
        AND evidence.event_type='world.action_completed' AND evidence.data->>'action'='work'
        AND evidence.data->'work'->>'output'='storm_debris_cleared'
        AND evidence.data->'work'->>'targetId'=target.id::text
        AND evidence.data->'work'->>'workOrderId'=work_order.id::text
        AND evidence.created_at>work_order.accepted_at
        AND (evidence.data->>'worldMinutes')::bigint>=work_order.accepted_world_minute)::int AS "validCount"
    FROM world_sync_work_order_batches batch
    LEFT JOIN world_sync_work_order_batch_items item ON item.world_id=batch.world_id AND item.batch_id=batch.id
    LEFT JOIN world_sync_work_orders work_order ON work_order.world_id=item.world_id AND work_order.id=item.work_order_id
    LEFT JOIN world_sync_cleanup_targets target ON target.world_id=work_order.world_id
      AND target.id=work_order.target_id
    LEFT JOIN world_events evidence ON evidence.id=work_order.evidence_event_id
    WHERE batch.world_id=$1 AND batch.action_id=$2 AND batch.status='committed'
    GROUP BY batch.id`, [worldId, row.sourceEconomicActionId]);
  if (source.rowCount === 0) {
    await validateResidentRewardBatch(pool, { worldId, actionId: row.sourceEconomicActionId,
      agentId: row.agent_id, recipient: row.recipient_address, amountRaw: amount });
  } else if (source.rowCount !== 1 || source.rows[0].agentId !== row.agent_id
      || !same(source.rows[0].recipient, row.recipient_address)
      || BigInt(source.rows[0].amount) !== amount || BigInt(source.rows[0].verifiedAmount) !== amount
      || Number(source.rows[0].workOrderCount) < 1
      || Number(source.rows[0].validCount) !== Number(source.rows[0].workOrderCount)) {
    fail('SYNC_PAYOUT_SOURCE_ACTION_MISMATCH');
  }
  const entries = await pool.query(`SELECT account.account_type AS "accountType",
      account.agent_id AS "agentId",posting.amount_raw::text AS amount
    FROM arc_sync_ledger_postings posting JOIN arc_sync_ledger_accounts account
      ON account.world_id=posting.world_id AND account.id=posting.account_id
    WHERE posting.world_id=$1 AND posting.transaction_id=$2`, [worldId, row.transaction_id]);
  const debit = entries.rows.find((e) => e.accountType === 'operating_pool');
  const credit = entries.rows.find((e) => e.accountType === 'agent' && e.agentId === row.agent_id);
  if (entries.rowCount !== 2 || !debit || !credit || BigInt(debit.amount) !== -amount
      || BigInt(credit.amount) !== amount) fail('SYNC_PAYOUT_DOUBLE_ENTRY_INVALID');
  const wallets = await pool.query(`SELECT address FROM arc_agent_wallets WHERE world_id=$1 AND agent_id=$2
    AND chain_id=5042 AND status='active'`, [worldId,row.agent_id]);
  if (wallets.rowCount !== 1 || !same(wallets.rows[0].address,row.recipient_address)) fail('SYNC_PAYOUT_AGENT_WALLET_MISMATCH');
  return row;
}
