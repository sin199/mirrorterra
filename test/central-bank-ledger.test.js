import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CENTRAL_BANK_LEDGER_RECENT_LIMIT, buildCentralBankLedger, buildCentralBankSummary, presentCentralBankScene,
  readCentralBankLedger, readCentralBankSummary } from '../src/central-bank.js';
import { BANK_GOVERNOR_WORK, CENTRAL_BANK_DESCRIPTION, CENTRAL_BANK_FEATURES, CENTRAL_BANK_GOVERNOR_ID,
  CENTRAL_BANK_PLACE_NAME, CENTRAL_BANK_POSITION, CENTRAL_BANK_PURPOSE, CENTRAL_BANK_SCENE_TYPE,
  governorBankShiftActive, governorShiftCandidates, routeBankGovernorActivity } from '../src/central-bank-place.js';
import { worldEnvironment } from '../src/world-environment.js';
import { centralBankInfoRows } from '../site/world-places3d.js';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WORLD = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const OTHER = '3b331e3d-88c9-4080-adf1-0fedc13b52ae';
const ON = { MIRRORTERRA_BANK_GOVERNOR: 'on' };
const OFF = { MIRRORTERRA_BANK_GOVERNOR: 'off' };
const MONDAY_10 = 600;
const MONDAY_20 = 20 * 60;
const SATURDAY_10 = 5 * 1440 + 600;

const balances = [
  { name: 'Synterra-02', balanceRaw: '760000' },
  { name: 'Synterra-07', balanceRaw: '1234567890' },
  { name: 'Synterra-01', balanceRaw: '0' },
  { name: 'Synterra-05', balanceRaw: '760000' },
  { name: 'Synterra-10', balanceRaw: '99999999999999999999' }
];
const reward = (i, name) => ({ entryType: 'reward', fromName: null, toName: name, amountRaw: '100000',
  sourceType: i % 2 ? 'research_project' : 'skill_output', kind: null, serviceName: null,
  createdAt: `2026-10-19T17:${String(i).padStart(2, '0')}:00Z`, sortKey: `2026101917${String(i).padStart(2, '0')}00000000` });
const purchase = (i) => ({ entryType: 'transfer', fromName: 'Synterra-04', toName: 'Synterra-06', amountRaw: '139200',
  sourceType: null, kind: 'business_service_payment', serviceName: 'Prepared Meal',
  createdAt: `2026-10-19T17:${String(i).padStart(2, '0')}:30Z`, sortKey: `2026101917${String(i).padStart(2, '0')}30000000` });

test('ledger view: balances sorted by amount (BigInt), names only, totals and counts', () => {
  const ledger = buildCentralBankLedger({ balances, totals: { bookedRaw: '2402005000', pendingRaw: '2402005000', rewardCount: 3426 },
    counts: { internalTrades: 225, internalTransfers: 225 }, recent: [] });
  assert.equal(ledger.available, true);
  assert.deepEqual(ledger.residents.map((row) => row.name),
    ['MirrorTerra-10', 'MirrorTerra-07', 'MirrorTerra-02', 'MirrorTerra-05', 'MirrorTerra-01']);
  assert.deepEqual(ledger.residents.map((row) => row.balanceRaw),
    ['99999999999999999999', '1234567890', '760000', '760000', '0']);
  assert.deepEqual(Object.keys(ledger.residents[0]).sort(), ['balanceRaw', 'name']);
  assert.deepEqual(ledger.totals, { bookedRaw: '2402005000', pendingRaw: '2402005000', rewardCount: 3426 });
  assert.deepEqual(ledger.counts, { internalTrades: 225, internalTransfers: 225 });
  const empty = buildCentralBankLedger({});
  assert.deepEqual(empty.residents, []);
  assert.deepEqual(empty.totals, { bookedRaw: '0', pendingRaw: '0', rewardCount: 0 });
  assert.deepEqual(empty.counts, { internalTrades: 0, internalTransfers: 0 });
});

test('ledger view: the 10 most recent entries, newest first, rewards from the bank and purchases between residents', () => {
  const recent = [];
  for (let i = 0; i < 8; i += 1) recent.push(reward(i, 'Synterra-03'), purchase(i));
  const ledger = buildCentralBankLedger({ recent });
  assert.equal(CENTRAL_BANK_LEDGER_RECENT_LIMIT, 10);
  assert.equal(ledger.recent.length, 10);
  // Newest first: 07:30 purchase, 07:00 reward, 06:30 purchase ...
  assert.equal(ledger.recent[0].at, '2026-10-19T17:07:30Z');
  assert.equal(ledger.recent[1].at, '2026-10-19T17:07:00Z');
  for (let i = 1; i < ledger.recent.length; i += 1) assert.ok(ledger.recent[i - 1].at >= ledger.recent[i].at);
  const first = ledger.recent[0], second = ledger.recent[1];
  assert.deepEqual(first, { type: 'purchase', from: 'MirrorTerra-04', to: 'MirrorTerra-06', label: 'resident → resident',
    amountRaw: '139200', reason: 'purchase · Prepared Meal', at: '2026-10-19T17:07:30Z' });
  assert.deepEqual(second, { type: 'reward', from: 'MirrorTerra Central Bank', to: 'MirrorTerra-03',
    label: 'Central Bank → resident', amountRaw: '100000', reason: 'research', at: '2026-10-19T17:07:00Z' });
});

test('no UUIDs anywhere in the bank payload or the rendered panel', () => {
  const ledger = buildCentralBankLedger({ balances, recent: [reward(1, 'Synterra-03'), purchase(2)],
    totals: { bookedRaw: '1', pendingRaw: '1', rewardCount: 1 }, counts: { internalTrades: 1, internalTransfers: 1 } });
  const bank = buildCentralBankSummary({ ledgerPoolBalanceRaw: '10000000000000', ledger,
    governor: { agentId: CENTRAL_BANK_GOVERNOR_ID, name: 'Synterra-01', location: `home:${CENTRAL_BANK_GOVERNOR_ID}` } });
  const payload = JSON.stringify(bank);
  assert.doesNotMatch(payload, UUID);
  assert.doesNotMatch(payload, /agentId/);
  const view = centralBankInfoRows(JSON.parse(payload), { timeZone: 'UTC' });
  assert.doesNotMatch(JSON.stringify(view), UUID);
  // Even a uuid-shaped name that slipped in is never shown.
  const leaked = centralBankInfoRows({ ...JSON.parse(payload), ledger: { ...ledger,
    residents: [{ name: OTHER, balanceRaw: '1' }] } }, { timeZone: 'UTC' });
  assert.doesNotMatch(JSON.stringify(leaked), UUID);
  // Small payload: well under 4 KB for 10 residents and 10 entries.
  const many = buildCentralBankLedger({ balances: Array.from({ length: 10 }, (_, i) => ({ name: `Synterra-${i}`, balanceRaw: String(i * 1000) })),
    recent: Array.from({ length: 12 }, (_, i) => purchase(i)) });
  assert.ok(JSON.stringify(many).length < 4096, `ledger payload ${JSON.stringify(many).length} bytes`);
});

function ledgerPool({ schema = true, failLedger = false } = {}) {
  const queries = [];
  const rows = (list) => ({ rowCount: list.length, rows: list });
  return { queries, async query(sql, params = []) {
    queries.push({ sql, params });
    if (/to_regclass/.test(sql)) return rows([{ ready: schema }]);
    if (failLedger && /arc_sync_internal_balances/.test(sql)) throw new Error('ledger down');
    if (/FROM arc_sync_internal_balances/.test(sql)) return rows(balances);
    if (/AS "bookedRaw"/.test(sql)) return rows([{ bookedRaw: '2402005000', pendingRaw: '2402005000', rewardCount: 3426 }]);
    if (/AS "internalTrades"/.test(sql)) return rows([{ internalTrades: 225, internalTransfers: 225 }]);
    if (/UNION ALL/.test(sql)) return rows([purchase(1), reward(1, 'Synterra-03')]);
    if (/FROM arc_sync_reward_capacity_snapshots/.test(sql)) return rows([]);
    if (/account_type='operating_pool'/.test(sql)) return rows([{ balance_raw: '10000000000000' }]);
    if (/count\(DISTINCT agent_id\)/.test(sql)) return rows([{ totalRaw: '2402005000', count: 3426, residents: 10 }]);
    if (/FROM arc_sync_resident_reward_entitlements WHERE world_id=\$1$/.test(sql.trim())) return rows([{ totalRaw: '2402005000', count: 3426 }]);
    if (/FROM agents agent LEFT JOIN world_members/.test(sql)) return rows([{ agentId: CENTRAL_BANK_GOVERNOR_ID, name: 'Synterra-01', location: CENTRAL_BANK_PLACE_NAME }]);
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  } };
}

test('readCentralBankLedger is SELECT-only, reads the arc_sync_internal_balances view, and degrades cleanly', async () => {
  const pool = ledgerPool();
  const ledger = await readCentralBankLedger(pool, { worldId: WORLD });
  assert.equal(ledger.available, true);
  assert.equal(ledger.residents[0].name, 'MirrorTerra-10');
  assert.deepEqual(ledger.counts, { internalTrades: 225, internalTransfers: 225 });
  assert.equal(ledger.recent[0].type, 'purchase');
  assert.ok(pool.queries.some(({ sql }) => /FROM arc_sync_internal_balances/.test(sql)));
  const union = pool.queries.find(({ sql }) => /UNION ALL/.test(sql));
  assert.deepEqual(union.params, [WORLD, 10]);
  for (const { sql } of pool.queries) assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|set_config|pg_advisory)\b/i);
  const missing = ledgerPool({ schema: false });
  assert.deepEqual(await readCentralBankLedger(missing, { worldId: WORLD }), { available: false, reason: 'sync_ledger_schema_missing' });
  assert.equal(missing.queries.length, 1);
  assert.deepEqual(await readCentralBankLedger(pool, {}), { available: false, reason: 'world_missing' });
});

test('a ledger read failure blanks only the ledger; the bank summary stays available', async () => {
  const summary = await readCentralBankSummary(ledgerPool({ failLedger: true }), { worldId: WORLD });
  assert.equal(summary.available, true);
  assert.deepEqual(summary.ledger, { available: false, reason: 'read_failed' });
  assert.equal(summary.governor.atBank, true);
  const rows = Object.fromEntries(centralBankInfoRows(summary).rows);
  assert.equal(rows.Ledger, 'Temporarily unavailable');
  const ok = await readCentralBankSummary(ledgerPool(), { worldId: WORLD });
  assert.equal(ok.ledger.available, true);
  assert.equal(ok.ledger.residents.length, 5);
});

test('the bank place row shows the bookkeeper wording in map data (display only)', () => {
  const old = { id: 'x', name: CENTRAL_BANK_PLACE_NAME, sceneType: CENTRAL_BANK_SCENE_TYPE,
    description: 'The MirrorTerra Central Bank on the world-centre plaza, where the governor keeps the SYNC reserves.',
    purpose: 'Governor MirrorTerra-01 governs the bank and reviews reserves here on working days; residents may visit.' };
  const shown = presentCentralBankScene(old);
  assert.equal(shown.description, CENTRAL_BANK_DESCRIPTION);
  assert.equal(shown.purpose, CENTRAL_BANK_PURPOSE);
  assert.match(CENTRAL_BANK_DESCRIPTION, /keeps the world's books/);
  assert.doesNotMatch(CENTRAL_BANK_DESCRIPTION + CENTRAL_BANK_PURPOSE, /reserves|governs the bank/i);
  const lab = { name: 'Lab', sceneType: 'code_lab', description: 'd' };
  assert.equal(presentCentralBankScene(lab), lab);
});

// --- Bookkeeping routing -------------------------------------------------------------------
const bank = { id: 'bank-1', name: CENTRAL_BANK_PLACE_NAME, sceneType: CENTRAL_BANK_SCENE_TYPE, status: 'active', capacity: 12,
  features: { ...CENTRAL_BANK_FEATURES }, position: { ...CENTRAL_BANK_POSITION } };
const lab = { id: 'lab-1', name: 'MirrorTerra Code Lab', sceneType: 'code_lab', status: 'active', capacity: 10,
  features: { action: 'work', openingHours: { weekday: [[0, 24]], weekend: [[0, 24]] } }, position: { x: 1.271, z: 0.271 } };
const scenes = [lab, bank];
const governor = { agentId: CENTRAL_BANK_GOVERNOR_ID, location: CENTRAL_BANK_PLACE_NAME, energy: 70, food: 60 };
const env = (minutes) => worldEnvironment(WORLD, minutes);
const routine = [
  { id: 'work:lab-1', action: 'work', targetLocation: lab.name, score: 30 },
  { id: 'learn:lab-1', action: 'learn', targetLocation: lab.name, score: 25 },
  { id: 'socialize:lab-1', action: 'socialize', targetLocation: lab.name, score: 40 },
  { id: 'cooperate:x', action: 'cooperate', targetLocation: lab.name, socialPartnerId: OTHER, score: 35 },
  { id: 'eat:home', action: 'eat', targetLocation: `home:${CENTRAL_BANK_GOVERNOR_ID}`, home: true, score: 20 },
  { id: 'rest:home', action: 'rest', targetLocation: `home:${CENTRAL_BANK_GOVERNOR_ID}`, home: true, score: 10 },
  { id: 'work:home', action: 'work', targetLocation: `home:${CENTRAL_BANK_GOVERNOR_ID}`, home: true, score: 50 },
  { id: 'work:wo', action: 'work', targetLocation: lab.name, workOrderId: 'wo-1', score: 60 }
];

test('the governor bank shift is on only for 01, in world weekday 09-17, with the bank place present, and obeys the kill switch', () => {
  assert.equal(governorBankShiftActive({ agent: governor, scenes, environment: env(MONDAY_10), env: ON }), true);
  assert.equal(governorBankShiftActive({ agent: governor, scenes, environment: env(MONDAY_10), env: {} }), true, 'default on');
  assert.equal(governorBankShiftActive({ agent: governor, scenes, environment: env(MONDAY_10), env: OFF }), false);
  assert.equal(governorBankShiftActive({ agent: governor, scenes, environment: env(MONDAY_20), env: ON }), false);
  assert.equal(governorBankShiftActive({ agent: governor, scenes, environment: env(SATURDAY_10), env: ON }), false);
  assert.equal(governorBankShiftActive({ agent: { ...governor, agentId: OTHER }, scenes, environment: env(MONDAY_10), env: ON }), false);
  assert.equal(governorBankShiftActive({ agent: governor, scenes: [lab], environment: env(MONDAY_10), env: ON }), false);
  assert.equal(governorBankShiftActive({ agent: governor, scenes: [lab, { ...bank, status: 'closed' }], environment: env(MONDAY_10), env: ON }), false);
});

test('during the shift the routine set is bookkeeping (work/learn) plus eat/rest; otherwise unchanged', () => {
  const shift = governorShiftCandidates(routine, { active: true });
  assert.deepEqual(shift.map((c) => c.id), ['work:lab-1', 'learn:lab-1', 'eat:home', 'rest:home']);
  // Deterministic and pure.
  assert.deepEqual(governorShiftCandidates(routine, { active: true }), shift);
  assert.equal(routine.length, 8);
  assert.equal(governorShiftCandidates(routine, { active: false }), routine);
  assert.equal(governorShiftCandidates(routine), routine);
  // Without any bookkeeping-eligible candidate nothing is removed (needs and plans still work).
  const noBookkeeping = routine.filter((c) => !['work:lab-1', 'learn:lab-1'].includes(c.id));
  assert.equal(governorShiftCandidates(noBookkeeping, { active: true }), noBookkeeping);
  assert.deepEqual(governorShiftCandidates(null, { active: true }), []);
  // Whatever the routine fallback picks from the shift set, work/learn lands at the bank as bookkeeping.
  for (const pick of shift.filter((c) => ['work', 'learn'].includes(c.action))) {
    const routed = routeBankGovernorActivity(pick, { agent: governor, scenes, environment: env(MONDAY_10), env: ON,
      decisionLayer: 'routine_fallback' });
    assert.equal(routed.targetLocation, CENTRAL_BANK_PLACE_NAME);
    assert.equal(routed.id, pick.id, 'candidate id kept for plan/Fruitfly bookkeeping');
    assert.equal(routed.goal, BANK_GOVERNOR_WORK[pick.action].goal);
  }
  assert.match(BANK_GOVERNOR_WORK.work.description, /Reconciling the ledger/);
  assert.match(BANK_GOVERNOR_WORK.learn.description, /Auditing resident accounts/);
  assert.equal(BANK_GOVERNOR_WORK.work.variant, 'ledger_reconciling');
  assert.equal(BANK_GOVERNOR_WORK.learn.variant, 'accounts_audit');
});

test('engine wiring: economic fallback is skipped and the routine set narrowed only during the governor shift', async () => {
  const engine = await readFile(new URL('../src/world-engine.js', import.meta.url), 'utf8');
  const shiftAt = engine.indexOf('const governorShift = governorBankShiftActive({ agent, scenes, environment });');
  const fallbackAt = engine.indexOf('if (!activity && openCognitionEnabled && strategicDue && economicFallbackEnabled() && !governorShift) {');
  const narrowAt = engine.indexOf('qualifyUtilityCandidates(governorShiftCandidates(routineFallbackCandidates(utilityCandidates),');
  assert.ok(shiftAt > 0 && fallbackAt > shiftAt && narrowAt > fallbackAt);
  // Survival interruptions and plan-grounded choices are decided before, and are not touched.
  assert.ok(engine.indexOf("decisionLayer = 'survival_interruption';") < shiftAt);
  assert.ok(engine.indexOf('else if (cognitionSelection.candidate) activity = cognitionSelection.candidate;') < shiftAt);
  assert.ok(engine.indexOf('activity = routeBankGovernorActivity(activity') > narrowAt);
  assert.match(engine, /'central bank bookkeeping'/);
  assert.doesNotMatch(engine, /central bank governance/);
});

test('wording: the bank keeps the books; no conversion or payout promise in the bank UI and data', async () => {
  const read = (file) => readFile(new URL(file, import.meta.url), 'utf8');
  const [bankSrc, place, places3d, world3d, app, html, css] = await Promise.all(['../src/central-bank.js',
    '../src/central-bank-place.js', '../site/world-places3d.js', '../site/world3d.js', '../site/app.js', '../site/index.html',
    '../site/styles.css'].map(read));
  for (const [file, text] of [['central-bank.js', bankSrc], ['world-places3d.js', places3d], ['app.js', app], ['world3d.js', world3d]]) {
    assert.doesNotMatch(text, /Conversion to on-chain SYNC|not yet open|Governing the bank|Reviewing reserves/, file);
  }
  assert.match(bankSrc, /SYNC is booked internally/);
  assert.match(bankSrc, /Keeps the world\\'s books/);
  assert.doesNotMatch(bankSrc + place, /MAINNET_WRITE_GATE|SYNC_COMMITTED_PAYOUT_WRITE_GATE|SYNC_RESIDENT_REWARD_COMMIT_ENABLED|INSERT INTO arc_|UPDATE arc_|DELETE FROM/);
  assert.match(css, /dt\.world3d-info-section\{grid-column:1\/-1/);
  for (const [file, text] of [['index.html', html], ['app.js', app], ['world3d.js', world3d]]) {
    assert.match(text, /v=growth4-20261022/, file);
    assert.doesNotMatch(text, /v=bankwork-20261020/, file);
  }
});
