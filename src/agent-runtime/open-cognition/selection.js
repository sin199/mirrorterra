const TARGETED_ACTIONS = new Set(['opportunity','project_join','project_contribute',
  'business_apply','business_hire','business_service','capability_use']);
const ROUTINE_ACTIONS = new Set(['eat','rest','learn','socialize','cooperate','work']);

export function routineFallbackCandidates(candidates) {
  return candidates.filter((candidate) => ROUTINE_ACTIONS.has(candidate.action) && !candidate.workOrderId);
}

function candidateTargets(candidate) {
  return [candidate.id,candidate.opportunityId,candidate.projectId,candidate.businessId,
    candidate.serviceId,candidate.jobId,candidate.workOrderId,candidate.capabilityId,candidate.socialPartnerId]
    .filter((value) => value != null).map(String);
}

export function hasPlannedAction(state) {
  if (!state) return false;
  if (typeof state.pending_action?.actionType === 'string') return true;
  return Array.isArray(state.plans) && state.plans.some((plan) =>
    plan?.status === 'active' && typeof plan.steps?.[plan.currentStep]?.actionType === 'string');
}

export function choosePlannedAffordance(state, feasibleCandidates) {
  if (!state || !Array.isArray(feasibleCandidates)) return { candidate: null, source: null };
  const pending = state.pending_action && typeof state.pending_action === 'object'
    ? state.pending_action : {};
  let intent = typeof pending.actionType === 'string' ? pending : null;
  let source = intent ? 'strategic_cognition' : null;
  let planId = null;
  let stepIndex = null;
  const plans = Array.isArray(state.plans) ? state.plans : [];
  if (intent) {
    const active = plans.find((plan) => plan?.status === 'active'
      && plan.steps?.[plan.currentStep]?.actionType === intent.actionType);
    if (active) { planId = active.id; stepIndex = active.currentStep; }
  }
  if (!intent) {
    const active = plans.find((plan) => plan?.status === 'active'
      && Number.isInteger(plan.currentStep) && plan.currentStep < (plan.steps?.length || 0));
    if (active) {
      const step = active.steps[active.currentStep];
      if (typeof step?.actionType === 'string') {
        intent = step;
        source = 'plan_continuation';
        planId = active.id;
        stepIndex = active.currentStep;
      }
    }
  }
  if (!intent) return { candidate: null, source: null };
  const targetId = intent.targetId == null ? null : String(intent.targetId);
  if (TARGETED_ACTIONS.has(intent.actionType) && !targetId) {
    return { candidate: null, source, blocked: 'target_required', planId, stepIndex };
  }
  if (intent.actionType === 'project_propose' && !intent.projectProposal) {
    return { candidate: null, source, blocked: 'project_proposal_required', planId, stepIndex };
  }
  const matches = feasibleCandidates.filter((candidate) => candidate.action === intent.actionType
    && (targetId === null || candidateTargets(candidate).includes(targetId)));
  if (!matches.length) return { candidate: null, source, blocked: 'affordance_unavailable', planId, stepIndex };
  const candidate = matches[0];
  if (candidate.capabilityContext?.researchIntent && !intent.researchIntent) {
    return { candidate: null, source, blocked: 'research_question_required', planId, stepIndex };
  }
  if (intent.researchIntent && !candidate.capabilityContext?.researchIntent) {
    return { candidate: null, source, blocked: 'research_target_mismatch', planId, stepIndex };
  }
  const selected = { ...candidate };
  if (intent.researchIntent) selected.capabilityContext = { ...candidate.capabilityContext,
    researchIntent: { ...candidate.capabilityContext.researchIntent, ...intent.researchIntent } };
  if (intent.projectProposal) Object.assign(selected, {
    projectProposal: { ...intent.projectProposal }, goal: intent.projectProposal.goal,
    description: intent.projectProposal.description
  });
  return { candidate: selected, source, planId, stepIndex };
}

export async function completePlannedAction(client, { worldId, agentId, context,
  abandoned = false, worldMinute }) {
  if (!context || !Number.isInteger(context.cognitionRevision)) return { updated: false };
  const current = await client.query(`SELECT revision,plans,pending_action,next_review_world_minute
    FROM world_agent_cognition_state WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`, [worldId, agentId]);
  if (!current.rowCount || Number(current.rows[0].revision) !== context.cognitionRevision) {
    return { updated: false, reason: 'cognition_revision_changed' };
  }
  const state = current.rows[0];
  const plans = Array.isArray(state.plans) ? state.plans : [];
  let advanced = false;
  const nextPlans = plans.map((plan) => {
    if (plan.id !== context.cognitionPlanId || plan.currentStep !== context.cognitionStepIndex) return plan;
    advanced = true;
    if (abandoned) return { ...plan, status: 'blocked' };
    const nextStep = plan.currentStep + 1;
    return { ...plan, currentStep: nextStep,
      status: nextStep >= (plan.steps?.length || 0) ? 'completed' : 'active' };
  });
  const pending = state.pending_action && typeof state.pending_action === 'object'
    ? state.pending_action : {};
  const clearPending = context.cognitionSource === 'strategic_cognition';
  const needsReview = abandoned || clearPending || (advanced && nextPlans.some((plan) =>
    plan.id === context.cognitionPlanId && plan.status === 'completed'));
  await client.query(`UPDATE world_agent_cognition_state SET revision=revision+1,plans=$3::jsonb,
      pending_action=$4::jsonb,next_review_world_minute=$5,
      review_reason=$6,lease_token=NULL,lease_until=NULL,updated_at=now()
    WHERE world_id=$1 AND agent_id=$2`,
  [worldId, agentId, JSON.stringify(nextPlans), JSON.stringify(clearPending ? {} : pending),
    needsReview ? Math.min(Number(state.next_review_world_minute), worldMinute)
      : Number(state.next_review_world_minute),
    needsReview ? abandoned ? 'plan_blocked' : 'plan_step_completed' : 'scheduled']);
  return { updated: true, advanced, needsReview };
}
