import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TOKENOMICS_MANIFEST_HASH } from '../src/arc/sync-tokenomics.js';
import { readValidatedSyncPayout } from '../src/arc/sync-payout-authorization.js';
import {
  SYNC_RESIDENT_REWARD_POLICY_HASH, SYNC_RESIDENT_REWARD_POLICY_V2, SYNC_RESIDENT_REWARD_POLICY_V2_HASH,
  SYNC_RESIDENT_REWARD_POLICY_VERSION, SyncResidentRewardAccrualWorker, activeSyncResidentRewardPolicy,
  commitEligibleSyncResidentRewardBatches,
  computeSyncInternalSpendable, deriveInternalCapacitySnapshot, enqueueSyncResidentRewardContribution,
  skillOutputRewardWeight, syncEconomyEnabled, syncResidentRewardCommitEnabled, syncRewardRawForWeight
} from '../src/arc/sync-resident-rewards.js';
import { practiceLibrarySkill } from '../src/world-skill-library.js';
import { buildBusinessCandidates, buildSyncInternalBusinessCandidates, completeWorldBusinessShift,
  purchaseWorldBusinessService, quoteSyncInternalServicePrice, syncInternalRestockTarget } from '../src/world-businesses.js';
import { ECONOMIC_FALLBACK_ACTIONS, chooseEconomicFallback, economicFallbackEnabled }
  from '../src/agent-runtime/open-cognition/selection.js';

const WORLD = '11111111-1111-4111-8111-111111111111';
const PRODUCER = '22222222-2222-4222-8222-222222222222';
const CONSUMER = '33333333-3333-4333-8333-333333333333';
const wallet = '0x1111111111111111111111111111111111111111';

test('policy v2 adds skill_output, keeps v1 untouched, and its hash is the 0027 literal', async () => {
  assert.equal(SYNC_RESIDENT_REWARD_POLICY_VERSION, 1);
  const m18 = await readFile(new URL('../migrations/0018_sync_resident_rewards.sql', import.meta.url), 'utf8');
  assert.ok(m18.includes(`VALUES (1,'${SYNC_RESIDENT_REWARD_POLICY_HASH}'`));
  const m27 = await readFile(new URL('../migrations/0027_sync_internal_economy.sql', import.meta.url), 'utf8');
  assert.ok(m27.includes(`VALUES (2,'${SYNC_RESIDENT_REWARD_POLICY_V2_HASH}'`));
  assert.ok(m27.includes(JSON.stringify(SYNC_RESIDENT_REWARD_POLICY_V2)), 'migration stores the exact v2 policy');
  assert.equal(SYNC_RESIDENT_REWARD_POLICY_V2.version, 2);
  assert.equal(SYNC_RESIDENT_REWARD_POLICY_V2.conversion.rewardWeightPerConsumedSkillOutputQuality, '1');
  assert.equal(SYNC_RESIDENT_REWARD_POLICY_V2.conversion.syncRawPerRewardWeightUnit, '100000');
  assert.equal(SYNC_RESIDENT_REWARD_POLICY_V2.retroactive, false);
  assert.equal(SYNC_RESIDENT_REWARD_POLICY_V2.residentLimits, 'none');
});

test('skill output reward is 1 weight x quality, about 0.1 SYNC per quality point', () => {
  assert.equal(skillOutputRewardWeight(1), '1.000');
  assert.equal(skillOutputRewardWeight(3), '3.000');
  assert.equal(syncRewardRawForWeight(skillOutputRewardWeight(1)), 100_000n);
  assert.equal(syncRewardRawForWeight(skillOutputRewardWeight(2)), 200_000n);
  assert.throws(() => skillOutputRewardWeight(0), { code: 'SYNC_REWARD_SKILL_OUTPUT_QUALITY_INVALID' });
  assert.throws(() => skillOutputRewardWeight(11), { code: 'SYNC_REWARD_SKILL_OUTPUT_QUALITY_INVALID' });
});

test('kill switches and commit gate default to economy on, commit off', () => {
  assert.equal(syncEconomyEnabled({}), true);
  assert.equal(syncEconomyEnabled({ MIRRORTERRA_SYNC_ECONOMY: 'off' }), false);
  assert.equal(syncResidentRewardCommitEnabled({}), false);
  assert.equal(syncResidentRewardCommitEnabled({ SYNC_RESIDENT_REWARD_COMMIT_ENABLED: 'false' }), false);
  assert.equal(syncResidentRewardCommitEnabled({ SYNC_RESIDENT_REWARD_COMMIT_ENABLED: 'true' }), true);
  assert.equal(activeSyncResidentRewardPolicy({}).version, 2);
  assert.equal(activeSyncResidentRewardPolicy({ MIRRORTERRA_SYNC_ECONOMY: 'off' }).version, 1);
  assert.equal(economicFallbackEnabled({}), true);
  assert.equal(economicFallbackEnabled({ MIRRORTERRA_ECON_FALLBACK: 'off' }), false);
  assert.equal(economicFallbackEnabled({ MIRRORTERRA_SYNC_ECONOMY: 'off' }), false);
});

test('enqueue writes skill_output under v2 and refuses it when the economy is off', async () => {
  const inserts = [];
  const client = { async query(sql, values) {
    inserts.push(values);
    return { rowCount: 1, rows: [{ id: 'contribution', status: 'queued' }] };
  } };
  const created = await enqueueSyncResidentRewardContribution(client, { worldId: WORLD, agentId: PRODUCER,
    sourceType: 'skill_output', sourceEventId: 9, sourceEntityId: '41', rewardWeight: '2.000' }, { env: {} });
  assert.equal(created.created, true);
  assert.deepEqual(inserts[0].slice(2), ['skill_output', '9', '41', '2.000', 2, SYNC_RESIDENT_REWARD_POLICY_V2_HASH]);
  await assert.rejects(enqueueSyncResidentRewardContribution(client, { worldId: WORLD, agentId: PRODUCER,
    sourceType: 'skill_output', sourceEventId: 9, sourceEntityId: '41', rewardWeight: '2' },
  { env: { MIRRORTERRA_SYNC_ECONOMY: 'off' } }), { code: 'SYNC_ECONOMY_DISABLED' });
  await enqueueSyncResidentRewardContribution(client, { worldId: WORLD, agentId: PRODUCER,
    sourceType: 'research_project', sourceEventId: 10, sourceEntityId: '5', rewardWeight: '1' },
  { env: { MIRRORTERRA_SYNC_ECONOMY: 'off' } });
  assert.deepEqual(inserts.at(-1).slice(6), [1, SYNC_RESIDENT_REWARD_POLICY_HASH], 'economy off keeps v1');
});

test('internal capacity snapshot never exceeds saved values and refuses an unread epoch', () => {
  const saved = { block_number: '100', epoch_index: '0', epoch_start: '1791883030',
    economy_quota_raw: '6930000000000', onchain_pool_balance_raw: '10000000000000' };
  const inside = deriveInternalCapacitySnapshot(saved, 1791883030 + 86_400);
  assert.equal(inside.source, 'internal');
  assert.equal(inside.economyQuotaRaw, '6930000000000');
  assert.equal(inside.onchainPoolBalanceRaw, '10000000000000');
  assert.equal(inside.epochIndex, '0');
  assert.equal(deriveInternalCapacitySnapshot(saved, 1791883030 + 2_592_000), null, 'epoch rollover needs a chain read');
  assert.equal(deriveInternalCapacitySnapshot(saved, 1791883029), null);
  assert.equal(deriveInternalCapacitySnapshot(null, 1791883030), null);
});

function workerPool({ snapshotRow, queuedRows = [], commitReady = true }) {
  const writes = [];
  const handle = async (sql, values = []) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes('advisory_')) return { rows: [{ owned: true }], rowCount: 1 };
    // tickfix1: members-first lock (FOR KEY SHARE) and its local lock_timeout.
    if (/^SET LOCAL/.test(sql) || sql.includes('FOR KEY SHARE')) return { rows: [], rowCount: 0 };
    if (sql.includes("to_regclass('public.arc_sync_resident_reward_contributions')")) return { rows: [{ ready: true }], rowCount: 1 };
    if (sql.includes('AS has_ready_source')) return { rows: [{ has_ready_source: true, has_commit_ready: commitReady }], rowCount: 1 };
    if (sql.includes('FROM arc_sync_reward_capacity_snapshots')) return snapshotRow
      ? { rows: [snapshotRow], rowCount: 1 } : { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO arc_sync_reward_capacity_snapshots')) { writes.push(sql); return { rows: [], rowCount: 1 }; }
    if (sql.includes('SELECT contribution.*')) return { rows: queuedRows, rowCount: queuedRows.length };
    if (sql.includes("account.account_type='operating_pool'") && sql.includes('balance_raw')) {
      return { rows: [{ balance_raw: '10000000000000' }], rowCount: 1 };
    }
    if (sql.includes('AS epoch_resident_raw')) return { rows: [{ epoch_resident_raw: '0', pending_raw: '0' }], rowCount: 1 };
    if (sql.includes('FROM world_sync_work_orders')) return { rows: [{ entitled_raw: '0', locked_raw: '0' }, { entitled_raw: '0', locked_raw: '0' }], rowCount: 2 };
    if (sql.includes('AS committed_payout_raw')) return { rows: [{ committed_payout_raw: '0' }], rowCount: 1 };
    if (sql.includes('SELECT world_minutes FROM world_runtime_state')) return { rows: [{ world_minutes: 10 }], rowCount: 1 };
    if (/^\s*(INSERT|UPDATE)/.test(sql)) { writes.push(sql); return { rows: [], rowCount: 1 }; }
    if (sql.includes('SELECT entitlement.agent_id,sum(entitlement.sync_amount_raw)')) {
      writes.push('COMMIT_GROUP_QUERY');
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("to_regclass('public.arc_sync_internal_transfers')")) return { rows: [{ ready: true }], rowCount: 1 };
    if (sql.includes('FROM arc_sync_internal_transfers')) return { rows: [], rowCount: 0 };
    throw new Error(`unexpected worker query: ${sql.slice(0, 120)}`);
  };
  const client = { query: handle, release() {} };
  return { writes, query: handle, async connect() { return client; } };
}

const skillRow = (overrides = {}) => ({ id: 'c1', world_id: WORLD, agent_id: PRODUCER, source_type: 'skill_output',
  source_entity_id: '41', reward_weight: '2.000', policy_version: 2, policy_hash: SYNC_RESIDENT_REWARD_POLICY_V2_HASH,
  skill_output_id: '41', skill_output_producer_id: PRODUCER, skill_output_consumer_id: CONSUMER,
  skill_output_quality: 2, skill_output_consumed_at: new Date('2026-10-20T01:00:00Z'),
  source_event_type: 'world.skill_output_delivered', source_actor_id: PRODUCER,
  source_event_data: { outputId: '41', consumerId: CONSUMER, quality: 2 },
  policy_activated_at: new Date('2026-10-20T00:00:00Z'), skill_output_factor: '1', raw_per_weight: '100000',
  ...overrides });

test('worker accrues from the saved snapshot when the chain read fails and never commits by default', async () => {
  const now = Math.floor(Date.now() / 1000);
  const pool = workerPool({ queuedRows: [skillRow(), skillRow({ id: 'c2', source_event_data: { outputId: '41', consumerId: PRODUCER } })],
    snapshotRow: { block_number: '100', epoch_index: '0', epoch_start: String(now - 3600),
      economy_quota_raw: '6930000000000', onchain_pool_balance_raw: '10000000000000', now_seconds: String(now) } });
  const worker = new SyncResidentRewardAccrualWorker({ pool, rpcClient: {}, intervalMs: 3_600_000, env: {} });
  await worker.start({ worldId: WORLD });
  await worker.stop();
  const status = worker.getStatus();
  assert.equal(status.snapshotSource, 'internal');
  assert.equal(status.commitMode, 'deferred_internal');
  assert.equal(status.lastResult.accrued, 1);
  assert.equal(status.lastResult.rejected, 1, 'a delivered event naming the producer as consumer is rejected');
  assert.equal(status.lastResult.committedBatches, 0);
  assert.ok(pool.writes.some((sql) => sql.includes('INSERT INTO arc_sync_resident_reward_entitlements')));
  assert.ok(!pool.writes.some((sql) => /arc_sync_payout_outbox|arc_sync_resident_reward_batches|arc_sync_ledger_postings/.test(sql)));
  assert.ok(!pool.writes.includes('COMMIT_GROUP_QUERY'));
});

test('worker without any saved snapshot keeps contributions queued when RPC fails', async () => {
  const pool = workerPool({ queuedRows: [skillRow()], snapshotRow: null });
  const worker = new SyncResidentRewardAccrualWorker({ pool, rpcClient: {}, intervalMs: 3_600_000, env: {} });
  await worker.start({ worldId: WORLD });
  await worker.stop();
  assert.equal(worker.getStatus().lastResult.accrued, 0);
  assert.equal(worker.getStatus().lastError, 'SYNC_REWARD_RPC_UNAVAILABLE');
  assert.ok(!pool.writes.some((sql) => sql.includes('arc_sync_resident_reward_entitlements')));
});

test('internal snapshot is never used to commit even with the commit gate on', async () => {
  const now = Math.floor(Date.now() / 1000);
  const pool = workerPool({ queuedRows: [], snapshotRow: { block_number: '1', epoch_index: '0',
    epoch_start: String(now - 60), economy_quota_raw: '1', onchain_pool_balance_raw: '1', now_seconds: String(now) } });
  const worker = new SyncResidentRewardAccrualWorker({ pool, rpcClient: {}, intervalMs: 3_600_000,
    env: { SYNC_RESIDENT_REWARD_COMMIT_ENABLED: 'true' } });
  await worker.start({ worldId: WORLD });
  await worker.stop();
  assert.equal(worker.getStatus().commitMode, 'enabled');
  assert.ok(!pool.writes.includes('COMMIT_GROUP_QUERY'));
});

test('commit refuses to run unless explicitly enabled and opts the transaction into the DB gate', async () => {
  const calls = [];
  const client = { async query(sql) { calls.push(sql); return { rows: [], rowCount: 0 }; } };
  await assert.rejects(commitEligibleSyncResidentRewardBatches(client, { worldId: WORLD, worldMinute: 1,
    snapshot: { epochIndex: '0' }, env: {} }), { code: 'SYNC_RESIDENT_REWARD_COMMIT_DISABLED' });
  assert.equal(calls.length, 0, 'no database access while the gate is off');
  await commitEligibleSyncResidentRewardBatches(client, { worldId: WORLD, worldMinute: 1,
    snapshot: { epochIndex: '0', epochStart: '0', economyQuotaRaw: '0', onchainPoolBalanceRaw: '0' },
    env: { SYNC_RESIDENT_REWARD_COMMIT_ENABLED: 'true' } }).catch(() => {});
  assert.match(calls[0], /set_config\('mirrorterra\.sync_resident_reward_commit','enabled',true\)/);
});

test('payout authorization accepts a consumed skill output and rejects tampered evidence', async () => {
  const now = new Date('2026-10-20T02:00:00Z');
  const selected = { id: 'outbox', world_id: WORLD, agent_id: PRODUCER, status: 'committed', transaction_id: 'ledger',
    transactionStatus: 'committed', transactionActionId: 'payout-action', transactionId: 'ledger',
    sourceEconomicActionId: 'sync-resident-reward-batch:batch', action_id: 'payout-action', amount_raw: '1000000',
    recipient_address: wallet, token_address: wallet, manifest_hash: TOKENOMICS_MANIFEST_HASH };
  const item = { batch_id: 'batch', batch_agent_id: PRODUCER, batch_amount_raw: '1000000', batch_recipient: wallet,
    batch_status: 'committed', entitlement_id: 'e', entitlement_agent_id: PRODUCER, contribution_id: 'c', epoch_index: 0,
    entitlement_policy_version: 2, entitlement_policy_hash: 'b'.repeat(64), entitlement_amount_raw: '1000000',
    entitlement_status: 'committed', entitlement_batch_id: 'batch', contribution_agent_id: PRODUCER,
    source_type: 'skill_output', source_event_id: '7', source_entity_id: '41', reward_weight: '10.000',
    contribution_epoch_index: 0, policy_version: 2, policy_hash: 'b'.repeat(64), contribution_status: 'accrued',
    activated_at: new Date('2026-10-20T00:00:00Z'), raw_per_weight: '100000', minimum_batch_raw: '1000000',
    evidence_world_id: WORLD, evidence_actor_id: PRODUCER, evidence_event_type: 'world.skill_output_delivered',
    evidence_created_at: now, evidence_action_id: `${PRODUCER}:delivered:41`,
    evidence_data: { outputId: '41', consumerId: CONSUMER, quality: 10 },
    skill_output_id: '41', skill_output_producer_id: PRODUCER, skill_output_consumer_id: CONSUMER,
    skill_output_quality: '10', skill_output_consumed_at: now, skill_output_factor: '1' };
  const makePool = (overrides = {}) => ({ async query(sql) {
    if (sql.includes('FROM arc_sync_payout_outbox outbox JOIN arc_sync_ledger_transactions')) return { rows: [selected], rowCount: 1 };
    if (sql.includes('FROM world_sync_work_order_batches batch')) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM arc_sync_resident_reward_batches batch')) {
      assert.match(sql, /LEFT JOIN world_skill_outputs skill_output/);
      return { rows: [{ ...item, ...overrides }], rowCount: 1 };
    }
    if (sql.includes('FROM arc_sync_ledger_postings posting')) return { rows: [
      { accountType: 'operating_pool', amount: '-1000000' }, { accountType: 'agent', agentId: PRODUCER, amount: '1000000' }], rowCount: 2 };
    if (sql.includes('FROM arc_agent_wallets')) return { rows: [{ address: wallet }], rowCount: 1 };
    throw new Error('unexpected query');
  } });
  const ok = await readValidatedSyncPayout(makePool(), { worldId: WORLD, outboxId: 'outbox' });
  assert.equal(ok.amount_raw, '1000000');
  for (const tamper of [{ skill_output_quality: '9' }, { skill_output_consumer_id: PRODUCER },
    { evidence_data: { outputId: '41', consumerId: 'someone-else' } }, { skill_output_producer_id: CONSUMER },
    { skill_output_consumed_at: new Date('2026-10-19T00:00:00Z') }, { skill_output_factor: null }]) {
    await assert.rejects(readValidatedSyncPayout(makePool(tamper), { worldId: WORLD, outboxId: 'outbox' }),
      { code: 'SYNC_PAYOUT_RESIDENT_REWARD_SOURCE_INVALID' });
  }
});

function scriptedClient(script) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push({ sql, params });
    for (const [match, result] of script) if (sql.includes(match)) {
      if (result instanceof Error) throw result;
      const rows = typeof result === 'function' ? result(params, sql) : result;
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  } };
}

test('using another resident output emits a producer event and a skill_output contribution', async () => {
  const script = [
    ['FROM world_members m', [{ energy: 90, food: 3, social: 90 }]],
    ["p.status='learning' AND $3 = ANY", [{ skillId: 's', name: 'S', tier: 4, drives: ['mastery'], xp: 1, level: 0, practiceCount: 1 }]],
    ['UPDATE world_skill_outputs', [{ outputId: '41', producerId: PRODUCER, skillId: 'k', drive: 'survival', quality: 2 }]],
    ["'world.skill_output_delivered'", [{ id: 777 }]],
    ['INSERT INTO arc_sync_resident_reward_contributions', [{ id: 'contribution', status: 'queued' }]]
  ];
  const client = scriptedClient(script);
  const result = await practiceLibrarySkill(client, { worldId: WORLD, agentId: CONSUMER, action: 'work', env: {} });
  assert.equal(result.used.reward.created, true);
  const delivered = client.calls.find((call) => call.sql.includes("'world.skill_output_delivered'"));
  assert.equal(delivered.params[1], PRODUCER, 'the producer is the event actor');
  assert.equal(delivered.params[2].consumerId, CONSUMER);
  assert.equal(delivered.params[3], `${PRODUCER}:delivered:41`);
  const contribution = client.calls.find((call) => call.sql.includes('INSERT INTO arc_sync_resident_reward_contributions'));
  assert.deepEqual(contribution.params.slice(1, 6), [PRODUCER, 'skill_output', '777', '41', '2.000']);
  assert.ok(client.calls.some((call) => call.sql === 'RELEASE SAVEPOINT world_skill_output_reward'));

  const off = scriptedClient(script);
  const disabled = await practiceLibrarySkill(off, { worldId: WORLD, agentId: CONSUMER, action: 'work',
    env: { MIRRORTERRA_SYNC_ECONOMY: 'off' } });
  assert.equal(disabled.used.reward, undefined);
  assert.ok(!off.calls.some((call) => call.sql.includes('skill_output_delivered')
    || call.sql.includes('arc_sync_resident_reward_contributions')));
});

test('a rejected reward rolls back only its own savepoint and keeps the consumption', async () => {
  const client = scriptedClient([
    ['FROM world_members m', [{ energy: 90, food: 3, social: 90 }]],
    ["p.status='learning' AND $3 = ANY", [{ skillId: 's', name: 'S', tier: 4, drives: ['mastery'], xp: 1, level: 0, practiceCount: 1 }]],
    ['UPDATE world_skill_outputs', [{ outputId: '41', producerId: PRODUCER, skillId: 'k', drive: 'survival', quality: 1 }]],
    ["'world.skill_output_delivered'", [{ id: 5 }]],
    ['INSERT INTO arc_sync_resident_reward_contributions', new Error('trigger rejected')]
  ]);
  const result = await practiceLibrarySkill(client, { worldId: WORLD, agentId: CONSUMER, action: 'work', env: {} });
  assert.equal(result.used.outputId, '41');
  assert.ok(result.used.reward.rewardError);
  assert.ok(client.calls.some((call) => call.sql === 'ROLLBACK TO SAVEPOINT world_skill_output_reward'));
});

test('internal pricing is deterministic and restocking follows demand', () => {
  assert.deepEqual(quoteSyncInternalServicePrice({ serviceType: 'food_service', demandCount: 0, stockUnits: 0 }).priceRaw, '120000');
  assert.equal(quoteSyncInternalServicePrice({ serviceType: 'food_service', demandCount: 9, stockUnits: 1 }).priceRaw, '139200');
  assert.equal(quoteSyncInternalServicePrice({ serviceType: 'food_service', demandCount: 0, stockUnits: 5 }).priceRaw, '96000');
  assert.equal(quoteSyncInternalServicePrice({ serviceType: 'research_service', demandCount: 3, stockUnits: 3 }).priceRaw, '350000');
  assert.equal(quoteSyncInternalServicePrice({ serviceType: 'food_service', publishedPriceRaw: '5000' }).basis, 'owner_published');
  assert.equal(syncInternalRestockTarget(0), 1);
  assert.equal(syncInternalRestockTarget(6), 6);
});

test('internal economy candidates restock, found for unmet demand, and buy only within internal balance', () => {
  const founder = 'f0000000-0000-4000-8000-000000000000';
  const business = { id: 'b1', status: 'active', founder_agent_id: founder, name: 'Cafe Co', metadata: { serviceType: 'food_service' } };
  const service = { id: 's1', business_id: 'b1', service_type: 'food_service', stock_units: 1, active: true,
    businessStatus: 'active', founderAgentId: founder, name: 'Meal', syncInternalPriceRaw: '130000', placeName: 'Cafe' };
  const context = { genesisCurrencyActive: true, syncInternalEconomy: true, worldMinutes: 1_440,
    genesisCurrency: { tokenId: 't', symbol: 'SYNC', decimals: 6, initialSupplyRaw: '1000000000000000' },
    businesses: [business], services: [service], allBusinessServices: [service],
    demand: [{ serviceType: 'food_service', demandCount: 5, unmetCount: 4 },
      { serviceType: 'research_service', demandCount: 8, unmetCount: 8 }],
    syncInternalBalances: { [CONSUMER]: '200000', [PRODUCER]: '100000' }, scenes: [] };
  const own = buildSyncInternalBusinessCandidates({ agentId: founder, name: 'Fay', energy: 80, food: 80 }, context);
  const restock = own.find((item) => item.action === 'business_work');
  assert.equal(restock.serviceId, 's1');
  assert.equal(restock.employmentId, undefined, 'founder self-work carries no employment or wage');
  assert.ok(own.some((item) => item.action === 'business_found' && item.businessProposal.serviceType === 'research_service'));
  assert.ok(!own.some((item) => item.action === 'business_found' && item.businessProposal.serviceType === 'food_service'));
  assert.equal(own.find((item) => item.action === 'business_found').businessProposal.capitalUsdc, undefined);
  const buyer = buildSyncInternalBusinessCandidates({ agentId: CONSUMER, energy: 80, food: 20 }, context);
  const purchase = buyer.find((item) => item.action === 'business_service');
  assert.equal(purchase.maxPriceRaw, '162500');
  const poor = buildSyncInternalBusinessCandidates({ agentId: PRODUCER, energy: 80, food: 20 }, context);
  assert.ok(!poor.some((item) => item.action === 'business_service'), 'no purchase above internal balance');
  const combined = buildBusinessCandidates({ agentId: CONSUMER, energy: 80, food: 20 }, context);
  assert.ok(combined.some((item) => item.id === 'sync:service:s1'));
  const off = buildBusinessCandidates({ agentId: CONSUMER, energy: 80, food: 20 }, { ...context, syncInternalEconomy: false });
  assert.ok(!off.some((item) => item.id.startsWith('sync:')));
});

test('economic fallback picks the best feasible economic candidate and ignores routine actions', () => {
  assert.ok(ECONOMIC_FALLBACK_ACTIONS.has('project_propose'));
  const choice = chooseEconomicFallback([
    { id: 'eat', action: 'eat', score: 99 },
    { id: 'p', action: 'project_contribute', score: 40 },
    { id: 'b', action: 'business_work', score: 44 },
    { id: 'x', action: 'business_invest', score: 80 }
  ]);
  assert.equal(choice.id, 'b');
  assert.equal(chooseEconomicFallback([{ id: 'eat', action: 'eat', score: 1 }]), null);
  assert.equal(chooseEconomicFallback([]), null);
});

const genesisRow = { world_id: WORLD, tokenId: 'token-1', symbol: 'SYNC', decimals: 6 };

test('internal SYNC purchase moves balance through a transfer and never creates an Arc settlement intent', async () => {
  const provider = PRODUCER;
  const client = scriptedClient([
    ['FROM world_genesis_currency_activations', [genesisRow]],
    ["to_regclass('public.arc_sync_internal_transfers')", [{ ready: true }]],
    ['FROM world_sync_internal_orders WHERE', []],
    ['FROM world_business_services service JOIN world_businesses business', [{ id: 's1', serviceType: 'food_service',
      serviceName: 'Meal', stockUnits: 2, businessId: 'b1', businessName: 'Cafe', providerAgentId: provider,
      placeStatus: 'active', publishedPriceRaw: null }]],
    ['agreement.terms->>', []],
    ['FROM world_economic_demand', [{ demandCount: 2 }]],
    ['FROM arc_sync_internal_balances', [{ spendable_raw: '500000' }]],
    ['INSERT INTO arc_sync_internal_transfers', [{ id: 'transfer-1' }]],
    ['INSERT INTO world_sync_internal_orders', [{ id: 'order-1' }]]
  ]);
  const order = await purchaseWorldBusinessService(client, { worldId: WORLD, serviceId: 's1', customerAgentId: CONSUMER,
    actionId: 'action-000001', worldTime: 100, maxPriceRaw: '200000' });
  assert.equal(order.status, 'fulfilled');
  assert.equal(order.settlement, 'internal_sync');
  assert.equal(order.amountRaw, '120000');
  const transfer = client.calls.find((call) => call.sql.includes('INSERT INTO arc_sync_internal_transfers'));
  assert.deepEqual(transfer.params.slice(2, 5), [CONSUMER, provider, '120000']);
  assert.ok(!client.calls.some((call) => /arc_genesis_token_settlement_outbox|arc_sync_payout_outbox|arc_sync_ledger/.test(call.sql)));
  assert.ok(client.calls.some((call) => call.sql.includes('stock_units=stock_units-1')));

  const broke = scriptedClient([
    ['FROM world_genesis_currency_activations', [genesisRow]],
    ["to_regclass('public.arc_sync_internal_transfers')", [{ ready: true }]],
    ['FROM world_business_services service JOIN world_businesses business', [{ id: 's1', serviceType: 'food_service',
      serviceName: 'Meal', stockUnits: 2, businessId: 'b1', businessName: 'Cafe', providerAgentId: provider,
      placeStatus: null, publishedPriceRaw: null }]],
    ['FROM arc_sync_internal_balances', [{ spendable_raw: '1000' }]]
  ]);
  await assert.rejects(purchaseWorldBusinessService(broke, { worldId: WORLD, serviceId: 's1', customerAgentId: CONSUMER,
    actionId: 'action-000002', worldTime: 100, maxPriceRaw: '200000' }), /SYNC_INTERNAL_BALANCE_INSUFFICIENT/);
  assert.ok(!broke.calls.some((call) => call.sql.includes('INSERT INTO arc_sync_internal_transfers')));
});

test('a founder self-produces with no wage so business production can be rewarded', async () => {
  const client = scriptedClient([
    ['FROM world_genesis_currency_activations', [genesisRow]],
    ['FROM world_business_production production', []],
    ['FROM world_businesses business LEFT JOIN world_economic_accounts', [{ id: 'b1', status: 'active',
      founder_agent_id: PRODUCER, name: 'Cafe' }]],
    ['SELECT id,service_type AS "serviceType" FROM world_business_services', [{ id: 's1', serviceType: 'food_service' }]],
    ['INSERT INTO world_business_production', [{ productionId: 'p1', productionUnits: 1 }]],
    ['stock_units=stock_units+1', [{ stock_units: 3 }]]
  ]);
  const result = await completeWorldBusinessShift(client, { worldId: WORLD, businessId: 'b1', serviceId: 's1',
    agentId: PRODUCER, actionId: 'work-action-1', worldTime: 50 });
  assert.equal(result.productionId, 'p1');
  assert.equal(result.producerAgentId, PRODUCER);
  assert.equal(result.selfProduction, true);
  assert.equal(result.businessId, 'b1');
  assert.ok(!client.calls.some((call) => /arc_genesis_token_settlement_outbox|business_employment/.test(call.sql)));

  const stranger = scriptedClient([
    ['FROM world_genesis_currency_activations', [genesisRow]],
    ['FROM world_business_production production', []],
    ['FROM world_businesses business LEFT JOIN world_economic_accounts', [{ id: 'b1', status: 'active',
      founder_agent_id: PRODUCER, name: 'Cafe' }]]
  ]);
  await assert.rejects(completeWorldBusinessShift(stranger, { worldId: WORLD, businessId: 'b1', serviceId: 's1',
    agentId: CONSUMER, actionId: 'work-action-2', worldTime: 50 }), /GENESIS_TOKEN_WORK_REQUIRES_ACCEPTED_TOKEN_WAGE/);
});

test('internal spendable is conserved: transfers move SYNC and never create it', () => {
  const pending = { a: 500_000n, b: 300_000n };
  const transfers = [{ from: 'a', to: 'b', amount: 120_000n }, { from: 'b', to: 'a', amount: 20_000n }];
  const balance = (agent) => computeSyncInternalSpendable({ pendingRaw: pending[agent].toString(),
    receivedRaw: transfers.filter((t) => t.to === agent).reduce((s, t) => s + t.amount, 0n).toString(),
    sentRaw: transfers.filter((t) => t.from === agent).reduce((s, t) => s + t.amount, 0n).toString() });
  assert.equal(balance('a') + balance('b'), pending.a + pending.b);
  assert.equal(balance('a'), 400_000n);
});

test('migration 0027 is additive, non-retroactive and never writes payouts', async () => {
  const sql = await readFile(new URL('../migrations/0027_sync_internal_economy.sql', import.meta.url), 'utf8');
  assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|VIEW|FUNCTION|TRIGGER|INDEX)\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b|\bDELETE\s+FROM\b|\bUPDATE\s+[a-z_]+\s+SET\b/i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+(arc_sync_resident_reward_contributions|arc_sync_resident_reward_entitlements|arc_sync_payout_outbox|arc_sync_ledger)/i);
  assert.equal((sql.match(/DROP CONSTRAINT/g) || []).length, 1, 'only the source_type CHECK is widened');
  assert.match(sql, /'research_project','shared_project_cooperation','business_production','skill_output'/);
  const m18 = await readFile(new URL('../migrations/0018_sync_resident_rewards.sql', import.meta.url), 'utf8');
  for (const marker of ["SYNC business reward requires completed attributable production",
    "storm_debris_cleared", "SYNC reward batch is below its immutable policy commitment threshold",
    "SYNC research reward requires attributable research effort"]) {
    assert.ok(m18.includes(marker) && sql.includes(marker), marker);
  }
  assert.match(sql, /world\.skill_output_delivered/);
  assert.match(sql, /CREATE VIEW arc_sync_internal_balances/);
  assert.match(sql, /BEFORE INSERT ON arc_sync_resident_reward_batches/);
  assert.match(sql, /mirrorterra\.sync_resident_reward_commit/);
});
