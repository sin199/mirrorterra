// drivefix1: project-place repair threshold, demand-aware skill outputs, early survival, stale project targets.
// Mock clients only; no DB, no network.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DRIVE_DEMAND_OUTPUT_KEY, STALE_TARGET_FIX_KEY, SURVIVAL_EARLY_KEY, createDrivefixFlags,
  driveDemandOutputEnabled, staleTargetFixEnabled, survivalEarlyEnabled } from '../src/drivefix-flags.js';
import { PROJECT_PLACE_REPAIR_MIN_USES_DEFAULT, PROJECT_PLACE_REPAIR_MIN_USES_KEY, projectPlaceFacility,
  projectPlaceRepairDue, projectPlaceRepairMinUses } from '../src/project-place-wear.js';
import { projectPlaceWearSetting } from '../src/project-place-wear-flags.js';
import { repairEligible } from '../src/public-works-growth.js';
import { projectPlaceRepairNeeds } from '../src/public-works.js';
import { chooseOutputDrive, computeDrives, consumerDrives, outputDemandFrom, practiceLibrarySkill }
  from '../src/world-skill-library.js';
import { ENERGY_EARLY, ENERGY_EMERGENCY, FOOD_EARLY, FOOD_EMERGENCY, arrivalPreemption, chooseSurvivalAction }
  from '../src/survival-early.js';
import { CONTRIBUTION_EFFORT_ESTIMATE, collectInFlight, createInFlight, filterStaleProjectCandidates, noteInFlight }
  from '../src/stale-target-fix.js';
import { buildWorldInitiativeCandidates } from '../src/world-initiatives.js';

const NOFILE = '/nonexistent/drivefix1-flags.json';
function withFlagsFile(content, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'drivefix1-'));
  const file = path.join(dir, 'tickfix-flags.json');
  if (content !== null) writeFileSync(file, content);
  try { return fn(file); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function fakeClient(script) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push({ sql, params });
    for (const [match, rows] of script) if (sql.includes(match)) {
      const value = typeof rows === 'function' ? rows(params, sql) : rows;
      return { rows: value, rowCount: value.length };
    }
    return { rows: [], rowCount: 0 };
  } };
}

// ---- switches ---------------------------------------------------------------------------------------
test('switches: default on, env off, the flags file wins over env, a bad file falls back to env', () => {
  for (const key of [DRIVE_DEMAND_OUTPUT_KEY, SURVIVAL_EARLY_KEY, STALE_TARGET_FIX_KEY]) {
    assert.equal(createDrivefixFlags({ env: { MIRRORTERRA_TICKFIX_FLAGS_FILE: NOFILE } }).enabled(key), true);
    assert.equal(createDrivefixFlags({ env: { [key]: 'off', MIRRORTERRA_TICKFIX_FLAGS_FILE: NOFILE } }).enabled(key), false);
    withFlagsFile(JSON.stringify({ [key]: 'off' }), (file) => {
      assert.equal(createDrivefixFlags({ env: { [key]: 'on' }, file }).enabled(key), false);
    });
    withFlagsFile(JSON.stringify({ [key]: 'on' }), (file) => {
      assert.equal(createDrivefixFlags({ env: { [key]: 'off' }, file }).enabled(key), true);
    });
    withFlagsFile('{not json', (file) => {
      assert.equal(createDrivefixFlags({ env: { [key]: 'off' }, file }).enabled(key), false);
      assert.equal(createDrivefixFlags({ env: {}, file }).enabled(key), true);
    });
  }
  assert.equal(driveDemandOutputEnabled({ [DRIVE_DEMAND_OUTPUT_KEY]: 'off', MIRRORTERRA_TICKFIX_FLAGS_FILE: NOFILE }), false);
  assert.equal(survivalEarlyEnabled({ [SURVIVAL_EARLY_KEY]: '0', MIRRORTERRA_TICKFIX_FLAGS_FILE: NOFILE }), false);
  assert.equal(staleTargetFixEnabled({ [STALE_TARGET_FIX_KEY]: 'false', MIRRORTERRA_TICKFIX_FLAGS_FILE: NOFILE }), false);
  assert.equal(staleTargetFixEnabled({ MIRRORTERRA_TICKFIX_FLAGS_FILE: NOFILE }), true);
});

// ---- 1. project places: >= 3 uses in 72 world hours ---------------------------------------------------
const MINUTE = 1_573_473;
const placeWith = (uses72h, condition = 65) => projectPlaceFacility({ id: 'aaaaaaaa-0000-4000-8000-000000000001',
  name: 'Workshop Annex', sceneType: 'studio', status: 'active', features: { placeWear: { condition, repairs: 0,
    useHours: uses72h ? { [Math.floor((MINUTE - 600) / 60)]: uses72h } : {} } } }, MINUTE);

test('project-place repair: default needs 3 uses in 72 world hours; 1-2 uses no longer enough; public buildings unchanged', () => {
  assert.equal(PROJECT_PLACE_REPAIR_MIN_USES_DEFAULT, 3);
  const env = { MIRRORTERRA_TICKFIX_FLAGS_FILE: NOFILE };
  assert.equal(projectPlaceRepairMinUses(env), 3);
  assert.deepEqual(projectPlaceRepairDue(placeWith(3), { minUses: 3 }), { due: true });
  assert.equal(projectPlaceRepairDue(placeWith(2), { minUses: 3 }).reason, 'below_min_uses_72h');
  assert.equal(projectPlaceRepairDue(placeWith(1), { minUses: 3 }).reason, 'below_min_uses_72h');
  assert.equal(projectPlaceRepairDue(placeWith(0), { minUses: 3 }).reason, 'unused_72h');
  assert.equal(projectPlaceRepairDue(placeWith(9, 80), { minUses: 3 }).reason, 'condition_ok');
  // placewear1 rule is minUses 1
  assert.deepEqual(projectPlaceRepairDue(placeWith(1), { minUses: 1 }), { due: true });
  // public buildings keep "any use in 72 h"
  assert.equal(repairEligible({ type: 'workshop', uses72h: 1 }).eligible, true);
  // the tender path uses the same threshold
  assert.equal(projectPlaceRepairNeeds({ places: [placeWith(2)], minUses: 3 }).length, 0);
  assert.equal(projectPlaceRepairNeeds({ places: [placeWith(3)], minUses: 3 }).length, 1);
});

test('project-place repair threshold is configurable: env, flags file wins, invalid values fall back to 3', () => {
  assert.equal(projectPlaceRepairMinUses({ [PROJECT_PLACE_REPAIR_MIN_USES_KEY]: '5', MIRRORTERRA_TICKFIX_FLAGS_FILE: NOFILE }), 5);
  assert.equal(projectPlaceRepairMinUses({ [PROJECT_PLACE_REPAIR_MIN_USES_KEY]: '1', MIRRORTERRA_TICKFIX_FLAGS_FILE: NOFILE }), 1);
  for (const bad of ['0', '-2', 'abc', '']) {
    assert.equal(projectPlaceRepairMinUses({ [PROJECT_PLACE_REPAIR_MIN_USES_KEY]: bad, MIRRORTERRA_TICKFIX_FLAGS_FILE: NOFILE }), 3);
  }
  withFlagsFile(JSON.stringify({ [PROJECT_PLACE_REPAIR_MIN_USES_KEY]: 4 }), (file) => {
    const env = { [PROJECT_PLACE_REPAIR_MIN_USES_KEY]: '2', MIRRORTERRA_TICKFIX_FLAGS_FILE: file };
    assert.equal(projectPlaceWearSetting(PROJECT_PLACE_REPAIR_MIN_USES_KEY, env), '4');
    assert.equal(projectPlaceRepairMinUses(env), 4);
  });
  const prior = process.env[PROJECT_PLACE_REPAIR_MIN_USES_KEY];
  process.env[PROJECT_PLACE_REPAIR_MIN_USES_KEY] = '1';
  try {
    // default argument reads the process env (same as production)
    const due = projectPlaceRepairNeeds({ places: [placeWith(1)] });
    assert.equal(due.length, 1);
  } finally {
    if (prior === undefined) delete process.env[PROJECT_PLACE_REPAIR_MIN_USES_KEY];
    else process.env[PROJECT_PLACE_REPAIR_MIN_USES_KEY] = prior;
  }
});

// ---- 2. skill outputs follow demand -------------------------------------------------------------------
const content = { energy: 100, food: 60, social: 100, happiness: 85, knowledge: 100, hygiene: 40, fun: 70,
  goal: 'balanced', risk_tolerance: 0.5, sociability: 0.6, curiosity: 0.6, discipline: 0.5, ambition: 0.5 };

test('chooseOutputDrive: without demand it is the old rule (producer strongest); a wanted, uncovered drive wins', () => {
  const producer = computeDrives(content);
  const old = (skill) => [...skill].sort((a, b) => (producer[b] || 0) - (producer[a] || 0) || a.localeCompare(b))[0];
  for (const skill of [['contribution', 'belonging'], ['contribution', 'esteem'], ['belonging', 'esteem'], ['creation']]) {
    assert.equal(chooseOutputDrive(skill, producer, null).drive, old(skill));
    assert.equal(chooseOutputDrive(skill, producer, { wanted: {}, open: {}, strength: {} }).drive, old(skill));
  }
  const lonely = { ...content, social: 20, sociability: 0.8 };
  assert.ok(consumerDrives(computeDrives(lonely)).includes('belonging'));
  const demand = outputDemandFrom([lonely, content], []);
  assert.equal(demand.wanted.belonging, 1);
  assert.equal(chooseOutputDrive(['contribution', 'belonging'], producer, demand).drive, 'belonging');
  assert.equal(chooseOutputDrive(['contribution', 'belonging'], producer, demand).reason, 'demand');
  // covered by an open output -> back to the producer's rule (no monopoly, no flood)
  const covered = outputDemandFrom([lonely, content], [{ drive: 'belonging', n: 1 }]);
  assert.equal(chooseOutputDrive(['contribution', 'belonging'], producer, covered).drive, old(['contribution', 'belonging']));
  // a drive outside the skill is never invented
  assert.equal(chooseOutputDrive(['creation', 'mastery'], producer, demand).drive, old(['creation', 'mastery']));
});

test('prod-shaped: with everyone at social 100 nobody wants belonging, so belonging is not forced; esteem goes where wanted', () => {
  const residents = [
    { energy: 100, food: 19, social: 100, happiness: 87, knowledge: 100, hygiene: 38, fun: 77, goal: 'balanced', risk_tolerance: 0.78, sociability: 0.55, curiosity: 0.6, discipline: 0.4, ambition: 0.45 },
    { energy: 31, food: 8, social: 100, happiness: 70, knowledge: 100, hygiene: 3, fun: 66, goal: 'community', risk_tolerance: 0.22, sociability: 0.65, curiosity: 0.7, discipline: 0.6, ambition: 0.85 },
    { energy: 18, food: 43, social: 100, happiness: 67, knowledge: 100, hygiene: 0, fun: 28, goal: 'community', risk_tolerance: 0.7, sociability: 0.8, curiosity: 0.6, discipline: 0.6, ambition: 0.4 }];
  const demand = outputDemandFrom(residents, []);
  assert.equal(demand.wanted.belonging || 0, 0);
  assert.equal(demand.wanted.esteem || 0, 0);
  assert.ok(demand.wanted.survival >= 1);
  const producer = computeDrives(residents[0]);
  // a {contribution, esteem} skill: esteem is unwanted (24 h before: 27 esteem made, 27 expired) -> contribution
  assert.equal(chooseOutputDrive(['contribution', 'esteem'], producer, demand).drive, 'contribution');
});

function libraryScript({ drives, others = [], open = [] }) {
  return [
    ['m.agent_id<>$2', others],
    ['FROM world_members m', [content]],
    ["p.status='learning' AND $3 = ANY", [{ skillId: 'onet:task:1', name: 'Task', tier: 4, drives, xp: 40,
      level: 2, practiceCount: 4 }]],
    ['GROUP BY drive', open],
    ['count(*)::int AS n FROM world_skill_outputs', [{ n: 0 }]],
    ['INSERT INTO world_skill_outputs', [{ outputId: '9' }]]];
}

test('produceOutput: on = demand-aware drive (two extra reads, multi-drive skills only); off = old drive, no extra read', async () => {
  const lonely = { ...content, social: 15, sociability: 0.9 };
  const env = { MIRRORTERRA_TICKFIX_FLAGS_FILE: NOFILE };
  const on = fakeClient(libraryScript({ drives: ['contribution', 'belonging'], others: [lonely] }));
  const result = await practiceLibrarySkill(on, { worldId: 'w', agentId: 'a', action: 'work', env });
  assert.equal(result.produced.drive, 'belonging');
  assert.equal(result.produced.demandChosen, true);
  assert.equal(on.calls.filter((call) => call.sql.includes('m.agent_id<>$2')).length, 1);
  assert.equal(on.calls.filter((call) => call.sql.includes('GROUP BY drive')).length, 1);
  assert.equal(on.calls.filter((call) => call.sql.includes('INSERT INTO world_skill_outputs')).length, 1);
  const off = fakeClient(libraryScript({ drives: ['contribution', 'belonging'], others: [lonely] }));
  const old = await practiceLibrarySkill(off, { worldId: 'w', agentId: 'a', action: 'work',
    env: { ...env, [DRIVE_DEMAND_OUTPUT_KEY]: 'off' } });
  const producer = computeDrives(content);
  assert.equal(old.produced.drive, ['contribution', 'belonging'].sort((a, b) => producer[b] - producer[a] || a.localeCompare(b))[0]);
  assert.equal(old.produced.demandChosen, undefined);
  assert.ok(!off.calls.some((call) => call.sql.includes('m.agent_id<>$2') || call.sql.includes('GROUP BY drive')));
  // single-drive skill: nothing to choose, no extra read even when on
  const single = fakeClient(libraryScript({ drives: ['belonging'], others: [lonely] }));
  const one = await practiceLibrarySkill(single, { worldId: 'w', agentId: 'a', action: 'work', env });
  assert.equal(one.produced.drive, 'belonging');
  assert.ok(!single.calls.some((call) => call.sql.includes('m.agent_id<>$2')));
  // open cap untouched: at 5 open outputs nothing is produced and no demand read happens
  const capped = fakeClient(libraryScript({ drives: ['contribution', 'belonging'], others: [lonely] })
    .map(([match, rows]) => (match.startsWith('count(*)') ? [match, [{ n: 5 }]] : [match, rows])));
  const none = await practiceLibrarySkill(capped, { worldId: 'w', agentId: 'a', action: 'work', env });
  assert.equal(none.produced, null);
  assert.ok(!capped.calls.some((call) => call.sql.includes('m.agent_id<>$2')));
});

// ---- 3. survival ------------------------------------------------------------------------------------
const cands = [
  { id: 'work:x', action: 'work', targetLocation: 'Workshop', score: 60 },
  { id: 'eat:far', action: 'eat', targetLocation: 'Cafe', score: 40 },
  { id: 'eat:here', action: 'eat', targetLocation: 'Garden', score: 30 },
  { id: 'rest:home', action: 'rest', targetLocation: 'home:a', score: 35 }];
function oldSurvival(agent, candidates) {
  return agent.food < 8 ? candidates.find((candidate) => candidate.action === 'eat')
    : agent.energy < 12 ? candidates.find((candidate) => candidate.action === 'rest') : null;
}

test('survival switch off = the old expression for every food/energy pair', () => {
  for (let food = 0; food <= 40; food += 1) for (let energy = 0; energy <= 40; energy += 1) {
    const agent = { food, energy, location: 'Garden' };
    const got = chooseSurvivalAction(agent, cands, { enabled: false })?.candidate || null;
    assert.equal(got, oldSurvival(agent, cands) || null, `food ${food} energy ${energy}`);
  }
  assert.equal(chooseSurvivalAction({ food: 3, energy: 50 }, [], { enabled: false }), null);
});

test('survival on: emergency unchanged, pre-sleep meal, early line prefers food here, nothing above the lines', () => {
  assert.equal(FOOD_EMERGENCY, 8); assert.equal(ENERGY_EMERGENCY, 12); assert.equal(FOOD_EARLY, 20); assert.equal(ENERGY_EARLY, 20);
  const at = (food, energy) => chooseSurvivalAction({ food, energy, location: 'Garden' }, cands, { enabled: true });
  assert.equal(at(5, 50).candidate.id, 'eat:far'); // emergency: same pick as before
  assert.equal(at(5, 50).layer, 'survival_interruption');
  assert.equal(at(30, 10).candidate.id, 'rest:home'); // tired but fed: sleep
  assert.equal(at(15, 10).candidate.id, 'eat:here'); // tired and hungry-ish: eat first (no waking at 0)
  assert.equal(at(15, 10).reason, 'meal_before_rest');
  assert.equal(at(15, 50).candidate.id, 'eat:here'); // early line, on the way
  assert.equal(at(15, 50).layer, 'survival_early');
  assert.equal(at(50, 15).candidate.id, 'rest:home');
  assert.equal(at(20, 20), null); // at/above the lines nothing changes
  assert.equal(at(60, 90), null);
  // no eat here -> best-scored eat elsewhere
  assert.equal(chooseSurvivalAction({ food: 15, energy: 50, location: 'Library' }, cands).candidate.id, 'eat:far');
  // waking with food 4 after sleep: first thing is eating
  assert.equal(chooseSurvivalAction({ food: 4, energy: 70, location: 'home:a' }, cands).candidate.action, 'eat');
});

test('survival on: the early line is one meal, not a lifestyle (simulated 3 world days, food -2/h, meal +45)', () => {
  let food = 60, meals = 0, minFood = 100, hungryHours = 0;
  for (let hour = 0; hour < 72; hour += 1) {
    food -= 2;
    const choice = chooseSurvivalAction({ food, energy: 80, location: 'Garden' }, cands);
    if (choice?.candidate.action === 'eat') { food = Math.min(100, food + 45); meals += 1; }
    minFood = Math.min(minFood, food);
    if (food < FOOD_EMERGENCY) hungryHours += 1;
  }
  assert.ok(meals >= 2 && meals <= 4, `meals ${meals}`); // ~one per world day, as before
  assert.ok(minFood >= 18);
  assert.equal(hungryHours, 0);
});

test('arrival pre-emption: only routine actions without a plan/target, only under an emergency line', () => {
  assert.deepEqual(arrivalPreemption({ food: 5, energy: 50, plannedAction: 'work', plannedContext: {} }), { reason: 'food_emergency' });
  assert.deepEqual(arrivalPreemption({ food: 5, energy: 50, plannedAction: 'rest', plannedContext: {} }), { reason: 'food_emergency' });
  assert.deepEqual(arrivalPreemption({ food: 50, energy: 5, plannedAction: 'learn', plannedContext: {} }), { reason: 'energy_emergency' });
  assert.equal(arrivalPreemption({ food: 50, energy: 5, plannedAction: 'rest', plannedContext: {} }), null);
  assert.equal(arrivalPreemption({ food: 5, energy: 5, plannedAction: 'eat', plannedContext: {} }), null);
  assert.equal(arrivalPreemption({ food: 5, energy: 50, plannedAction: 'work', plannedContext: { cognitionPlanId: 'p' } }), null);
  assert.equal(arrivalPreemption({ food: 5, energy: 50, plannedAction: 'project_contribute', plannedContext: {} }), null);
  assert.equal(arrivalPreemption({ food: 5, energy: 50, plannedAction: 'business_work', plannedContext: {} }), null);
  assert.equal(arrivalPreemption({ food: 9, energy: 13, plannedAction: 'work', plannedContext: {} }), null);
});

// ---- 4. stale project targets -------------------------------------------------------------------------
const A = 'a0000000-0000-4000-8000-000000000001', B = 'a0000000-0000-4000-8000-000000000002';
const C = 'a0000000-0000-4000-8000-000000000003';
const P = 'b0000000-0000-4000-8000-000000000001', Q = 'b0000000-0000-4000-8000-000000000002';
const recruiting = { id: P, status: 'recruiting', participantCount: 1, capacity: 4, project_type: 'BUILD',
  required_resources: { effortPoints: 28 }, progressValue: '0', creator_agent_id: C };

test('join: a recruiting project with 1 member takes exactly one in-flight joiner (it activates at 2)', () => {
  const join = (agentId) => ({ id: `project:join:${P}`, action: 'project_join', projectId: P, decision: 'accept', agentId });
  const inFlight = createInFlight();
  const first = filterStaleProjectCandidates([join(A)], { agentId: A, projects: [recruiting], inFlight });
  assert.equal(first.candidates.length, 1);
  noteInFlight(inFlight, { agentId: A, action: 'project_join', projectId: P });
  const second = filterStaleProjectCandidates([join(B)], { agentId: B, projects: [recruiting], inFlight });
  assert.equal(second.candidates.length, 0);
  assert.deepEqual(second.dropped.map((item) => item.reason), ['closing']);
  // the joiner itself is not counted against itself
  assert.equal(filterStaleProjectCandidates([join(A)], { agentId: A, projects: [recruiting], inFlight }).candidates.length, 1);
  // not recruiting / full
  assert.equal(filterStaleProjectCandidates([join(B)], { agentId: B, projects: [{ ...recruiting, status: 'active' }] })
    .dropped[0].reason, 'not_recruiting');
  assert.equal(filterStaleProjectCandidates([join(B)], { agentId: B, projects: [{ ...recruiting, participantCount: 4 }] })
    .dropped[0].reason, 'full');
  // reject decisions and unknown projects are left alone
  const reject = { id: `project:reject:${P}`, action: 'project_reject', projectId: P, decision: 'reject' };
  assert.equal(filterStaleProjectCandidates([reject], { agentId: B, projects: [recruiting], inFlight }).candidates.length, 1);
  assert.equal(filterStaleProjectCandidates([join(B)], { agentId: B, projects: [], inFlight }).candidates.length, 1);
});

test('contribute: dropped only when the in-flight contributions are expected to finish it', () => {
  const active = { ...recruiting, id: Q, status: 'active', participantCount: 2 };
  const contribute = { id: `project:contribute:${Q}`, action: 'project_contribute', projectId: Q };
  const inFlight = createInFlight();
  noteInFlight(inFlight, { agentId: A, action: 'project_contribute', projectId: Q });
  assert.equal(filterStaleProjectCandidates([contribute], { agentId: B, projects: [active], inFlight }).candidates.length, 1);
  const nearlyDone = { ...active, progressValue: String(100 * (1 - CONTRIBUTION_EFFORT_ESTIMATE / 28) + 1) };
  assert.equal(filterStaleProjectCandidates([contribute], { agentId: B, projects: [nearlyDone], inFlight })
    .dropped[0].reason, 'finishing');
  assert.equal(filterStaleProjectCandidates([contribute], { agentId: B, projects: [nearlyDone] }).candidates.length, 1);
  assert.equal(filterStaleProjectCandidates([contribute], { agentId: B, projects: [{ ...active, status: 'completed' }] })
    .dropped[0].reason, 'not_active');
});

test('collectInFlight reads walking/performing residents (json or object context), ignores rejects and idle', () => {
  const rows = [
    { agent_id: A, status: 'performing', planned_action: 'project_join', planned_context: JSON.stringify({ projectId: P, decision: 'accept' }) },
    { agent_id: B, status: 'walking', planned_action: 'project_contribute', planned_context: { projectId: Q } },
    { agent_id: C, status: 'idle', planned_action: 'project_join', planned_context: { projectId: P } },
    { agent_id: C, status: 'performing', planned_action: 'project_reject', planned_context: { projectId: P, decision: 'reject' } }];
  const inFlight = collectInFlight(rows);
  assert.deepEqual([...inFlight.get(P).joins], [A]);
  assert.deepEqual([...inFlight.get(Q).contributes], [B]);
});

test('prod race reproduced: three residents decide in one tick on the same new project -> one join, not three', () => {
  const agentFor = (id) => ({ agentId: id, location: 'Town Square', energy: 80, food: 60,
    skills: { engineering: 50, research: 50, trading: 50, social: 50 }, relationships: [], goals: [],
    organizationMemberships: [], projectInvitations: [], activeProjects: [], projectMemberships: [] });
  const context = { projects: [recruiting], worldMinutes: 1000 };
  const before = [A, B, C].filter((id) => id !== C).map((id) => buildWorldInitiativeCandidates(agentFor(id), context)
    .filter((candidate) => candidate.action === 'project_join'));
  assert.ok(before.every((list) => list.length === 1), 'every resident is offered the join (old behaviour)');
  const inFlight = createInFlight();
  let joins = 0;
  for (const id of [A, B]) {
    const fresh = filterStaleProjectCandidates(buildWorldInitiativeCandidates(agentFor(id), context),
      { agentId: id, projects: context.projects, inFlight }).candidates.filter((candidate) => candidate.action === 'project_join');
    if (fresh.length) { joins += 1; noteInFlight(inFlight, { agentId: id, action: 'project_join', projectId: P }); }
  }
  assert.equal(joins, 1);
});
