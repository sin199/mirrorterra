import { createHash } from 'node:crypto';

// OPEN_COGNITION_SCHEDULE_HOURS: hours between each resident's routine reflection (default 48, min 0.1).
const scheduleHours = Number(process.env.OPEN_COGNITION_SCHEDULE_HOURS);
export const SCHEDULE_PERIOD_MS = (Number.isFinite(scheduleHours) && scheduleHours >= 0.1 && scheduleHours <= 168
  ? Math.round(scheduleHours * 60) : 48 * 60) * 60_000;
const EPOCH_MS = Date.parse('2026-01-01T00:00:00Z');
const MATERIAL_EVENT = /goal|project|relationship|capability|work_order|research|target|opportunity|failure|identity|business|institution/iu;

export function nextScheduledSlot(nowMs, agentOrdinal, agentCount = 10) {
  if (!Number.isFinite(nowMs) || !Number.isInteger(agentOrdinal) || agentOrdinal < 0
      || !Number.isInteger(agentCount) || agentCount < 1 || agentOrdinal >= agentCount) {
    throw new RangeError('COGNITION_SCHEDULE_INPUT_INVALID');
  }
  const phase = Math.floor(SCHEDULE_PERIOD_MS * agentOrdinal / agentCount);
  const slot = EPOCH_MS + phase;
  return slot + (Math.floor((nowMs - slot) / SCHEDULE_PERIOD_MS) + 1) * SCHEDULE_PERIOD_MS;
}

function activePlanSummary(plans) {
  return (plans || []).filter((plan) => ['active','blocked','replan_required'].includes(plan.status))
    .map((plan) => ({ id: plan.id, goalId: plan.goalId, summary: plan.summary,
      status: plan.status,
      // Advancing a healthy plan step is routine execution, not a new reason to
      // call a model. A blocked step and its retry fingerprint are material.
      blockedStep: ['blocked','replan_required'].includes(plan.status) && (plan.steps || [])[plan.currentStep] ? {
        targetId: plan.steps[plan.currentStep].targetId,
        targetType: plan.steps[plan.currentStep].targetType,
        reason: plan.steps[plan.currentStep].groundingBlocked?.reason || null,
        retryFingerprint: plan.steps[plan.currentStep].groundingBlocked?.retryFingerprint || null
      } : null,
      pendingReplans: (plan.executionReplans || []).filter((item) => item.status === 'pending')
        .map((item) => item.fingerprint) }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function materialEvents(context) {
  return (context?.recentEvents || []).filter((event) => MATERIAL_EVENT.test(event.type || ''))
    .map((event) => [event.id, event.type, event.actionId]);
}

export function materialCognitionFingerprint(context) {
  const prior = context?.prior || {};
  const snapshot = {
    goals: (prior.goals || []).filter((goal) => goal.status === 'active')
      .map((goal) => [goal.id, goal.title, goal.why, goal.priority, goal.status])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    plans: activePlanSummary(prior.plans),
    target: context?.targetState || null,
    capabilities: (context?.capabilities || []).map((item) => [item.key, item.status, item.specification])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    capabilityGaps: (context?.capabilityGaps || []).map((item) =>
      [item.id, item.status, item.observationCount])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    capabilityProposals: (context?.capabilityProposals || []).map((item) =>
      [item.id, item.gapId, item.supportCount, item.oppositionCount])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    capabilityExperiences: (context?.capabilityExperiences || []).map((item) =>
      [item.useId, item.status, item.success])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    projects: (context?.projects || []).map((item) => [item.id, item.status,
      Math.floor(Number(item.progress || 0) * 10) / 10])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    relationships: (context?.relationships || []).map((item) => [item.agent_id,
      Math.floor(Number(item.trust || 0) * 10) / 10,
      Math.floor(Number(item.affinity || 0) * 10) / 10])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    research: (context?.research || []).map((item) => [item.id, item.status, item.normalized_findings])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    toolResults: (context?.toolResults || []).filter((item) => item.status === 'succeeded')
      .map((item) => item.id).sort()
  };
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

export function hasPendingExecutionReplan(plans) {
  return (plans || []).some((plan) => (plan.executionReplans || [])
    .some((entry) => entry.status === 'pending'
      && (entry.replanTriggered !== true || entry.providerRetryEligible === true)));
}

export function shouldCallForMaterialChange({ context, previousFingerprint, trigger }) {
  const fingerprint = materialCognitionFingerprint(context);
  const pendingReplan = hasPendingExecutionReplan(context?.prior?.plans);
  const continuingPlan = (context?.prior?.plans || []).some((plan) => plan.status === 'active'
    && Number.isInteger(plan.currentStep) && plan.currentStep < (plan.steps || []).length);
  const strategic = ['initial','strategic_review','identity_revision','goal_conflict',
    'major_failure','major_opportunity'].includes(trigger);
  const changed = previousFingerprint !== null && previousFingerprint !== fingerprint;
  const newlyUnplanned = previousFingerprint === null
    && !(context?.prior?.goals || []).length && !(context?.prior?.plans || []).length;
  return { fingerprint, call: pendingReplan || (strategic && newlyUnplanned)
    || (changed && ((trigger === 'scheduled' && !continuingPlan) || materialEvents(context).length > 0
      || ['research_result','tool_result','plan_completed','world_outcome',
        'capability_result','strategic_review','identity_revision','goal_conflict',
        'major_failure','major_opportunity'].includes(trigger))) };
}
