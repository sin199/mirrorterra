import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Interface } from 'ethers';
import { arcNetworkConfig } from '../src/arc/config.js';
import { TOKENOMICS_MANIFEST_HASH } from '../src/arc/sync-tokenomics.js';
import { readValidatedSyncPayout } from '../src/arc/sync-payout-authorization.js';
import {
  SYNC_RESIDENT_REWARD_POLICY,
  SYNC_RESIDENT_REWARD_POLICY_HASH,
  SYNC_RESIDENT_REWARD_POLICY_VERSION,
  computeSyncResidentRewardCapacity,
  enqueueSyncResidentRewardContribution,
  normalizeSyncRewardWeight,
  readSyncResidentRewardChainSnapshot,
  syncRewardRawForWeight
} from '../src/arc/sync-resident-rewards.js';

const policyInterface = new Interface([
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
const tokenInterface = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenomicsManifestHash() view returns (bytes32)'
]);
const tokenAddress = '0x1111111111111111111111111111111111111111';
const poolAddress = '0x2222222222222222222222222222222222222222';
const policyAddress = '0x3333333333333333333333333333333333333333';
const reserveAddress = '0x4444444444444444444444444444444444444444';

function chainSnapshotRpc({ timestamp, storedEpochIndex = 0n, reserveBalance = 990_000_000_000_000n } = {}) {
  const calls = [];
  const deploymentTimestamp = 1_700_000_000n;
  const epochDuration = 30n * 24n * 60n * 60n;
  const policyValues = {
    TOKENOMICS_MANIFEST_HASH,
    token: tokenAddress,
    epochIndex: storedEpochIndex,
    epochStart: deploymentTimestamp + storedEpochIndex * epochDuration,
    economyQuota: 6_930_000_000_000n,
    economyReleased: 0n,
    deploymentTimestamp,
    EPOCH_DURATION: epochDuration,
    MAX_EPOCH_RELEASE_RAW: 10_000_000_000_000n,
    reserve: reserveAddress
  };
  const tokenValues = { tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH };
  return {
    calls,
    client: {
      async getChainId() { return 5042; },
      async getBlockNumber() { return '0x64'; },
      async getBlock() {
        return { timestamp: '0x' + BigInt(timestamp ?? deploymentTimestamp + 100n).toString(16) };
      },
      async call(transaction, tag) {
        calls.push({ to: transaction.to, tag });
        if (transaction.to === policyAddress) {
          const method = policyInterface.parseTransaction({ data: transaction.data }).name;
          return policyInterface.encodeFunctionResult(method, [policyValues[method]]);
        }
        const method = tokenInterface.parseTransaction({ data: transaction.data }).name;
        if (method === 'balanceOf') {
          const parsed = tokenInterface.parseTransaction({ data: transaction.data });
          return tokenInterface.encodeFunctionResult(method,
            [parsed.args[0].toLowerCase() === reserveAddress.toLowerCase()
              ? reserveBalance : 10_000_000_000_000n]);
        }
        return tokenInterface.encodeFunctionResult(method, [tokenValues[method]]);
      }
    },
    deploymentTimestamp,
    epochDuration
  };
}

test('v1 conversion is exact, deterministic, and policy hash matches migration', async () => {
  assert.equal(SYNC_RESIDENT_REWARD_POLICY_VERSION, 1);
  assert.equal(SYNC_RESIDENT_REWARD_POLICY.commit.minimumPendingSyncRawPerAgent, '1000000');
  assert.equal(normalizeSyncRewardWeight('12.345').milli, 12_345n);
  assert.equal(syncRewardRawForWeight('1'), 100_000n);
  assert.equal(syncRewardRawForWeight('0.125'), 12_500n);
  assert.equal(syncRewardRawForWeight('2','50000'), 100_000n);
  assert.throws(() => normalizeSyncRewardWeight('0'));
  assert.throws(() => normalizeSyncRewardWeight('1.0001'));
  const migration = await readFile(new URL('../migrations/0018_sync_resident_rewards.sql', import.meta.url), 'utf8');
  assert.ok(migration.includes('VALUES (1,' + "'" + SYNC_RESIDENT_REWARD_POLICY_HASH + "'"));
  const entitlementInsertCheck = migration.match(/IF TG_OP='INSERT' THEN([\s\S]*?)END IF;/)?.[1] || '';
  assert.match(entitlementInsertCheck, /contribution\.status IS DISTINCT FROM 'queued'/);
  assert.doesNotMatch(entitlementInsertCheck, /contribution\.epoch_index IS DISTINCT FROM NEW\.epoch_index/);
  assert.match(migration, /count\(DISTINCT actual_contribution\.agent_id\)[\s\S]*?\)>=2/);
});

test('capacity is the lesser of unspent epoch economy allocation and backed pool capacity', () => {
  const result = computeSyncResidentRewardCapacity({
    economyQuotaRaw: '6930000000000',
    epochResidentEntitlementsRaw: '1000000',
    epochStormEntitlementsRaw: '500000',
    onchainPoolBalanceRaw: '9000000',
    ledgerPoolBalanceRaw: '8000000',
    pendingResidentRaw: '1200000',
    outstandingStormRaw: '300000'
  });
  assert.equal(result.quotaRemainingRaw, 6_929_998_500_000n);
  assert.equal(result.poolAssetsRaw, 8_000_000n);
  assert.equal(result.poolReservedRaw, 1_500_000n);
  assert.equal(result.availablePoolRaw, 6_500_000n);
  assert.equal(result.remainingRaw, 6_500_000n);

  const exhausted = computeSyncResidentRewardCapacity({
    economyQuotaRaw: '100', epochResidentEntitlementsRaw: '100', epochStormEntitlementsRaw: '0',
    onchainPoolBalanceRaw: '1000', ledgerPoolBalanceRaw: '1000', pendingResidentRaw: '0', outstandingStormRaw: '0'
  });
  assert.equal(exhausted.remainingRaw, 0n);

  const drifted = computeSyncResidentRewardCapacity({
    economyQuotaRaw: '1000', epochResidentEntitlementsRaw: '0', epochStormEntitlementsRaw: '0',
    onchainPoolBalanceRaw: '1000', ledgerPoolBalanceRaw: '2000', committedPayoutRaw: '500',
    pendingResidentRaw: '100', outstandingStormRaw: '100'
  });
  assert.equal(drifted.poolAssetsRaw, 500n);
  assert.equal(drifted.poolReservedRaw, 200n);
  assert.equal(drifted.remainingRaw, 300n);
});

test('reward enqueue is idempotent and excludes unapproved source types before database access', async () => {
  let calls = 0;
  let insertCount = 0;
  await assert.rejects(enqueueSyncResidentRewardContribution({ query() { calls += 1; } }, {
    worldId: 'world', agentId: 'agent', sourceType: 'trade', sourceEventId: 1,
    sourceEntityId: 'trade-1', rewardWeight: '1'
  }), { code: 'SYNC_REWARD_SOURCE_TYPE_INVALID' });
  assert.equal(calls, 0);

  const client = { async query(sql, values) {
    calls += 1;
    if (sql.startsWith('INSERT')) {
      insertCount += 1;
      return insertCount === 1
        ? { rowCount: 1, rows: [{ id: 'contribution-1', status: 'queued' }] }
        : { rowCount: 0, rows: [] };
    }
    assert.deepEqual(values.slice(1), ['123', 'research_project', 'source-1']);
    return { rowCount: 1, rows: [{ id: 'contribution-1', agent_id: 'agent',
      source_type: 'research_project', source_event_id: '123', source_entity_id: 'source-1',
      reward_weight: '2.500', status: 'queued' }] };
  } };
  const first = await enqueueSyncResidentRewardContribution(client, {
    worldId: 'world', agentId: 'agent', sourceType: 'research_project', sourceEventId: 123,
    sourceEntityId: 'source-1', rewardWeight: '2.5'
  });
  assert.equal(first.created, true);
  assert.equal(first.contributionId, 'contribution-1');
  const duplicate = await enqueueSyncResidentRewardContribution(client, {
    worldId: 'world', agentId: 'agent', sourceType: 'research_project', sourceEventId: 123,
    sourceEntityId: 'source-1', rewardWeight: '2.5'
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.contributionId, 'contribution-1');
});

test('chain snapshot uses pinned read calls and derives a stale stored epoch without writing', async () => {
  const deployment = { rows: [{ token_address: tokenAddress, operating_pool_address: poolAddress,
    genesis_policy_address: policyAddress, manifest_hash: TOKENOMICS_MANIFEST_HASH }], rowCount: 1 };
  const pool = { async query(sql) {
    assert.match(sql, /SELECT token_address,operating_pool_address,genesis_policy_address/);
    return deployment;
  } };
  const stale = chainSnapshotRpc({ timestamp: 1_700_000_000n + 2n * 2_592_000n + 50n });
  const snapshot = await readSyncResidentRewardChainSnapshot(pool, stale.client, { worldId: 'world' });
  assert.equal(snapshot.epochIndex, '2');
  assert.equal(snapshot.epochStart, (stale.deploymentTimestamp + 2n * stale.epochDuration).toString());
  assert.equal(snapshot.economyQuotaRaw, '6930000000000');
  assert.equal(snapshot.economyReleasedRaw, '0');
  assert.ok(stale.calls.length > 0);
  assert.ok(stale.calls.every((call) => call.tag === '0x64'));
});

test('production gate defaults to zero Mainnet writes and no committed payout broadcasts', () => {
  const config = arcNetworkConfig({
    MAINNET_WRITE_GATE: 'false',
    SYNC_COMMITTED_PAYOUT_WRITE_GATE: 'false'
  });
  assert.equal(config.writesEnabled, false);
  assert.equal(config.syncCommittedPayoutWritesEnabled, false);
});

test('committed resident reward payout requires exact source, Agent, threshold, and double-entry evidence', async () => {
  const now = new Date('2026-10-18T00:00:00.000Z');
  const selected = { id: 'outbox', world_id: 'world', agent_id: 'agent', status: 'committed',
    transaction_id: 'ledger', transactionStatus: 'committed', transactionActionId: 'payout-action',
    transactionId: 'ledger', sourceEconomicActionId: 'sync-resident-reward-batch:batch-id',
    action_id: 'payout-action', amount_raw: '1000000', recipient_address: tokenAddress,
    token_address: tokenAddress, manifest_hash: TOKENOMICS_MANIFEST_HASH };
  const item = {
    batch_id: 'batch-id', batch_agent_id: 'agent', batch_amount_raw: '1000000',
    batch_recipient: tokenAddress, batch_status: 'committed', entitlement_id: 'entitlement-id',
    entitlement_agent_id: 'agent', contribution_id: 'contribution-id', epoch_index: 1,
    entitlement_policy_version: 1, entitlement_policy_hash: 'a'.repeat(64),
    entitlement_amount_raw: '1000000', entitlement_status: 'committed',
    entitlement_batch_id: 'batch-id', contribution_agent_id: 'agent',
    source_type: 'research_project', source_event_id: '200', source_entity_id: '77',
    reward_weight: '10.000', contribution_epoch_index: 1, policy_version: 1,
    policy_hash: 'a'.repeat(64), contribution_status: 'accrued',
    activated_at: new Date('2026-10-01T00:00:00.000Z'), raw_per_weight: '100000',
    minimum_batch_raw: '1000000', evidence_world_id: 'world', evidence_actor_id: 'agent',
    evidence_event_type: 'world.project_contribution', evidence_created_at: now,
    evidence_action_id: 'project-action',
    evidence_data: { projectId: 'project-id', effortPoints: 10 },
    project_contribution_id: '77', project_agent_id: 'agent', contribution_type: 'work',
    project_effort: '10.000', project_contribution_created_at: now, project_action_id: 'project-action',
    project_id: 'project-id', project_status: 'active', project_type: 'RESEARCH',
    project_result: {}, production_id: null, production_agent_id: null,
    production_business_id: null, production_service_id: null, production_units: null,
    production_created_at: null
  };
  const makePool = ({ invalidSource = false, itemOverrides = {} } = {}) => ({
    async query(sql) {
      if (sql.includes('FROM arc_sync_payout_outbox outbox JOIN arc_sync_ledger_transactions')) {
        return { rows: [selected], rowCount: 1 };
      }
      if (sql.includes('FROM world_sync_work_order_batches batch')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM arc_sync_resident_reward_batches batch')) return {
        rows: [{ ...item, ...itemOverrides, ...(invalidSource ? { source_type: 'trade' } : {}) }], rowCount: 1
      };
      if (sql.includes('FROM arc_sync_ledger_postings posting')) return { rows: [
        { accountType: 'operating_pool', amount: '-1000000' },
        { accountType: 'agent', agentId: 'agent', amount: '1000000' }
      ], rowCount: 2 };
      if (sql.includes('FROM arc_agent_wallets')) return { rows: [{ address: tokenAddress }], rowCount: 1 };
      throw new Error('unexpected payout authorization query');
    }
  });
  const authorized = await readValidatedSyncPayout(makePool(), { worldId: 'world', outboxId: 'outbox' });
  assert.equal(authorized.amount_raw, '1000000');
  await assert.rejects(readValidatedSyncPayout(makePool({ invalidSource: true }),
    { worldId: 'world', outboxId: 'outbox' }), { code: 'SYNC_PAYOUT_RESIDENT_REWARD_SOURCE_INVALID' });
  await assert.rejects(readValidatedSyncPayout(makePool({ itemOverrides: { evidence_action_id: 'different-action' } }),
    { worldId: 'world', outboxId: 'outbox' }), { code: 'SYNC_PAYOUT_RESIDENT_REWARD_SOURCE_INVALID' });
  const sharedBase = { source_type: 'shared_project_cooperation', project_status: 'completed',
    project_type: 'ORGANIZATION', contribution_type: 'work' };
  await assert.rejects(readValidatedSyncPayout(makePool({ itemOverrides: { ...sharedBase,
    project_contributor_count: 1 } }), { worldId: 'world', outboxId: 'outbox' }),
  { code: 'SYNC_PAYOUT_RESIDENT_REWARD_SOURCE_INVALID' });
  const shared = await readValidatedSyncPayout(makePool({ itemOverrides: { ...sharedBase,
    project_contributor_count: 2 } }), { worldId: 'world', outboxId: 'outbox' });
  assert.equal(shared.amount_raw, '1000000');
});

test('migration records no history backfill and keeps the fixed storm cleanup path', async () => {
  const migration = await readFile(new URL('../migrations/0018_sync_resident_rewards.sql', import.meta.url), 'utf8');
  assert.match(migration, /BEFORE INSERT ON arc_sync_resident_reward_contributions/);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+arc_sync_resident_reward_contributions[\s\S]{0,200}SELECT/i);
  assert.match(migration, /storm_debris_cleared/);
  assert.match(migration, /world_sync_work_order_batch_items/);
  assert.match(migration, /arc_sync_resident_reward_batch_items/);
});
