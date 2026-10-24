import { chainFixEnabled } from './chainfix-flags.js';

const ROUTINE_ACTIONS = new Set(['eat','rest','learn','socialize','cooperate','work']);

export function routineFallbackCandidates(candidates) {
  return candidates.filter((candidate) => ROUTINE_ACTIONS.has(candidate.action) && !candidate.workOrderId);
}

// Economic actions open cognition may fall back to when no LLM plan grounds onto a candidate.
// Only already-feasible candidates are eligible: callers pass the needs- and destination-gated set.
export const ECONOMIC_FALLBACK_ACTIONS = Object.freeze(new Set(['project_propose','project_join',
  'project_contribute','business_found','business_work','business_service']));

export function economicFallbackEnabled(env = process.env) {
  return String(env?.MIRRORTERRA_ECON_FALLBACK ?? 'on').trim().toLowerCase() !== 'off'
    && String(env?.MIRRORTERRA_SYNC_ECONOMY ?? 'on').trim().toLowerCase() !== 'off';
}

export function economicFallbackCandidates(candidates) {
  const seen = new Set();
  return (candidates || []).filter((candidate) => {
    if (!candidate || !ECONOMIC_FALLBACK_ACTIONS.has(candidate.action) || seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return Number.isFinite(Number(candidate.score));
  });
}

// Deterministic pick: highest utility score, ties broken by id.
export function chooseEconomicFallback(candidates) {
  const eligible = economicFallbackCandidates(candidates);
  if (!eligible.length) return null;
  return [...eligible].sort((left, right) => Number(right.score) - Number(left.score)
    || String(left.id).localeCompare(String(right.id)))[0];
}

function targetForCandidate(candidate) {
  for (const key of ['workOrderId','opportunityId','projectId','businessId','serviceId','jobId',
    'capabilityId','socialPartnerId','agreementId','organizationId','id']) {
    if (candidate?.[key] != null) return String(candidate[key]);
  }
  return null;
}

// chainfix1: ONE predicate for "this live candidate is the one the grounded pending action names",
// shared by the tick (choosePlannedAffordance) and the cognition worker (pending-candidate check).
// The pending targetId comes from the advertised affordance snapshot, which carries no organizationId,
// so for organization_* candidates it equals the candidate id, while the live candidate's canonical
// target is its organizationId. Both spellings name the same object: candidateId and action must
// already match exactly, and the id-spelling is only accepted when it IS this candidate's own id.
// chainFix=false (kill switch MIRRORTERRA_CHAIN_FIX=off) = the old strict tick predicate.
export function candidateMatchesPending(candidate, pending, { chainFix = chainFixEnabled() } = {}) {
  if (!candidate || !pending || typeof pending.candidateId !== 'string') return false;
  if (candidate.id !== pending.candidateId || candidate.action !== pending.executableAction) return false;
  const wanted = pending.targetId == null ? null : String(pending.targetId);
  const canonical = targetForCandidate(candidate);
  if (canonical === wanted) return true;
  return chainFix && wanted !== null && String(candidate.id) === wanted;
}

export function hasPlannedAction(state) {
  if (!state) return false;
  if (typeof state.pending_action?.candidateId === 'string') return true;
  if (typeof state.pending_action?.actionType === 'string'
      && state.pending_action.actionType !== 'world_action') return true;
  return Array.isArray(state.plans) && state.plans.some((plan) =>
    ['active','blocked'].includes(plan?.status) && Number.isInteger(plan.currentStep)
      && plan.currentStep < (plan.steps?.length || 0));
}

export function choosePlannedAffordance(state, feasibleCandidates, { chainFix = chainFixEnabled() } = {}) {
  if (!state || !Array.isArray(feasibleCandidates)) return { candidate: null, source: null,
    grounded: false, groundingAttempted: false, groundingSucceeded: false, groundingStatus: 'not_attempted' };
  const pending = state.pending_action && typeof state.pending_action === 'object'
    ? state.pending_action : {};
  const plans = Array.isArray(state.plans) ? state.plans : [];
  if (typeof pending.candidateId === 'string' && typeof pending.executableAction === 'string') {
    const plan = plans.find((item) => item.id === pending.planId && item.status === 'active'
      && item.currentStep < (item.steps?.length || 0));
    const step = plan?.steps?.[plan.currentStep];
    if (!plan || !step || step.stepId !== pending.stepId || step.intentId !== pending.intentId) {
      return { candidate: null, source: null, blocked: 'grounded_plan_stale', planId: pending.planId,
        stepIndex: plan?.currentStep ?? null, grounded: false, groundingAttempted: true,
        groundingSucceeded: false, groundingStatus: 'stale', retryFingerprint: pending.affordanceFingerprint || null };
    }
    const candidate = feasibleCandidates.find((item) => candidateMatchesPending(item, pending, { chainFix }));
    if (!candidate) return { candidate: null, source: 'plan_continuation', blocked: 'grounded_candidate_unavailable',
      planId: plan.id, stepIndex: plan.currentStep, grounded: false, groundingAttempted: true,
      groundingSucceeded: false, groundingStatus: 'blocked',
      retryFingerprint: pending.affordanceFingerprint || null };
    const selected = { ...candidate };
    if (pending.researchIntent && selected.capabilityContext?.researchIntent) {
      selected.capabilityContext = { ...selected.capabilityContext,
        researchIntent: { ...selected.capabilityContext.researchIntent, ...pending.researchIntent } };
    }
    if (pending.projectProposal) Object.assign(selected, { projectProposal: { ...pending.projectProposal },
      goal: pending.projectProposal.goal, description: pending.projectProposal.description });
    return { candidate: selected, source: 'plan_continuation', planId: plan.id,
      stepIndex: plan.currentStep, grounded: true, intentId: step.intentId,
      groundingAttempted: true, groundingSucceeded: true, groundingStatus: 'grounded',
      executionCorrelationId: pending.executionCorrelationId, expectedOutcome: pending.expectedOutcome,
      modelCallId: pending.modelCallId || null,
      modelCallIds: Array.isArray(pending.attributionModelCallIds)
        ? pending.attributionModelCallIds : [],
      cognitionTurnId: pending.attributionTurnId || null,
      candidateId: candidate.id, executableAction: candidate.action,
      capabilityId: candidate.capabilityId || null, targetId: pending.targetId || null,
      affordanceFingerprint: pending.affordanceFingerprint || null };
  }
  const active = plans.find((plan) => plan?.status === 'active'
    && Number.isInteger(plan.currentStep) && plan.currentStep < (plan.steps?.length || 0));
  if (active) {
    const step = active.steps[active.currentStep];
    return { candidate: null, source: 'plan_continuation', needsGrounding: true,
      grounded: false, groundingAttempted: false, groundingSucceeded: false, groundingStatus: 'awaiting_grounding',
      planId: active.id, stepIndex: active.currentStep,
      step: { ...step, intent: step.intent || step.description } };
  }
  if (typeof pending.actionType === 'string') return { candidate: null, source: null,
    grounded: false, groundingAttempted: false, groundingSucceeded: false,
    groundingStatus: 'awaiting_grounding', needsGrounding: true, blocked: 'legacy_intent_requires_grounding' };
  return { candidate: null, source: null, grounded: false, groundingAttempted: false,
    groundingSucceeded: false, groundingStatus: 'not_attempted' };
}

export async function completePlannedAction(client, { worldId, agentId, context,
  abandoned = false, worldMinute, completionEventId = null, actionType = null }) {
  if (!context || !Number.isInteger(context.cognitionRevision)
      || !Number.isInteger(context.cognitionStepIndex)
      || typeof context.cognitionPlanId !== 'string'
      || typeof context.cognitionExecutionCorrelationId !== 'string'
      || !completionEventId) return { updated: false };
  const evidence = await client.query(`SELECT event.id,event.event_type,event.data
    FROM world_events event WHERE event.world_id=$1 AND event.actor_id=$2 AND event.id=$3`,
  [worldId, agentId, completionEventId]);
  const worldEvent = evidence.rows[0];
  const execution = worldEvent?.data?.cognitionExecution;
  if (!worldEvent || worldEvent.event_type !== 'world.action_completed'
      || execution?.correlationId !== context.cognitionExecutionCorrelationId
      || execution?.goalId !== context.cognitionGoalId
      || execution?.planId !== context.cognitionPlanId
      || execution?.stepId !== context.cognitionStepId
      || execution?.intentId !== context.cognitionIntentId
      || execution?.candidateId !== context.cognitionCandidateId
      || (execution?.targetId ?? null) !== (context.cognitionTargetId ?? null)
      || execution?.action !== actionType
      || execution?.action !== context.cognitionExecutableAction
      || (execution?.modelCallId ?? null) !== (context.cognitionModelCallId ?? null)
      || (execution?.cognitionTurnId ?? null) !== (context.cognitionTurnId ?? null)
      || worldEvent.data.status !== 'completed') {
    return { updated: false, reason: 'authoritative_execution_evidence_missing' };
  }
  const current = await client.query(`SELECT revision,plans,pending_action,next_review_world_minute
    FROM world_agent_cognition_state WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`, [worldId, agentId]);
  if (!current.rowCount) return { updated: false, reason: 'cognition_state_missing' };
  const state = current.rows[0];
  const plans = Array.isArray(state.plans) ? state.plans : [];
  const persistedPlan = plans.find((plan) => plan.id === context.cognitionPlanId);
  const persistedPending = state.pending_action && typeof state.pending_action === 'object'
    ? state.pending_action : {};
  if (!persistedPlan || persistedPlan.currentStep !== context.cognitionStepIndex
      || persistedPlan.steps?.[persistedPlan.currentStep]?.stepId !== context.cognitionStepId
      || persistedPending.executionCorrelationId !== context.cognitionExecutionCorrelationId) {
    return { updated: false, reason: 'plan_step_or_execution_changed' };
  }
  let advanced = false;
  let blocked = false;
  const nextPlans = plans.map((plan) => {
    if (plan.id !== context.cognitionPlanId || plan.currentStep !== context.cognitionStepIndex
        || plan.steps?.[plan.currentStep]?.stepId !== context.cognitionStepId) return plan;
    if (abandoned || worldEvent.data.abandoned) {
      blocked = true;
      const steps = (plan.steps || []).map((step, index) => index === plan.currentStep
        ? { ...step, status: 'blocked', groundingBlocked: { reason: 'execution_failed', observedWorldMinute: worldMinute,
          affordanceFingerprint: context.cognitionAffordanceFingerprint || null,
          requiredChange: 'The relevant World state or executable affordance must change before retry.' } } : step);
      return { ...plan, steps, status: 'blocked' };
    }
    advanced = true;
    const nextStep = plan.currentStep + 1;
    const steps = (plan.steps || []).map((step, index) => index === plan.currentStep
      ? { ...step, status: 'completed', groundingBlocked: null, executionEvidence: { success: true,
        eventId: Number(completionEventId), correlationId: context.cognitionExecutionCorrelationId,
        modelCallId: context.cognitionModelCallId || null,
        cognitionTurnId: context.cognitionTurnId || null,
        action: actionType, worldMinute } } : step);
    return { ...plan, steps, currentStep: nextStep,
      status: nextStep >= (plan.steps?.length || 0) ? 'completed' : 'active' };
  });
  if (!advanced && !blocked) return { updated: false, reason: 'plan_step_changed' };
  await client.query(`INSERT INTO world_agent_cognition_memories(world_id,agent_id,memory_key,
      memory_type,summary,evidence,source_event_id,created_world_minute)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
    ON CONFLICT(world_id,agent_id,memory_key) DO NOTHING`, [worldId, agentId,
    `plan-outcome:${completionEventId}`, blocked ? 'failure' : 'episodic',
    blocked ? `My planned ${actionType} action did not complete.`
      : `My planned ${actionType} action completed.`,
    JSON.stringify({ source: 'world', planId: context.cognitionPlanId,
      stepId: context.cognitionStepId, worldEventId: completionEventId,
      outcome: blocked ? 'failed' : 'completed' }), completionEventId, worldMinute]);
  const pending = persistedPending;
  const clearPending = pending.executionCorrelationId === context.cognitionExecutionCorrelationId;
  const needsReview = blocked || advanced;
  const completed = nextPlans.some((plan) => plan.id === context.cognitionPlanId && plan.status === 'completed');
  await client.query(`UPDATE world_agent_cognition_state SET revision=revision+1,plans=$3::jsonb,
      pending_action=$4::jsonb,next_review_world_minute=$5,
      review_reason=$6,lease_token=NULL,lease_until=NULL,updated_at=now()
    WHERE world_id=$1 AND agent_id=$2`,
  [worldId, agentId, JSON.stringify(nextPlans), JSON.stringify(clearPending ? {} : pending),
    needsReview ? Math.min(Number(state.next_review_world_minute), worldMinute)
      : Number(state.next_review_world_minute),
    blocked ? 'plan_blocked' : completed ? 'plan_completed' : 'plan_step_completed']);
  await client.query(`UPDATE world_agent_cognition_model_calls SET execution_result=$3
    WHERE world_id=$1 AND id=$2 AND execution_result IS NULL`,
  [worldId, context.cognitionModelCallId, blocked ? 'failed' : 'succeeded']);
  if (!blocked && !abandoned) {
    for (const callId of [...new Set((context.cognitionModelCallIds || [])
      .filter((id) => typeof id === 'string'))]) {
      await client.query(`INSERT INTO bai_model_call_effects(model_call_id,effect_type,
          cognition_turn_id,goal_id,plan_id,step_id,world_event_id,execution_source)
        VALUES($1,'world_execution',$2,$3,$4,$5,$6,$7)`,
      [callId, context.cognitionTurnId || null, context.cognitionGoalId || null,
        context.cognitionPlanId, context.cognitionStepId, completionEventId,
        context.cognitionExecutionSource || 'plan_continuation']);
      if (advanced) await client.query(`INSERT INTO bai_model_call_effects(model_call_id,effect_type,
          cognition_turn_id,goal_id,plan_id,step_id,world_event_id,execution_source)
        VALUES($1,'plan_step_completed',$2,$3,$4,$5,$6,$7)`,
      [callId, context.cognitionTurnId || null, context.cognitionGoalId || null,
        context.cognitionPlanId, context.cognitionStepId, completionEventId,
        context.cognitionExecutionSource || 'plan_continuation']);
      if (completed) await client.query(`INSERT INTO bai_model_call_effects(model_call_id,effect_type,
          cognition_turn_id,goal_id,plan_id,step_id,world_event_id,execution_source)
        VALUES($1,'plan_completed',$2,$3,$4,$5,$6,$7)`,
      [callId, context.cognitionTurnId || null, context.cognitionGoalId || null,
        context.cognitionPlanId, context.cognitionStepId, completionEventId,
        context.cognitionExecutionSource || 'plan_continuation']);
    }
  }
  return { updated: true, advanced, blocked, completed };
}
