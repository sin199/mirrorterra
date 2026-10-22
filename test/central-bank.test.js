import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CENTRAL_BANK_CONVERSION_NOTE, CENTRAL_BANK_GOVERNOR_AGENT_ID, CENTRAL_BANK_NAME,
  CENTRAL_BANK_PAYOUT_LABEL, buildCentralBankLedger, buildCentralBankSummary, centralBankUnavailable, readCentralBankSummary }
  from '../src/central-bank.js';
import { SYNC_GENESIS_ISSUER_AGENT_ID } from '../src/arc/sync-tokenomics.js';
import { readSyncInternalAccount } from '../src/arc/sync-resident-rewards.js';
import { isAuthExemptRoutePath } from '../src/request-routing.js';
import { centralBankInfoRows, formatSyncRaw } from '../site/world-places3d.js';

const WORLD = '11111111-1111-4111-8111-111111111111';
const RESIDENT = '22222222-2222-4222-8222-222222222222';
const EPOCH_START = 1791883030;
const saved = { block_number: '26803050', epoch_index: '0', epoch_start: String(EPOCH_START),
  economy_quota_raw: '6930000000000', onchain_pool_balance_raw: '10000000000000',
  observed_at: '2026-10-19T16:44:18.726Z' };

function fakePool({ schema = true, snapshot = saved, nowSeconds = EPOCH_START + 600_000, pendingRaw = '19622500',
  pendingCount = 24, residents = 9 } = {}) {
  const queries = [];
  const rows = (list) => ({ rowCount: list.length, rows: list });
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/to_regclass/.test(sql)) return rows([{ ready: schema }]);
      // Ledger view (bank-ledger): balances, totals, counts, recent entries.
      if (/FROM arc_sync_internal_balances/.test(sql)) return rows([{ name: 'Synterra-03', balanceRaw: '100000' }]);
      if (/AS "bookedRaw"/.test(sql)) return rows([{ bookedRaw: pendingRaw, pendingRaw, rewardCount: pendingCount }]);
      if (/AS "internalTrades"/.test(sql)) return rows([{ internalTrades: 0, internalTransfers: 0 }]);
      if (/UNION ALL/.test(sql)) {
        return rows([{ entryType: 'reward', fromName: null, toName: 'Synterra-03', amountRaw: '100000', sourceType: 'skill_output',
          kind: null, serviceName: null, createdAt: '2026-10-19T17:00:00Z', sortKey: '20261019170000000000' }]);
      }
      if (/FROM arc_sync_reward_capacity_snapshots/.test(sql)) {
        return rows(snapshot ? [{ ...snapshot, now_seconds: String(nowSeconds) }] : []);
      }
      if (/account_type='operating_pool'/.test(sql)) return rows([{ balance_raw: '10000000000000' }]);
      if (/FILTER \(WHERE entitlement.epoch_index=\$2\)/.test(sql)) {
        return rows([{ epoch_resident_raw: pendingRaw, pending_raw: pendingRaw }]);
      }
      if (/world_sync_work_orders/.test(sql)) return rows([{ entitled_raw: '0', locked_raw: '0' }, { entitled_raw: '0', locked_raw: '0' }]);
      if (/arc_sync_payout_outbox/.test(sql)) return rows([{ committed_payout_raw: '0' }]);
      if (/status='pending'/.test(sql) && /count\(DISTINCT agent_id\)/.test(sql)) {
        return rows([{ totalRaw: pendingRaw, count: pendingCount, residents }]);
      }
      if (/FROM arc_sync_resident_reward_entitlements WHERE world_id=\$1$/.test(sql.trim())) {
        return rows([{ totalRaw: pendingRaw, count: pendingCount }]);
      }
      if (/FROM agents agent LEFT JOIN world_members/.test(sql)) {
        return rows([{ agentId: SYNC_GENESIS_ISSUER_AGENT_ID, name: 'Synterra-01', location: 'Exchange' }]);
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    }
  };
}

test('governor is the SYNC issuer agent and the bank is an institution at the world centre', () => {
  assert.equal(CENTRAL_BANK_GOVERNOR_AGENT_ID, 'f952ef0a-001f-408e-8e5d-684b63f133ac');
  assert.equal(CENTRAL_BANK_NAME, 'MirrorTerra Central Bank');
  assert.equal(CENTRAL_BANK_PAYOUT_LABEL, 'Central Bank → resident');
  assert.equal(CENTRAL_BANK_CONVERSION_NOTE, 'SYNC is booked internally');
  const summary = buildCentralBankSummary({ savedSnapshot: saved, nowSeconds: EPOCH_START + 10,
    ledgerPoolBalanceRaw: '10000000000000', governor: { agentId: SYNC_GENESIS_ISSUER_AGENT_ID, name: 'Synterra-01' } });
  assert.equal(summary.kind, 'institution');
  assert.equal(summary.institutionalReserve, true);
  assert.deepEqual(summary.location, { label: 'World centre', x: 0, z: 0 });
  assert.equal(summary.governor.name, 'MirrorTerra-01');
  assert.equal(summary.governor.title, 'Governor');
  assert.equal(summary.onChainTransfers, false);
  assert.deepEqual(summary.conversion, { open: false, note: 'SYNC is booked internally' });
  assert.match(summary.role, /keeps the world's books/i);
  // The governor's own balance is never part of the bank summary.
  assert.ok(!JSON.stringify(summary).match(/spendable|earnedRaw|governorBalance/));
});

test('vault reads the on-chain snapshot; quota remaining only for the snapshot epoch', () => {
  const capacity = { quotaRemainingRaw: 6929980377500n, remainingRaw: 6929980377500n };
  const current = buildCentralBankSummary({ savedSnapshot: saved, nowSeconds: EPOCH_START + 100,
    ledgerPoolBalanceRaw: '10000000000000', capacity });
  assert.equal(current.vault.source, 'chain_snapshot');
  assert.equal(current.vault.balanceRaw, '10000000000000');
  assert.equal(current.vault.snapshotBlock, '26803050');
  assert.equal(current.epoch.status, 'current');
  assert.equal(current.epoch.quotaRemainingRaw, '6929980377500');
  assert.equal(current.epoch.endsAtSeconds, String(EPOCH_START + 2_592_000));
  const stale = buildCentralBankSummary({ savedSnapshot: saved, nowSeconds: EPOCH_START + 2_592_001,
    ledgerPoolBalanceRaw: '10000000000000', capacity });
  assert.equal(stale.epoch.status, 'awaiting_chain_snapshot_for_current_epoch');
  assert.equal(stale.epoch.quotaRemainingRaw, null, 'never carries a quota into an unread epoch');
  assert.equal(stale.vault.balanceRaw, '10000000000000');
});

test('without a chain snapshot the vault falls back to the DB ledger and never invents a quota', () => {
  const summary = buildCentralBankSummary({ savedSnapshot: null, ledgerPoolBalanceRaw: '10000000000000' });
  assert.equal(summary.vault.source, 'db_ledger');
  assert.equal(summary.vault.balanceRaw, '10000000000000');
  assert.equal(summary.epoch.status, 'no_chain_snapshot_yet');
  assert.equal(summary.epoch.quotaRemainingRaw, null);
  const empty = buildCentralBankSummary({});
  assert.equal(empty.vault.balanceRaw, null);
  assert.equal(empty.vault.source, null);
});

test('readCentralBankSummary is read-only and shows pending entitlements and payouts from the bank', async () => {
  const pool = fakePool();
  const summary = await readCentralBankSummary(pool, { worldId: WORLD });
  assert.equal(summary.available, true);
  assert.equal(summary.vault.balanceRaw, '10000000000000');
  assert.equal(summary.epoch.quotaRemainingRaw, String(6930000000000n - 19622500n));
  assert.deepEqual(summary.pendingEntitlements, { totalRaw: '19622500', count: 24, residents: 9 });
  assert.equal(summary.payouts.totalRaw, '19622500');
  assert.equal(summary.ledger.available, true);
  assert.equal(summary.ledger.recent.length, 1);
  assert.equal(summary.ledger.recent[0].from, 'MirrorTerra Central Bank');
  assert.equal(summary.ledger.recent[0].label, 'Central Bank → resident');
  assert.equal(summary.ledger.recent[0].to, 'MirrorTerra-03');
  assert.deepEqual(summary.ledger.residents, [{ name: 'MirrorTerra-03', balanceRaw: '100000' }]);
  assert.equal(summary.governor.name, 'MirrorTerra-01');
  for (const { sql } of pool.queries) {
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|set_config|pg_advisory)/i);
  }
  assert.ok(pool.queries.some(({ params }) => params.includes(SYNC_GENESIS_ISSUER_AGENT_ID)));
});

test('readCentralBankSummary degrades cleanly when the economy schema is missing', async () => {
  const pool = fakePool({ schema: false });
  const summary = await readCentralBankSummary(pool, { worldId: WORLD });
  assert.equal(summary.available, false);
  assert.equal(summary.reason, 'sync_economy_schema_missing');
  assert.equal(summary.conversion.note, 'SYNC is booked internally');
  assert.equal(pool.queries.length, 1);
  assert.equal(centralBankUnavailable('x').available, false);
});

test('resident rewards are labelled as paid by the Central Bank', async () => {
  const pool = { async query(sql) {
    if (/to_regclass/.test(sql)) return { rowCount: 1, rows: [{ ready: true }] };
    if (/arc_sync_internal_balances/.test(sql)) return { rowCount: 1, rows: [{ earnedRaw: '300000', receivedRaw: '0', sentRaw: '0', spendableRaw: '300000' }] };
    if (/arc_sync_internal_transfers/.test(sql)) return { rowCount: 0, rows: [] };
    if (/arc_sync_resident_reward_entitlements/.test(sql)) return { rowCount: 1, rows: [{ id: 'e1', amountRaw: '300000', sourceType: 'skill_output', status: 'pending', createdAt: 'now' }] };
    throw new Error('unexpected');
  } };
  const account = await readSyncInternalAccount(pool, { worldId: WORLD, agentId: RESIDENT });
  assert.equal(account.recentRewards.length, 1);
  assert.equal(account.recentRewards[0].payer, 'MirrorTerra Central Bank');
  assert.equal(account.recentRewards[0].label, 'Central Bank → resident');
  assert.equal(account.spendableRaw, '300000');
});

test('the bank info panel shows the books, governor, the internal-booking line and the pool only as a reference', () => {
  assert.equal(formatSyncRaw('10000000000000'), '10,000,000');
  assert.equal(formatSyncRaw('19622500'), '19.6225');
  assert.equal(formatSyncRaw('x'), null);
  const bank = buildCentralBankSummary({ savedSnapshot: saved, nowSeconds: EPOCH_START + 100,
    ledgerPoolBalanceRaw: '10000000000000', capacity: { quotaRemainingRaw: 6929980377500n, remainingRaw: 1n },
    pending: { totalRaw: '19622500', count: 24, residents: 9 }, totals: { totalRaw: '19622500', count: 24 },
    governor: { agentId: SYNC_GENESIS_ISSUER_AGENT_ID, name: 'Synterra-01' },
    ledger: buildCentralBankLedger({ balances: [{ name: 'Synterra-03', balanceRaw: '100000' }],
      totals: { bookedRaw: '19622500', pendingRaw: '19622500', rewardCount: 24 }, counts: { internalTrades: 2, internalTransfers: 3 },
      recent: [{ entryType: 'reward', toName: 'Synterra-03', amountRaw: '100000', sourceType: 'skill_output',
        createdAt: '2026-10-19T17:00:00Z', sortKey: '2' }] }) });
  const view = centralBankInfoRows(JSON.parse(JSON.stringify(bank)), { timeZone: 'UTC' });
  const rows = Object.fromEntries(view.rows);
  assert.equal(view.title, 'MirrorTerra Central Bank');
  assert.equal(rows.Governor, 'MirrorTerra-01 (resident)');
  assert.equal(rows.Location, 'World centre');
  assert.equal(rows['Operating pool (reference)'], '10,000,000 SYNC · not in circulation');
  assert.equal(rows['Total booked'], '19.6225 SYNC · 24 rewards');
  assert.equal(rows['Total pending'], '19.6225 SYNC');
  assert.equal(rows['Internal trades'], '2');
  assert.equal(rows['Internal transfers'], '3');
  assert.equal(rows['1. MirrorTerra-03'], '0.1 SYNC');
  assert.equal(rows['Central Bank → MirrorTerra-03'], '0.1 SYNC · skill output · Oct 19, 17:00');
  assert.equal(rows.SYNC, 'SYNC is booked internally');
  assert.match(view.body, /keeps the world's books/i);
  assert.doesNotMatch(JSON.stringify(view), /Conversion|not yet open|payout|Vault|quota/i);
  const down = centralBankInfoRows({ available: false, name: 'MirrorTerra Central Bank' });
  assert.equal(Object.fromEntries(down.rows).SYNC, 'SYNC is booked internally');
});

test('bank summary rides on the auth-exempt public map data and touches no payout gate', async () => {
  assert.equal(isAuthExemptRoutePath('/public/map-data'), true);
  const [mapData, bank, world3d, app] = await Promise.all(['../src/public-map-data.js', '../src/central-bank.js',
    '../site/world3d.js', '../site/app.js'].map((file) => readFile(new URL(file, import.meta.url), 'utf8')));
  assert.match(mapData, /readCentralBankSummary\(pool, \{ worldId \}\)/);
  assert.match(mapData, /centralBank, generatedAt/);
  assert.doesNotMatch(bank, /MAINNET_WRITE_GATE|SYNC_COMMITTED_PAYOUT_WRITE_GATE|SYNC_RESIDENT_REWARD_COMMIT_ENABLED|INSERT|UPDATE |DELETE/);
  assert.match(world3d, /kind: 'bank'/);
  assert.match(app, /createCentralBankNode/);
});
