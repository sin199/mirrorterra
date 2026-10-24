// chainfix1: resident plan -> grounding -> tick selection -> World event -> completion/attribution.
// Mock clients only; no database, no network.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { candidateMatchesPending, choosePlannedAffordance, completePlannedAction }
  from '../src/agent-runtime/open-cognition/selection.js';
import { BUDGET_FALLBACK_RETRY_MS, MAX_BUDGET_DEFERRAL_MS, budgetDeferralClause, capBudgetDeferral,
  deferredUntilFor, pendingCandidateOffered } from '../src/agent-runtime/open-cognition/worker.js';
import { CHAIN_FIX_KEY, createChainFixFlags } from '../src/agent-runtime/open-cognition/chainfix-flags.js';

const ORG = '97cef63d-9efa-4f28-9e6c-956c77ed6598';
const OTHER_ORG = '43f52516-13a2-4034-88be-d07d3241af37';
const CANDIDATE_ID = `organization:contribute:${ORG}`;
const CALLS = ['0a641366-0000-4000-8000-000000000001', '9a8ba806-0000-4000-8000-000000000002',
  '87d4a39a-0000-4000-8000-000000000003'];

// The grounded pending action exactly as production stores it for MirrorTerra-02 (snapshot spelling:
// the advertised affordance snapshot carries no organizationId, so targetId = candidate id).
function pendingAction(overrides = {}) {
  return { goalId: 'goal-collective', planId: 'plan-community-contribution-practice', stepId: 'step:0-collective',
    intentId: 'intent-collective', candidateId: CANDIDATE_ID, executableAction: 'organization_contribute',
    targetId: CANDIDATE_ID, executionCorrelationId: '75789f1f-0000-4000-8000-000000000009',
    modelCallId: CALLS[2], attributionModelCallIds: [...CALLS], attributionTurnId: '936',
    affordanceFingerprint: 'fp-1', expectedOutcome: 'Effort contributed to the collective.', ...overrides };
}
function cognitionState(pending = pendingAction(), steps = 2) {
  return { revision: 7, pending_action: pending,
    plans: [{ id: pending.planId, goalId: pending.goalId, status: 'active', currentStep: 0,
      steps: Array.from({ length: steps }, (_, index) => index === 0
        ? { stepId: pending.stepId, intentId: pending.intentId, description: 'Contribute effort to the collective.' }
        : { stepId: `step:${index}`, intentId: `intent-${index}`, description: 'Follow up.' }) }] };
}
const liveCandidate = (org = ORG) => ({ id: `organization:contribute:${org}`, action: 'organization_contribute',
  organizationId: org, contributionType: 'effort', score: 3 });
const snapshotCandidate = (org = ORG) => ({ id: `organization:contribute:${org}`, action: 'organization_contribute',
  score: 3 }); // what state.available_affordances holds (no organizationId)

// Mirrors world-engine.js (~3318-3337): planned_context from the tick selection.
function plannedContextFrom(state, selection) {
  const plan = state.plans.find((item) => item.id === selection.planId);
  const step = plan.steps[selection.stepIndex];
  return { cognitionRevision: Number(state.revision), cognitionSource: selection.source,
    cognitionPlanId: selection.planId, cognitionGoalId: plan.goalId || state.pending_action.goalId || null,
    cognitionStepIndex: selection.stepIndex, cognitionStepId: step.stepId,
    cognitionIntentId: selection.intentId || step.intentId, cognitionCandidateId: selection.candidateId,
    cognitionExecutableAction: selection.executableAction, cognitionTargetId: selection.targetId || null,
    cognitionExecutionCorrelationId: selection.executionCorrelationId || null,
    cognitionModelCallId: selection.modelCallId || null, cognitionModelCallIds: selection.modelCallIds || [],
    cognitionTurnId: selection.cognitionTurnId || null, cognitionExecutionSource: selection.source,
    cognitionAffordanceFingerprint: selection.affordanceFingerprint || null,
    cognitionExpectedOutcome: selection.expectedOutcome || null };
}
// Mirrors world-engine.js (~1639-1656): the authoritative completion event.
function completionEvent(id, context, activity, { abandoned = false } = {}) {
  return { id, event_type: 'world.action_completed', data: { status: 'completed',
    ...(abandoned ? { abandoned: true } : {}),
    cognitionExecution: { goalId: context.cognitionGoalId || null, planId: context.cognitionPlanId,
      stepId: context.cognitionStepId, intentId: context.cognitionIntentId, candidateId: context.cognitionCandidateId,
      correlationId: context.cognitionExecutionCorrelationId, cognitionTurnId: context.cognitionTurnId || null,
      modelCallId: context.cognitionModelCallId || null, modelCallIds: context.cognitionModelCallIds || [],
      executionSource: context.cognitionExecutionSource || null, action: activity,
      targetId: context.cognitionTargetId || null } } };
}
// Stateful mock client: one cognition-state row, a world_events table and the effects ledger.
function mockDb(state, events) {
  const db = { state: structuredClone(state), effects: [], memories: [], callResults: [] };
  db.client = { query: async (sql, params = []) => {
    if (sql.includes('FROM world_events event')) {
      const row = events.find((event) => event.id === params[2]);
      return row ? { rowCount: 1, rows: [structuredClone(row)] } : { rowCount: 0, rows: [] };
    }
    if (sql.includes('SELECT revision,plans,pending_action')) return { rowCount: 1, rows: [{ revision: db.state.revision,
      plans: structuredClone(db.state.plans), pending_action: structuredClone(db.state.pending_action),
      next_review_world_minute: 5000 }] };
    if (sql.includes('UPDATE world_agent_cognition_state')) {
      db.state.revision += 1; db.state.plans = JSON.parse(params[2]); db.state.pending_action = JSON.parse(params[3]);
      db.state.review_reason = params[5]; return { rowCount: 1, rows: [] };
    }
    if (sql.includes('INSERT INTO world_agent_cognition_memories')) { db.memories.push(params); return { rowCount: 1, rows: [] }; }
    if (sql.includes('UPDATE world_agent_cognition_model_calls')) { db.callResults.push(params[2]); return { rowCount: 1, rows: [] }; }
    if (sql.includes('INSERT INTO bai_model_call_effects')) {
      const type = sql.match(/VALUES\(\$1,'([a-z_]+)'/)[1];
      db.effects.push({ callId: params[0], type, turnId: params[1], planId: params[3], stepId: params[4], eventId: params[5] });
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  } };
  return db;
}
const complete = (db, context, eventId, activity = 'organization_contribute', abandoned = false) =>
  completePlannedAction(db.client, { worldId: 'w', agentId: 'MirrorTerra-02', context, abandoned,
    worldMinute: 4000, completionEventId: eventId, actionType: activity });

test('full chain: snapshot-spelled org pending is selected, executed, advanced and attributed', async () => {
  const state = cognitionState();
  const selection = choosePlannedAffordance(state, [liveCandidate(OTHER_ORG), liveCandidate()], { chainFix: true });
  assert.equal(selection.source, 'plan_continuation');
  assert.equal(selection.candidate?.id, CANDIDATE_ID);
  assert.equal(selection.candidate.organizationId, ORG);
  assert.equal(selection.targetId, CANDIDATE_ID);
  assert.deepEqual(selection.modelCallIds, CALLS);
  assert.equal(selection.cognitionTurnId, '936');
  const context = plannedContextFrom(state, selection);
  const db = mockDb(state, [completionEvent(1400001, context, 'organization_contribute')]);
  const result = await complete(db, context, 1400001);
  assert.deepEqual(result, { updated: true, advanced: true, blocked: false, completed: false });
  assert.equal(db.state.plans[0].currentStep, 1);
  assert.equal(db.state.plans[0].steps[0].status, 'completed');
  assert.equal(db.state.plans[0].steps[0].executionEvidence.eventId, 1400001);
  assert.deepEqual(db.state.pending_action, {});
  assert.equal(db.state.review_reason, 'plan_step_completed');
  assert.deepEqual(db.callResults, ['succeeded']);
  assert.equal(db.effects.filter((e) => e.type === 'world_execution').length, 3);
  assert.equal(db.effects.filter((e) => e.type === 'plan_step_completed').length, 3);
  assert.equal(db.effects.filter((e) => e.type === 'plan_completed').length, 0);
  for (const effect of db.effects) {
    assert.equal(effect.eventId, 1400001); assert.equal(effect.turnId, '936');
    assert.equal(effect.planId, state.plans[0].id); assert.equal(effect.stepId, 'step:0-collective');
  }
  // last step -> plan_completed too
  const single = cognitionState(pendingAction(), 1);
  const ctx1 = plannedContextFrom(single, choosePlannedAffordance(single, [liveCandidate()], { chainFix: true }));
  const db1 = mockDb(single, [completionEvent(1400002, ctx1, 'organization_contribute')]);
  assert.equal((await complete(db1, ctx1, 1400002)).completed, true);
  assert.equal(db1.effects.filter((e) => e.type === 'plan_completed').length, 3);
});

test('canonical target spelling still matches (organizationId as targetId)', () => {
  const state = cognitionState(pendingAction({ targetId: ORG }));
  assert.equal(choosePlannedAffordance(state, [liveCandidate()], { chainFix: true }).candidate?.id, CANDIDATE_ID);
  assert.equal(choosePlannedAffordance(state, [liveCandidate()], { chainFix: false }).candidate?.id, CANDIDATE_ID);
});

test('missing attribution: plan still advances but no effects are written', async () => {
  const state = cognitionState(pendingAction({ attributionModelCallIds: undefined, attributionTurnId: undefined,
    modelCallId: undefined }));
  const selection = choosePlannedAffordance(state, [liveCandidate()], { chainFix: true });
  assert.equal(selection.candidate?.id, CANDIDATE_ID);
  assert.deepEqual(selection.modelCallIds, []);
  const context = plannedContextFrom(state, selection);
  const db = mockDb(state, [completionEvent(1400003, context, 'organization_contribute')]);
  const result = await complete(db, context, 1400003);
  assert.equal(result.advanced, true);
  assert.equal(db.state.plans[0].currentStep, 1);
  assert.equal(db.effects.length, 0);
});

test('abandoned execution: step blocked, call marked failed, no success effects', async () => {
  const state = cognitionState();
  const context = plannedContextFrom(state, choosePlannedAffordance(state, [liveCandidate()], { chainFix: true }));
  for (const viaFlag of [true, false]) {
    const db = mockDb(state, [completionEvent(1400004, context, 'organization_contribute', { abandoned: !viaFlag })]);
    const result = await complete(db, context, 1400004, 'organization_contribute', viaFlag);
    assert.equal(result.updated, true); assert.equal(result.blocked, true); assert.equal(result.advanced, false);
    assert.equal(db.state.plans[0].status, 'blocked');
    assert.equal(db.state.plans[0].currentStep, 0);
    assert.equal(db.state.plans[0].steps[0].status, 'blocked');
    assert.equal(db.state.review_reason, 'plan_blocked');
    assert.deepEqual(db.callResults, ['failed']);
    assert.equal(db.effects.length, 0);
  }
});

test('duplicate processing of the same completion event is not a second success', async () => {
  const state = cognitionState();
  const context = plannedContextFrom(state, choosePlannedAffordance(state, [liveCandidate()], { chainFix: true }));
  const db = mockDb(state, [completionEvent(1400005, context, 'organization_contribute')]);
  assert.equal((await complete(db, context, 1400005)).advanced, true);
  const effectsAfterFirst = db.effects.length;
  const second = await complete(db, context, 1400005);
  assert.equal(second.updated, false);
  assert.equal(second.reason, 'plan_step_or_execution_changed');
  assert.equal(db.effects.length, effectsAfterFirst);
  assert.equal(db.state.plans[0].currentStep, 1);
  // a mismatched event (wrong action / other target) never counts
  const db2 = mockDb(state, [completionEvent(1400006, { ...context, cognitionTargetId: OTHER_ORG }, 'organization_contribute')]);
  assert.equal((await complete(db2, context, 1400006)).reason, 'authoritative_execution_evidence_missing');
  assert.equal(db2.effects.length, 0);
});

test('restart recovery: planned_context survives a JSON round trip and still completes once', async () => {
  const persisted = JSON.parse(JSON.stringify(cognitionState()));
  const selection = choosePlannedAffordance(persisted, JSON.parse(JSON.stringify([liveCandidate()])), { chainFix: true });
  const context = JSON.parse(JSON.stringify(plannedContextFrom(persisted, selection))); // world_agent_states.planned_context jsonb
  const db = mockDb(persisted, [completionEvent(1400007, context, 'organization_contribute')]);
  assert.equal((await complete(db, context, 1400007)).advanced, true);
  assert.equal(db.effects.filter((e) => e.type === 'world_execution').length, 3);
  // pending already cleared (crash after commit, replay): no second completion
  const replay = await complete(db, JSON.parse(JSON.stringify(context)), 1400007);
  assert.equal(replay.updated, false);
  assert.equal(db.effects.filter((e) => e.type === 'world_execution').length, 3);
});

test("another organization's candidate is never selected; tick and worker agree", () => {
  const state = cognitionState();
  const pending = state.pending_action;
  for (const chainFix of [true, false]) {
    const blocked = choosePlannedAffordance(state, [liveCandidate(OTHER_ORG)], { chainFix });
    assert.equal(blocked.candidate, null); assert.equal(blocked.blocked, 'grounded_candidate_unavailable');
  }
  assert.equal(candidateMatchesPending(liveCandidate(OTHER_ORG), pending, { chainFix: true }), false);
  assert.equal(candidateMatchesPending({ ...liveCandidate(), action: 'organization_leave' }, pending, { chainFix: true }), false);
  // same id but a foreign canonical target AND a foreign spelled target: not selected
  assert.equal(candidateMatchesPending(liveCandidate(), { ...pending, targetId: OTHER_ORG }, { chainFix: true }), false);
  // tick (live candidates with organizationId) and worker (advertised snapshot) give the same verdict
  const cases = [
    { live: [liveCandidate()], snapshot: [snapshotCandidate()], pending, expect: true },
    { live: [liveCandidate(OTHER_ORG)], snapshot: [snapshotCandidate(OTHER_ORG)], pending, expect: false },
    // canonical spelling: production grounding cannot produce it for org candidates (the snapshot has no
    // organizationId); the snapshot-side worker then re-grounds instead of deferring, so no loop either way.
    { live: [liveCandidate()], snapshot: [snapshotCandidate()], pending: pendingAction({ targetId: ORG }), expect: true,
      snapshotExpect: false },
    { live: [liveCandidate()], snapshot: [snapshotCandidate()], pending: pendingAction({ targetId: OTHER_ORG }), expect: false },
    { live: [], snapshot: [], pending, expect: false }
  ];
  for (const item of cases) {
    const tick = Boolean(choosePlannedAffordance(cognitionState(item.pending), item.live, { chainFix: true }).candidate);
    const workerOnLive = pendingCandidateOffered(item.live, item.pending, { chainFix: true });
    const workerOnSnapshot = pendingCandidateOffered(item.snapshot, item.pending, { chainFix: true });
    assert.equal(tick, item.expect); assert.equal(workerOnLive, item.expect);
    assert.equal(workerOnSnapshot, item.snapshotExpect ?? item.expect);
  }
  // the bug this fixes: old tick said "unavailable" while the old worker said "still offered"
  assert.equal(choosePlannedAffordance(state, [liveCandidate()], { chainFix: false }).blocked, 'grounded_candidate_unavailable');
  assert.equal(pendingCandidateOffered([snapshotCandidate()], pending, { chainFix: false }), true);
});

test('budget deferral: fallback <= 5 min, every deferral capped at 25 h, stale rows ignored by claim', async () => {
  const unavailable = Object.assign(new Error('BAI_BUDGET_UNAVAILABLE'), { code: 'BAI_BUDGET_UNAVAILABLE' });
  const gateway = (admission = {}) => ({ availability: async () => ({ budgetAvailable: true,
    nextAdmissionPossibleAt: null, nextRateSlotAt: null, ...admission }) });
  const before = Date.now();
  const fallback = new Date(await deferredUntilFor(gateway(), unavailable, { chainFix: true })).getTime();
  assert.ok(fallback - before <= BUDGET_FALLBACK_RETRY_MS + 1000, 'fallback <= 5 min');
  assert.ok(fallback >= before + BUDGET_FALLBACK_RETRY_MS - 1000);
  const thirtyDays = new Date(Date.now() + 30 * 86_400_000).toISOString();
  const capped = new Date(await deferredUntilFor(gateway(), { code: 'MODEL_DAILY_BUDGET_EXCEEDED',
    nextAdmissionPossibleAt: thirtyDays }, { chainFix: true })).getTime();
  assert.ok(capped - Date.now() <= MAX_BUDGET_DEFERRAL_MS + 1000 && capped - Date.now() > MAX_BUDGET_DEFERRAL_MS - 5000);
  const viaAvailability = new Date(await deferredUntilFor(gateway({ nextRateSlotAt: thirtyDays }), unavailable,
    { chainFix: true })).getTime();
  assert.ok(viaAvailability - Date.now() <= MAX_BUDGET_DEFERRAL_MS + 1000);
  const soon = new Date(Date.now() + 20 * 60_000).toISOString(); // legitimate deferral kept exactly
  assert.equal(await deferredUntilFor(gateway(), { nextAdmissionPossibleAt: soon }, { chainFix: true }), soon);
  assert.equal(capBudgetDeferral('not a date', 1_000_000), new Date(1_000_000 + BUDGET_FALLBACK_RETRY_MS).toISOString());
  const clause = budgetDeferralClause(true);
  assert.match(clause, /budget_deferred_until IS NULL OR state\.budget_deferred_until<=now\(\)/);
  assert.match(clause, /OR state\.budget_deferred_until>now\(\)\+interval '25 hours'/);
  assert.equal(budgetDeferralClause(false), '(state.budget_deferred_until IS NULL OR state.budget_deferred_until<=now())');
});

test('kill switch: MIRRORTERRA_CHAIN_FIX=off restores old matching and old scheduling', async () => {
  const state = cognitionState();
  assert.equal(choosePlannedAffordance(state, [liveCandidate()], { chainFix: false }).blocked, 'grounded_candidate_unavailable');
  const unavailable = { code: 'BAI_BUDGET_UNAVAILABLE' };
  const old = new Date(await deferredUntilFor({ availability: async () => ({}) }, unavailable, { chainFix: false })).getTime();
  assert.ok(old - Date.now() > 9 * 86_400_000, 'old 10-day fallback');
  const far = 'Sun 2026-11-22 8:00 PM CST (UTC+08:00)';
  assert.equal(await deferredUntilFor({ availability: async () => ({}) }, { nextAdmissionPossibleAt: far }, { chainFix: false }), far);
  // flag reader: env and tickfix-flags.json (file wins, re-read within 15 s)
  const dir = mkdtempSync(path.join(tmpdir(), 'chainfix-'));
  const file = path.join(dir, 'tickfix-flags.json');
  try {
    let t = 0;
    assert.equal(createChainFixFlags({ env: {}, file, now: () => t }).enabled(), true);
    assert.equal(createChainFixFlags({ env: { [CHAIN_FIX_KEY]: 'off' }, file, now: () => t }).enabled(), false);
    assert.equal(createChainFixFlags({ env: { [CHAIN_FIX_KEY]: 'on' }, file, now: () => t }).enabled(), true);
    const flags = createChainFixFlags({ env: { [CHAIN_FIX_KEY]: 'on' }, file, now: () => t });
    assert.equal(flags.enabled(), true);
    writeFileSync(file, JSON.stringify({ [CHAIN_FIX_KEY]: 'off', MIRRORTERRA_BAI_SETTLE_RETRY: 'on' }));
    t = 10_000; assert.equal(flags.enabled(), true, 'cached < 15 s');
    t = 15_001; assert.equal(flags.enabled(), false, 'file off wins after reload');
    writeFileSync(file, '{not json');
    t = 31_000; assert.equal(flags.enabled(), true, 'unreadable file = env value');
    writeFileSync(file, JSON.stringify({ [CHAIN_FIX_KEY]: false }));
    t = 47_000; assert.equal(flags.enabled(), false);
    const viaEnvFile = createChainFixFlags({ env: { MIRRORTERRA_TICKFIX_FLAGS_FILE: file }, now: () => 0 });
    assert.equal(viaEnvFile.enabled(), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
