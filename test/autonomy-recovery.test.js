import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { clearRevisedRuntime, planRevisionChanged, reconcilePlan,
  shouldEscalateBlocked } from '../src/agent-runtime/open-cognition/lifecycle.js';
import { completePendingExecutionReplans, groundPlanStep, retryFingerprintFor }
  from '../src/agent-runtime/open-cognition/grounding.js';
import { completePlannedAction, choosePlannedAffordance, routineFallbackCandidates }
  from '../src/agent-runtime/open-cognition/selection.js';
import { hasPendingExecutionReplan, nextScheduledSlot, shouldCallForMaterialChange,
  SCHEDULE_PERIOD_MS } from '../src/agent-runtime/open-cognition/schedule.js';
import { toolCallFingerprint } from '../src/agent-runtime/open-cognition/tool-call-guard.js';

const id = '10000000-0000-4000-8000-000000000101';
const step = { stepId: 'step-1', intentId: 'intent-1', intent: 'Contribute to the project',
  description: 'Contribute to the project', actionType: 'world_action', targetBindingMode: 'exact',
  targetType: 'project', targetId: `project:contribute:${id}` };
const plan = (override = {}) => ({ id: 'plan-1', goalId: 'goal-1', status: 'blocked',
  currentStep: 0, steps: [{ ...step }], ...override });
const options = { worldMinute: 1_000, state: { location: 'Workshop', energy: 80, food: 80 },
  affordances: [], capabilities: [], syncBalances: [] };

test('terminal target creates exactly one durable replan need across repeated ticks', () => {
  const blocked = plan({ steps: [{ ...step, groundingBlocked: {
    reason: 'target_affordance_missing', observedWorldMinute: 900 } }] });
  const terminal = { ...options, targetState: { lookupSupported: true, type: 'project', id,
    exists: true, status: 'failed', stateVersion: 'v7|failed' } };
  const first = reconcilePlan(blocked, terminal);
  assert.equal(first.status, 'replan_required');
  assert.equal(first.steps[0].groundingBlocked.reason, 'target_state_changed');
  assert.equal(first.executionReplans.length, 1);
  assert.equal(first.executionReplans[0].targetStateVersion, 'v7|failed');
  assert.deepEqual(reconcilePlan(first, { ...terminal, worldMinute: 1_001 }), first);
  assert.equal(hasPendingExecutionReplan([first]), true);
});

test('legacy invalid and missing blocks become bounded replans; new fingerprint resets attempts', () => {
  for (const reason of ['grounding_invalid', 'target_affordance_missing']) {
    const legacy = plan({ steps: [{ ...step, groundingBlocked: { reason,
      observedWorldMinute: 500 }, groundingDiagnostics: { groundingChecks: 1,
      retryGateChecks: 4 } }] });
    const recovered = reconcilePlan(legacy, options);
    assert.equal(recovered.status, 'replan_required');
    assert.equal(recovered.executionReplans.length, 1);
  }
  const first = retryFingerprintFor({ reason: 'grounding_invalid', step,
    state: options.state, affordances: [] });
  const changed = retryFingerprintFor({ reason: 'grounding_invalid', step: {
    ...step, intent: 'Inspect a different project', targetId: 'project:contribute:other' },
    state: options.state, affordances: [] });
  assert.notEqual(first.fingerprint, changed.fingerprint);
  assert.equal(shouldEscalateBlocked({ groundingBlocked: { reason: 'grounding_invalid',
    retryFingerprint: first.fingerprint, observedWorldMinute: 900 },
    groundingDiagnostics: { groundingChecks: 5 } }, 'grounding_invalid', 1_000,
  changed.fingerprint), false);
  const fresh = plan({ steps: [{ ...step, status: 'blocked', groundingBlocked: {
    reason: 'target_affordance_missing', observedWorldMinute: 999 },
  groundingDiagnostics: { groundingChecks: 1 } }] });
  assert.equal(reconcilePlan(fresh, options).status, 'blocked');
  const legacy = plan({ steps: [{ ...step, groundingBlocked: {
    reason: 'target_affordance_missing', observedWorldMinute: 999 } }] });
  assert.equal(reconcilePlan(legacy, options).status, 'replan_required');
});

test('returned exact affordance resumes the original plan and clears one pending need', () => {
  const legacy = plan({ steps: [{ ...step, targetId: 'opportunity:propose:SOCIAL',
    targetType: 'opportunity', groundingBlocked: { reason: 'target_affordance_missing',
      observedWorldMinute: 100 } }] });
  const pending = reconcilePlan(legacy, options);
  const resumed = reconcilePlan(pending, { ...options,
    affordances: [{ id: 'opportunity:propose:SOCIAL', action: 'propose_opportunity' }] });
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.steps[0].groundingBlocked, undefined);
  assert.equal(resumed.executionReplans[0].status, 'resolved_by_affordance');
  assert.equal(hasPendingExecutionReplan([resumed]), false);
});

test('replan completion requires a real revision and clears stale step runtime', () => {
  const old = plan({ status: 'replan_required', steps: [{ ...step,
    groundingBlocked: { reason: 'target_expired' },
    groundingDiagnostics: { groundingChecks: 8 } }] });
  assert.equal(planRevisionChanged(old, old), false);
  const revisedStep = { ...old.steps[0], intent: 'Find an active project', targetId: null };
  assert.equal(planRevisionChanged(old, { ...old, status: 'active', steps: [revisedStep] }), true);
  const clean = clearRevisedRuntime(old.steps[0], revisedStep);
  assert.equal(clean.groundingBlocked, undefined);
  assert.equal(clean.groundingDiagnostics, undefined);
  const fingerprint = 'a'.repeat(64);
  const pending = { ...old, executionReplans: [{ fingerprint, status: 'pending' }] };
  assert.equal(completePendingExecutionReplans([pending], { trigger: 'execution_replan_required',
    fingerprints: [fingerprint], planIds: [], turnId: 3 })[0].executionReplans[0].status, 'pending');
});

test('budget or rate deferral leaves a pending replan and 48h stagger unchanged', () => {
  const pending = reconcilePlan(plan({ steps: [{ ...step, groundingBlocked: {
    reason: 'grounding_invalid', observedWorldMinute: 100 } }] }), options);
  assert.equal(hasPendingExecutionReplan([pending]), true);
  const context = { prior: { goals: [{ id: 'goal-1', status: 'active' }], plans: [pending] },
    recentEvents: [], projects: [], relationships: [], capabilities: [] };
  assert.equal(shouldCallForMaterialChange({ context, previousFingerprint: null,
    trigger: 'execution_replan_required' }).call, true);
  const now = Date.parse('2026-10-19T00:00:00Z');
  assert.equal(nextScheduledSlot(now + SCHEDULE_PERIOD_MS, 0, 10)
    - nextScheduledSlot(now, 0, 10), SCHEDULE_PERIOD_MS);
  const reloaded = JSON.parse(JSON.stringify(pending));
  assert.equal(reconcilePlan(reloaded, options).executionReplans.length, 1,
    'persisted JSON state survives restart without a duplicate need');
});

test('routine interruption retains the same strategic plan and tool identity respects intent and args', () => {
  const strategic = plan({ status: 'active' });
  const state = { plans: [strategic], pending_action: {} };
  assert.equal(choosePlannedAffordance(state, []).needsGrounding, true);
  assert.equal(routineFallbackCandidates([{ id: 'meal', action: 'eat' }]).length, 1);
  assert.equal(choosePlannedAffordance(state, []).planId, strategic.id);
  const base = { capability: 'github_public_read', operation: 'repository',
    owner: 'example', repo: 'one' };
  assert.notEqual(toolCallFingerprint(base), toolCallFingerprint({ ...base, repo: 'two' }));
});

test('mock provider to exact grounding to authoritative World completion advances one step', async () => {
  const candidate = { id: 'project:contribute:' + id, action: 'project_contribute', projectId: id };
  const context = { world: { minute: 1_000 }, resident: { id: 'agent-1', location: 'Workshop' },
    availableAffordances: { candidates: [candidate] }, capabilities: [], syncBalances: [] };
  const action = await groundPlanStep({ context, goal: { id: 'goal-1', title: 'Build' },
    plan: { id: 'plan-1', summary: 'Contribute' }, step,
    requestModel: async () => ({ callId: '10000000-0000-4000-8000-000000000102', output: {
      candidateId: candidate.id, executableAction: candidate.action, arguments: { projectId: id },
      capabilityId: null, targetId: id, targetType: 'project', expectedOutcome: 'Project progressed',
      blockedReason: null, requiredChange: null } }) });
  assert.equal(action.status, 'grounded');
  const active = plan({ status: 'active', steps: [{ ...step }] });
  let stored;
  const db = { query: async (sql, args = []) => {
    if (sql.includes('FROM world_events event')) return { rowCount: 1, rows: [{ id: 91,
      event_type: 'world.action_completed', data: { status: 'completed', cognitionExecution: {
        goalId: 'goal-1', planId: 'plan-1', stepId: 'step-1', intentId: 'intent-1',
        candidateId: candidate.id, correlationId: action.executionCorrelationId,
        action: candidate.action, targetId: id } } }] };
    if (sql.includes('SELECT revision,plans,pending_action')) return { rowCount: 1,
      rows: [{ revision: 1, plans: [active], pending_action: action,
        next_review_world_minute: 1_000 }] };
    if (sql.includes('UPDATE world_agent_cognition_state')) {
      stored = JSON.parse(args[2]); return { rowCount: 1, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  } };
  const result = await completePlannedAction(db, { worldId: 'world', agentId: 'agent-1',
    context: { cognitionRevision: 1, cognitionGoalId: 'goal-1', cognitionPlanId: 'plan-1',
      cognitionStepIndex: 0, cognitionStepId: 'step-1', cognitionIntentId: 'intent-1',
      cognitionCandidateId: candidate.id, cognitionTargetId: id,
      cognitionExecutableAction: candidate.action,
      cognitionExecutionCorrelationId: action.executionCorrelationId },
    worldMinute: 1_001, completionEventId: 91, actionType: candidate.action });
  assert.equal(result.completed, true);
  assert.equal(stored[0].steps[0].executionEvidence.eventId, 91);
});

test('migration stores only gate metadata and creates no Mainnet write path', async () => {
  const sql = await readFile(new URL('../migrations/0020_autonomy_gate_decisions.sql', import.meta.url), 'utf8');
  assert.match(sql, /material_fingerprint text/u);
  assert.match(sql, /budget_admissible boolean/u);
  assert.doesNotMatch(sql, /prompt|response|private_key|transaction_hash/iu);
});
