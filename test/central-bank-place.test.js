import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BANK_GOVERNOR_WORK, CENTRAL_BANK_DESCRIPTION, CENTRAL_BANK_FEATURES, CENTRAL_BANK_GOVERNOR_ID,
  CENTRAL_BANK_PLACE_NAME, CENTRAL_BANK_POSITION, CENTRAL_BANK_SCENE_TYPE, bankGovernorEnabled,
  ensureCentralBankPlace, ensureCentralBankPlaceSafely, findCentralBankScene, isCentralBankScene,
  routeBankGovernorActivity } from '../src/central-bank-place.js';
import { CENTRAL_BANK_NAME, buildCentralBankSummary, governorLocationLabel } from '../src/central-bank.js';
import { SYNC_GENESIS_ISSUER_AGENT_ID } from '../src/arc/sync-tokenomics.js';
import { activityNeedEffects, activityVariant, placeSchedule, worldCalendar, worldEnvironment } from '../src/world-environment.js';
import { isCooperativeScene, isSkillPlace, isSocialScene } from '../src/world-skill-places.js';

const WORLD = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const OTHER = '3b331e3d-88c9-4080-adf1-0fedc13b52ae';
const ON = { MIRRORTERRA_BANK_GOVERNOR: 'on' };
const OFF = { MIRRORTERRA_BANK_GOVERNOR: 'off' };
const DAY = 1440;
// Day index 0 is a Monday; 10:00 on a weekday is inside isWorkHours (09:00-17:00).
const MONDAY_10 = 600;
const MONDAY_20 = 20 * 60;
const SATURDAY_10 = 5 * DAY + 600;
const MONDAY_17_30 = 17 * 60 + 30;

const bank = { id: 'bank-1', name: CENTRAL_BANK_PLACE_NAME, sceneType: CENTRAL_BANK_SCENE_TYPE, status: 'active', capacity: 12,
  features: { ...CENTRAL_BANK_FEATURES }, position: { ...CENTRAL_BANK_POSITION } };
const lab = { id: 'lab-1', name: 'MirrorTerra Code Lab', sceneType: 'code_lab', status: 'active', capacity: 10,
  features: { skillGroup: 'onet:gwa:4.A.3.b.1', action: 'work', openingHours: { weekday: [[0, 24]], weekend: [[0, 24]] } },
  position: { x: 1.271, z: 0.271 } };
const library = { id: 'lib-1', name: "Synterra-03's Library", sceneType: 'library', status: 'active', capacity: 8, features: {}, position: {} };
const scenes = [lab, library, bank];
const governor = { agentId: CENTRAL_BANK_GOVERNOR_ID, location: `home:${CENTRAL_BANK_GOVERNOR_ID}`, energy: 70, food: 60 };
const env = (minutes) => worldEnvironment(WORLD, minutes);
const work = { id: `work:${lab.id}`, action: 'work', targetLocation: lab.name, goal: 'Work at the lab.', score: 30 };
const learn = { id: `learn:${library.id}`, action: 'learn', targetLocation: library.name, goal: 'Study.', score: 25 };

function fakeClient({ existing = false, member = true } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/^SAVEPOINT|^RELEASE|^ROLLBACK/.test(sql)) return { rowCount: 0, rows: [] };
      if (/SELECT id FROM world_scenes/.test(sql)) return existing ? { rowCount: 1, rows: [{ id: 'bank-1' }] } : { rowCount: 0, rows: [] };
      if (/FROM world_members/.test(sql)) return member ? { rowCount: 1, rows: [{ agent_id: CENTRAL_BANK_GOVERNOR_ID }] } : { rowCount: 0, rows: [] };
      if (/INSERT INTO world_scenes/.test(sql)) return { rowCount: 1, rows: [{ id: 'bank-1', name: params[2], sceneType: params[3] }] };
      return { rowCount: 1, rows: [] };
    }
  };
}

test('the Central Bank place row satisfies the world_scenes checks and sits at the plaza bank spot', () => {
  assert.equal(CENTRAL_BANK_PLACE_NAME, CENTRAL_BANK_NAME);
  assert.equal(CENTRAL_BANK_PLACE_NAME, 'MirrorTerra Central Bank');
  assert.equal(CENTRAL_BANK_GOVERNOR_ID, SYNC_GENESIS_ISSUER_AGENT_ID);
  // 0025: an existing legacy type or a lowercase slug.
  assert.match(CENTRAL_BANK_SCENE_TYPE, /^[a-z][a-z_]{2,39}$/);
  assert.ok(CENTRAL_BANK_PLACE_NAME.length >= 3 && CENTRAL_BANK_PLACE_NAME.length <= 64);
  assert.ok(CENTRAL_BANK_DESCRIPTION.length >= 12 && CENTRAL_BANK_DESCRIPTION.length <= 240);
  // Same angle as site/world3d.js BANK_ANGLE (-0.21), just off the world centre.
  assert.ok(Math.abs(Math.atan2(CENTRAL_BANK_POSITION.z, CENTRAL_BANK_POSITION.x) - (-0.21)) < 0.01);
  assert.ok(Math.hypot(CENTRAL_BANK_POSITION.x, CENTRAL_BANK_POSITION.z) < 0.2);
  // Not a skill place: it never shifts skill-place positions or gets skill work candidates.
  assert.equal(isSkillPlace(bank), false);
  assert.equal(isCooperativeScene(bank), false);
  // Residents may visit: it is a social place like a cafe.
  assert.equal(isSocialScene(bank), true);
  assert.equal(isCentralBankScene(bank), true);
  assert.equal(findCentralBankScene(scenes), bank);
  assert.equal(findCentralBankScene([lab, { ...bank, status: 'closed' }]), null);
  const calendar = worldCalendar(MONDAY_10);
  assert.equal(placeSchedule(bank, calendar).open, true);
  assert.equal(placeSchedule(bank, worldCalendar(MONDAY_20)).open, false);
});

test('ensureCentralBankPlace inserts the place once, idempotently, and the kill switch skips it', async () => {
  const client = fakeClient();
  const scene = await ensureCentralBankPlace(client, { worldId: WORLD, worldMinutes: 1234, env: ON });
  assert.equal(scene.name, CENTRAL_BANK_PLACE_NAME);
  const insert = client.queries.find((query) => /INSERT INTO world_scenes/.test(query.sql));
  assert.match(insert.sql, /ON CONFLICT\(world_id,name\) DO NOTHING/);
  assert.equal(insert.params[0], WORLD);
  assert.equal(insert.params[1], CENTRAL_BANK_GOVERNOR_ID);
  assert.equal(insert.params[3], 'central_bank');
  assert.deepEqual(JSON.parse(insert.params[7]), { ...CENTRAL_BANK_POSITION });
  assert.equal(JSON.parse(insert.params[6]).action, 'socialize');
  assert.ok(client.queries.some((query) => /INSERT INTO world_events/.test(query.sql) && query.params.includes('landmark:central-bank')));
  const again = fakeClient({ existing: true });
  assert.equal(await ensureCentralBankPlace(again, { worldId: WORLD, env: ON }), null);
  assert.ok(!again.queries.some((query) => /INSERT/.test(query.sql)));
  const noGovernor = fakeClient({ member: false });
  assert.equal(await ensureCentralBankPlace(noGovernor, { worldId: WORLD, env: ON }), null);
  assert.ok(!noGovernor.queries.some((query) => /INSERT/.test(query.sql)));
  const off = fakeClient();
  assert.equal(await ensureCentralBankPlaceSafely(off, { worldId: WORLD, env: OFF }), null);
  assert.equal(off.queries.length, 0);
  const broken = { queries: [], async query(sql) { this.queries.push(sql); if (/SELECT id/.test(sql)) throw new Error('boom'); return { rowCount: 0, rows: [] }; } };
  const failed = await ensureCentralBankPlaceSafely(broken, { worldId: WORLD, env: ON });
  assert.equal(failed.error, 'boom');
  assert.ok(broken.queries.includes('ROLLBACK TO SAVEPOINT world_central_bank_place'));
});

test('during world working hours the governor reconciles the ledger and audits accounts at the Central Bank', () => {
  const routed = routeBankGovernorActivity(work, { agent: governor, scenes, environment: env(MONDAY_10), env: ON });
  assert.equal(routed.targetLocation, CENTRAL_BANK_PLACE_NAME);
  assert.equal(routed.action, 'work');
  assert.equal(routed.id, work.id);
  assert.equal(routed.goal, BANK_GOVERNOR_WORK.work.goal);
  assert.equal(routed.routedFrom, lab.name);
  const study = routeBankGovernorActivity(learn, { agent: governor, scenes, environment: env(MONDAY_10), env: ON });
  assert.equal(study.targetLocation, CENTRAL_BANK_PLACE_NAME);
  assert.equal(study.action, 'learn');
  // Deterministic: the same inputs give the same result.
  assert.deepEqual(routeBankGovernorActivity(work, { agent: governor, scenes, environment: env(MONDAY_10), env: ON }), routed);
  // Arriving there gives the bank variants, whose need effects equal a normal shift / study (no special reward).
  const calendar = worldCalendar(MONDAY_10);
  assert.equal(activityVariant({ action: 'work', location: bank.name, sceneType: 'central_bank', calendar, weather: {} }), 'ledger_reconciling');
  assert.equal(activityVariant({ action: 'learn', location: bank.name, sceneType: 'central_bank', calendar, weather: {} }), 'accounts_audit');
  assert.deepEqual(activityNeedEffects({ action: 'work', variant: 'ledger_reconciling' }), activityNeedEffects({ action: 'work', variant: 'workshop_shift' }));
  assert.deepEqual(activityNeedEffects({ action: 'learn', variant: 'accounts_audit' }), activityNeedEffects({ action: 'learn', variant: 'library_study' }));
  // Actions started under the previous release keep the same need effects when they complete.
  assert.deepEqual(activityNeedEffects({ action: 'work', variant: 'bank_governing' }), activityNeedEffects({ action: 'work', variant: 'workshop_shift' }));
  assert.deepEqual(activityNeedEffects({ action: 'learn', variant: 'bank_reserves_review' }), activityNeedEffects({ action: 'learn', variant: 'library_study' }));
});

test('outside working hours, for other residents and for life activities nothing is rerouted', () => {
  const same = (activity, options) => assert.equal(routeBankGovernorActivity(activity, { agent: governor, scenes, env: ON, ...options }), activity);
  same(work, { environment: env(MONDAY_20) });
  same(work, { environment: env(SATURDAY_10) });
  same(work, { environment: env(MONDAY_10), agent: { ...governor, agentId: OTHER } });
  for (const action of ['eat', 'rest', 'socialize', 'cooperate', 'project_join', 'business_work']) {
    same({ ...work, action }, { environment: env(MONDAY_10) });
  }
  same({ id: `rest:home:${governor.agentId}`, action: 'rest', targetLocation: governor.location, home: true }, { environment: env(MONDAY_10) });
  same({ ...work, id: `work:home:${governor.agentId}`, targetLocation: governor.location, home: true }, { environment: env(MONDAY_10) });
  same({ ...work, workOrderId: 'wo-1' }, { environment: env(MONDAY_10) });
  same({ ...work, projectId: 'p-1' }, { environment: env(MONDAY_10) });
  same({ ...work, socialPartnerId: OTHER }, { environment: env(MONDAY_10) });
  same(work, { environment: env(MONDAY_10), decisionLayer: 'survival_interruption' });
  same(work, { environment: env(MONDAY_10), scenes: [lab, library] });
  same(work, { environment: env(MONDAY_10), scenes: [lab, library, { ...bank, status: 'inactive' }] });
  // Too close to closing to walk there (bank closes 18:00 on weekdays; a 17:30 start is outside work hours anyway).
  same(work, { environment: env(MONDAY_17_30) });
  same(null, { environment: env(MONDAY_10) });
});

test('MIRRORTERRA_BANK_GOVERNOR=off is the kill switch; default is on', () => {
  assert.equal(bankGovernorEnabled({}), true);
  assert.equal(bankGovernorEnabled({ MIRRORTERRA_BANK_GOVERNOR: 'on' }), true);
  assert.equal(bankGovernorEnabled({ MIRRORTERRA_BANK_GOVERNOR: 'OFF ' }), false);
  assert.equal(routeBankGovernorActivity(work, { agent: governor, scenes, environment: env(MONDAY_10), env: OFF }), work);
});

test('the governor location is a friendly name, never a raw home key', () => {
  assert.equal(governorLocationLabel(`home:${SYNC_GENESIS_ISSUER_AGENT_ID}`, { governorName: 'Synterra-01' }), "MirrorTerra-01's home");
  assert.equal(governorLocationLabel(`home:${OTHER}`, { governorName: 'Synterra-01', homeOwnerName: 'Synterra-02' }), "MirrorTerra-02's home");
  assert.equal(governorLocationLabel(`home:${OTHER}`, {}), "A resident's home");
  assert.equal(governorLocationLabel('Exchange'), 'Research Exchange');
  assert.equal(governorLocationLabel(CENTRAL_BANK_PLACE_NAME), CENTRAL_BANK_PLACE_NAME);
  assert.equal(governorLocationLabel(null), null);
  const home = buildCentralBankSummary({ ledgerPoolBalanceRaw: '1', governor: { agentId: SYNC_GENESIS_ISSUER_AGENT_ID,
    name: 'Synterra-01', location: `home:${SYNC_GENESIS_ISSUER_AGENT_ID}` } });
  assert.equal(home.governor.location, "MirrorTerra-01's home");
  assert.equal(home.governor.atHome, true);
  assert.doesNotMatch(JSON.stringify(home.governor), /home:/);
  const atWork = buildCentralBankSummary({ ledgerPoolBalanceRaw: '1', governor: { agentId: SYNC_GENESIS_ISSUER_AGENT_ID,
    name: 'Synterra-01', location: CENTRAL_BANK_PLACE_NAME } });
  assert.equal(atWork.governor.atBank, true);
});

test('engine, map and page wiring for the bank place; no gate or SYNC flow is touched', async () => {
  const read = (file) => readFile(new URL(file, import.meta.url), 'utf8');
  const [engine, place, world3d, app, html, css] = await Promise.all(['../src/world-engine.js', '../src/central-bank-place.js',
    '../site/world3d.js', '../site/app.js', '../site/index.html', '../site/styles.css'].map(read));
  assert.match(engine, /import \{ ensureCentralBankPlaceSafely, governorBankShiftActive, governorShiftCandidates, isCentralBankScene,\s+routeBankGovernorActivity \} from '\.\/central-bank-place\.js'/);
  assert.match(engine, /ensureCentralBankPlaceSafely\(client, \{ worldId, worldMinutes \}\)/);
  // Routing happens after a feasible activity exists and before it is traced and started.
  const routeAt = engine.indexOf('activity = routeBankGovernorActivity(activity');
  assert.ok(routeAt > engine.indexOf("phaseSucceeded('TACTICAL_DECISIONS')"));
  assert.ok(routeAt < engine.indexOf('INSERT INTO world_decision_traces'));
  assert.doesNotMatch(place, /MAINNET_WRITE_GATE|SYNC_COMMITTED_PAYOUT_WRITE_GATE|SYNC_RESIDENT_REWARD_COMMIT_ENABLED|enqueueSync|arc_sync_|payout|UPDATE |DELETE/);
  assert.match(world3d, /isBankScene/);
  assert.match(world3d, /scenes: nextData\.scenes\.filter\(\(item\) => !isBankScene\(item\)\)/);
  assert.match(world3d, /ledger_reconciling: 'Reconciling the ledger', accounts_audit: 'Auditing resident accounts'/);
  assert.doesNotMatch(world3d + app, /Governing the bank|Reviewing reserves/);
  assert.match(app, /if \(isCentralBankScene\(scene\)\) return;/);
  assert.match(app, /exchangeNode\.style\.top = 'calc\(50% \+ 66px\)'/);
  assert.match(css, /:has\(\.world3d-info:not\(\[hidden\]\)\) \.agent-panel:has\(\.agent-panel-empty\)\{display:none\}/);
  for (const [file, text] of [['index.html', html], ['app.js', app], ['world3d.js', world3d]]) {
    assert.doesNotMatch(text, /v=bank-20261020|v=bankwork-20261020/, file);
    assert.match(text, /v=growth4-20261022/, file);
  }
});
