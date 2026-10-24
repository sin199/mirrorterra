import { randomUUID, createHash } from 'node:crypto';
import { lockMembersFirst } from '../tick-lock-order.js';
import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';
import { TOKENOMICS_MANIFEST_HASH } from './sync-tokenomics.js';

const policyUrl = new URL('../../config/sync-resident-rewards-v1.json', import.meta.url);
export const SYNC_RESIDENT_REWARD_POLICY = Object.freeze(JSON.parse(readFileSync(policyUrl, 'utf8')));
export const SYNC_RESIDENT_REWARD_POLICY_HASH = createHash('sha256')
  .update(JSON.stringify(SYNC_RESIDENT_REWARD_POLICY)).digest('hex');
export const SYNC_RESIDENT_REWARD_POLICY_VERSION = SYNC_RESIDENT_REWARD_POLICY.version;
export const SYNC_RESIDENT_REWARD_RAW_PER_WEIGHT = BigInt(
  SYNC_RESIDENT_REWARD_POLICY.conversion.syncRawPerRewardWeightUnit);
export const SYNC_RESIDENT_REWARD_WORKER_LOCK = 'synterra-sync-resident-reward-accrual-worker';

// Policy v2 (migration 0027) adds the consumed skill_output source. v1 stays byte-identical and
// remains the authority for every row written under it; new contributions use v2 while the
// internal SYNC economy is enabled.
const policyV2Url = new URL('../../config/sync-resident-rewards-v2.json', import.meta.url);
export const SYNC_RESIDENT_REWARD_POLICY_V2 = Object.freeze(JSON.parse(readFileSync(policyV2Url, 'utf8')));
export const SYNC_RESIDENT_REWARD_POLICY_V2_HASH = createHash('sha256')
  .update(JSON.stringify(SYNC_RESIDENT_REWARD_POLICY_V2)).digest('hex');
export const SYNC_RESIDENT_REWARD_POLICY_V2_VERSION = SYNC_RESIDENT_REWARD_POLICY_V2.version;
export const SYNC_RESIDENT_REWARD_SOURCE_TYPES = Object.freeze(['research_project',
  'shared_project_cooperation','business_production','skill_output']);
export const SYNC_INTERNAL_LABEL = 'SYNC (internal)';
export const SYNC_CENTRAL_BANK_NAME = 'MirrorTerra Central Bank';
export const SYNC_CENTRAL_BANK_PAYOUT_LABEL = 'Central Bank → resident';
const SYNC_EPOCH_DURATION_SECONDS = 2_592_000n;
const CAPACITY_SNAPSHOT_PERSIST_MS = 60 * 60 * 1000;

// Whole-economy kill switch: MIRRORTERRA_SYNC_ECONOMY=off restores the pre-0027 behaviour
// (v1 enqueue, chain-only accrual, no internal sales, no skill_output source).
export function syncEconomyEnabled(env = process.env) {
  return String(env?.MIRRORTERRA_SYNC_ECONOMY ?? 'on').trim().toLowerCase() !== 'off';
}

// Commit writes batches into arc_sync_payout_outbox and debits the ledger pool. It stays off
// unless explicitly enabled; entitlements then remain pending (internal SYNC).
export function syncResidentRewardCommitEnabled(env = process.env) {
  return String(env?.SYNC_RESIDENT_REWARD_COMMIT_ENABLED ?? '').trim().toLowerCase() === 'true';
}

export function activeSyncResidentRewardPolicy(env = process.env) {
  return syncEconomyEnabled(env)
    ? { version: SYNC_RESIDENT_REWARD_POLICY_V2_VERSION, hash: SYNC_RESIDENT_REWARD_POLICY_V2_HASH,
      policy: SYNC_RESIDENT_REWARD_POLICY_V2 }
    : { version: SYNC_RESIDENT_REWARD_POLICY_VERSION, hash: SYNC_RESIDENT_REWARD_POLICY_HASH,
      policy: SYNC_RESIDENT_REWARD_POLICY };
}

const GENESIS_POLICY_INTERFACE = new Interface([
  'function TOKENOMICS_MANIFEST_HASH() view returns (bytes32)',
  'function token() view returns (address)',
  'function epochIndex() view returns (uint64)',
  'function epochStart() view returns (uint64)',
  'function economyQuota() view returns (uint256)',
  'function economyReleased() view returns (uint256)',
  'function deploymentTimestamp() view returns (uint64)',
  'function EPOCH_DURATION() view returns (uint256)',
  'function MAX_EPOCH_RELEASE_RAW() view returns (uint256)',
  'function reserve() view returns (address)'
]);
const TOKEN_INTERFACE = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenomicsManifestHash() view returns (bytes32)'
]);

function coded(code) { return Object.assign(new Error(code), { code }); }
function maxZero(value) { return value > 0n ? value : 0n; }
function minBigInt(...values) { return values.reduce((left, right) => left < right ? left : right); }
function blockTag(value) { return `0x${BigInt(value).toString(16)}`; }

export function normalizeSyncRewardWeight(value) {
  const raw = typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : String(value ?? '').trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(raw)) throw coded('SYNC_REWARD_WEIGHT_INVALID');
  const [whole, fraction = ''] = raw.split('.');
  const milli = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, '0') || '0');
  if (milli <= 0n) throw coded('SYNC_REWARD_WEIGHT_INVALID');
  return { decimal: `${whole}.${fraction.padEnd(3, '0')}`, milli };
}

export function syncRewardRawForWeight(value, rawPerWeight = SYNC_RESIDENT_REWARD_RAW_PER_WEIGHT) {
  const { milli } = normalizeSyncRewardWeight(value);
  const raw = milli * BigInt(rawPerWeight) / 1000n;
  if (raw <= 0n) throw coded('SYNC_REWARD_AMOUNT_INVALID');
  return raw;
}

// 1 reward weight x quality for an output another resident used (policy v2 factor).
export function skillOutputRewardWeight(quality, policy = SYNC_RESIDENT_REWARD_POLICY_V2) {
  const q = Number(quality);
  if (!Number.isInteger(q) || q < 1 || q > 10) throw coded('SYNC_REWARD_SKILL_OUTPUT_QUALITY_INVALID');
  const factor = policy?.conversion?.rewardWeightPerConsumedSkillOutputQuality;
  if (factor === undefined) throw coded('SYNC_REWARD_POLICY_LACKS_SKILL_OUTPUT');
  const milli = BigInt(q) * normalizeSyncRewardWeight(factor).milli;
  return `${milli / 1000n}.${(milli % 1000n).toString().padStart(3, '0')}`;
}

export function computeSyncInternalSpendable({ pendingRaw = '0', receivedRaw = '0', sentRaw = '0' } = {}) {
  return BigInt(pendingRaw || '0') + BigInt(receivedRaw || '0') - BigInt(sentRaw || '0');
}

export function computeSyncResidentRewardCapacity({ economyQuotaRaw,
  epochResidentEntitlementsRaw, epochStormEntitlementsRaw, onchainPoolBalanceRaw,
  ledgerPoolBalanceRaw, committedPayoutRaw = '0', pendingResidentRaw, outstandingStormRaw }) {
  const quotaRemaining = maxZero(BigInt(economyQuotaRaw)
    - BigInt(epochResidentEntitlementsRaw) - BigInt(epochStormEntitlementsRaw));
  const onchainAvailable = maxZero(BigInt(onchainPoolBalanceRaw) - BigInt(committedPayoutRaw));
  const poolAssets = minBigInt(onchainAvailable, BigInt(ledgerPoolBalanceRaw));
  const poolReserved = BigInt(pendingResidentRaw) + BigInt(outstandingStormRaw);
  const availablePool = maxZero(poolAssets - poolReserved);
  return { quotaRemainingRaw: quotaRemaining, poolAssetsRaw: poolAssets,
    committedPayoutRaw: BigInt(committedPayoutRaw), poolReservedRaw: poolReserved, availablePoolRaw: availablePool,
    remainingRaw: minBigInt(quotaRemaining, availablePool) };
}

export async function enqueueSyncResidentRewardContribution(client, { worldId, agentId, sourceType,
  sourceEventId, sourceEntityId, rewardWeight }, { env = process.env } = {}) {
  if (!client || typeof client.query !== 'function') throw new TypeError('PostgreSQL transaction client is required.');
  if (!SYNC_RESIDENT_REWARD_SOURCE_TYPES.includes(sourceType)) {
    throw coded('SYNC_REWARD_SOURCE_TYPE_INVALID');
  }
  const activePolicy = activeSyncResidentRewardPolicy(env);
  if (sourceType === 'skill_output' && activePolicy.version < 2) throw coded('SYNC_ECONOMY_DISABLED');
  const weight = normalizeSyncRewardWeight(rewardWeight);
  if (typeof sourceEventId !== 'string' && typeof sourceEventId !== 'number' && typeof sourceEventId !== 'bigint') {
    throw coded('SYNC_REWARD_SOURCE_EVENT_INVALID');
  }
  if (typeof sourceEntityId !== 'string' || !sourceEntityId.length || sourceEntityId.length > 180) {
    throw coded('SYNC_REWARD_SOURCE_ENTITY_INVALID');
  }
  const result = await client.query(`INSERT INTO arc_sync_resident_reward_contributions(
      world_id,agent_id,source_type,source_event_id,source_entity_id,reward_weight,policy_version,policy_hash)
    VALUES($1,$2,$3,$4,$5,$6::numeric,$7,$8)
    ON CONFLICT DO NOTHING RETURNING id,status`, [worldId, agentId, sourceType, String(sourceEventId),
    sourceEntityId, weight.decimal, activePolicy.version, activePolicy.hash]);
  if (result.rowCount === 1) return { contributionId: result.rows[0].id, created: true, status: result.rows[0].status };
  const prior = await client.query(`SELECT id,agent_id,source_type,source_event_id::text AS source_event_id,
      source_entity_id,reward_weight::text AS reward_weight,status
    FROM arc_sync_resident_reward_contributions
    WHERE world_id=$1 AND (source_event_id=$2 OR (source_type=$3 AND source_entity_id=$4))`,
  [worldId, String(sourceEventId), sourceType, sourceEntityId]);
  const row = prior.rows[0];
  if (prior.rowCount !== 1 || row.agent_id !== agentId || row.source_type !== sourceType
      || String(row.source_event_id) !== String(sourceEventId) || row.source_entity_id !== sourceEntityId
      || Number(row.reward_weight) !== Number(weight.decimal)) throw coded('SYNC_REWARD_SOURCE_IDEMPOTENCY_CONFLICT');
  return { contributionId: row.id, created: false, idempotent: true, status: row.status };
}

export async function readSyncResidentRewardChainSnapshot(pool, rpcClient, { worldId }) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('PostgreSQL pool is required.');
  if (!rpcClient || typeof rpcClient.call !== 'function' || typeof rpcClient.getBlockNumber !== 'function'
      || typeof rpcClient.getBlock !== 'function' || typeof rpcClient.getChainId !== 'function') {
    throw coded('SYNC_REWARD_RPC_UNAVAILABLE');
  }
  const deployment = await pool.query(`SELECT token_address,operating_pool_address,genesis_policy_address,
      manifest_hash FROM arc_sync_tokenomics_deployments WHERE world_id=$1 AND chain_id=5042`, [worldId]);
  if (deployment.rowCount !== 1 || deployment.rows[0].manifest_hash !== TOKENOMICS_MANIFEST_HASH) {
    throw coded('SYNC_TOKENOMICS_DEPLOYMENT_NOT_READY');
  }
  const { token_address: tokenAddress, operating_pool_address: poolAddress,
    genesis_policy_address: policyAddress } = deployment.rows[0];
  if (Number(await rpcClient.getChainId()) !== 5042) throw coded('SYNC_REWARD_CHAIN_MISMATCH');
  const blockNumber = BigInt(await rpcClient.getBlockNumber());
  const tag = blockTag(blockNumber);
  const call = async (to, iface, method, args = []) => {
    const data = await rpcClient.call({ to, data: iface.encodeFunctionData(method, args) }, tag);
    return iface.decodeFunctionResult(method, data)[0];
  };
  const [chainManifestHash, onchainToken, storedEpochIndex, storedEpochStart, storedEconomyQuota,
    economyReleased, deploymentTimestamp, epochDuration, maxEpochRelease, reserveAddress,
    tokenManifestHash, poolBalanceRaw] = await Promise.all([
    call(policyAddress, GENESIS_POLICY_INTERFACE, 'TOKENOMICS_MANIFEST_HASH'),
    call(policyAddress, GENESIS_POLICY_INTERFACE, 'token'),
    call(policyAddress, GENESIS_POLICY_INTERFACE, 'epochIndex'),
    call(policyAddress, GENESIS_POLICY_INTERFACE, 'epochStart'),
    call(policyAddress, GENESIS_POLICY_INTERFACE, 'economyQuota'),
    call(policyAddress, GENESIS_POLICY_INTERFACE, 'economyReleased'),
    call(policyAddress, GENESIS_POLICY_INTERFACE, 'deploymentTimestamp'),
    call(policyAddress, GENESIS_POLICY_INTERFACE, 'EPOCH_DURATION'),
    call(policyAddress, GENESIS_POLICY_INTERFACE, 'MAX_EPOCH_RELEASE_RAW'),
    call(policyAddress, GENESIS_POLICY_INTERFACE, 'reserve'),
    call(tokenAddress, TOKEN_INTERFACE, 'tokenomicsManifestHash'),
    call(tokenAddress, TOKEN_INTERFACE, 'balanceOf', [poolAddress])
  ]);
  if (String(chainManifestHash).toLowerCase() !== TOKENOMICS_MANIFEST_HASH.toLowerCase()
      || String(tokenManifestHash).toLowerCase() !== TOKENOMICS_MANIFEST_HASH.toLowerCase()
      || String(onchainToken).toLowerCase() !== String(tokenAddress).toLowerCase()) {
    throw coded('SYNC_REWARD_CHAIN_DEPLOYMENT_MISMATCH');
  }
  const block = await rpcClient.getBlock(tag, false);
  const blockTimestamp = BigInt(block?.timestamp || '0x0');
  const epochZero = BigInt(deploymentTimestamp);
  const epochLength = BigInt(epochDuration);
  if (epochLength <= 0n || blockTimestamp < epochZero) throw coded('SYNC_REWARD_EPOCH_STATE_INVALID');
  const derivedEpochIndex = (blockTimestamp - epochZero) / epochLength;
  const storedIndex = BigInt(storedEpochIndex);
  if (storedIndex > derivedEpochIndex) throw coded('SYNC_REWARD_EPOCH_STATE_INVALID');
  let epochIndex = storedIndex;
  let epochStart = BigInt(storedEpochStart);
  let economyQuota = BigInt(storedEconomyQuota);
  let effectiveEconomyReleased = BigInt(economyReleased);
  if (storedIndex < derivedEpochIndex) {
    // Every contract path that changes reserve balances synchronizes the epoch first.
    // A stale index therefore means no current-epoch reserve release has occurred.
    const reserveBalance = BigInt(await call(tokenAddress, TOKEN_INTERFACE, 'balanceOf', [reserveAddress]));
    const releaseCap = minBigInt(BigInt(maxEpochRelease), reserveBalance / 100n);
    epochIndex = derivedEpochIndex;
    epochStart = epochZero + derivedEpochIndex * epochLength;
    economyQuota = releaseCap * 70n / 100n;
    effectiveEconomyReleased = 0n;
  }
  return { blockNumber: blockNumber.toString(), tokenAddress, poolAddress,
    epochIndex: epochIndex.toString(), epochStart: epochStart.toString(),
    economyQuotaRaw: economyQuota.toString(), economyReleasedRaw: effectiveEconomyReleased.toString(),
    onchainPoolBalanceRaw: BigInt(poolBalanceRaw).toString() };
}

async function readRewardCapacity(client, worldId, snapshot) {
  const epochStart = new Date(Number(BigInt(snapshot.epochStart) * 1000n)).toISOString();
  const [pool, rewards, storm, payouts] = await Promise.all([
    client.query(`SELECT (account.opening_balance_raw+COALESCE(sum(posting.amount_raw),0))::text AS balance_raw
      FROM arc_sync_ledger_accounts account LEFT JOIN arc_sync_ledger_postings posting
        ON posting.world_id=account.world_id AND posting.account_id=account.id
      WHERE account.world_id=$1 AND account.account_type='operating_pool'
        AND account.account_key='operating-pool'
      GROUP BY account.id,account.opening_balance_raw`, [worldId]),
    client.query(`SELECT
        COALESCE(sum(entitlement.sync_amount_raw) FILTER (WHERE entitlement.epoch_index=$2),0)::text AS epoch_resident_raw,
        COALESCE(sum(entitlement.sync_amount_raw) FILTER (WHERE entitlement.status='pending'),0)::text AS pending_raw
      FROM arc_sync_resident_reward_entitlements entitlement WHERE entitlement.world_id=$1`,
    [worldId, snapshot.epochIndex]),
    client.query(`SELECT
        COALESCE(sum(work_order.raw_sync_reward) FILTER (WHERE work_order.status='verified'),0)::text AS entitled_raw,
        COALESCE(sum(work_order.raw_sync_reward) FILTER (WHERE work_order.status='verified'),0)::text AS locked_raw
      FROM world_sync_work_orders work_order WHERE work_order.world_id=$1 AND work_order.created_at>= $2::timestamptz
      UNION ALL
      SELECT COALESCE(sum(batch.amount_raw),0)::text AS entitled_raw,'0'::text AS locked_raw
      FROM world_sync_work_order_batches batch WHERE batch.world_id=$1 AND batch.created_at>= $2::timestamptz`,
    [worldId, epochStart]),
    client.query(`SELECT COALESCE(sum(amount_raw),0)::text AS committed_payout_raw
      FROM arc_sync_payout_outbox WHERE world_id=$1 AND status<>'reconciled'`, [worldId])
  ]);
  if (pool.rowCount !== 1) throw coded('SYNC_OPERATING_POOL_LEDGER_NOT_INITIALIZED');
  const stormEntitled = storm.rows.reduce((sum, row) => sum + BigInt(row.entitled_raw || '0'), 0n);
  const stormLocked = BigInt(storm.rows[0]?.locked_raw || '0');
  return computeSyncResidentRewardCapacity({ economyQuotaRaw: snapshot.economyQuotaRaw,
    epochResidentEntitlementsRaw: rewards.rows[0]?.epoch_resident_raw || '0',
    epochStormEntitlementsRaw: stormEntitled,
    onchainPoolBalanceRaw: snapshot.onchainPoolBalanceRaw,
    ledgerPoolBalanceRaw: pool.rows[0].balance_raw,
    committedPayoutRaw: payouts.rows[0]?.committed_payout_raw || '0',
    pendingResidentRaw: rewards.rows[0]?.pending_raw || '0',
    outstandingStormRaw: stormLocked });
}

// Read-only capacity for a given snapshot; also used by the Central Bank vault display.
export { readRewardCapacity as readSyncResidentRewardCapacity };

async function markContribution(client, row, status, reason, epochIndex = null) {
  await client.query(`UPDATE arc_sync_resident_reward_contributions SET status=$3,decision_reason=$4,
      epoch_index=$5,updated_at=now() WHERE world_id=$1 AND id=$2 AND status='queued'`,
  [row.world_id, row.id, status, reason, epochIndex]);
}

function skillOutputSourceMatches(row, weight) {
  if (row.source_event_type !== 'world.skill_output_delivered') return false;
  if (row.skill_output_id !== row.source_entity_id || row.skill_output_producer_id !== row.agent_id) return false;
  if (!row.skill_output_consumer_id || row.skill_output_consumer_id === row.skill_output_producer_id) return false;
  const data = row.source_event_data && typeof row.source_event_data === 'object' ? row.source_event_data : {};
  if (String(data.outputId) !== row.source_entity_id || data.consumerId !== row.skill_output_consumer_id) return false;
  const consumedAt = Date.parse(row.skill_output_consumed_at);
  const activatedAt = Date.parse(row.policy_activated_at);
  if (!Number.isFinite(consumedAt) || !Number.isFinite(activatedAt) || consumedAt < activatedAt) return false;
  if (row.skill_output_factor === null || row.skill_output_factor === undefined) return false;
  try {
    return weight.milli === BigInt(Number(row.skill_output_quality)) * normalizeSyncRewardWeight(row.skill_output_factor).milli;
  } catch { return false; }
}

async function processQueuedContributions(client, { worldId, snapshot }) {
  const selected = await client.query(`SELECT contribution.*,project.status AS project_status,
      project.project_type,project.result AS project_result,
      (SELECT count(DISTINCT actual_contribution.agent_id)::int FROM world_project_contributions actual_contribution
        WHERE actual_contribution.world_id=contribution.world_id
          AND actual_contribution.project_id=project_contribution.project_id) AS project_contributor_count,
      project_contribution.id::text AS project_contribution_id,
      project_contribution.agent_id AS project_agent_id,
      project_contribution.contribution_type,project_contribution.effort_points::text AS source_weight,
      production.id::text AS production_id,production.agent_id AS production_agent_id,
      production.units::text AS production_units,
      skill_output.output_id::text AS skill_output_id,skill_output.producer_id AS skill_output_producer_id,
      skill_output.consumer_id AS skill_output_consumer_id,skill_output.quality AS skill_output_quality,
      skill_output.consumed_at AS skill_output_consumed_at,
      evidence.event_type AS source_event_type,evidence.actor_id AS source_actor_id,
      evidence.created_at AS source_event_created_at,evidence.data AS source_event_data,
      reward_policy.activated_at AS policy_activated_at,
      reward_policy.policy->'conversion'->>'rewardWeightPerConsumedSkillOutputQuality' AS skill_output_factor,
      reward_policy.policy->'conversion'->>'syncRawPerRewardWeightUnit' AS raw_per_weight
    FROM arc_sync_resident_reward_contributions contribution
    JOIN world_events evidence ON evidence.id=contribution.source_event_id
    JOIN arc_sync_resident_reward_policies reward_policy
      ON reward_policy.version=contribution.policy_version AND reward_policy.policy_hash=contribution.policy_hash
    LEFT JOIN world_project_contributions project_contribution
      ON contribution.source_type IN ('research_project','shared_project_cooperation')
      AND project_contribution.world_id=contribution.world_id
      AND project_contribution.id::text=contribution.source_entity_id
    LEFT JOIN world_projects project ON project.world_id=project_contribution.world_id
      AND project.id=project_contribution.project_id
    LEFT JOIN world_business_production production
      ON contribution.source_type='business_production' AND production.world_id=contribution.world_id
      AND production.id::text=contribution.source_entity_id
    LEFT JOIN world_skill_outputs skill_output
      ON contribution.source_type='skill_output' AND skill_output.world_id=contribution.world_id
      AND skill_output.output_id::text=contribution.source_entity_id
    WHERE contribution.world_id=$1 AND contribution.status='queued'
      AND (contribution.source_type IN ('research_project','business_production','skill_output')
        OR project.status IN ('completed','failed','abandoned'))
    ORDER BY contribution.created_at,contribution.id LIMIT 100 FOR UPDATE OF contribution SKIP LOCKED`, [worldId]);
  if (!selected.rowCount) return { accrued: 0, rejected: 0, remainingRaw: null };
  const capacity = await readRewardCapacity(client, worldId, snapshot);
  let remainingRaw = capacity.remainingRaw;
  let accrued = 0;
  let rejected = 0;
  // external1b: a queued contribution by an external resident (e.g. one recorded before 0031) is rejected,
  // never accrued: the 0031 entitlement guard would raise and abort the whole batch.
  const externalIds = new Set();
  const externalReady = await client.query(`SELECT to_regclass('public.world_external_residents') IS NOT NULL AS ready`);
  if (externalReady.rows?.[0]?.ready) {
    const flagged = await client.query(`SELECT agent_id::text AS agent_id FROM world_external_residents
      WHERE world_id=$1 AND agent_id = ANY($2::uuid[])`, [worldId, [...new Set(selected.rows.map((row) => row.agent_id))]]);
    for (const row of flagged.rows) externalIds.add(row.agent_id);
  }
  for (const row of selected.rows) {
    if (externalIds.has(String(row.agent_id))) {
      await markContribution(client, row, 'not_eligible', 'external_resident', snapshot.epochIndex);
      rejected += 1;
      continue;
    }
    const weight = normalizeSyncRewardWeight(row.reward_weight);
    const sourceMatches = row.source_actor_id === row.agent_id
      && ((row.source_type === 'research_project'
          && row.source_event_type === 'world.project_contribution'
          && row.project_contribution_id === row.source_entity_id
          && row.project_agent_id === row.agent_id
          && Number(row.source_weight) === Number(weight.decimal))
        || (row.source_type === 'shared_project_cooperation'
          && row.project_status === 'completed'
          && Number(row.project_contributor_count || 0) >= 2
          && row.project_contribution_id === row.source_entity_id
          && row.project_agent_id === row.agent_id
          && Number(row.source_weight) === Number(weight.decimal))
        || (row.source_type === 'business_production'
          && row.source_event_type === 'world.action_completed'
          && row.production_id === row.source_entity_id
          && row.production_agent_id === row.agent_id
          && row.source_event_data?.initiative?.productionId === row.production_id
          && BigInt(row.production_units || '0') === weight.milli / 1000n)
        || (row.source_type === 'skill_output' && skillOutputSourceMatches(row, weight)));
    if (row.source_type === 'shared_project_cooperation'
        && ['failed','abandoned'].includes(row.project_status)) {
      await markContribution(client, row, 'not_eligible', 'shared_project_not_completed', snapshot.epochIndex);
      rejected += 1;
      continue;
    }
    if (!sourceMatches) {
      await markContribution(client, row, 'not_eligible', 'source_evidence_mismatch', snapshot.epochIndex);
      rejected += 1;
      continue;
    }
    const amountRaw = syncRewardRawForWeight(weight.decimal, BigInt(row.raw_per_weight));
    if (amountRaw > remainingRaw) {
      await markContribution(client, row, 'cap_exceeded',
        capacity.availablePoolRaw < amountRaw ? 'operating_pool_capacity_exhausted' : 'epoch_allocation_exhausted',
        snapshot.epochIndex);
      rejected += 1;
      continue;
    }
    await client.query(`INSERT INTO arc_sync_resident_reward_entitlements(world_id,agent_id,contribution_id,
        epoch_index,policy_version,policy_hash,sync_amount_raw,status)
      VALUES($1,$2,$3,$4,$5,$6,$7::numeric,'pending')`, [worldId, row.agent_id, row.id,
      snapshot.epochIndex, row.policy_version, row.policy_hash, amountRaw.toString()]);
    await client.query(`UPDATE arc_sync_resident_reward_contributions SET status='accrued',epoch_index=$3,
        decision_reason=NULL,updated_at=now() WHERE world_id=$1 AND id=$2 AND status='queued'`,
    [worldId, row.id, snapshot.epochIndex]);
    remainingRaw -= amountRaw;
    accrued += 1;
  }
  return { accrued, rejected, remainingRaw: remainingRaw.toString() };
}

async function poolLedgerBalance(client, worldId, { lock = false } = {}) {
  const account = await client.query(`SELECT id FROM arc_sync_ledger_accounts
    WHERE world_id=$1 AND account_type='operating_pool' AND account_key='operating-pool'${lock ? ' FOR UPDATE' : ''}`,
  [worldId]);
  if (!account.rowCount) throw coded('SYNC_OPERATING_POOL_LEDGER_NOT_INITIALIZED');
  const result = await client.query(`SELECT (account.opening_balance_raw+COALESCE(sum(posting.amount_raw),0))::text AS balance_raw
    FROM arc_sync_ledger_accounts account LEFT JOIN arc_sync_ledger_postings posting
      ON posting.world_id=account.world_id AND posting.account_id=account.id
    WHERE account.world_id=$1 AND account.id=$2 GROUP BY account.id,account.opening_balance_raw`,
  [worldId, account.rows[0].id]);
  return { accountId: account.rows[0].id, balanceRaw: BigInt(result.rows[0].balance_raw) };
}

export async function commitEligibleSyncResidentRewardBatches(client, { worldId, worldMinute, snapshot,
  env = process.env }) {
  if (!snapshot) throw coded('SYNC_REWARD_CHAIN_SNAPSHOT_REQUIRED');
  if (!syncResidentRewardCommitEnabled(env)) throw coded('SYNC_RESIDENT_REWARD_COMMIT_DISABLED');
  // Migration 0027 enforces the same gate in the database: batches can only be inserted in a
  // transaction that explicitly opted in.
  await client.query(`SELECT set_config('mirrorterra.sync_resident_reward_commit','enabled',true)`);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sync-resident-rewards:${worldId}`]);
  const capacity = await readRewardCapacity(client, worldId, snapshot);
  if (capacity.poolAssetsRaw < capacity.poolReservedRaw) throw coded('SYNC_REWARD_POOL_CAPACITY_UNBACKED');
  // An agent who spent or received internal SYNC no longer holds exactly its gross entitlements;
  // paying those gross amounts on chain would break conservation, so such agents wait for a
  // future internal-balance conversion batch type.
  const transfersReady = await client.query(`SELECT to_regclass('public.arc_sync_internal_transfers') IS NOT NULL AS ready`);
  const internalMovers = new Set();
  if (transfersReady.rows[0]?.ready) {
    const movers = await client.query(`SELECT from_agent_id AS agent_id FROM arc_sync_internal_transfers WHERE world_id=$1
      UNION SELECT to_agent_id FROM arc_sync_internal_transfers WHERE world_id=$1`, [worldId]);
    for (const row of movers.rows) internalMovers.add(row.agent_id);
  }
  const groups = await client.query(`SELECT entitlement.agent_id,sum(entitlement.sync_amount_raw)::text AS amount_raw,
      min((policy.policy->'commit'->>'minimumPendingSyncRawPerAgent')::numeric)::text AS minimum_batch_raw
    FROM arc_sync_resident_reward_entitlements entitlement
    JOIN arc_sync_resident_reward_policies policy
      ON policy.version=entitlement.policy_version AND policy.policy_hash=entitlement.policy_hash
    WHERE entitlement.world_id=$1 AND entitlement.status='pending'
    GROUP BY entitlement.agent_id
    HAVING sum(entitlement.sync_amount_raw)>=min((policy.policy->'commit'->>'minimumPendingSyncRawPerAgent')::numeric)
    ORDER BY entitlement.agent_id`, [worldId]);
  const committed = [];
  for (const group of groups.rows) {
    if (internalMovers.has(group.agent_id)) continue;
    const wallet = await client.query(`SELECT address FROM arc_agent_wallets
      WHERE world_id=$1 AND agent_id=$2 AND chain_id=5042 AND status='active'`, [worldId, group.agent_id]);
    if (wallet.rowCount !== 1 || !/^0x[0-9a-fA-F]{40}$/.test(String(wallet.rows[0]?.address || ''))) {
      throw coded('SYNC_REWARD_AGENT_WALLET_NOT_READY');
    }
    const deployment = await client.query(`SELECT manifest_hash FROM arc_sync_tokenomics_deployments
      WHERE world_id=$1 AND chain_id=5042`, [worldId]);
    if (deployment.rows[0]?.manifest_hash !== TOKENOMICS_MANIFEST_HASH) throw coded('SYNC_TOKENOMICS_DEPLOYMENT_NOT_READY');
    const pool = await poolLedgerBalance(client, worldId, { lock: true });
    const entitlements = await client.query(`SELECT id,sync_amount_raw::text AS amount_raw
      FROM arc_sync_resident_reward_entitlements WHERE world_id=$1 AND agent_id=$2 AND status='pending'
      ORDER BY created_at,id FOR UPDATE`, [worldId, group.agent_id]);
    const amountRaw = entitlements.rows.reduce((sum, row) => sum + BigInt(row.amount_raw), 0n);
    if (amountRaw < BigInt(group.minimum_batch_raw)) continue;
    if (amountRaw > pool.balanceRaw) throw coded('SYNC_REWARD_POOL_LEDGER_CAPACITY_EXCEEDED');
    const batchId = randomUUID();
    const batchActionId = `sync-resident-reward-batch:${batchId}`;
    const payoutActionId = `sync-resident-reward-payout:${batchId}`;
    await client.query(`INSERT INTO arc_sync_resident_reward_batches(id,world_id,action_id,agent_id,
        recipient_address,amount_raw,status) VALUES($1,$2,$3,$4,$5,$6::numeric,'committed')`,
    [batchId, worldId, batchActionId, group.agent_id, wallet.rows[0].address, amountRaw.toString()]);
    await client.query(`INSERT INTO arc_sync_resident_reward_batch_items(world_id,batch_id,entitlement_id)
      SELECT $1,$2,id FROM arc_sync_resident_reward_entitlements
      WHERE world_id=$1 AND id=ANY($3::uuid[])`, [worldId, batchId, entitlements.rows.map((row) => row.id)]);
    await client.query(`UPDATE arc_sync_resident_reward_entitlements SET status='committed',batch_id=$3,committed_at=now()
      WHERE world_id=$1 AND id=ANY($2::uuid[]) AND status='pending'`,
    [worldId, entitlements.rows.map((row) => row.id), batchId]);
    await client.query(`INSERT INTO arc_sync_ledger_accounts(world_id,account_type,account_key,agent_id,opening_balance_raw)
      VALUES($1,'agent',$2,$3,0) ON CONFLICT(world_id,account_key) DO NOTHING`,
    [worldId, `agent:${group.agent_id}`, group.agent_id]);
    const agentAccount = await client.query(`SELECT id FROM arc_sync_ledger_accounts
      WHERE world_id=$1 AND account_type='agent' AND account_key=$2 AND agent_id=$3`,
    [worldId, `agent:${group.agent_id}`, group.agent_id]);
    if (agentAccount.rowCount !== 1) throw coded('SYNC_LEDGER_ACCOUNTS_MISSING');
    const ledger = await client.query(`INSERT INTO arc_sync_ledger_transactions(world_id,action_id,
        source_economic_action_id,transaction_type,world_minute,status,metadata)
      VALUES($1,$2,$3,'operating_pool_payout',$4,'draft',jsonb_build_object(
        'source','resident_reward_entitlements','policyVersion',$5::int,'policyHash',$6::text,
        'entitlementCount',$7::int)) RETURNING id`, [worldId, payoutActionId, batchActionId,
      worldMinute, SYNC_RESIDENT_REWARD_POLICY_VERSION, SYNC_RESIDENT_REWARD_POLICY_HASH, entitlements.rowCount]);
    await client.query(`INSERT INTO arc_sync_ledger_postings(world_id,transaction_id,account_id,amount_raw)
      VALUES($1,$2,$3,-($5::numeric)),($1,$2,$4,$5::numeric)`,
    [worldId, ledger.rows[0].id, pool.accountId, agentAccount.rows[0].id, amountRaw.toString()]);
    await client.query(`INSERT INTO arc_sync_payout_outbox(world_id,transaction_id,action_id,agent_id,
        recipient_address,amount_raw,status)
      VALUES($1,$2,$3,$4,$5,$6::numeric,'committed')`,
    [worldId, ledger.rows[0].id, payoutActionId, group.agent_id, wallet.rows[0].address, amountRaw.toString()]);
    await client.query(`UPDATE arc_sync_ledger_transactions SET status='committed',committed_at=now()
      WHERE world_id=$1 AND id=$2 AND status='draft'`, [worldId, ledger.rows[0].id]);
    committed.push({ batchId, agentId: group.agent_id, amountRaw: amountRaw.toString(),
      entitlementCount: entitlements.rowCount });
  }
  return committed;
}

export async function persistSyncRewardCapacitySnapshot(pool, { worldId, snapshot }) {
  await pool.query(`INSERT INTO arc_sync_reward_capacity_snapshots(world_id,block_number,epoch_index,epoch_start,
      economy_quota_raw,onchain_pool_balance_raw)
    VALUES($1,$2::numeric,$3::bigint,$4::bigint,$5::numeric,$6::numeric)
    ON CONFLICT(world_id,block_number) DO NOTHING`, [worldId, String(snapshot.blockNumber),
    String(snapshot.epochIndex), String(snapshot.epochStart), String(snapshot.economyQuotaRaw),
    String(snapshot.onchainPoolBalanceRaw)]);
}

// Pure: derives an accrual snapshot from the last chain-observed values. It never exceeds the
// saved quota or pool balance, and it refuses to cross into an epoch the chain was never read in.
export function deriveInternalCapacitySnapshot(saved, nowSeconds, epochDurationSeconds = SYNC_EPOCH_DURATION_SECONDS) {
  if (!saved) return null;
  const epochStart = BigInt(saved.epoch_start ?? saved.epochStart);
  const epochIndex = BigInt(saved.epoch_index ?? saved.epochIndex);
  const now = BigInt(Math.trunc(Number(nowSeconds)));
  const duration = BigInt(epochDurationSeconds);
  if (duration <= 0n || now < epochStart || now >= epochStart + duration) return null;
  return { source: 'internal', blockNumber: String(saved.block_number ?? saved.blockNumber),
    epochIndex: epochIndex.toString(), epochStart: epochStart.toString(),
    economyQuotaRaw: BigInt(saved.economy_quota_raw ?? saved.economyQuotaRaw).toString(),
    economyReleasedRaw: '0',
    onchainPoolBalanceRaw: BigInt(saved.onchain_pool_balance_raw ?? saved.onchainPoolBalanceRaw).toString() };
}

export async function readSyncRewardInternalSnapshot(pool, { worldId }) {
  const result = await pool.query(`SELECT block_number::text AS block_number,epoch_index::text AS epoch_index,
      epoch_start::text AS epoch_start,economy_quota_raw::text AS economy_quota_raw,
      onchain_pool_balance_raw::text AS onchain_pool_balance_raw,
      extract(epoch FROM now())::bigint::text AS now_seconds
    FROM arc_sync_reward_capacity_snapshots WHERE world_id=$1
    ORDER BY block_number DESC,id DESC LIMIT 1`, [worldId]);
  if (!result.rowCount) return null;
  return deriveInternalCapacitySnapshot(result.rows[0], result.rows[0].now_seconds);
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function readSyncResidentRewardDiagnostics(pool, { worldId }) {
  const [summary, residents, outbox, recentContributions] = await Promise.all([
    pool.query(`SELECT count(*) FILTER (WHERE contribution.status='accrued'
          AND contribution.created_at>now()-interval '24 hours')::int AS eligible_contributions_24h,
        COALESCE(sum(contribution.reward_weight) FILTER (WHERE contribution.status='accrued'
          AND contribution.created_at>now()-interval '24 hours'),0)::text AS reward_weight_24h,
        COALESCE(sum(entitlement.sync_amount_raw) FILTER (WHERE contribution.created_at>now()-interval '24 hours'),0)::text AS accrued_raw_24h,
        COALESCE(sum(entitlement.sync_amount_raw),0)::text AS accrued_raw,
        COALESCE(sum(entitlement.sync_amount_raw) FILTER (WHERE entitlement.status='pending'),0)::text AS pending_raw,
        COALESCE(sum(entitlement.sync_amount_raw) FILTER (WHERE entitlement.status='committed'),0)::text AS committed_raw,
        COALESCE(sum(entitlement.sync_amount_raw) FILTER (WHERE entitlement.status='paid'),0)::text AS paid_raw
      FROM arc_sync_resident_reward_contributions contribution
      LEFT JOIN arc_sync_resident_reward_entitlements entitlement
        ON entitlement.world_id=contribution.world_id AND entitlement.contribution_id=contribution.id
      WHERE contribution.world_id=$1`, [worldId]),
    pool.query(`SELECT member.agent_id AS "agentId",agent.name,
        COALESCE(sum(contribution.reward_weight) FILTER (WHERE contribution.status='accrued'),0)::text AS "rewardWeight",
        COALESCE(sum(entitlement.sync_amount_raw),0)::text AS "accruedRaw",
        COALESCE(sum(entitlement.sync_amount_raw) FILTER (WHERE entitlement.status='pending'),0)::text AS "pendingRaw",
        COALESCE(sum(entitlement.sync_amount_raw) FILTER (WHERE entitlement.status='committed'),0)::text AS "committedRaw",
        COALESCE(sum(entitlement.sync_amount_raw) FILTER (WHERE entitlement.status='paid'),0)::text AS "paidRaw"
      FROM world_members member JOIN agents agent ON agent.id=member.agent_id
      LEFT JOIN arc_sync_resident_reward_contributions contribution
        ON contribution.world_id=member.world_id AND contribution.agent_id=member.agent_id
      LEFT JOIN arc_sync_resident_reward_entitlements entitlement
        ON entitlement.world_id=contribution.world_id AND entitlement.contribution_id=contribution.id
      WHERE member.world_id=$1 GROUP BY member.agent_id,agent.name ORDER BY agent.name`, [worldId]),
    pool.query(`SELECT status,count(*)::int AS count,COALESCE(sum(amount_raw),0)::text AS amount_raw
      FROM arc_sync_payout_outbox WHERE world_id=$1 GROUP BY status ORDER BY status`, [worldId]),
    pool.query(`SELECT contribution.id AS "contributionId",contribution.agent_id AS "agentId",
        agent.name AS "agentName",contribution.source_type AS "sourceType",
        contribution.source_event_id::text AS "sourceEventId",contribution.source_entity_id AS "sourceEntityId",
        contribution.reward_weight::text AS "rewardWeight",contribution.policy_version AS "policyVersion",
        contribution.status AS "contributionStatus",contribution.created_at AS "createdAt",
        entitlement.id AS "entitlementId",entitlement.sync_amount_raw::text AS "syncAmountRaw",
        entitlement.status AS "entitlementStatus",entitlement.epoch_index AS "epochIndex",
        entitlement.batch_id AS "batchId"
      FROM arc_sync_resident_reward_contributions contribution
      JOIN agents agent ON agent.id=contribution.agent_id
      LEFT JOIN arc_sync_resident_reward_entitlements entitlement
        ON entitlement.world_id=contribution.world_id AND entitlement.contribution_id=contribution.id
      WHERE contribution.world_id=$1 ORDER BY contribution.created_at DESC,contribution.id DESC LIMIT 20`,
    [worldId])
  ]);
  const summaryRow = summary.rows[0] || {};
  const payoutOutboxCount = outbox.rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
  const payoutOutbox = Object.fromEntries(outbox.rows.map((row) => [row.status,
    { count: Number(row.count), amountRaw: row.amount_raw }]));
  const activePolicy = activeSyncResidentRewardPolicy();
  const internalEconomy = await readSyncInternalEconomySummary(pool, { worldId })
    .catch(() => ({ available: false, label: SYNC_INTERNAL_LABEL }));
  return { available: true, policyVersion: activePolicy.version,
    policyHash: activePolicy.hash, internalEconomy,
    commitMode: syncResidentRewardCommitEnabled() ? 'enabled' : 'deferred_internal',
    eligibleContributions24h: Number(summaryRow.eligible_contributions_24h || 0),
    rewardWeight24h: summaryRow.reward_weight_24h || '0.000', accruedRaw24h: summaryRow.accrued_raw_24h || '0',
    accruedSync24h: summaryRow.accrued_raw_24h || '0',
    accruedRaw: summaryRow.accrued_raw || '0',
    pendingRaw: summaryRow.pending_raw || '0', committedRaw: summaryRow.committed_raw || '0',
    totalPendingSyncRaw: summaryRow.pending_raw || '0',
    totalCommittedSyncRaw: summaryRow.committed_raw || '0',
    paidRaw: summaryRow.paid_raw || '0', paidSyncRaw: summaryRow.paid_raw || '0',
    payoutOutboxCount, payoutOutbox, residents: residents.rows,
    recentContributions: recentContributions.rows };
}

export async function readSyncResidentRewardBalances(pool, rpcClient, { worldId, agentId }) {
  const ledger = await pool.query(`SELECT
      COALESCE(sum(entitlement.sync_amount_raw),0)::text AS accrued_raw,
      COALESCE(sum(entitlement.sync_amount_raw) FILTER (WHERE entitlement.status='pending'),0)::text AS pending_raw,
      COALESCE(sum(entitlement.sync_amount_raw) FILTER (WHERE entitlement.status='committed'),0)::text AS committed_raw,
      COALESCE(sum(entitlement.sync_amount_raw) FILTER (WHERE entitlement.status='paid'),0)::text AS paid_raw,
      COALESCE(sum(contribution.reward_weight) FILTER (WHERE entitlement.epoch_index=epoch.epoch_index),0)::text AS latest_epoch_weight,
      COALESCE(sum(entitlement.sync_amount_raw) FILTER (WHERE entitlement.epoch_index=epoch.epoch_index),0)::text AS latest_epoch_entitlement_raw,
      max(entitlement.epoch_index)::text AS latest_epoch_index
    FROM arc_sync_resident_reward_entitlements entitlement
    JOIN arc_sync_resident_reward_contributions contribution
      ON contribution.world_id=entitlement.world_id AND contribution.id=entitlement.contribution_id
    LEFT JOIN (SELECT max(epoch_index) AS epoch_index FROM arc_sync_resident_reward_entitlements
      WHERE world_id=$1) epoch ON true
    WHERE entitlement.world_id=$1 AND entitlement.agent_id=$2`, [worldId, agentId]);
  const row = ledger.rows[0] || {};
  let onChainRaw = null;
  let observedBlock = null;
  let symbol = 'SYNC';
  if (rpcClient) {
    try {
      const deployment = await pool.query(`SELECT token_address FROM arc_sync_tokenomics_deployments
        WHERE world_id=$1 AND chain_id=5042 AND manifest_hash=$2`, [worldId, TOKENOMICS_MANIFEST_HASH]);
      const wallet = await pool.query(`SELECT address FROM arc_agent_wallets
        WHERE world_id=$1 AND agent_id=$2 AND chain_id=5042 AND status='active'`, [worldId, agentId]);
      if (deployment.rowCount === 1 && wallet.rowCount === 1) {
        const block = BigInt(await rpcClient.getBlockNumber());
        const data = TOKEN_INTERFACE.encodeFunctionData('balanceOf', [wallet.rows[0].address]);
        const encoded = await rpcClient.call({ to: deployment.rows[0].token_address, data }, blockTag(block));
        onChainRaw = BigInt(TOKEN_INTERFACE.decodeFunctionResult('balanceOf', encoded)[0]).toString();
        observedBlock = block.toString();
      }
    } catch {
      // A chain-read failure remains visibly unavailable; internal balances stay separate.
    }
  }
  const internal = await readSyncInternalAccount(pool, { worldId, agentId }).catch(() => null);
  return { token: symbol, decimals: 6, policyVersion: activeSyncResidentRewardPolicy().version,
    ...(internal ? { internal } : {}),
    accruedRaw: row.accrued_raw || '0', pendingRaw: row.pending_raw || '0',
    committedRaw: row.committed_raw || '0', paidRaw: row.paid_raw || '0',
    latestRewardEpoch: row.latest_epoch_index || null, latestRewardEpochWeight: row.latest_epoch_weight || '0.000',
    latestRewardEpochSyncEntitlementRaw: row.latest_epoch_entitlement_raw || '0',
    onChainRaw, observedBlock, onChainAuthority: 'Arc ERC-20 balanceOf' };
}

async function internalEconomyReady(pool) {
  const result = await pool.query(`SELECT to_regclass('public.arc_sync_internal_balances') IS NOT NULL AS ready`);
  return result.rows[0]?.ready === true;
}

// Read-only internal SYNC view for one resident: entitlement-backed balance plus internal
// transfers. Labelled "SYNC (internal)"; it makes no on-chain claim.
export async function readSyncInternalAccount(pool, { worldId, agentId, limit = 10 }) {
  if (!await internalEconomyReady(pool)) return null;
  const [balance, transfers, rewards] = await Promise.all([
    pool.query(`SELECT earned_raw::text AS "earnedRaw",received_raw::text AS "receivedRaw",
        sent_raw::text AS "sentRaw",spendable_raw::text AS "spendableRaw"
      FROM arc_sync_internal_balances WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]),
    pool.query(`SELECT transfer.id,transfer.kind,transfer.amount_raw::text AS "amountRaw",
        CASE WHEN transfer.from_agent_id=$2 THEN 'sent' ELSE 'received' END AS direction,
        CASE WHEN transfer.from_agent_id=$2 THEN transfer.to_agent_id ELSE transfer.from_agent_id END AS "counterpartyAgentId",
        counterparty.name AS "counterpartyName",transfer.source_ref AS "sourceRef",
        transfer.world_minute AS "worldMinute",transfer.created_at AS "createdAt"
      FROM arc_sync_internal_transfers transfer
      JOIN agents counterparty ON counterparty.id=CASE WHEN transfer.from_agent_id=$2
        THEN transfer.to_agent_id ELSE transfer.from_agent_id END
      WHERE transfer.world_id=$1 AND (transfer.from_agent_id=$2 OR transfer.to_agent_id=$2)
      ORDER BY transfer.created_at DESC,transfer.id DESC LIMIT $3`, [worldId, agentId, limit]),
    // Rewards are entitlements against the operating pool, shown in-world as paid by the Central Bank.
    pool.query(`SELECT entitlement.id,entitlement.sync_amount_raw::text AS "amountRaw",
        contribution.source_type AS "sourceType",entitlement.status,entitlement.created_at AS "createdAt"
      FROM arc_sync_resident_reward_entitlements entitlement
      JOIN arc_sync_resident_reward_contributions contribution
        ON contribution.world_id=entitlement.world_id AND contribution.id=entitlement.contribution_id
      WHERE entitlement.world_id=$1 AND entitlement.agent_id=$2
      ORDER BY entitlement.created_at DESC,entitlement.id DESC LIMIT $3`, [worldId, agentId, limit])
  ]);
  const row = balance.rows[0] || {};
  return { label: SYNC_INTERNAL_LABEL, decimals: 6, onChain: false,
    earnedRaw: row.earnedRaw || '0', receivedRaw: row.receivedRaw || '0', sentRaw: row.sentRaw || '0',
    spendableRaw: row.spendableRaw || '0', recentTransactions: transfers.rows,
    recentRewards: (rewards?.rows || []).map((reward) => ({ ...reward, payer: SYNC_CENTRAL_BANK_NAME,
      label: SYNC_CENTRAL_BANK_PAYOUT_LABEL })) };
}

// Spendable internal SYNC per resident, for economic choice. Empty when 0027 is not applied.
export async function readSyncInternalSpendableMap(client, { worldId }) {
  if (!await internalEconomyReady(client)) return {};
  const result = await client.query(`SELECT agent_id,spendable_raw::text AS spendable_raw
    FROM arc_sync_internal_balances WHERE world_id=$1`, [worldId]);
  return Object.fromEntries(result.rows.map((row) => [row.agent_id, row.spendable_raw]));
}

export async function readSyncInternalEconomySummary(pool, { worldId, limit = 20 }) {
  if (!await internalEconomyReady(pool)) return { available: false, label: SYNC_INTERNAL_LABEL };
  const [totals, transfers, orders] = await Promise.all([
    pool.query(`SELECT COALESCE(sum(earned_raw),0)::text AS "earnedRaw",
        COALESCE(sum(spendable_raw),0)::text AS "spendableRaw",
        (SELECT COALESCE(sum(amount_raw),0)::text FROM arc_sync_internal_transfers WHERE world_id=$1) AS "transferredRaw",
        (SELECT count(*)::int FROM arc_sync_internal_transfers WHERE world_id=$1) AS "transferCount"
      FROM arc_sync_internal_balances WHERE world_id=$1`, [worldId]),
    pool.query(`SELECT transfer.id,transfer.kind,transfer.amount_raw::text AS "amountRaw",
        transfer.from_agent_id AS "fromAgentId",sender.name AS "fromName",
        transfer.to_agent_id AS "toAgentId",receiver.name AS "toName",transfer.source_ref AS "sourceRef",
        transfer.world_minute AS "worldMinute",transfer.created_at AS "createdAt"
      FROM arc_sync_internal_transfers transfer
      JOIN agents sender ON sender.id=transfer.from_agent_id JOIN agents receiver ON receiver.id=transfer.to_agent_id
      WHERE transfer.world_id=$1 ORDER BY transfer.created_at DESC,transfer.id DESC LIMIT $2`, [worldId, limit]),
    pool.query(`SELECT count(*)::int AS count,COALESCE(sum(amount_raw),0)::text AS "amountRaw"
      FROM world_sync_internal_orders WHERE world_id=$1`, [worldId])
  ]);
  return { available: true, label: SYNC_INTERNAL_LABEL, decimals: 6, onChain: false,
    ...totals.rows[0], orders: orders.rows[0], recentTransactions: transfers.rows };
}

export class SyncResidentRewardAccrualWorker {
  #pool;
  #rpc;
  #isOwner;
  #onError;
  #lockClient = null;
  #timer = null;
  #active = false;
  #worldId = null;
  #env;
  #lastPersistedSnapshot = null;
  #status = { available: true, running: false, mode: 'disabled', lastProcessedAt: null,
    lastResult: null, lastError: null, currentEpoch: null, snapshotBlock: null,
    snapshotSource: null, commitMode: 'deferred_internal', syncEconomy: 'on' };

  constructor({ pool, rpcClient, isOwner = () => true, onError = () => {}, intervalMs = 5_000, env = process.env }) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
      throw new TypeError('PostgreSQL pool is required for SYNC resident rewards.');
    }
    this.#pool = pool;
    this.#rpc = rpcClient;
    this.#isOwner = isOwner;
    this.#onError = onError;
    this.intervalMs = Math.max(1_000, Number(intervalMs) || 5_000);
    this.#env = env;
    this.#status.commitMode = syncResidentRewardCommitEnabled(env) ? 'enabled' : 'deferred_internal';
    this.#status.syncEconomy = syncEconomyEnabled(env) ? 'on' : 'off';
  }

  async #persistSnapshot(snapshot) {
    const previous = this.#lastPersistedSnapshot;
    if (previous && previous.epochIndex === snapshot.epochIndex && previous.economyQuotaRaw === snapshot.economyQuotaRaw
        && previous.onchainPoolBalanceRaw === snapshot.onchainPoolBalanceRaw
        && Date.now() - previous.at < CAPACITY_SNAPSHOT_PERSIST_MS) return;
    await persistSyncRewardCapacitySnapshot(this.#pool, { worldId: this.#worldId, snapshot });
    this.#lastPersistedSnapshot = { ...snapshot, at: Date.now() };
  }

  getStatus() { return structuredClone(this.#status); }

  async start({ worldId }) {
    if (this.#status.running) return this.getStatus();
    this.#worldId = worldId;
    const exists = await this.#pool.query(`SELECT to_regclass('public.arc_sync_resident_reward_contributions') IS NOT NULL AS ready`);
    if (!exists.rows[0]?.ready) {
      this.#status = { ...this.#status, mode: 'disabled', reason: 'sync_resident_reward_migration_required' };
      return this.getStatus();
    }
    if (!this.#isOwner()) {
      this.#status = { ...this.#status, mode: 'disabled', reason: 'world_writer_not_owned' };
      return this.getStatus();
    }
    this.#lockClient = await this.#pool.connect();
    const lock = await this.#lockClient.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS owned',
      [`${SYNC_RESIDENT_REWARD_WORKER_LOCK}:${worldId}`]);
    if (!lock.rows[0]?.owned) {
      this.#lockClient.release();
      this.#lockClient = null;
      this.#status = { ...this.#status, mode: 'disabled', reason: 'another_sync_reward_worker_owns_lock' };
      return this.getStatus();
    }
    this.#status = { ...this.#status, running: true, mode: 'internal_reward_accounting', reason: null };
    this.#timer = setInterval(() => this.#process().catch((error) => this.#reportError(error)), this.intervalMs);
    this.#timer.unref?.();
    await this.#process();
    return this.getStatus();
  }

  async stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    while (this.#active) await new Promise((resolve) => setTimeout(resolve, 10));
    this.#status.running = false;
    if (this.#lockClient) {
      await this.#lockClient.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',
        [`${SYNC_RESIDENT_REWARD_WORKER_LOCK}:${this.#worldId}`]).catch(() => {});
      this.#lockClient.release();
      this.#lockClient = null;
    }
  }

  async #process() {
    if (this.#active || !this.#status.running || !this.#isOwner()) return;
    this.#active = true;
    let snapshot = null;
    let snapshotError = null;
    try {
      const ready = await this.#pool.query(`SELECT EXISTS (
        SELECT 1 FROM arc_sync_resident_reward_contributions contribution
        LEFT JOIN world_project_contributions project_contribution
          ON contribution.source_type='shared_project_cooperation'
          AND project_contribution.world_id=contribution.world_id
          AND project_contribution.id::text=contribution.source_entity_id
        LEFT JOIN world_projects project ON project.world_id=project_contribution.world_id
          AND project.id=project_contribution.project_id
        WHERE contribution.world_id=$1 AND contribution.status='queued'
          AND (contribution.source_type IN ('research_project','business_production','skill_output')
            OR project.status IN ('completed','failed','abandoned'))
      ) AS has_ready_source,
      EXISTS(SELECT 1 FROM arc_sync_resident_reward_entitlements entitlement
        JOIN arc_sync_resident_reward_policies policy
          ON policy.version=entitlement.policy_version AND policy.policy_hash=entitlement.policy_hash
        WHERE entitlement.world_id=$1 AND entitlement.status='pending'
        GROUP BY entitlement.agent_id
        HAVING sum(entitlement.sync_amount_raw)>=min((policy.policy->'commit'->>'minimumPendingSyncRawPerAgent')::numeric))
        AS has_commit_ready`, [this.#worldId]);
      const commitEnabled = syncResidentRewardCommitEnabled(this.#env);
      const economyEnabled = syncEconomyEnabled(this.#env);
      let snapshotSource = null;
      if (ready.rows[0]?.has_ready_source || (commitEnabled && ready.rows[0]?.has_commit_ready)) {
        try {
          snapshot = await readSyncResidentRewardChainSnapshot(this.#pool, this.#rpc, { worldId: this.#worldId });
          snapshotSource = 'chain';
        } catch (error) { snapshotError = error; }
        if (snapshot && economyEnabled) await this.#persistSnapshot(snapshot).catch(() => {});
        if (!snapshot && economyEnabled) {
          snapshot = await readSyncRewardInternalSnapshot(this.#pool, { worldId: this.#worldId }).catch(() => null);
          if (snapshot) snapshotSource = 'internal';
        }
      }
      const result = await inTransaction(this.#pool, async (client) => {
        // tickfix1: world_members first (agent_id order, FOR KEY SHARE), then the advisory lock. The
        // tick holds the members and then wants this advisory lock (work-order batches); taking the
        // advisory lock first and the members later (entitlement FK checks) deadlocked with it.
        await lockMembersFirst(client, this.#worldId);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`sync-resident-rewards:${this.#worldId}`]);
        let accrual = { accrued: 0, rejected: 0, remainingRaw: null };
        if (snapshot) accrual = await processQueuedContributions(client, { worldId: this.#worldId, snapshot });
        const clock = await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [this.#worldId]);
        // Commit only with the explicit gate and a live chain snapshot; otherwise entitlements stay
        // pending (internal SYNC) and no outbox rows or pool debits are written.
        const committed = snapshot && commitEnabled && snapshotSource === 'chain'
          ? await commitEligibleSyncResidentRewardBatches(client, { worldId: this.#worldId,
            worldMinute: Number(clock.rows[0]?.world_minutes) || 0, snapshot, env: this.#env }) : [];
        return { ...accrual, committedBatches: committed.length, committedAmountRaw:
          committed.reduce((sum, batch) => sum + BigInt(batch.amountRaw), 0n).toString() };
      });
      this.#status.lastProcessedAt = new Date().toISOString();
      this.#status.currentEpoch = snapshot?.epochIndex || this.#status.currentEpoch;
      this.#status.snapshotBlock = snapshot?.blockNumber || this.#status.snapshotBlock;
      this.#status.snapshotSource = snapshotSource || this.#status.snapshotSource;
      this.#status.commitMode = commitEnabled ? 'enabled' : 'deferred_internal';
      this.#status.syncEconomy = economyEnabled ? 'on' : 'off';
      this.#status.lastResult = result;
      if (snapshotError) this.#status.lastError = String(snapshotError.code || 'SYNC_REWARD_CHAIN_SNAPSHOT_FAILED')
        .replace(/[^A-Z0-9_]/gi, '').slice(0, 80);
      else this.#status.lastError = null;
    } catch (error) { this.#reportError(error); }
    finally { this.#active = false; }
  }

  #reportError(error) {
    const code = String(error?.code || 'SYNC_RESIDENT_REWARD_ERROR').replace(/[^A-Z0-9_]/gi, '').slice(0, 80);
    this.#status.lastError = code;
    this.#status.lastProcessedAt = new Date().toISOString();
    try { this.#onError({ code, worldId: this.#worldId }); } catch {}
  }
}

export function startSyncResidentRewardAccrualWorker(options) {
  const worker = new SyncResidentRewardAccrualWorker(options);
  return worker;
}
