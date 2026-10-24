// ctxfix2: (A) stuck-grounding escalation + typed snapshot target match + context backlog skip;
// (B) town-growth guard on project-built places (visitors included). Mock clients only; no DB, no network.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { groundPlanStep, markExecutionReplanPending, retryFingerprintFor }
  from '../src/agent-runtime/open-cognition/grounding.js';
import { nextStuckGrounding, shouldEscalateBlocked, STUCK_GROUNDING_ESCALATE_AFTER,
  STUCK_GROUNDING_MAX_WORLD_MINUTES } from '../src/agent-runtime/open-cognition/lifecycle.js';
import { finishGroundingClaim, withStuckDiagnostics } from '../src/agent-runtime/open-cognition/worker.js';
import { eligibleExecutionReplanFingerprints } from '../src/agent-runtime/open-cognition/diagnostics.js';
import { shouldCallForMaterialChange } from '../src/agent-runtime/open-cognition/schedule.js';
import { CONTEXT_LATEST_EVENTS_SQL, CONTEXT_PINNED_EVENTS_SQL, CURSOR_SKIP_LAG_IDS, pinnedOwnEventIds,
  readCognitionContext, shouldSkipBacklog, skippedCount }
  from '../src/agent-runtime/open-cognition/context.js';
import { CURSOR_FIX_KEY, createCursorFixFlags } from '../src/agent-runtime/open-cognition/cursorfix-flags.js';
import { BUILD_GUARD_FIX_KEY, createBuildGuardFixFlags } from '../src/build-guard-flags.js';
import { PLACE_GUARD_COOLDOWN_MINUTES, placeBuildDecision, proposeWorldProject } from '../src/world-projects.js';

const WORLD = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const MT10 = '46015f3f-d58c-4e0f-8bd6-bdb2afc3da91';
const VISITOR = 'c0c95ab1-e08c-4e06-bc99-f188730089e5';
const ORG = '43f52516-13a2-4034-88be-d07d3241af37';
const OTHER_ORG = '97cef63d-9efa-4f28-9e6c-956c77ed6598';
const CALL = '7ddb83e2-05f1-49cb-8b04-30e821e10d1c';

// MirrorTerra-10's real stuck step (plan-recover-then-contribute step 0, 10-23).
function mt10Step(extra = {}) {
  return { stepId: 'plan-recover-then-contribute:step:0', intentId: 'plan-recover-then-contribute:intent:0',
    intent: 'Make one bounded contribution to the Shared Field Study Collective.',
    description: 'Contribute once to the Shared Field Study Collective.', actionType: 'world_action',
    targetId: ORG, targetType: 'organization', targetBindingMode: 'exact', status: 'blocked', ...extra };
}
// The advertised snapshot spelling (no organizationId field), exactly as world-engine writes it.
function snapshotCandidates() {
  return [
    { id: `organization:contribute:${ORG}`, action: 'organization_contribute', goal: 'Contribute to the collective', targetLocation: 'Synterra Data Center' },
    { id: `organization:leave:${ORG}`, action: 'organization_leave', goal: 'Leave the collective', targetLocation: 'Synterra Data Center' },
    { id: `organization:invite:${ORG}:${VISITOR}`, action: 'organization_invite', goal: 'Invite', targetLocation: 'Synterra Data Center' },
    { id: `organization:contribute:${OTHER_ORG}`, action: 'organization_contribute', goal: 'Contribute elsewhere', targetLocation: 'Synterra Data Center' },
    { id: 'eat:home:x', action: 'eat', goal: 'Eat at home' }
  ];
}
function mt10Context(minute = 1568212, version = minute) {
  return { world: { minute, environment: {} }, resident: { id: MT10, location: 'home', energy: 80, food: 60 },
    targetState: { id: ORG, type: 'organization', exists: true, status: 'active', lookupSupported: true,
      permissionStatus: 'active', stateVersion: `${version}|active|active|||` },
    availableAffordances: { candidates: snapshotCandidates() }, capabilities: [], syncBalances: [] };
}

// ---------------------------------------------------------------- A1: the loop and its escalation
test('MT-10 loop reproduced: the old counter never escalates because the fingerprint changes every tick', () => {
  let step = mt10Step();
  for (let i = 0; i < 6; i += 1) {
    const minute = 1568000 + i * 70;
    const fp = retryFingerprintFor({ reason: 'target_affordance_missing', step, state: mt10Context().resident,
      targetState: mt10Context(minute).targetState, affordances: snapshotCandidates(), worldMinute: minute }).fingerprint;
    if (i) assert.equal(shouldEscalateBlocked(step, 'target_affordance_missing', minute, fp), false, `round ${i}`);
    step = { ...step, groundingBlocked: { reason: 'target_affordance_missing', retryCondition: { fingerprint: fp },
      retryFingerprint: fp, observedWorldMinute: minute },
    groundingDiagnostics: { groundingChecks: 1, retryGateChecks: 0, stateFingerprintHash: fp } };
  }
});

test('stuck counter: escalates on the 3rd consecutive blocked grounding of the same step, despite fingerprint churn', () => {
  let step = mt10Step();
  const seen = [];
  for (let i = 0; i < 7; i += 1) {
    const out = nextStuckGrounding(step, { worldMinute: 1568000 + i * 60, reason: 'target_affordance_missing' });
    seen.push(out.escalate);
    step = { ...step, groundingDiagnostics: { groundingChecks: 1, stuck: out.stuck } };
  }
  assert.equal(STUCK_GROUNDING_ESCALATE_AFTER, 3);
  assert.deepEqual(seen, [false, false, true, false, false, true, false]);
  assert.equal(step.groundingDiagnostics.stuck.escalations, 2);
  assert.equal(step.groundingDiagnostics.stuck.count, 1);
});

test('stuck counter: time rule, other step resets, kill switch writes nothing', () => {
  const since = 1_500_000;
  const step = mt10Step({ groundingDiagnostics: { stuck: { stepId: mt10Step().stepId, count: 1, sinceWorldMinute: since, escalations: 0 } } });
  assert.equal(nextStuckGrounding(step, { worldMinute: since + STUCK_GROUNDING_MAX_WORLD_MINUTES - 1 }).escalate, false);
  assert.equal(nextStuckGrounding(step, { worldMinute: since + STUCK_GROUNDING_MAX_WORLD_MINUTES }).escalate, true);
  const other = { ...step, stepId: 'another:step' };
  const reset = nextStuckGrounding(other, { worldMinute: since + 99_999 });
  assert.equal(reset.escalate, false);
  assert.equal(reset.stuck.count, 1);
  assert.deepEqual(nextStuckGrounding(step, { worldMinute: since + 99_999, enabled: false }), { escalate: false, stuck: null });
});

test('escalation path ends in a model replan: pending executionReplan -> execution_replan_required trigger -> model call', () => {
  const plan = { id: 'plan-recover-then-contribute', goalId: 'goal-project-delivery', status: 'blocked', currentStep: 0, steps: [mt10Step()] };
  const replan = markExecutionReplanPending({ ...plan, status: 'replan_required' },
    { fingerprint: 'a'.repeat(64), reason: 'target_affordance_missing', targetId: ORG, targetType: 'organization', worldMinute: 1568300 });
  assert.equal(replan.status, 'replan_required');
  assert.deepEqual(eligibleExecutionReplanFingerprints([replan]), ['a'.repeat(64)]);
  const decision = shouldCallForMaterialChange({ context: { prior: { plans: [replan], goals: [] }, recentEvents: [] },
    previousFingerprint: 'same', trigger: 'execution_replan_required' });
  assert.equal(decision.call, true);
});

test('withStuckDiagnostics: blocked keeps the counter, grounded drops it, off (no counter) is unchanged', () => {
  const diag = { groundingChecks: 1 };
  const stuck = { stepId: 's', count: 2 };
  assert.deepEqual(withStuckDiagnostics(diag, { blocked: { stuckGrounding: stuck } }), { groundingChecks: 1, stuck });
  assert.equal(withStuckDiagnostics(diag, { blocked: { stuckGrounding: stuck }, grounding: { status: 'grounded' } }), diag);
  assert.equal(withStuckDiagnostics(diag, { blocked: { reason: 'x' } }), diag);
  assert.deepEqual(withStuckDiagnostics(null, { blocked: { stuckGrounding: stuck } }), { stuck });
});

// finishGroundingClaim against a mock pool: an escalated block is a replan request, never a success.
function groundingPool(plans, revision = 12) {
  const log = { sql: [], params: [] };
  const client = {
    async query(sql, params) {
      const text = String(sql); log.sql.push(text); log.params.push(params);
      if (text.startsWith('SELECT revision,lease_token,goals,plans,pending_action')) {
        return { rowCount: 1, rows: [{ revision: String(revision), lease_token: 'tok', goals: [], plans, pending_action: {} }] };
      }
      if (text.startsWith('SELECT world_minutes FROM world_runtime_state')) return { rowCount: 1, rows: [{ world_minutes: '1568300' }] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  return { pool: { async connect() { return client; } }, log };
}

test('escalated block: plan -> replan_required, review execution_replan_required, pending cleared, no effects, counter stored', async () => {
  const plan = { id: 'plan-recover-then-contribute', goalId: 'goal-project-delivery', status: 'blocked', currentStep: 0, steps: [mt10Step()] };
  const { pool, log } = groundingPool([plan]);
  const stuck = nextStuckGrounding(mt10Step({ groundingDiagnostics: { stuck: { stepId: mt10Step().stepId, count: 2, sinceWorldMinute: 1568000 } } }),
    { worldMinute: 1568300, reason: 'target_affordance_missing' });
  assert.equal(stuck.escalate, true);
  const retryCondition = { fingerprint: 'b'.repeat(64) };
  const result = await finishGroundingClaim(pool, WORLD, { agentId: MT10, revision: 12, token: 'tok' }, mt10Context(), {
    plan, step: mt10Step(), grounding: { status: 'blocked', reason: 'target_affordance_missing' },
    blocked: { reason: 'target_affordance_missing', retryCondition, replanRequired: true, stuckGrounding: stuck.stuck } });
  assert.equal(result.committed, true);
  assert.equal(result.groundingSucceeded, false);
  const update = log.params[log.sql.findIndex((sql) => sql.startsWith('UPDATE world_agent_cognition_state SET revision=revision+1,plans=$4'))];
  const saved = JSON.parse(update[3]);
  assert.equal(saved[0].status, 'replan_required');
  assert.equal(saved[0].executionReplans.at(-1).status, 'pending');
  assert.equal(saved[0].steps[0].groundingDiagnostics.stuck.escalations, 1);
  assert.equal(saved[0].steps[0].groundingDiagnostics.stuck.count, 0);
  assert.equal(saved[0].steps[0].executionEvidence, undefined);
  assert.equal(update[4], '{}', 'no pending action');
  assert.equal(update[6], 'execution_replan_required');
  assert.ok(!log.sql.some((sql) => sql.includes('bai_model_call_effects')), 'no success/attribution effects');
  assert.ok(log.sql.includes('COMMIT'));
});

test('stale claim (revision moved, e.g. duplicate worker) is rolled back and changes nothing', async () => {
  const plan = { id: 'p', goalId: 'g', status: 'blocked', currentStep: 0, steps: [mt10Step()] };
  const { pool, log } = groundingPool([plan], 13);
  const result = await finishGroundingClaim(pool, WORLD, { agentId: MT10, revision: 12, token: 'tok' }, mt10Context(), {
    plan, step: mt10Step(), blocked: { reason: 'target_affordance_missing', replanRequired: true } });
  assert.deepEqual(result, { committed: false, reason: 'stale_grounding' });
  assert.ok(log.sql.includes('ROLLBACK'));
  assert.ok(!log.sql.some((sql) => sql.startsWith('UPDATE world_agent_cognition_state')));
});

// ---------------------------------------------------------------- A2: typed snapshot target match
test('grounding: bare-uuid organization step now reaches the model with only that organization\'s candidates', async () => {
  const seen = [];
  const requestModel = async (input) => { seen.push(input); return { callId: CALL,
    output: { candidateId: `organization:contribute:${ORG}`, expectedOutcome: 'Effort recorded for the collective.' } }; };
  requestModel.recordApplicationResult = async () => {};
  const context = mt10Context();
  const out = await groundPlanStep({ requestModel, context, goal: { id: 'goal-project-delivery', title: 'Deliver' },
    plan: { id: 'plan-recover-then-contribute' }, step: mt10Step(), typedSnapshotMatch: true });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].promptSections.affordances.map((c) => c.id).sort(),
    [`organization:contribute:${ORG}`, `organization:leave:${ORG}`]);
  assert.equal(out.status, 'grounded');
  assert.equal(out.executableAction, 'organization_contribute');
  assert.equal(out.targetId, `organization:contribute:${ORG}`, 'snapshot spelling, which chainfix selection accepts');
});

test('grounding: kill switch off = the old deterministic block, model never called', async () => {
  let called = 0;
  const requestModel = async () => { called += 1; return {}; };
  const out = await groundPlanStep({ requestModel, context: mt10Context(), goal: { id: 'g' }, plan: { id: 'p' },
    step: mt10Step(), typedSnapshotMatch: false });
  assert.equal(out.status, 'blocked');
  assert.equal(out.reason, 'target_affordance_missing');
  assert.equal(called, 0);
});

test('grounding: typed match never widens to another organization or the wrong type', async () => {
  let called = 0;
  const requestModel = async () => { called += 1; return {}; };
  const missing = await groundPlanStep({ requestModel, context: { ...mt10Context(), availableAffordances: { candidates:
    snapshotCandidates().filter((c) => !c.id.includes(`:${ORG}`)) } }, goal: { id: 'g' }, plan: { id: 'p' },
  step: mt10Step(), typedSnapshotMatch: true });
  assert.equal(missing.status, 'blocked');
  const wrongType = await groundPlanStep({ requestModel, context: mt10Context(), goal: { id: 'g' }, plan: { id: 'p' },
    step: mt10Step({ targetType: 'business' }), typedSnapshotMatch: true });
  assert.equal(wrongType.status, 'blocked');
  assert.equal(called, 0);
});

// ---------------------------------------------------------------- A3: context backlog skip
const LAST_SEEN = 909008;
function ownEvents(count, start = LAST_SEEN + 10) {
  return Array.from({ length: count }, (_, i) => ({ id: String(start + i * 7), event_type: i % 3 ? 'world.agent_arrived' : 'world.project_contribution',
    data: { n: i }, action_id: `a-${start + i * 7}`, created_at: new Date(1_760_000_000_000 + i * 1000).toISOString() }));
}
function contextPool({ relevantCount, scanCursor, plans = [], pinnedRows = [] }) {
  const log = { sql: [], params: [] };
  const events = ownEvents(relevantCount);
  const client = {
    async query(sql, params) {
      const text = String(sql); log.sql.push(text); log.params.push(params);
      if (text.startsWith('SELECT world_minutes,tick_count')) return { rowCount: 1, rows: [{ world_minutes: '1568212', tick_count: '1', environment: {} }] };
      if (text.includes('FROM world_members m JOIN agents a')) return { rowCount: 1, rows: [{ name: 'MirrorTerra-10', location: 'home' }] };
      if (text.startsWith('SELECT * FROM world_agent_cognition_state')) return { rowCount: 1, rows: [{ revision: '3',
        last_context_event_id: String(LAST_SEEN), plans, goals: [], available_affordances: [], pending_action: {} }] };
      if (text.includes('WITH last_seen AS (')) {
        const picked = events.slice(0, 101);
        const rows = picked.length ? picked.map((row) => ({ ...row, scan_cursor: String(scanCursor) })) : [{ id: null, scan_cursor: String(scanCursor) }];
        return { rowCount: rows.length, rows };
      }
      if (text === CONTEXT_LATEST_EVENTS_SQL) { const rows = events.slice(-100).reverse(); return { rowCount: rows.length, rows }; }
      if (text === CONTEXT_PINNED_EVENTS_SQL) return { rowCount: pinnedRows.length, rows: pinnedRows };
      return { rowCount: 0, rows: [] };
    },
    release() {}
  };
  return { pool: { async connect() { return client; } }, log };
}
const quiet = () => {};

test('backlog skip: far-behind cursor shows the newest 100 events, says how many were skipped, cursor jumps to newest', async () => {
  const relevantCount = 400;
  const scanCursor = LAST_SEEN + CURSOR_SKIP_LAG_IDS + 50_000;
  const events = ownEvents(relevantCount);
  const ownExecution = { id: String(LAST_SEEN + 500), event_type: 'world.action_completed',
    data: { action: 'organization_contribute', cognitionExecution: { planId: 'p' } }, action_id: 'exec', created_at: new Date().toISOString() };
  const plans = [{ id: 'p', steps: [{ executionEvidence: { success: true, eventId: LAST_SEEN + 500 } }, { executionEvidence: { eventId: 1 } }] }];
  const { pool, log } = contextPool({ relevantCount, scanCursor, plans, pinnedRows: [ownExecution] });
  const lines = [];
  const { context } = await readCognitionContext(pool, { worldId: WORLD, agentId: MT10 },
    { contextFix: true, cursorFix: true, log: (event, fields) => lines.push(fields) });
  const delta = context.world.delta;
  assert.equal(delta.hasMore, false);
  assert.equal(delta.cursor, scanCursor);
  assert.deepEqual(context.recentEvents.slice(1).map((e) => e.id), events.slice(-100).map((e) => Number(e.id)));
  assert.equal(context.recentEvents[0].id, LAST_SEEN + 500, 'own plan-executed event in the skipped range is pinned');
  assert.equal(delta.eventCount, 101);
  assert.equal(delta.skipped.count, 101, 'lower bound from the rows the oldest-first read already returned');
  assert.equal(delta.skipped.countIsLowerBound, true);
  assert.equal(delta.skipped.estimatedCount, 301, 'true number skipped is 300');
  assert.equal(delta.skipped.afterEventId, LAST_SEEN);
  assert.equal(delta.skipped.beforeEventId, Number(events.at(-100).id));
  assert.match(delta.skipped.note, /^Skipped at least 101 \(about 301\) earlier unseen events of yours/);
  assert.equal(log.sql.filter((sql) => sql.includes('count(')).length, 0, 'no extra count query');
  assert.deepEqual(log.params[log.sql.indexOf(CONTEXT_PINNED_EVENTS_SQL)][2], [LAST_SEEN + 500]);
  assert.equal(lines[0].skipped, 101);
  assert.match(CONTEXT_LATEST_EVENTS_SQL, /ORDER BY event\.id DESC LIMIT 100$/);
});

test('backlog skip: count helper; small lag or no backlog -> exactly the ctxfix1 delta; kill switch off -> ctxfix1', async () => {
  const far = LAST_SEEN + CURSOR_SKIP_LAG_IDS + 1;
  const few = ownEvents(50);
  assert.deepEqual(skippedCount(few, ownEvents(100, 920000), { afterId: LAST_SEEN, beforeId: 920000 }),
    { count: 50, lowerBound: false, estimate: 50 });
  for (const [count, scan, cursorFix] of [[300, LAST_SEEN + CURSOR_SKIP_LAG_IDS - 1, true], [80, far, true], [300, far, false]]) {
    const { pool, log } = contextPool({ relevantCount: count, scanCursor: scan });
    const { context } = await readCognitionContext(pool, { worldId: WORLD, agentId: MT10 }, { contextFix: true, cursorFix, log: quiet });
    assert.equal(context.world.delta.skipped, undefined);
    assert.equal(context.world.delta.hasMore, count > 100);
    assert.equal(context.recentEvents[0].id, LAST_SEEN + 10, 'oldest-first, unchanged');
    assert.ok(!log.sql.includes(CONTEXT_LATEST_EVENTS_SQL));
  }
  assert.equal(shouldSkipBacklog({ hasMore: true, scanCursor: far, stateCursor: LAST_SEEN, contextFix: false }), false);
  assert.deepEqual(pinnedOwnEventIds([{ steps: [{ executionEvidence: { eventId: 5 } }, { executionEvidence: { eventId: 50 } }] }],
    { afterId: 5, beforeId: 60 }), [50]);
});

// ---------------------------------------------------------------- kill switches
test('kill switches: MIRRORTERRA_CURSOR_FIX / MIRRORTERRA_BUILD_GUARD_FIX via env or tickfix-flags.json (file wins)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ctxfix2-'));
  try {
    const file = path.join(dir, 'tickfix-flags.json');
    for (const [key, make] of [[CURSOR_FIX_KEY, createCursorFixFlags], [BUILD_GUARD_FIX_KEY, createBuildGuardFixFlags]]) {
      assert.equal(make({ env: {}, file }).enabled(), true, `${key} default on`);
      assert.equal(make({ env: { [key]: 'off' }, file }).enabled(), false);
      writeFileSync(file, JSON.stringify({ [key]: 'on', MIRRORTERRA_CHAIN_FIX: 'on' }));
      assert.equal(make({ env: { [key]: 'off' }, file }).enabled(), true, 'file wins');
      writeFileSync(file, JSON.stringify({ [key]: 'off' }));
      assert.equal(make({ env: {}, file }).enabled(), false);
      writeFileSync(file, '{not json');
      assert.equal(make({ env: {}, file }).enabled(), true, 'bad file = default');
      rmSync(file);
    }
    assert.equal(CURSOR_FIX_KEY, 'MIRRORTERRA_CURSOR_FIX');
    assert.equal(BUILD_GUARD_FIX_KEY, 'MIRRORTERRA_BUILD_GUARD_FIX');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- B: place build guard
const STUDIOS = Array.from({ length: 18 }, (_, i) => ({ name: `Studio ${i}`, capacity: 10, occupancy: 0, createdWorldMinute: 1_433_072 + i * 7000 }));

test('placeBuildDecision: spare capacity, same type in progress, 48 h cooldown; completion ignores its own proposal', () => {
  const now = 1_570_000;
  assert.equal(placeBuildDecision({ placeType: 'studio', places: STUDIOS, worldMinute: now }).reason, 'same_type_has_spare_capacity');
  assert.equal(placeBuildDecision({ placeType: 'studio', places: STUDIOS, openSameType: 1, worldMinute: now }).reason, 'same_type_in_progress');
  const full = [{ name: 'A', capacity: 10, occupancy: 8, createdWorldMinute: now - PLACE_GUARD_COOLDOWN_MINUTES + 1 }];
  assert.equal(placeBuildDecision({ placeType: 'studio', places: full, worldMinute: now }).reason, 'same_type_cooldown_48h');
  const fullOld = [{ ...full[0], createdWorldMinute: now - PLACE_GUARD_COOLDOWN_MINUTES }];
  assert.equal(placeBuildDecision({ placeType: 'studio', places: fullOld, worldMinute: now }).ok, true);
  assert.equal(placeBuildDecision({ placeType: 'studio', places: fullOld, lastProposedMinute: now - 10, worldMinute: now }).reason,
    'same_type_cooldown_48h');
  assert.equal(placeBuildDecision({ placeType: 'studio', places: fullOld, openSameType: 3, lastProposedMinute: now - 10,
    worldMinute: now, phase: 'complete' }).ok, true);
  assert.equal(placeBuildDecision({ placeType: 'library', places: [], worldMinute: now }).ok, true, 'first of a type is allowed');
});

function projectClient({ studios = STUDIOS, open = 0, lastProposed = null } = {}) {
  const log = { sql: [], params: [] };
  return { log, client: { async query(sql, params) {
    const text = String(sql); log.sql.push(text); log.params.push(params);
    if (text.startsWith('SELECT 1 FROM world_members')) return { rowCount: 1, rows: [{}] };
    if (text.includes('world_genesis_currency_activations')) return { rowCount: 1, rows: [{ tokenId: 't' }] };
    if (text.includes('AS "ownedCount"')) return { rowCount: 1, rows: [{ ownedCount: 0, worldCount: 5 }] };
    if (text.includes('FROM world_scenes scene WHERE scene.world_id=$1 AND scene.scene_type=$2')) return { rowCount: studios.length, rows: studios };
    if (text.includes('AS "openSameType"')) return { rowCount: 1, rows: [{ openSameType: open, lastProposedMinute: lastProposed }] };
    if (text.startsWith('INSERT INTO world_projects')) return { rowCount: 1, rows: [{ id: 'p-new', status: 'recruiting', progress: '0' }] };
    return { rowCount: 0, rows: [] };
  } } };
}
// The proposal Visitor-Hark's fallback engine makes when Synterra-04's Cafe is crowded (world-initiatives).
function visitorProposal(extra = {}) {
  return { worldId: WORLD, agentId: VISITOR, actionId: 'visitor-propose-0001', projectType: 'BUILD',
    title: 'Community Workshop Extension', goal: "Create a useful alternative to the crowded Synterra-04's Cafe.",
    description: "Create a useful alternative to the crowded Synterra-04's Cafe. Participation requires several actions.",
    requiredSkills: { engineering: 12 }, requiredResources: { effortPoints: 45, maxParticipants: 6 },
    reward: { skill: 'engineering', skillGain: 2, relationship: 1 }, worldTime: 1_570_000,
    metadata: { createPlace: true, placeType: 'studio', placeCapacity: 10,
      placePurpose: "A resident-created alternative for Synterra-04's Cafe that adds capacity for the shared world.",
      crowdedSceneId: 'cafe-04' }, ...extra };
}
const savedMetadata = (log) => JSON.parse(log.params[log.sql.findIndex((sql) => sql.startsWith('INSERT INTO world_projects'))][15]);

test('visitor proposal while 18 studios stand empty: still a project, but no new place (rule recorded)', async () => {
  process.env[BUILD_GUARD_FIX_KEY] = 'on';
  const { client, log } = projectClient();
  const project = await proposeWorldProject(client, visitorProposal());
  assert.equal(project.id, 'p-new');
  const metadata = savedMetadata(log);
  assert.equal(metadata.createPlace, false);
  assert.equal(metadata.placeGuard.reason, 'same_type_has_spare_capacity');
  assert.equal(metadata.placeGuard.spare, 18);
  assert.equal(metadata.placeGuard.phase, 'propose');
});

test('visitor is bound by in-progress and cooldown rules too; a justified build passes; kill switch off = old behaviour', async () => {
  process.env[BUILD_GUARD_FIX_KEY] = 'on';
  const busy = [{ name: 'Busy Studio', capacity: 10, occupancy: 9, createdWorldMinute: 1_000_000 }];
  let run = projectClient({ studios: busy, open: 1 });
  await proposeWorldProject(run.client, visitorProposal());
  assert.equal(savedMetadata(run.log).placeGuard.reason, 'same_type_in_progress');
  run = projectClient({ studios: busy, lastProposed: 1_569_000 });
  await proposeWorldProject(run.client, visitorProposal());
  assert.equal(savedMetadata(run.log).placeGuard.reason, 'same_type_cooldown_48h');
  run = projectClient({ studios: busy, lastProposed: 1_500_000 });
  await proposeWorldProject(run.client, visitorProposal());
  assert.equal(savedMetadata(run.log).createPlace, true);
  assert.equal(savedMetadata(run.log).placeGuard, undefined);
  process.env[BUILD_GUARD_FIX_KEY] = 'off';
  try {
    run = projectClient();
    await proposeWorldProject(run.client, visitorProposal({ actionId: 'visitor-propose-0002' }));
    assert.equal(savedMetadata(run.log).createPlace, true);
    assert.ok(!run.log.sql.some((sql) => sql.includes('scene.scene_type=$2')), 'no guard queries when off');
  } finally { process.env[BUILD_GUARD_FIX_KEY] = 'on'; }
  run = projectClient();
  await proposeWorldProject(run.client, visitorProposal({ metadata: { createPlace: false, placeType: 'studio' } }));
  assert.ok(!run.log.sql.some((sql) => sql.includes('scene.scene_type=$2')), 'ordinary projects are not touched');
});
