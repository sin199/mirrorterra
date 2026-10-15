import { createHash, randomUUID } from 'node:crypto';

const ARGUMENT_KEYS = Object.freeze(['opportunityId','projectId','businessId','serviceId','jobId',
  'workOrderId','capabilityId','socialPartnerId','agreementId','organizationId',
  'direction','contributionType','serviceType','candidateId']);

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function targetFor(candidate) {
  for (const key of ['workOrderId','opportunityId','projectId','businessId','serviceId','jobId',
    'capabilityId','socialPartnerId','agreementId','organizationId','id']) {
    if (candidate?.[key] != null) return String(candidate[key]);
  }
  return null;
}

function candidateTargets(candidate) {
  return ['id','workOrderId','opportunityId','projectId','businessId','serviceId','jobId',
    'capabilityId','socialPartnerId','agreementId','organizationId']
    .filter((key) => candidate?.[key] != null).map((key) => String(candidate[key]));
}

function executableArguments(candidate) {
  return Object.fromEntries(ARGUMENT_KEYS.filter((key) => candidate?.[key] !== undefined)
    .map((key) => [key, candidate[key]]));
}

function validText(value, max = 500) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u001f]/.test(value);
}

function terms(value) {
  return new Set((String(value || '').toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]{1,}/gu) || [])
    .filter((word) => word.length > 1));
}

function relatedCapabilities(capabilities, intentText, candidates) {
  const intentTerms = terms(`${intentText} ${(candidates || []).map((candidate) =>
    `${candidate.action} ${candidate.description || ''}`).join(' ')}`);
  return (capabilities || []).map((capability) => {
    const capabilityTerms = terms(`${capability.key} ${capability.description || ''} ${capability.name || ''}`);
    let matches = 0;
    for (const token of capabilityTerms) if (intentTerms.has(token)) matches += 1;
    return { capability, matches };
  }).filter(({ matches }) => matches > 0)
    .sort((a, b) => b.matches - a.matches || String(a.capability.key).localeCompare(String(b.capability.key)))
    .map(({ capability }) => capability);
}

export function affordanceFingerprint(affordances = [], state = {}) {
  const candidates = (Array.isArray(affordances) ? affordances : []).map((candidate) => ({
    id: candidate.id, action: candidate.action, targetId: targetFor(candidate),
    targetLocation: candidate.targetLocation || null, capabilityId: candidate.capabilityId || null
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  // Resource changes that alter feasible actions are reflected in the candidate set.
  // Raw need balances fluctuate each tick and must not wake an unchanged blocked plan.
  return digest({ candidates, location: state.location || null,
    capabilityVersion: state.capabilityVersion || null,
    resourceVersion: state.resourceVersion || null });
}

export function shouldRetryBlockedGrounding(blockedState, currentFingerprint) {
  return !blockedState?.affordanceFingerprint
    || blockedState.affordanceFingerprint !== currentFingerprint;
}

export async function groundPlanStep({ requestModel, context, goal, plan, step,
  affordances = context?.availableAffordances?.candidates || [],
  capabilities = context?.capabilities || [], correlationId = null } = {}) {
  if (typeof requestModel !== 'function') throw Object.assign(new Error('COGNITION_MODEL_ROUTER_REQUIRED'),
    { code: 'COGNITION_MODEL_ROUTER_REQUIRED' });
  if (!goal?.id || !plan?.id || !step?.stepId || !step?.intentId) {
    throw Object.assign(new Error('GROUNDING_CONTEXT_INVALID'), { code: 'GROUNDING_CONTEXT_INVALID' });
  }
  const candidates = (Array.isArray(affordances) ? affordances : [])
    .filter((candidate) => candidate && typeof candidate.id === 'string'
      && typeof candidate.action === 'string' && candidate.action !== 'world_action');
  const state = context?.resident || {};
  const candidateFingerprint = affordanceFingerprint(candidates, { ...state,
    capabilityVersion: context?.capabilityVersion || digest((capabilities || []).map((item) => [
      item.key,item.status,item.specification || null])),
    resourceVersion: digest((context?.syncBalances || []).map((account) => [
      account.account_type,account.account_key,account.balance_raw]).sort((a,b) => String(a[1]).localeCompare(String(b[1])))) });
  if (!candidates.length) return { status: 'blocked', reason: 'no_matching_affordance',
    requiredChange: 'A relevant executable World affordance becomes available.',
    retryCondition: { affordanceFingerprint: candidateFingerprint },
    affordanceFingerprint: candidateFingerprint };
  const requestedTarget = step.targetId == null ? null : String(step.targetId);
  const eligibleCandidates = requestedTarget == null ? candidates
    : candidates.filter((candidate) => candidateTargets(candidate).includes(requestedTarget));
  if (!eligibleCandidates.length) return { status: 'blocked', reason: 'target_affordance_unavailable',
    requiredChange: `The requested target ${requestedTarget} appears in a current executable World affordance.`,
    retryCondition: { affordanceFingerprint: candidateFingerprint },
    affordanceFingerprint: candidateFingerprint };

  const intentText = `${step.intent || step.description || ''} ${goal.title || ''} ${goal.why || ''}`.trim();
  const capabilitiesForIntent = relatedCapabilities(capabilities, intentText, eligibleCandidates);
  const callContext = { agentId: context?.resident?.id || null, goalId: goal.id,
    planId: plan.id, stepId: step.stepId, groundingResult: 'requested' };
  const result = await requestModel({ tier: 'execution', trigger: 'plan_grounding', callContext,
    correlationId, maxTokens: 1_600,
    messages: [
      { role: 'system', content: 'Ground the resident intent to one currently available executable candidate, respecting step.targetId when present. Choose only a listed candidate ID. If none fits the intent, return candidateId=null with one blockedReason from missing_location, missing_capability, missing_resource, no_matching_affordance and a concise requiredChange. Never invent an action, argument, capability, target, permission, or result. The World will validate a selected candidate again. Return only JSON: {"candidateId":null|"...","executableAction":null|"...","arguments":{},"capabilityId":null|"...","targetId":null|"...","expectedOutcome":null|"...","blockedReason":null|"missing_location|missing_capability|missing_resource|no_matching_affordance","requiredChange":null|"..."}. For a selected candidate, blockedReason and requiredChange must be null. For a blocked result, all executable fields must be null/empty. expectedOutcome is a short observable outcome, not hidden reasoning.' },
      { role: 'user', content: JSON.stringify({ goal: { id: goal.id, title: goal.title, why: goal.why },
        plan: { id: plan.id, summary: plan.summary }, step: { stepId: step.stepId,
          intentId: step.intentId, intent: step.intent, description: step.description,
          targetId: step.targetId ?? null },
        world: { minute: context?.world?.minute, environment: context?.world?.environment,
          location: state.location, energy: state.energy, food: state.food, social: state.social },
        affordances: eligibleCandidates, capabilities: capabilitiesForIntent }) }
    ] });
  const proposal = result?.output;
  if (proposal?.candidateId === null) {
    const blockedReasons = new Set(['missing_location','missing_capability','missing_resource','no_matching_affordance']);
    if (!blockedReasons.has(proposal.blockedReason) || !validText(proposal.requiredChange, 500)
        || proposal.executableAction !== null || !proposal.arguments || Object.keys(proposal.arguments).length
        || proposal.capabilityId !== null || proposal.targetId !== null || proposal.expectedOutcome !== null) {
      throw Object.assign(new Error('GROUNDING_RESULT_INVALID'), { code: 'GROUNDING_RESULT_INVALID',
        modelCallId: result?.callId || null });
    }
    return { status: 'blocked', reason: proposal.blockedReason, requiredChange: proposal.requiredChange,
      retryCondition: { affordanceFingerprint: candidateFingerprint },
      affordanceFingerprint: candidateFingerprint, modelCallId: result.callId || null };
  }
  const selected = eligibleCandidates.find((candidate) => candidate.id === proposal?.candidateId);
  const selectedTarget = selected ? targetFor(selected) : null;
  const selectedCapability = selected?.capabilityId == null ? null : String(selected.capabilityId);
  if (!selected || proposal.executableAction !== selected.action
      || !validText(proposal.expectedOutcome, 500)
      || proposal.blockedReason != null || proposal.requiredChange != null
      || (proposal.capabilityId == null ? null : String(proposal.capabilityId)) !== selectedCapability
      || (proposal.targetId == null ? null : String(proposal.targetId)) !== selectedTarget
      || !proposal.arguments || typeof proposal.arguments !== 'object' || Array.isArray(proposal.arguments)) {
    throw Object.assign(new Error('GROUNDING_RESULT_INVALID'), { code: 'GROUNDING_RESULT_INVALID',
      modelCallId: result?.callId || null });
  }
  const canonicalArguments = executableArguments(selected);
  for (const [key, value] of Object.entries(proposal.arguments)) {
    if (!ARGUMENT_KEYS.includes(key) || canonicalArguments[key] === undefined
        || JSON.stringify(value) !== JSON.stringify(canonicalArguments[key])) {
      throw Object.assign(new Error('GROUNDING_ARGUMENT_NOT_AUTHORIZED'), {
        code: 'GROUNDING_ARGUMENT_NOT_AUTHORIZED', modelCallId: result?.callId || null });
    }
  }
  const executionCorrelationId = correlationId || randomUUID();
  return { status: 'grounded', goalId: goal.id, planId: plan.id, stepId: step.stepId,
    intentId: step.intentId, executableAction: selected.action,
    arguments: canonicalArguments, capabilityId: selectedCapability,
    targetId: selectedTarget, expectedOutcome: proposal.expectedOutcome,
    ...(step.researchIntent ? { researchIntent: step.researchIntent } : {}),
    ...(step.projectProposal ? { projectProposal: step.projectProposal } : {}),
    candidateId: selected.id, executionCorrelationId, affordanceFingerprint: candidateFingerprint,
    modelCallId: result.callId || null };
}
