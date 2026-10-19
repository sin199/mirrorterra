import { classifyUnavailableTarget, markExecutionReplanPending,
  retryFingerprintFor } from './grounding.js';

export const BOUNDED_GROUNDING_ATTEMPTS = 3;
export const BOUNDED_BLOCKED_WORLD_MINUTES = 180;

const TERMINAL = new Set(['completed', 'failed', 'abandoned']);
const RECOVERABLE = new Set(['grounding_invalid', 'target_affordance_missing',
  'no_matching_affordance', 'grounded_candidate_stale', 'plan_goal_missing',
  'target_temporarily_unavailable', 'missing_location', 'missing_capability',
  'missing_resource', 'target_wrong_location', 'execution_failed']);

export function stepIdentity(step = {}) {
  return JSON.stringify([step.stepId, step.intentId, step.intent, step.actionType,
    step.targetBindingMode, step.targetType, step.targetId, step.arguments || null,
    step.researchIntent || null, step.projectProposal || null]);
}

export function clearRevisedRuntime(previous, next, { force = false } = {}) {
  if (!previous || (!force && stepIdentity(previous) === stepIdentity(next))) return next;
  const { groundingBlocked: _blocked, groundingDiagnostics: _diagnostics,
    groundingTelemetry: _telemetry, executionEvidence: _evidence,
    modelDeferredReason: _deferredReason, modelDeferredUntil: _deferredUntil,
    ...clean } = next;
  return { ...clean, status: 'pending' };
}

export function planRevisionChanged(previous, next) {
  if (!previous || !next) return Boolean(previous || next);
  if (TERMINAL.has(next.status) && next.status !== previous.status) return true;
  const signature = (plan) => JSON.stringify([plan.goalId, plan.currentStep,
    (plan.steps || []).map(stepIdentity)]);
  return signature(previous) !== signature(next);
}

export function shouldEscalateBlocked(step, reason, worldMinute, fingerprint) {
  if (!RECOVERABLE.has(reason)) return false;
  const blocked = step?.groundingBlocked;
  if (!blocked || blocked.reason !== reason) return false;
  const saved = blocked.retryCondition?.fingerprint || blocked.retryFingerprint;
  if (saved && saved !== fingerprint) return false;
  const diagnostics = step.groundingDiagnostics || {};
  const attempts = Number(diagnostics.groundingChecks || 0)
    + Number(diagnostics.retryGateChecks || 0);
  const age = Number(worldMinute) - Number(blocked.observedWorldMinute);
  return attempts >= BOUNDED_GROUNDING_ATTEMPTS
    || Number.isFinite(age) && age >= BOUNDED_BLOCKED_WORLD_MINUTES;
}

export function reconcilePlan(plan, { worldMinute, state = {}, targetState = null,
  affordances = [], capabilities = [], syncBalances = [] } = {}) {
  if (!plan || TERMINAL.has(plan.status)) return plan;
  if (plan.status === 'replan_required' && (plan.executionReplans || [])
    .some((entry) => entry.status === 'pending')) {
    const step = plan.steps?.[plan.currentStep];
    const reason = step?.groundingBlocked?.reason;
    const returned = ['target_affordance_missing','no_matching_affordance'].includes(reason)
      && step?.targetId && (affordances || []).some((candidate) =>
        candidate.id === step.targetId && typeof candidate.action === 'string');
    if (!returned) return plan;
    const fingerprint = step.groundingBlocked.replanFingerprint
      || step.groundingBlocked.retryFingerprint;
    return { ...plan, status: 'active',
      executionReplans: (plan.executionReplans || []).map((entry) => entry.status === 'pending'
        && entry.fingerprint === fingerprint ? { ...entry, status: 'resolved_by_affordance',
          resolvedWorldMinute: worldMinute } : entry),
      steps: plan.steps.map((item, index) => index === plan.currentStep
        ? clearRevisedRuntime(item, item, { force: true }) : item) };
  }
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  const index = Number(plan.currentStep);
  if (!Number.isInteger(index) || index < 0 || index > steps.length) {
    return { ...plan, status: 'failed', failureReason: 'invalid_step_position' };
  }
  if (index === steps.length) {
    return { ...plan, status: steps.every((step) => step.executionEvidence?.success === true)
      ? 'completed' : 'failed',
    ...(steps.every((step) => step.executionEvidence?.success === true) ? {}
      : { failureReason: 'missing_authoritative_step_evidence' }) };
  }
  const step = steps[index];
  const existingNeed = (plan.executionReplans || []).find((entry) => entry.status === 'pending');
  if (existingNeed) return { ...plan, status: 'replan_required',
    steps: steps.map((item, position) => position === index ? { ...item,
      status: 'blocked',
      groundingBlocked: { ...(item.groundingBlocked || {}), replanRequired: true,
        replanResult: 'pending', replanFingerprint: existingNeed.fingerprint } } : item) };
  const classification = targetState ? classifyUnavailableTarget({ step, state, targetState,
    worldMinute }) : null;
  const blocked = classification?.terminal ? { ...(step?.groundingBlocked || {}),
    reason: classification.reason, targetId: targetState.id || step.targetId,
    targetType: targetState.type || step.targetType, replanRequired: true,
    observedWorldMinute: worldMinute } : step?.groundingBlocked;
  if (!blocked) return plan;
  const retry = retryFingerprintFor({ reason: blocked.reason, step, state, targetState,
    affordances, capabilities, syncBalances, worldMinute });
  const fingerprint = retry.fingerprint;
  const terminal = blocked.replanRequired === true
    || ['target_expired', 'target_deleted', 'target_completed', 'target_state_changed',
      'target_permission_changed', 'target_stale_reference'].includes(blocked.reason);
  const currentExactCandidate = step.targetId && (affordances || []).some((candidate) =>
    candidate.id === step.targetId && typeof candidate.action === 'string');
  const legacyUnbounded = !Object.hasOwn(step, 'status') && RECOVERABLE.has(blocked.reason)
    && !currentExactCandidate;
  if (!terminal && !legacyUnbounded
      && !shouldEscalateBlocked(step, blocked.reason, worldMinute, fingerprint)) return plan;
  const updatedStep = { ...step, status: 'blocked', groundingBlocked: { ...blocked, replanRequired: true,
    replanResult: 'pending', retryFingerprint: fingerprint,
    retryCondition: retry, targetStateVersion: retry.targetStateVersion,
    affordanceSignature: retry.affordanceSignature } };
  return markExecutionReplanPending({ ...plan, status: 'replan_required',
    steps: steps.map((item, position) => position === index ? updatedStep : item) }, {
    fingerprint, reason: blocked.reason, targetId: blocked.targetId || step.targetId,
    targetType: blocked.targetType || step.targetType,
    targetStateVersion: retry.targetStateVersion,
    affordanceSignature: retry.affordanceSignature, worldMinute });
}
