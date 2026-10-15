const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/;
const ACTION = /^[a-z][a-z0-9_]{1,79}$/;
const MEMORY_TYPES = new Set(['episodic','semantic','relationship','project','economic',
  'goal','tool','research','failure','skill']);
const PROJECT_TYPES = new Set(['RESEARCH','TRADE','BUILD','SOCIAL','DATA','LEARNING','GENERAL']);
const TARGET_BINDING_MODES = new Set(['exact','semantic']);
const TARGET_TYPES = new Set(['world_work_order','cleanup_target','project','opportunity',
  'organization','business','service','job','capability','resident','agreement','information_share','affordance']);
const GITHUB_OPERATIONS = new Set(['search_repositories','repository','contents','issues']);
const GOAL_HORIZONS = new Set(['life','long','project','medium','short','immediate']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validText(value, max = 1200) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}
function boundedArray(value, max, name) {
  if (!Array.isArray(value) || value.length > max) throw new TypeError(`${name}_INVALID`);
  return value;
}
function mergeById(prior, updates) {
  const merged = new Map((Array.isArray(prior) ? prior : []).map((item) => [item.id, item]));
  for (const item of updates) merged.set(item.id, { ...(merged.get(item.id) || {}), ...item });
  return [...merged.values()];
}
function requireUniqueIds(items, name) {
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !KEY.test(item.id || '') || ids.has(item.id)) {
      throw new TypeError(`${name}_ID_INVALID`);
    }
    ids.add(item.id);
  }
}

function validateResearchIntent(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !validText(value.researchQuestion, 1200) || value.researchQuestion.length < 8
      || !validText(value.objective, 1600) || value.objective.length < 8
      || !validText(value.desiredInvestigation, 1200)
      || !validText(value.expectedResult, 800)) throw new TypeError('RESEARCH_INTENT_INVALID');
  return { researchQuestion: value.researchQuestion, objective: value.objective,
    desiredInvestigation: value.desiredInvestigation, expectedResult: value.expectedResult };
}

function validateProjectProposal(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !PROJECT_TYPES.has(value.projectType)
      || !validText(value.title, 96) || value.title.length < 3
      || !validText(value.goal, 240) || value.goal.length < 3
      || !validText(value.description, 800) || value.description.length < 12) {
    throw new TypeError('PROJECT_PROPOSAL_INVALID');
  }
  return { projectType: value.projectType, title: value.title,
    goal: value.goal, description: value.description };
}

function validateToolRequests(value) {
  const requests = boundedArray(value, 4, 'TOOL_REQUESTS');
  requireUniqueIds(requests, 'TOOL_REQUESTS');
  return requests.map((request) => {
    if (request.capability === 'model_analysis') {
      if (!['haiku','sonnet'].includes(request.tier)
          || !validText(request.question, 800) || request.question.length < 8
          || !validText(request.objective, 800)) throw new TypeError('MODEL_SUBTASK_INVALID');
      return { id: request.id, capability: 'model_analysis', tier: request.tier,
        question: request.question, objective: request.objective };
    }
    if (request.capability !== 'github_public_read' || !GITHUB_OPERATIONS.has(request.operation)
        || (request.owner != null && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(request.owner))
        || (request.repo != null && !/^[A-Za-z0-9_.-]{1,100}$/.test(request.repo))
        || (request.path != null && (typeof request.path !== 'string' || request.path.length > 300
          || request.path.startsWith('/') || request.path.split('/').some((part) => !part || part === '..')))
        || (request.query != null && !validText(request.query, 160))) throw new TypeError('TOOL_REQUEST_INVALID');
    if (request.operation === 'search_repositories' ? !request.query
      : !request.owner || !request.repo) throw new TypeError('TOOL_REQUEST_INPUT_INVALID');
    if (request.operation === 'contents' && !request.path) throw new TypeError('TOOL_REQUEST_INPUT_INVALID');
    return { id: request.id, capability: request.capability, operation: request.operation,
      ...(request.owner ? { owner: request.owner } : {}), ...(request.repo ? { repo: request.repo } : {}),
      ...(request.path ? { path: request.path } : {}), ...(request.query ? { query: request.query } : {}) };
  });
}

function validateCapabilityDecisions(value, { availableCapabilityContext = null } = {}) {
  const decisions = boundedArray(value, 8, 'CAPABILITY_DECISIONS');
  const seen = new Set();
  return decisions.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || !['propose','review_proposal','review_experiment'].includes(entry.type)
        || !Array.isArray(entry.evidenceRefs)) throw new TypeError('CAPABILITY_DECISION_INVALID');
    let target;
    if (entry.type === 'propose') {
      if (!UUID.test(entry.gapId || '') || !entry.proposal || typeof entry.proposal !== 'object'
          || Array.isArray(entry.proposal)
          || !validText(entry.proposal.name, 120)
          || !validText(entry.proposal.category, 80)
          || !validText(entry.proposal.problemStatement, 600)
          || !validText(entry.proposal.expectedBenefit, 600)
          || !entry.proposal.specification || typeof entry.proposal.specification !== 'object'
          || Array.isArray(entry.proposal.specification)
          || !entry.proposal.expectedCost || typeof entry.proposal.expectedCost !== 'object'
          || Array.isArray(entry.proposal.expectedCost)
          || !entry.proposal.requiredResources || typeof entry.proposal.requiredResources !== 'object'
          || Array.isArray(entry.proposal.requiredResources)
          || !Array.isArray(entry.proposal.affectedSystems)
          || Buffer.byteLength(JSON.stringify(entry.proposal), 'utf8') > 20_000) {
        throw new TypeError('CAPABILITY_PROPOSAL_INVALID');
      }
      target = `gap:${entry.gapId}`;
      if (availableCapabilityContext && !availableCapabilityContext.gaps.has(entry.gapId)) {
        throw new TypeError('CAPABILITY_GAP_NOT_OBSERVED');
      }
      if (seen.has(target)) throw new TypeError('CAPABILITY_DECISION_DUPLICATE');
      seen.add(target);
      return { type: entry.type, gapId: entry.gapId, proposal: entry.proposal,
        evidenceRefs: entry.evidenceRefs };
    }
    if (!UUID.test(entry.proposalId || '')
        || !['support','oppose','modify','ignore'].includes(entry.decision)
        || !validText(entry.rationale, 600)) throw new TypeError('CAPABILITY_REVIEW_INVALID');
    if (entry.type === 'review_proposal') {
      target = `proposal:${entry.proposalId}`;
      if (availableCapabilityContext && !availableCapabilityContext.proposals.has(entry.proposalId)) {
        throw new TypeError('CAPABILITY_PROPOSAL_NOT_VISIBLE');
      }
    } else {
      if (!UUID.test(entry.experimentId || '')
          || !/^[1-9][0-9]{0,18}$/.test(String(entry.useId ?? ''))
          || entry.decision === 'modify') throw new TypeError('CAPABILITY_EXPERIMENT_REVIEW_INVALID');
      target = `experiment:${entry.experimentId}:${entry.useId}`;
      if (availableCapabilityContext
          && availableCapabilityContext.experiences.get(target) !== entry.proposalId) {
        throw new TypeError('CAPABILITY_EXPERIENCE_NOT_VISIBLE');
      }
    }
    if (seen.has(target)) throw new TypeError('CAPABILITY_DECISION_DUPLICATE');
    seen.add(target);
    if (entry.decision === 'modify' && (!entry.suggestedSpecification
        || typeof entry.suggestedSpecification !== 'object'
        || Array.isArray(entry.suggestedSpecification))) throw new TypeError('CAPABILITY_REVISION_REQUIRED');
    if (entry.decision !== 'modify' && entry.suggestedSpecification != null) {
      throw new TypeError('CAPABILITY_REVISION_UNEXPECTED');
    }
    return { type: entry.type, proposalId: entry.proposalId,
      ...(entry.type === 'review_experiment' ? { experimentId: entry.experimentId,
        useId: String(entry.useId) } : {}),
      decision: entry.decision, rationale: entry.rationale,
      ...(entry.suggestedSpecification ? { suggestedSpecification: entry.suggestedSpecification } : {}),
      evidenceRefs: entry.evidenceRefs };
  });
}

// The model returns changes, never an authoritative replacement snapshot. Old
// goals and plans remain until a specific status change is committed.
export function validateCognitionIntent(output, prior = {}, { allowedEvidenceRefs = null,
  availableCapabilityContext = null } = {}) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw new TypeError('INTENT_INVALID');
  if (!validText(output.reasonSummary, 600) || !validText(output.uncertainty, 600)) {
    throw new TypeError('INTENT_SUMMARY_INVALID');
  }
  const goalUpdates = boundedArray(output.goalUpdates, 16, 'GOAL_UPDATES');
  requireUniqueIds(goalUpdates, 'GOAL_UPDATES');
  for (const goal of goalUpdates) {
    if (!validText(goal.title, 500) || !validText(goal.why, 1000)
        || !['active','paused','completed','abandoned','failed'].includes(goal.status)
        || !Number.isInteger(goal.priority) || goal.priority < 0 || goal.priority > 100
        || (goal.horizon != null && !GOAL_HORIZONS.has(goal.horizon))
        || (goal.parentGoalId != null && !KEY.test(goal.parentGoalId))) {
      throw new TypeError('GOAL_UPDATE_INVALID');
    }
  }
  const goals = mergeById(prior.goals, goalUpdates);
  const goalIds = new Set(goals.map((goal) => goal.id));
  for (const goal of goalUpdates) if (goal.parentGoalId &&
      (goal.parentGoalId === goal.id || !goalIds.has(goal.parentGoalId))) {
    throw new TypeError('GOAL_PARENT_INVALID');
  }
  const planUpdates = boundedArray(output.planUpdates, 8, 'PLAN_UPDATES');
  requireUniqueIds(planUpdates, 'PLAN_UPDATES');
  const priorPlans = new Map((Array.isArray(prior.plans) ? prior.plans : []).map((plan) => [plan.id, plan]));
  const normalizedPlanUpdates = [];
  for (const plan of planUpdates) {
    const old = priorPlans.get(plan.id);
    const oldSteps = Array.isArray(old?.steps) ? old.steps : [];
    const oldCurrentStep = Number.isInteger(old?.currentStep) ? old.currentStep : 0;
    const incomingSteps = Array.isArray(plan.steps) ? plan.steps : [];
    const steps = old && plan.replaceSteps === true
      ? [...oldSteps.slice(0, oldCurrentStep), ...incomingSteps]
      : old ? [...oldSteps, ...(Array.isArray(plan.appendSteps) ? plan.appendSteps : [])]
        : incomingSteps;
    if (!goalIds.has(plan.goalId) || !validText(plan.summary, 1500)
        || !['active','blocked','paused','completed','abandoned','failed'].includes(plan.status)
        || (plan.replaceSteps != null && typeof plan.replaceSteps !== 'boolean')
        || !Array.isArray(steps) || steps.length < 1
        || (plan.appendSteps != null && (!Array.isArray(plan.appendSteps) || plan.appendSteps.length > 100))) {
      throw new TypeError('PLAN_UPDATE_INVALID');
    }
    const normalizedSteps = steps.map((step, index) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)
          || !validText(step.description, 1000)
          || (step.actionType != null && !ACTION.test(step.actionType))
          || (step.targetId != null && !validText(step.targetId, 160))
          || (step.targetBindingMode != null && !TARGET_BINDING_MODES.has(step.targetBindingMode))
          || (step.targetType != null && !TARGET_TYPES.has(step.targetType))) {
        throw new TypeError('PLAN_STEP_INVALID');
      }
      const stepId = KEY.test(step.stepId || '') ? step.stepId
        : `${plan.id.slice(0, 48)}:step:${index}`;
      const intentId = KEY.test(step.intentId || '') ? step.intentId
        : `${plan.id.slice(0, 42)}:intent:${index}`;
      const replacingCurrentOrFutureStep = old && plan.replaceSteps === true && index >= oldCurrentStep;
      const oldStep = replacingCurrentOrFutureStep ? null
        : oldSteps.find((item) => item.stepId === stepId) || oldSteps[index];
      if (!oldStep && !TARGET_BINDING_MODES.has(step.targetBindingMode)) {
        throw new TypeError('PLAN_STEP_BINDING_MODE_REQUIRED');
      }
      const targetId = Object.hasOwn(step, 'targetId') ? step.targetId : oldStep?.targetId ?? null;
      const targetType = Object.hasOwn(step, 'targetType') ? step.targetType : oldStep?.targetType ?? null;
      if (!oldStep && targetId != null && !targetType) throw new TypeError('PLAN_STEP_TARGET_TYPE_REQUIRED');
      return { ...(oldStep || {}), stepId, intentId, description: step.description,
        intent: validText(step.intent, 1000) ? step.intent : step.description,
        actionType: step.actionType ?? oldStep?.actionType ?? 'world_action',
        targetId,
        targetBindingMode: step.targetBindingMode ?? oldStep?.targetBindingMode ?? 'exact',
        targetType };
    });
    const currentStep = old ? oldCurrentStep : 0;
    let status = old?.status === 'completed' ? 'completed' : plan.status;
    const allStepsExecuted = currentStep >= normalizedSteps.length
      && normalizedSteps.every((step) => step.executionEvidence?.success === true);
    if (status === 'completed' && !allStepsExecuted) status = currentStep >= normalizedSteps.length ? 'blocked' : 'active';
    if (currentStep >= normalizedSteps.length && status === 'active') {
      status = allStepsExecuted ? 'completed' : 'blocked';
    }
    if (currentStep > normalizedSteps.length) throw new TypeError('PLAN_STEP_POSITION_INVALID');
    normalizedPlanUpdates.push({ id: plan.id, goalId: plan.goalId, summary: plan.summary,
      status, steps: normalizedSteps, currentStep });
  }
  const plans = mergeById(prior.plans, normalizedPlanUpdates);
  const beliefUpdates = boundedArray(output.beliefUpdates, 16, 'BELIEF_UPDATES');
  requireUniqueIds(beliefUpdates, 'BELIEF_UPDATES');
  for (const belief of beliefUpdates) {
    if (!validText(belief.claim, 1000) || !Number.isFinite(belief.confidence)
        || belief.confidence < 0 || belief.confidence > 1
        || !Array.isArray(belief.evidence) || !Array.isArray(belief.counterevidence)) {
      throw new TypeError('BELIEF_UPDATE_INVALID');
    }
  }
  const beliefs = mergeById(prior.beliefs, beliefUpdates);
  const valueUpdates = boundedArray(output.valueUpdates, 12, 'VALUE_UPDATES');
  requireUniqueIds(valueUpdates, 'VALUE_UPDATES');
  for (const value of valueUpdates) if (!validText(value.description, 500)
      || !validText(value.basis, 1000)) throw new TypeError('VALUE_UPDATE_INVALID');
  const values = mergeById(prior.values, valueUpdates);
  const policyExperimentUpdates = boundedArray(output.policyExperimentUpdates, 8, 'POLICY_EXPERIMENT_UPDATES');
  requireUniqueIds(policyExperimentUpdates, 'POLICY_EXPERIMENT_UPDATES');
  for (const experiment of policyExperimentUpdates) {
    if (!validText(experiment.hypothesis, 800) || !validText(experiment.behavior, 800)
        || !validText(experiment.successMetric, 800)
        || !['active','paused','completed','abandoned','failed'].includes(experiment.status)
        || !Number.isSafeInteger(experiment.durationWorldMinutes)
        || experiment.durationWorldMinutes < 1
        || !Array.isArray(experiment.evidenceRefs)) throw new TypeError('POLICY_EXPERIMENT_INVALID');
  }
  const policyExperiments = mergeById(prior.policyExperiments, policyExperimentUpdates);
  const questionUpdates = boundedArray(output.questionUpdates, 16, 'QUESTION_UPDATES');
  requireUniqueIds(questionUpdates, 'QUESTION_UPDATES');
  for (const question of questionUpdates) if (!validText(question.question, 500)
      || !['open','exploring','resolved','abandoned'].includes(question.status)) {
    throw new TypeError('QUESTION_UPDATE_INVALID');
  }
  const openQuestions = mergeById(prior.openQuestions, questionUpdates);
  const selfModelUpdate = output.selfModelUpdate;
  if (selfModelUpdate !== null && (typeof selfModelUpdate !== 'object'
      || Array.isArray(selfModelUpdate) || !validText(selfModelUpdate.summary, 1200)
      || !validText(selfModelUpdate.revisionReason, 600)
      || !Array.isArray(selfModelUpdate.evidenceRefs))) throw new TypeError('SELF_MODEL_UPDATE_INVALID');
  const memories = boundedArray(output.memoryUpdates, 20, 'MEMORY_UPDATES');
  const capabilityDecisions = validateCapabilityDecisions(output.capabilityDecisions,
    { availableCapabilityContext });
  requireUniqueIds(memories, 'MEMORY_UPDATES');
  for (const memory of memories) if (!MEMORY_TYPES.has(memory.type)
      || !validText(memory.summary, 1200) || !Array.isArray(memory.evidenceRefs)) {
    throw new TypeError('MEMORY_UPDATE_INVALID');
  }
  const evidenceRefs = [selfModelUpdate?.evidenceRefs || [],
    ...memories.map((memory) => memory.evidenceRefs),
    ...policyExperimentUpdates.map((experiment) => experiment.evidenceRefs),
    ...beliefUpdates.flatMap((belief) => [belief.evidence, belief.counterevidence]),
    ...capabilityDecisions.map((decision) => decision.evidenceRefs)].flat();
  if (selfModelUpdate && !selfModelUpdate.evidenceRefs.length) throw new TypeError('SELF_MODEL_EVIDENCE_REQUIRED');
  if (evidenceRefs.some((ref) => !validText(ref, 160)
      || allowedEvidenceRefs && !allowedEvidenceRefs.has(ref))) throw new TypeError('EVIDENCE_REFERENCE_INVALID');
  const nextAction = output.nextAction;
  if (nextAction !== null && (typeof nextAction !== 'object' || Array.isArray(nextAction)
      || (nextAction.actionType != null && !ACTION.test(nextAction.actionType))
      || (nextAction.targetId != null && !validText(nextAction.targetId, 160))
      || !TARGET_BINDING_MODES.has(nextAction.targetBindingMode)
      || (nextAction.targetType != null && !TARGET_TYPES.has(nextAction.targetType))
      || (nextAction.targetId != null && !nextAction.targetType))) {
    throw new TypeError('NEXT_ACTION_INVALID');
  }
  const nextIntent = nextAction?.intent
    || nextAction?.projectProposal?.goal
    || nextAction?.researchIntent?.researchQuestion
    || nextAction?.actionType;
  if (nextAction && !validText(nextIntent, 1000)) throw new TypeError('NEXT_ACTION_INTENT_REQUIRED');
  const normalizedAction = nextAction ? { actionType: 'world_action',
    ...(KEY.test(nextAction.intentId || '') ? { intentId: nextAction.intentId } : {}),
    intent: nextIntent,
    targetId: nextAction.targetId ?? null,
    targetBindingMode: nextAction.targetBindingMode,
    targetType: nextAction.targetType ?? null,
    ...(nextAction.researchIntent ? { researchIntent: validateResearchIntent(nextAction.researchIntent) } : {}),
    ...(nextAction.projectProposal ? { projectProposal: validateProjectProposal(nextAction.projectProposal) } : {}) } : null;
  const toolRequests = validateToolRequests(output.toolRequests);
  if (!Number.isInteger(output.reviewAfterWorldMinutes)
      || output.reviewAfterWorldMinutes < 1 || output.reviewAfterWorldMinutes > 10080) {
    throw new TypeError('REVIEW_INTERVAL_INVALID');
  }
  if (output.requestModel !== null && !['sonnet','opus'].includes(output.requestModel)) {
    throw new TypeError('MODEL_REQUEST_INVALID');
  }
  return { selfModel: selfModelUpdate || prior.selfModel || {}, goals, plans, beliefs, values, policyExperiments,
    openQuestions, memoryUpdates: memories, nextAction: normalizedAction, toolRequests,
    capabilityDecisions,
    reviewAfterWorldMinutes: output.reviewAfterWorldMinutes, requestModel: output.requestModel,
    reasonSummary: output.reasonSummary, uncertainty: output.uncertainty,
    changes: { goalUpdates, planUpdates: normalizedPlanUpdates, beliefUpdates, valueUpdates,
      policyExperimentUpdates, questionUpdates,
      selfModelUpdate, memoryUpdates: memories, toolRequests, capabilityDecisions } };
}
