import { createHash, randomUUID } from 'node:crypto';

const ARGUMENT_KEYS = Object.freeze(['opportunityId','projectId','businessId','serviceId','jobId',
  'workOrderId','capabilityId','socialPartnerId','agreementId','organizationId',
  'direction','contributionType','serviceType','candidateId']);
const TARGET_TYPE_BY_FIELD = Object.freeze({ workOrderId: 'world_work_order', opportunityId: 'opportunity',
  projectId: 'project', businessId: 'business', serviceId: 'service', jobId: 'job',
  capabilityId: 'capability', socialPartnerId: 'resident', agreementId: 'agreement',
  organizationId: 'organization' });
const TARGET_TYPES = new Set([...Object.values(TARGET_TYPE_BY_FIELD), 'cleanup_target',
  'information_share', 'affordance']);
const ENTITY_TARGET_TYPES = new Set(['world_work_order','opportunity','project','cleanup_target',
  'information_share','organization','business','service','job','capability','resident','agreement']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function targetDescriptor(candidate) {
  for (const [field, type] of Object.entries(TARGET_TYPE_BY_FIELD)) {
    if (candidate?.[field] != null) return { type, id: String(candidate[field]) };
  }
  const value = String(candidate?.id || '');
  const match = value.match(/^(project|opportunity|organization|business|service|job|capability|resident|agreement|cleanup[-_]target|information(?:[-_]share)?|world[-_]work[-_]order):(?:[^:]+:)?([0-9a-f-]{36})$/i);
  if (match) {
    const normalizedType = match[1].toLowerCase().replaceAll('-', '_');
    return { type: normalizedType === 'information' ? 'information_share' : normalizedType,
      id: match[2] };
  }
  return value ? { type: 'affordance', id: value } : { type: null, id: null };
}

export function targetReferenceForStep(step = {}) {
  const value = typeof step.targetId === 'string' ? step.targetId : '';
  const patterns = [
    [/^project:(contribute|join|org-join|leave|reject):([0-9a-f-]{36})$/i, 'project'],
    [/^(?:world[-_]work[-_]order|work[-_]order):([0-9a-f-]{36})$/i, 'world_work_order'],
    [/^opportunity:(?:[^:]+:)?([0-9a-f-]{36})$/i, 'opportunity'],
    [/^information(?::(?:accept|ignore|doubt):|[-_]share:)([0-9a-f-]{36})$/i, 'information_share'],
    [/^(organization|business|service|job|capability|resident|agreement|cleanup[-_]target|cleanup_target):(?:[^:]+:)?([0-9a-f-]{36})$/i,
      'typed']
  ];
  for (const [pattern, type] of patterns) {
    const match = value.match(pattern);
    if (match) {
      const parsedType = type === 'typed' ? match[1].toLowerCase().replaceAll('-', '_') : type;
      const middle = value.split(':').slice(1, -1);
      const parsedAction = type === 'typed' && middle.length === 1
        && !/^[0-9a-f-]{36}$/i.test(middle[0]) ? middle[0] : null;
      return { type: parsedType === 'information' ? 'information_share' : parsedType,
        id: match.at(-1), targetAction: parsedAction || (type !== 'typed' && match.length === 3 ? match[1] : null),
        candidateId: value };
    }
  }
  if (step.targetType && TARGET_TYPES.has(step.targetType) && value) {
    const uuids = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/ig) || [];
    if (uuids.length === 1) return { type: step.targetType, id: uuids[0], candidateId: value };
    return { type: step.targetType, id: value, candidateId: value };
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
    id: candidate.id, action: candidate.action, ...targetDescriptor(candidate),
    targetLocation: candidate.targetLocation || null, capabilityId: candidate.capabilityId || null,
    targetStatus: candidate.targetStatus || null,
    targetStateVersion: candidate.targetStateVersion ?? candidate.targetVersion ?? null,
    permissionVersion: candidate.permissionVersion ?? candidate.permissionStatus ?? null,
    requiredResourceState: candidate.requiredResourceState || null
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  // Resource changes that alter feasible actions are reflected in the candidate set.
  // Raw need balances fluctuate each tick and must not wake an unchanged blocked plan.
  return digest({ candidates, location: state.location || null,
    capabilityVersion: state.capabilityVersion || null,
    resourceVersion: state.resourceVersion || null });
}

export function shouldRetryBlockedGrounding(blockedState, currentFingerprint) {
  const saved = blockedState?.retryCondition?.fingerprint || blockedState?.retryFingerprint
    || blockedState?.affordanceFingerprint;
  return !saved || saved !== currentFingerprint;
}

function candidateSnapshot(candidate, { includeResources = false } = {}) {
  return { id: candidate.id, action: candidate.action, ...targetDescriptor(candidate),
    targetLocation: candidate.targetLocation || null, capabilityId: candidate.capabilityId || null,
    targetStatus: candidate.targetStatus || null,
    targetStateVersion: candidate.targetStateVersion ?? candidate.targetVersion ?? null,
    permissionVersion: candidate.permissionVersion ?? candidate.permissionStatus ?? null,
    ...(includeResources ? { requiredResourceState: candidate.requiredResourceState || null } : {}) };
}

function relevantCandidates(affordances, step, targetState) {
  const reference = targetReferenceForStep(step);
  const intentTokens = terms(`${step.intent || ''} ${step.description || ''} ${step.targetType || ''}`);
  const ranked = (Array.isArray(affordances) ? affordances : []).map((candidate) => {
    const descriptor = targetDescriptor(candidate);
    let overlap = 0;
    for (const token of terms(`${candidate.action || ''} ${candidate.goal || ''} ${candidate.description || ''} ${descriptor.type || ''}`)) {
      if (intentTokens.has(token)) overlap += 1;
    }
    const sameTarget = Boolean(reference && descriptor.type === reference.type && descriptor.id === reference.id);
    return { candidate, overlap, sameTarget };
  }).filter((item) => item.sameTarget || item.overlap > 0);
  if (ranked.length) return ranked.map((item) => item.candidate);
  if (reference && targetState?.type === reference.type && String(targetState?.id) === reference.id) return [];
  // When no current candidate has matching language, retain the action set so
  // a newly appearing World affordance can still wake the blocked plan.
  return Array.isArray(affordances) ? affordances : [];
}

export function retryFingerprintFor({ reason, step = {}, state = {}, targetState = null,
  affordances = [], capabilities = [], syncBalances = [], worldMinute = null } = {}) {
  const includeResources = reason === 'missing_resource';
  const selectedCandidates = relevantCandidates(affordances, step, targetState)
    .map((candidate) => candidateSnapshot(candidate, { includeResources }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const reference = targetReferenceForStep(step);
  const resourceState = {
    energyReady: Number(state.energy) >= 20,
    foodReady: Number(state.food) >= 10,
    balances: (syncBalances || []).map((account) => [account.account_type, account.account_key,
      account.balance_raw]).sort((a, b) => String(a[1]).localeCompare(String(b[1])))
  };
  let observed;
  if (reason === 'missing_location' || reason === 'target_wrong_location') {
    observed = { location: state.location || null, targetLocation: targetState?.location || null,
      candidates: selectedCandidates.map(({ id, targetLocation }) => [id, targetLocation]) };
  } else if (reason === 'missing_capability') {
    observed = { capabilities: (capabilities || []).map((item) => [item.key,item.status,
      item.specification || null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))) };
  } else if (reason === 'missing_resource') {
    observed = resourceState;
  } else if (String(reason || '').startsWith('target_')) {
    const deadlineValue = targetState?.deadlineWorldMinute ?? targetState?.deadline_world_minute;
    const minuteValue = worldMinute ?? state.worldMinute;
    const deadline = deadlineValue == null ? Number.NaN : Number(deadlineValue);
    const observedWorldMinute = minuteValue == null ? Number.NaN : Number(minuteValue);
    observed = { target: targetState ? { type: targetState.type, id: targetState.id,
      exists: targetState.exists, status: targetState.status, stateVersion: targetState.stateVersion ?? null,
      permissionStatus: targetState.permissionStatus ?? null, deadlineWorldMinute: targetState.deadlineWorldMinute ?? null,
      deadlinePassed: Number.isFinite(deadline) && Number.isFinite(observedWorldMinute)
        ? observedWorldMinute >= deadline : null,
      location: targetState.location ?? null } : { type: reference?.type || step.targetType || null,
      id: reference?.id || step.targetId || null, exists: null },
      candidates: selectedCandidates };
  } else {
    observed = { candidates: selectedCandidates };
  }
  return { type: reason || 'no_matching_affordance', fingerprint: digest({ reason, observed }),
    targetStateVersion: targetState?.stateVersion ?? null,
    affordanceSignature: digest(selectedCandidates), observed };
}

export function classifyUnavailableTarget({ step = {}, state = {}, targetState = null,
  worldMinute = null } = {}) {
  if (!targetState?.lookupSupported) {
    const type = targetState?.type || step.targetType || targetReferenceForStep(step)?.type;
    const id = targetState?.id || targetReferenceForStep(step)?.id || step.targetId;
    if (ENTITY_TARGET_TYPES.has(type) && id != null && !UUID.test(String(id))) {
      return { reason: 'target_stale_reference', terminal: true };
    }
    return { reason: 'target_affordance_missing', terminal: false };
  }
  if (targetState.exists === false) return { reason: 'target_deleted', terminal: true };
  const statuses = [targetState.status,targetState.targetStatus,targetState.workOrderStatus]
    .filter(Boolean).map((value) => String(value).toLowerCase());
  const deadlineValue = targetState.deadlineWorldMinute ?? targetState.deadline_world_minute;
  const deadline = deadlineValue == null ? Number.NaN : Number(deadlineValue);
  const currentMinute = worldMinute == null ? Number.NaN : Number(worldMinute);
  if (Number.isFinite(deadline) && Number.isFinite(currentMinute) && currentMinute >= deadline) {
    return { reason: 'target_expired', terminal: true };
  }
  if (statuses.some((value) => ['completed','cleared','verified','batched'].includes(value))) {
    return { reason: 'target_completed', terminal: true };
  }
  if (statuses.some((value) => ['expired','failed','cancelled','closed','filled','inactive',
    'bankrupt','dissolved','deprecated','rejected','breached'].includes(value))) {
    return { reason: statuses.includes('expired') || targetState.failureReason === 'deadline_passed'
      ? 'target_expired' : 'target_state_changed', terminal: true };
  }
  if (statuses.some((value) => ['abandoned','deleted','dissolved'].includes(value))) {
    return { reason: statuses.includes('deleted') ? 'target_deleted' : 'target_state_changed', terminal: true };
  }
  const permission = String(targetState.permissionStatus || '').toLowerCase();
  const openWorkOrderAwaitingAcceptance = permission === 'not_accepted'
    && ((targetState.type === 'world_work_order' && statuses.includes('open'))
      || (targetState.type === 'cleanup_target' && statuses.includes('pending')
        && String(targetState.workOrderStatus || '').toLowerCase() === 'open'));
  if (openWorkOrderAwaitingAcceptance) {
    return { reason: 'target_temporarily_unavailable', terminal: false };
  }
  if (permission === 'accepted_by_other' || permission === 'permission_revoked'
      || permission === 'not_accepted' || permission === 'not_recipient' || permission === 'not_participant'
      || (permission === 'not_member'
        && ['contribute','project_contribute','organization_contribute'].includes(targetState.targetAction
          || targetReferenceForStep(step)?.targetAction))
      || (['rejected','left','withdrawn','completed','failed'].includes(permission)
        && ['contribute','project_contribute','organization_contribute'].includes(targetState.targetAction
          || targetReferenceForStep(step)?.targetAction))) {
    return { reason: 'target_permission_changed', terminal: true };
  }
  if (['contribute','project_contribute'].includes(targetState.targetAction)
      && (Number(state.energy) < 20 || Number(state.food) < 10)) {
    return { reason: 'missing_resource', terminal: false };
  }
  if (targetState.location && state.location && targetState.location !== state.location) {
    return { reason: 'target_wrong_location', terminal: false };
  }
  return { reason: 'target_affordance_missing', terminal: false };
}

export function hasCompletedExecutionReplan(plan, fingerprint) {
  return (plan?.executionReplans || []).some((entry) => entry?.fingerprint === fingerprint
    && entry.status === 'completed');
}

export function markExecutionReplanPending(plan, { fingerprint, reason, targetId, targetType,
  targetStateVersion = null, affordanceSignature = null, worldMinute = null } = {}) {
  const prior = Array.isArray(plan?.executionReplans) ? plan.executionReplans : [];
  if (prior.some((entry) => entry.fingerprint === fingerprint)) return plan;
  return { ...plan, executionReplans: [...prior.slice(-19), { fingerprint, status: 'pending', reason,
    targetId: targetId || null, targetType: targetType || null,
    targetStateVersion, affordanceSignature, requestedWorldMinute: worldMinute }] };
}

export function completePendingExecutionReplans(plans, { turnId = null, worldMinute = null,
  trigger = null, fingerprints = null } = {}) {
  if (trigger !== 'execution_replan_required') return Array.isArray(plans) ? plans : [];
  const eligibleFingerprints = fingerprints == null ? null : new Set(fingerprints);
  return (Array.isArray(plans) ? plans : []).map((plan) => {
    let changed = false;
    const executionReplans = (plan.executionReplans || []).map((entry) => {
      if (entry.status !== 'pending'
          || (eligibleFingerprints && !eligibleFingerprints.has(entry.fingerprint))) return entry;
      changed = true;
      return { ...entry, status: 'completed', triggerTurnId: turnId, completedWorldMinute: worldMinute };
    });
    if (!changed) return plan;
    const completedFingerprints = new Set(executionReplans.filter((entry) => entry.status === 'completed')
      .map((entry) => entry.fingerprint));
    const steps = (plan.steps || []).map((step) => step.groundingBlocked
      && completedFingerprints.has(step.groundingBlocked.replanFingerprint
        || step.groundingBlocked.retryFingerprint)
      ? { ...step, groundingBlocked: { ...step.groundingBlocked,
        replanRequired: false, replanTriggered: true, replanResult: 'completed' } } : step);
    return { ...plan, steps, executionReplans };
  });
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
  const bindingMode = step.targetBindingMode || 'exact';
  const requestedTarget = step.targetId == null ? null : String(step.targetId);
  const requestedType = step.targetType || targetReferenceForStep(step)?.type || null;
  const targetReference = targetReferenceForStep(step);
  const retryFor = (reason) => retryFingerprintFor({ reason, step, state,
    targetState: context?.targetState || null, affordances: candidates,
    capabilities, syncBalances: context?.syncBalances || [], worldMinute: context?.world?.minute });
  const blockedTarget = (classification) => {
    const retryCondition = retryFor(classification.reason);
    return { status: 'blocked', reason: classification.reason, terminal: classification.terminal,
      targetId: context?.targetState?.id || targetReference?.id || requestedTarget,
      targetType: context?.targetState?.type || requestedType,
      targetStateVersion: retryCondition.targetStateVersion,
      affordanceSignature: retryCondition.affordanceSignature, retryCondition,
      requiredChange: classification.terminal
        ? 'The exact World target is no longer eligible; the resident must reconsider the blocked intention once.'
        : 'The exact World target must become executable under current World rules.',
      affordanceFingerprint: candidateFingerprint };
  };
  if (!candidates.length) {
    if (bindingMode === 'exact' && requestedTarget != null) {
      return blockedTarget(classifyUnavailableTarget({ step, state,
        targetState: context?.targetState || null, worldMinute: context?.world?.minute }));
    }
    const retryCondition = retryFor('no_matching_affordance');
    return { status: 'blocked', reason: 'no_matching_affordance',
    requiredChange: 'A relevant executable World affordance becomes available.',
    retryCondition,
    affordanceFingerprint: candidateFingerprint };
  }
  const eligibleCandidates = bindingMode === 'exact' && requestedTarget != null ? candidates.filter((candidate) => {
    const descriptor = targetDescriptor(candidate);
    return candidateTargets(candidate).includes(requestedTarget)
      && (!requestedType || !descriptor.type || descriptor.type === requestedType);
  }) : candidates;
  if (!eligibleCandidates.length) {
    return blockedTarget(classifyUnavailableTarget({ step, state,
      targetState: context?.targetState || null, worldMinute: context?.world?.minute }));
  }

  const intentText = `${step.intent || step.description || ''} ${goal.title || ''} ${goal.why || ''}`.trim();
  const capabilitiesForIntent = relatedCapabilities(capabilities, intentText, eligibleCandidates);
  const callContext = { agentId: context?.resident?.id || null, goalId: goal.id,
    planId: plan.id, stepId: step.stepId, groundingResult: 'requested' };
  const result = await requestModel({ tier: 'execution', trigger: 'plan_grounding', callContext,
    correlationId, maxTokens: 1_600,
    messages: [
      { role: 'system', content: 'Ground the resident intent to one currently available executable candidate. Respect targetBindingMode: exact requires the specified World object and must never switch it; semantic treats targetId as a prior candidate hint and may select another live candidate that still serves the same intent. Choose only a listed candidate ID. If none fits the intent, return candidateId=null with one blockedReason from missing_location, missing_capability, missing_resource, no_matching_affordance and a concise requiredChange. Never invent an action, argument, capability, target, permission, or result. The World will validate a selected candidate again. Return only JSON: {"candidateId":null|"...","executableAction":null|"...","arguments":{},"capabilityId":null|"...","targetId":null|"...","targetType":null|"project|opportunity|world_work_order|cleanup_target|organization|business|service|job|capability|resident|agreement|information_share|affordance","expectedOutcome":null|"...","blockedReason":null|"missing_location|missing_capability|missing_resource|no_matching_affordance","requiredChange":null|"..."}. For a selected candidate, blockedReason and requiredChange must be null. For a blocked result, all executable fields must be null/empty. expectedOutcome is a short observable outcome, not hidden reasoning.' },
      { role: 'user', content: JSON.stringify({ goal: { id: goal.id, title: goal.title, why: goal.why },
        plan: { id: plan.id, summary: plan.summary }, step: { stepId: step.stepId,
          intentId: step.intentId, intent: step.intent, description: step.description,
          targetBindingMode: bindingMode, targetType: step.targetType || null,
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
        || proposal.capabilityId !== null || proposal.targetId !== null
        || proposal.targetType !== null || proposal.expectedOutcome !== null) {
      throw Object.assign(new Error('GROUNDING_RESULT_INVALID'), { code: 'GROUNDING_RESULT_INVALID',
        modelCallId: result?.callId || null });
    }
    const retryCondition = retryFor(proposal.blockedReason);
    return { status: 'blocked', reason: proposal.blockedReason, requiredChange: proposal.requiredChange,
      retryCondition,
      affordanceFingerprint: candidateFingerprint, modelCallId: result.callId || null };
  }
  const selected = eligibleCandidates.find((candidate) => candidate.id === proposal?.candidateId);
  const selectedTarget = selected ? targetFor(selected) : null;
  const selectedType = selected ? targetDescriptor(selected).type : null;
  const selectedCapability = selected?.capabilityId == null ? null : String(selected.capabilityId);
  if (!selected || proposal.executableAction !== selected.action
      || !validText(proposal.expectedOutcome, 500)
      || proposal.blockedReason != null || proposal.requiredChange != null
      || (proposal.capabilityId == null ? null : String(proposal.capabilityId)) !== selectedCapability
      || (proposal.targetId == null ? null : String(proposal.targetId)) !== selectedTarget
      || (proposal.targetType == null ? null : String(proposal.targetType)) !== selectedType
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
    intentId: step.intentId, targetBindingMode: bindingMode, targetType: selectedType,
    executableAction: selected.action,
    arguments: canonicalArguments, capabilityId: selectedCapability,
    targetId: selectedTarget, expectedOutcome: proposal.expectedOutcome,
    ...(step.researchIntent ? { researchIntent: step.researchIntent } : {}),
    ...(step.projectProposal ? { projectProposal: step.projectProposal } : {}),
    candidateId: selected.id, executionCorrelationId, affordanceFingerprint: candidateFingerprint,
    modelCallId: result.callId || null };
}
