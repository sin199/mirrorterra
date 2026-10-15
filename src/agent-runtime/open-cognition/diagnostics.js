const MAX_AGENTS = 10;
const MAX_MODEL_CALL_IDS = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const FAILURE_CATEGORIES = new Set(['provider_insufficient_balance', 'provider_model_unsupported',
  'provider_request_failed']);

function finiteCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 2_147_483_647) : 0;
}

function boundedString(value, max = 180) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u001f]/.test(value) ? value : null;
}

function safeWorldMinute(value) {
  if (value == null || value === '') return null;
  const minute = Number(value);
  return Number.isSafeInteger(minute) && minute >= 0 ? minute : null;
}

function currentPlan(plans = []) {
  return [...(Array.isArray(plans) ? plans : [])]
    .sort((left, right) => Number(right?.status === 'active') - Number(left?.status === 'active'))
    .find((plan) => ['active', 'blocked'].includes(plan?.status)
      && Number.isInteger(plan.currentStep) && plan.currentStep >= 0
      && plan.currentStep < (Array.isArray(plan.steps) ? plan.steps.length : 0)) || null;
}

function matchingReplan(plan, fingerprint) {
  if (!fingerprint) return null;
  return (Array.isArray(plan?.executionReplans) ? plan.executionReplans : [])
    .find((entry) => entry?.fingerprint === fingerprint) || null;
}

function latestExecutionReplan(plan) {
  return [...(Array.isArray(plan?.executionReplans) ? plan.executionReplans : [])]
    .sort((left, right) => Number(right?.completedWorldMinute ?? right?.requestedWorldMinute ?? 0)
      - Number(left?.completedWorldMinute ?? left?.requestedWorldMinute ?? 0))[0] || null;
}

function relevantReplan(plan, step) {
  return matchingReplan(plan, fingerprintFor(step)) || latestExecutionReplan(plan);
}

function fingerprintFor(step) {
  return step?.groundingBlocked?.retryFingerprint
    || step?.groundingBlocked?.retryCondition?.fingerprint
    || (step?.groundingDiagnostics?.fingerprintKind !== 'affordance'
      ? step?.groundingDiagnostics?.retryFingerprintHash || step?.groundingDiagnostics?.stateFingerprintHash : null)
    || null;
}

function modelCallIdsForStep(step, plan) {
  const replan = relevantReplan(plan, step);
  const ids = [
    ...(Array.isArray(step?.groundingDiagnostics?.modelCallIds) ? step.groundingDiagnostics.modelCallIds : []),
    ...(Array.isArray(replan?.modelCallIds) ? replan.modelCallIds : [])
  ].filter((id) => typeof id === 'string' && UUID.test(id));
  return [...new Set(ids)].slice(-MAX_MODEL_CALL_IDS);
}

export function cognitionDiagnosticModelCallIds(stateRows = []) {
  const ids = [];
  for (const row of (Array.isArray(stateRows) ? stateRows : []).slice(0, MAX_AGENTS)) {
    const plan = currentPlan(row?.plans);
    const step = plan?.steps?.[plan.currentStep];
    ids.push(...modelCallIdsForStep(step, plan));
  }
  return [...new Set(ids)].slice(0, MAX_AGENTS * MAX_MODEL_CALL_IDS);
}

export function isExecutionReplanEligible(entry) {
  return entry?.status === 'pending'
    && (entry.replanTriggered !== true || entry.providerRetryEligible === true);
}

export function eligibleExecutionReplanFingerprints(plans = []) {
  return [...new Set((Array.isArray(plans) ? plans : []).flatMap((plan) =>
    (Array.isArray(plan?.executionReplans) ? plan.executionReplans : [])
      .filter(isExecutionReplanEligible)
      .map((entry) => entry.fingerprint)
      .filter((value) => typeof value === 'string' && SHA256.test(value))))];
}

export function markProviderRecoveryAvailable(plans = [], { worldMinute = null } = {}) {
  const minute = safeWorldMinute(worldMinute);
  let changed = false;
  const updated = (Array.isArray(plans) ? plans : []).map((plan) => {
    if (!Array.isArray(plan?.executionReplans)) return plan;
    let planChanged = false;
    const executionReplans = plan.executionReplans.map((entry) => {
      if (entry?.status !== 'pending' || entry.replanTriggered !== true
          || entry.providerRetryEligible === true) return entry;
      planChanged = true;
      return { ...entry, providerRetryEligible: true, providerRecoveryWorldMinute: minute };
    });
    if (!planChanged) return plan;
    changed = true;
    return { ...plan, executionReplans };
  });
  return changed ? updated : plans;
}

export function cognitionPlanForPrompt(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  const { groundingDiagnostics: _groundingDiagnostics, ...visiblePlan } = plan;
  const visibleReplans = (Array.isArray(plan.executionReplans) ? plan.executionReplans : []).map((entry) => {
    const { modelCallIds: _modelCallIds, modelCallCount: _modelCallCount,
      providerFailureCategory: _providerFailureCategory, replanTriggered: _replanTriggered,
      replanCompleted: _replanCompleted, providerRetryEligible: _providerRetryEligible,
      providerRecoveryWorldMinute: _providerRecoveryWorldMinute, ...visibleEntry } = entry;
    return visibleEntry;
  });
  const visibleSteps = (Array.isArray(plan.steps) ? plan.steps : []).map((step) => {
    const { groundingDiagnostics: _groundingDiagnostics, ...visibleStep } = step;
    if (step.groundingTelemetry && typeof step.groundingTelemetry === 'object') {
      const { model_call_id: _modelCallId, ...visibleTelemetry } = step.groundingTelemetry;
      visibleStep.groundingTelemetry = visibleTelemetry;
    }
    if (step.groundingBlocked && typeof step.groundingBlocked === 'object') {
      const { replanCompleted: _replanCompleted, replanFailureCode: _replanFailureCode,
        ...visibleBlocked } = step.groundingBlocked;
      visibleStep.groundingBlocked = visibleBlocked;
    }
    return visibleStep;
  });
  return { ...visiblePlan,
    ...(Array.isArray(plan.executionReplans) ? { executionReplans: visibleReplans } : {}),
    ...(Array.isArray(plan.steps) ? { steps: visibleSteps } : {}) };
}

export function isPrivateCognitionDiagnosticsRequest({ bindHost, hostHeader, remoteAddress } = {}) {
  const loopbackHosts = new Set(['127.0.0.1', '::1', 'localhost']);
  let requestHost = '';
  try {
    requestHost = new URL(`http://${String(hostHeader || '')}`).hostname.toLowerCase()
      .replace(/^\[|\]$/g, '');
  } catch { return false; }
  const bind = String(bindHost || '').toLowerCase().replace(/^\[|\]$/g, '');
  const remote = String(remoteAddress || '').toLowerCase().replace(/^::ffff:/, '');
  return loopbackHosts.has(bind) && loopbackHosts.has(requestHost)
    && (remote === '127.0.0.1' || remote === '::1');
}

export function nextGroundingDiagnostics(previous, { fingerprint, fingerprintKind = 'retry',
  worldMinute, modelCallId = null } = {}) {
  const safeFingerprint = typeof fingerprint === 'string' && SHA256.test(fingerprint) ? fingerprint : null;
  if (!safeFingerprint) return previous && typeof previous === 'object' ? previous : null;
  const kind = fingerprintKind === 'affordance' ? 'affordance' : 'retry';
  const previousFingerprint = previous?.stateFingerprintHash || previous?.retryFingerprintHash;
  const sameFingerprint = previousFingerprint === safeFingerprint && previous?.fingerprintKind === kind;
  const oldIds = sameFingerprint && Array.isArray(previous?.modelCallIds)
    ? previous.modelCallIds.filter((id) => UUID.test(String(id))).slice(-MAX_MODEL_CALL_IDS) : [];
  const newId = typeof modelCallId === 'string' && UUID.test(modelCallId) ? modelCallId : null;
  const modelCallIds = newId ? [...oldIds.filter((id) => id !== newId), newId].slice(-MAX_MODEL_CALL_IDS) : oldIds;
  const isNewModelCall = Boolean(newId && !oldIds.includes(newId));
  const minute = safeWorldMinute(worldMinute);
  const priorFingerprint = typeof previous?.retryFingerprintHash === 'string'
    && SHA256.test(previous.retryFingerprintHash) ? previous.retryFingerprintHash
    : typeof previous?.stateFingerprintHash === 'string' && SHA256.test(previous.stateFingerprintHash)
      ? previous.stateFingerprintHash : null;
  return {
    retryFingerprintHash: kind === 'retry' ? safeFingerprint : null,
    stateFingerprintHash: safeFingerprint,
    fingerprintKind: kind,
    groundingChecks: Math.min(2_147_483_647,
      sameFingerprint ? finiteCounter(previous?.groundingChecks) + 1 : 1),
    deterministicGroundingChecks: Math.min(2_147_483_647,
      sameFingerprint ? finiteCounter(previous?.deterministicGroundingChecks) + Number(!newId) : Number(!newId)),
    retryGateChecks: sameFingerprint ? finiteCounter(previous?.retryGateChecks) : 0,
    modelCallCount: Math.min(2_147_483_647,
      (sameFingerprint ? finiteCounter(previous?.modelCallCount) : 0) + Number(isNewModelCall)),
    modelCallIds,
    lastGroundingWorldMinute: minute,
    // This is the World minute when a changed relevant fingerprint was first observed;
    // older state cannot establish the exact historical change minute.
    lastRelevantStateChangeWorldMinute: sameFingerprint
      ? safeWorldMinute(previous?.lastRelevantStateChangeWorldMinute)
      : priorFingerprint ? minute : null
  };
}

export function nextRetryGateDiagnostics(previous, { fingerprint, worldMinute } = {}) {
  const safeFingerprint = typeof fingerprint === 'string' && SHA256.test(fingerprint) ? fingerprint : null;
  if (!safeFingerprint) return previous && typeof previous === 'object' ? previous : null;
  const previousFingerprint = previous?.stateFingerprintHash || previous?.retryFingerprintHash;
  const sameFingerprint = previousFingerprint === safeFingerprint && previous?.fingerprintKind !== 'affordance';
  const minute = safeWorldMinute(worldMinute);
  const priorFingerprint = typeof previousFingerprint === 'string'
    && SHA256.test(previousFingerprint) ? previousFingerprint : null;
  return {
    retryFingerprintHash: safeFingerprint,
    stateFingerprintHash: safeFingerprint,
    fingerprintKind: 'retry',
    groundingChecks: sameFingerprint ? finiteCounter(previous?.groundingChecks) : 0,
    deterministicGroundingChecks: sameFingerprint ? finiteCounter(previous?.deterministicGroundingChecks) : 0,
    retryGateChecks: Math.min(2_147_483_647,
      (sameFingerprint ? finiteCounter(previous?.retryGateChecks) : 0) + 1),
    modelCallCount: sameFingerprint ? finiteCounter(previous?.modelCallCount) : 0,
    modelCallIds: sameFingerprint && Array.isArray(previous?.modelCallIds)
      ? previous.modelCallIds.filter((id) => UUID.test(String(id))).slice(-MAX_MODEL_CALL_IDS) : [],
    lastGroundingWorldMinute: sameFingerprint ? safeWorldMinute(previous?.lastGroundingWorldMinute) : null,
    lastRelevantStateChangeWorldMinute: sameFingerprint
      ? safeWorldMinute(previous?.lastRelevantStateChangeWorldMinute)
      : priorFingerprint ? minute : null
  };
}

export function recordExecutionReplanAttempt(plans = [], { fingerprints = [], modelCallIds = [],
  modelCallAttempted = null, providerFailureCategory = null } = {}) {
  const allowedFingerprints = new Set((Array.isArray(fingerprints) ? fingerprints : [])
    .filter((value) => typeof value === 'string' && SHA256.test(value)));
  const safeIds = (Array.isArray(modelCallIds) ? modelCallIds : [])
    .filter((id) => typeof id === 'string' && UUID.test(id));
  const triggered = modelCallAttempted == null ? safeIds.length > 0 : modelCallAttempted === true;
  const safeFailure = FAILURE_CATEGORIES.has(providerFailureCategory) ? providerFailureCategory : null;
  if (!allowedFingerprints.size) return Array.isArray(plans) ? plans : [];
  return (Array.isArray(plans) ? plans : []).map((plan) => {
    let changed = false;
    const executionReplans = (Array.isArray(plan.executionReplans) ? plan.executionReplans : []).map((entry) => {
      if (!allowedFingerprints.has(entry?.fingerprint) || entry.status !== 'pending') return entry;
      changed = true;
      const priorIds = Array.isArray(entry.modelCallIds) ? entry.modelCallIds.filter((id) => UUID.test(String(id))) : [];
      const addedIds = safeIds.filter((id) => !priorIds.includes(id));
      return { ...entry,
        modelCallIds: [...priorIds, ...addedIds].slice(-MAX_MODEL_CALL_IDS),
        modelCallCount: Math.min(2_147_483_647, finiteCounter(entry.modelCallCount) + addedIds.length),
        replanTriggered: Boolean(entry.replanTriggered || triggered),
        replanCompleted: false,
        providerRetryEligible: triggered ? false : entry.providerRetryEligible !== false,
        providerFailureCategory: safeFailure || entry.providerFailureCategory || null };
    });
    if (!changed) return plan;
    const steps = (Array.isArray(plan.steps) ? plan.steps : []).map((step) => {
      const blockedFingerprint = step?.groundingBlocked?.replanFingerprint
        || step?.groundingBlocked?.retryFingerprint;
      if (!allowedFingerprints.has(blockedFingerprint)) return step;
      return { ...step, groundingBlocked: { ...step.groundingBlocked,
        replanRequired: true,
        replanTriggered: Boolean(step.groundingBlocked.replanTriggered || triggered),
        replanCompleted: false,
        replanResult: 'pending',
        replanFailureCode: safeFailure || step.groundingBlocked.replanFailureCode || null } };
    });
    return { ...plan, executionReplans, steps };
  });
}

function safeFailureCategory(value) {
  return FAILURE_CATEGORIES.has(value) ? value : null;
}

function tokenTotal(rows, key) {
  const values = rows.map((row) => row[key]).filter((value) => value != null && value !== ''
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0);
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) : null;
}

function summarizeModelCalls(rows = [], totalModelCallCount = null) {
  const byTier = Object.fromEntries(['haiku', 'sonnet', 'opus'].map((tier) => [tier, {
    calls: 0, succeeded: 0, failed: 0, cachedSelections: 0, cacheHits: 0,
    inputTokens: null, outputTokens: null, totalTokens: null
  }]));
  const retained = Array.isArray(rows) ? rows : [];
  for (const row of retained) {
    const tier = byTier[row.tier] ? row.tier : null;
    if (!tier) continue;
    const summary = byTier[tier];
    if (row.status === 'cached') summary.cachedSelections += 1;
    else summary.calls += 1;
    if (row.status === 'succeeded') summary.succeeded += 1;
    if (row.status === 'failed') summary.failed += 1;
    if (row.cache_hit === true || row.status === 'cached') summary.cacheHits += 1;
  }
  for (const tier of Object.keys(byTier)) {
    const tierRows = retained.filter((row) => row.tier === tier);
    byTier[tier].inputTokens = tokenTotal(tierRows, 'input_tokens');
    byTier[tier].outputTokens = tokenTotal(tierRows, 'output_tokens');
    byTier[tier].totalTokens = tokenTotal(tierRows, 'total_tokens');
  }
  const total = Number.isSafeInteger(totalModelCallCount) && totalModelCallCount >= 0
    ? totalModelCallCount : null;
  const retainedCount = retained.length;
  const providerCallsRetained = retained.filter((row) => row.status !== 'cached').length;
  const complete = total == null ? false : total === retainedCount;
  const usageRows = retained.filter((row) => row.status !== 'cached');
  const usageKnownCalls = usageRows.filter((row) => row.total_tokens != null
    || row.input_tokens != null || row.output_tokens != null).length;
  if (total == null) {
    for (const tier of Object.keys(byTier)) {
      byTier[tier] = { calls: null, succeeded: null, failed: null, cachedSelections: null,
        cacheHits: null, inputTokens: null, outputTokens: null, totalTokens: null };
    }
  }
  return {
    coverage: total == null ? 'not_attributable' : 'fingerprint_linked',
    totalCalls: complete ? providerCallsRetained : null,
    retainedProviderCalls: providerCallsRetained,
    linkedRecordsTracked: total,
    retainedCalls: retainedCount,
    complete,
    failedCalls: complete ? retained.filter((row) => row.status === 'failed').length : null,
    cacheHits: complete ? retained.filter((row) => row.cache_hit === true || row.status === 'cached').length : null,
    inputTokens: complete ? tokenTotal(retained, 'input_tokens') : null,
    outputTokens: complete ? tokenTotal(retained, 'output_tokens') : null,
    totalTokens: complete ? tokenTotal(retained, 'total_tokens') : null,
    tokenUsageCoverage: total == null ? 'not_attributable'
      : usageKnownCalls === providerCallsRetained ? 'complete'
        : usageKnownCalls ? 'partial' : providerCallsRetained ? 'unavailable' : 'no_provider_calls',
    byTier
  };
}

function safeLifecycle(value) {
  const safe = boundedString(value, 64);
  return safe && /^[a-z0-9 _-]+$/i.test(safe) ? safe : null;
}

export function projectCognitionDiagnostics(stateRows = [], modelCallRows = [], { worldId = null,
  worldMinute = null } = {}) {
  const modelCalls = new Map((Array.isArray(modelCallRows) ? modelCallRows : [])
    .filter((row) => row && typeof row.id === 'string' && UUID.test(row.id)).map((row) => [row.id, row]));
  const agents = [];
  for (const row of (Array.isArray(stateRows) ? stateRows : []).slice(0, MAX_AGENTS)) {
    const plan = currentPlan(row?.plans);
    if (!plan) continue;
    const step = plan.steps[plan.currentStep];
    const blocked = step?.groundingBlocked && typeof step.groundingBlocked === 'object'
      ? step.groundingBlocked : null;
    const diagnostics = step?.groundingDiagnostics && typeof step.groundingDiagnostics === 'object'
      ? step.groundingDiagnostics : null;
    const retry = blocked?.retryCondition && typeof blocked.retryCondition === 'object'
      ? blocked.retryCondition : {};
    const fingerprint = fingerprintFor(step);
    const replan = relevantReplan(plan, step);
    const callIds = modelCallIdsForStep(step, plan);
    const linkedCalls = callIds.map((id) => modelCalls.get(id)).filter(Boolean);
    const diagnosticFingerprint = diagnostics?.stateFingerprintHash || diagnostics?.retryFingerprintHash;
    const hasDiagnostics = Boolean(diagnostics && SHA256.test(String(diagnosticFingerprint || '')));
    const hasReplanMetrics = Number.isSafeInteger(replan?.modelCallCount) && replan.modelCallCount >= 0;
    const targetObserved = retry?.observed?.target && typeof retry.observed.target === 'object'
      ? retry.observed.target : {};
    const retryFingerprintHash = typeof fingerprint === 'string' && SHA256.test(fingerprint) ? fingerprint : null;
    const affordanceSignature = blocked?.affordanceSignature || retry?.affordanceSignature || null;
    const safeAffordanceSignature = typeof affordanceSignature === 'string'
      && SHA256.test(affordanceSignature) ? affordanceSignature : null;
    const replanStatusKnown = Boolean(replan && ['pending', 'completed'].includes(replan.status));
    const replanTriggered = typeof blocked?.replanTriggered === 'boolean' ? blocked.replanTriggered
      : typeof replan?.replanTriggered === 'boolean' ? replan.replanTriggered : null;
    const replanCompleted = replan?.status === 'completed' || replan?.replanCompleted === true
      ? true : replan?.status === 'pending' || replan?.replanCompleted === false
        ? false : typeof blocked?.replanCompleted === 'boolean' ? blocked.replanCompleted
          : replanStatusKnown ? false : null;
    const providerFailureCategory = safeFailureCategory(replan?.providerFailureCategory)
      || safeFailureCategory(blocked?.providerFailureCategory)
      || safeFailureCategory(blocked?.replanFailureCode);
    const telemetry = step?.groundingTelemetry && typeof step.groundingTelemetry === 'object'
      ? step.groundingTelemetry : null;
    const lastCallId = callIds.at(-1) || null;
    const lastCompletedStep = [...(Array.isArray(plan.steps) ? plan.steps.slice(0, plan.currentStep) : [])]
      .reverse().find((item) => item?.executionEvidence?.success === true);
    const coverage = hasDiagnostics ? 'instrumented' : hasReplanMetrics ? 'replan_instrumented'
      : telemetry ? 'step_telemetry_only' : 'not_instrumented';
    const diagnosticCallIds = Array.isArray(diagnostics?.modelCallIds) ? diagnostics.modelCallIds : [];
    const replanCallIds = Array.isArray(replan?.modelCallIds) ? replan.modelCallIds : [];
    const duplicateLinkedCalls = new Set(diagnosticCallIds.filter((id) => replanCallIds.includes(id))).size;
    const modelCallCount = hasDiagnostics
      ? Math.max(0, finiteCounter(diagnostics.modelCallCount) + finiteCounter(replan?.modelCallCount)
        - duplicateLinkedCalls)
      : hasReplanMetrics ? replan.modelCallCount : null;
    agents.push({
      agentId: boundedString(String(row.agent_id || ''), 80),
      goalId: boundedString(String(plan.goalId || ''), 120),
      planId: boundedString(String(plan.id || ''), 120),
      stepId: boundedString(String(step?.stepId || ''), 120),
      planStatus: plan.status,
      currentStep: Number.isInteger(plan.currentStep) ? plan.currentStep : null,
      stepCount: Array.isArray(plan.steps) ? plan.steps.length : null,
      targetBindingMode: ['exact', 'semantic'].includes(step?.targetBindingMode)
        ? step.targetBindingMode : ['exact', 'semantic'].includes(blocked?.targetBindingMode)
          ? blocked.targetBindingMode : null,
      targetId: boundedString(String(blocked?.targetId ?? step?.targetId ?? ''), 180),
      targetType: boundedString(String(blocked?.targetType ?? step?.targetType ?? ''), 80),
      blockedReason: boundedString(String(blocked?.reason || ''), 80),
      groundingAttempted: typeof telemetry?.grounding_attempted === 'boolean'
        ? telemetry.grounding_attempted : null,
      groundingSucceeded: typeof telemetry?.grounding_succeeded === 'boolean'
        ? telemetry.grounding_succeeded : null,
      groundingStatus: boundedString(String(telemetry?.grounding_status || ''), 40),
      targetStateVersion: boundedString(String(blocked?.targetStateVersion ?? retry?.targetStateVersion ?? ''), 100),
      targetLifecycleStatus: safeLifecycle(targetObserved.status || targetObserved.targetStatus
        || targetObserved.workOrderStatus || retry?.observed?.status),
      targetLifecycleObserved: Boolean(targetObserved.status || targetObserved.targetStatus
        || targetObserved.workOrderStatus || retry?.observed?.status),
      retryFingerprintHash: blocked ? retryFingerprintHash : null,
      retryCondition: retryFingerprintHash ? {
        type: boundedString(String(retry.type || blocked?.reason || ''), 80),
        fingerprintHash: retryFingerprintHash,
        targetStateVersion: boundedString(String(retry.targetStateVersion ?? blocked?.targetStateVersion ?? ''), 100),
        relevantAffordanceSignature: safeAffordanceSignature,
        targetLifecycleStatus: safeLifecycle(targetObserved.status || targetObserved.targetStatus
          || targetObserved.workOrderStatus || retry?.observed?.status)
      } : null,
      relevantAffordanceSignature: safeAffordanceSignature,
      replanRequired: typeof blocked?.replanRequired === 'boolean' ? blocked.replanRequired
        : replan?.status === 'pending' ? true : replan?.status === 'completed' ? false : null,
      replanTriggered,
      replanCompleted,
      replanFailureCode: providerFailureCategory,
      providerRetryEligible: replan ? isExecutionReplanEligible(replan) : null,
      providerRecoveryWorldMinute: safeWorldMinute(replan?.providerRecoveryWorldMinute),
      lastExecutionReplan: replan ? {
        fingerprintHash: typeof replan.fingerprint === 'string' && SHA256.test(replan.fingerprint)
          ? replan.fingerprint : null,
        reason: boundedString(String(replan.reason || ''), 80),
        targetId: boundedString(String(replan.targetId || ''), 180),
        targetType: boundedString(String(replan.targetType || ''), 80),
        targetStateVersion: boundedString(String(replan.targetStateVersion ?? ''), 100),
        status: ['pending', 'completed'].includes(replan.status) ? replan.status : null,
        replanTriggered: typeof replan.replanTriggered === 'boolean' ? replan.replanTriggered : null,
        replanCompleted: typeof replan.replanCompleted === 'boolean' ? replan.replanCompleted
          : replan.status === 'completed' ? true : replan.status === 'pending' ? false : null,
        providerFailureCategory: safeFailureCategory(replan.providerFailureCategory),
        providerRetryEligible: isExecutionReplanEligible(replan),
        providerRecoveryWorldMinute: safeWorldMinute(replan.providerRecoveryWorldMinute),
        modelCallId: callIds.at(-1) || null
      } : null,
      lastGroundingWorldMinute: safeWorldMinute(diagnostics?.lastGroundingWorldMinute
        ?? blocked?.observedWorldMinute),
      lastRelevantStateChangeWorldMinute: hasDiagnostics
        ? safeWorldMinute(diagnostics.lastRelevantStateChangeWorldMinute) : null,
      modelCallId: lastCallId,
      providerFailureCategory,
      lastCompletedStep: lastCompletedStep ? {
        stepId: boundedString(String(lastCompletedStep.stepId || ''), 120),
        eventId: lastCompletedStep.executionEvidence.eventId != null
          && Number.isSafeInteger(Number(lastCompletedStep.executionEvidence.eventId))
          ? Number(lastCompletedStep.executionEvidence.eventId) : null,
        correlationId: typeof lastCompletedStep.executionEvidence.correlationId === 'string'
          && UUID.test(lastCompletedStep.executionEvidence.correlationId)
          ? lastCompletedStep.executionEvidence.correlationId : null,
        worldMinute: safeWorldMinute(lastCompletedStep.executionEvidence.worldMinute)
      } : null,
      diagnosticCoverage: coverage,
      fingerprintMetrics: {
        coverage: hasDiagnostics ? 'instrumented' : hasReplanMetrics ? 'replan_instrumented' : 'not_instrumented',
        groundingAttempts: hasDiagnostics ? finiteCounter(diagnostics.groundingChecks) : null,
        deterministicGroundingChecks: hasDiagnostics
          ? finiteCounter(diagnostics.deterministicGroundingChecks) : null,
        unchangedRetryGateChecks: hasDiagnostics ? finiteCounter(diagnostics.retryGateChecks) : null,
        modelCalls: summarizeModelCalls(linkedCalls, modelCallCount)
      }
    });
  }
  const sampledAgentCount = Array.isArray(stateRows) ? stateRows.length : 0;
  const totalAgentCount = stateRows?.[0]?.total_agents ?? sampledAgentCount;
  return { worldId: boundedString(String(worldId || ''), 80),
    worldMinute: safeWorldMinute(worldMinute), agentCount: finiteCounter(Number(totalAgentCount)),
    agentsSampled: Math.min(MAX_AGENTS, sampledAgentCount), agentsWithActivePlan: agents.length, agents };
}
