import { createHash, randomUUID } from 'node:crypto';
import { createCognitionModelRouter, configuredCognitionCatalog, DEFAULT_OPEN_COGNITION_MODEL,
  discoverBaiClaudeModels, selectConfiguredClaudeCatalog } from './provider.js';
import { evidenceRefsForContext, readCognitionContext } from './context.js';
import { runModelAnalysisSubtask, runOpenCognition, selectRelevantMemories } from './prompt.js';
import { affordanceFingerprint, completePendingExecutionReplans, groundPlanStep,
  hasCompletedExecutionReplan, markExecutionReplanPending, retryFingerprintFor,
  shouldRetryBlockedGrounding } from './grounding.js';
import { cognitionPlanForPrompt, eligibleExecutionReplanFingerprints, markProviderRecoveryAvailable,
  nextGroundingDiagnostics, nextRetryGateDiagnostics,
  recordExecutionReplanAttempt } from './diagnostics.js';
import { prefilterMemoryCandidates } from './memory-retrieval.js';
import { materialCognitionFingerprint, nextScheduledSlot, shouldCallForMaterialChange,
  SCHEDULE_PERIOD_MS } from './schedule.js';
import { createBaiBudgetGateway } from '../bai-budget.js';
import { readPublicGitHub } from './github-public-read.js';
import { createWorldCapabilityProposal, reviewWorldCapabilityProposal,
  reviewWorldCapabilityExperiment } from '../../world-capabilities.js';
import { clearRevisedRuntime, planRevisionChanged, reconcilePlan,
  shouldEscalateBlocked } from './lifecycle.js';

const LEASE_SECONDS = 180;
const RETRY_MINUTES = 60;
const PROVIDER_RETRY_MINUTES = 4 * 60 * 60;

async function initializeScheduledSlots(pool, worldId) {
  const runtime = await pool.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`, [worldId]);
  const minute = Number(runtime.rows[0]?.world_minutes || 0);
  const rows = await pool.query(`SELECT agent_id,next_scheduled_at,next_review_world_minute,review_reason
    FROM world_agent_cognition_state WHERE world_id=$1 ORDER BY agent_id`, [worldId]);
  const now = Date.now();
  const ordinals = new Map();
  for (const [index, row] of rows.rows.entries()) {
    ordinals.set(row.agent_id, index);
    if (row.next_scheduled_at && new Date(row.next_scheduled_at).getTime() > now) continue;
    const next = nextScheduledSlot(now, index, rows.rowCount);
    await pool.query(`UPDATE world_agent_cognition_state SET next_scheduled_at=$3,
        next_review_world_minute=CASE WHEN review_reason='scheduled' AND next_review_world_minute<=$4 THEN $5
          ELSE next_review_world_minute END,updated_at=now()
      WHERE world_id=$1 AND agent_id=$2`, [worldId, row.agent_id, new Date(next), minute,
      minute + Math.ceil((next - now) / 1_000)]);
  }
  return ordinals;
}

async function applyCapabilityDecision(client, { worldId, agentId, turnId, index, decision, worldMinute }) {
  const actionId = `cognition-capability:${turnId}:${index}`;
  const evidence = { cognitionTurnId: turnId, refs: decision.evidenceRefs,
    ...(decision.type === 'review_experiment' ? { useId: String(decision.useId) } : {}) };
  if (decision.type === 'propose') return createWorldCapabilityProposal(client, {
    worldId, agentId, worldMinute, actionId, gapId: decision.gapId,
    proposal: decision.proposal });
  if (decision.type === 'review_proposal') return reviewWorldCapabilityProposal(client, {
    worldId, agentId, worldMinute, actionId, proposalId: decision.proposalId,
    decision: decision.decision, rationale: decision.rationale,
    suggestedSpecification: decision.suggestedSpecification, evidence,
    decisionSource: 'agent_cognition' });
  const use = await client.query(`SELECT 1 FROM world_capability_uses
    WHERE world_id=$1 AND id=$2 AND experiment_id=$3
      AND (actor_agent_id=$4 OR partner_agent_id=$4)`,
  [worldId, decision.useId, decision.experimentId, agentId]);
  if (!use.rowCount) throw Object.assign(new Error('CAPABILITY_EXPERIENCE_STALE'),
    { code: 'CAPABILITY_EXPERIENCE_STALE' });
  return reviewWorldCapabilityExperiment(client, { worldId, agentId, worldMinute, actionId,
    experimentId: decision.experimentId, decision: decision.decision,
    rationale: decision.rationale, evidence, decisionSource: 'agent_cognition' });
}

async function ensureResidentRows(pool, worldId) {
  await pool.query(`INSERT INTO world_agent_cognition_state(world_id,agent_id)
    SELECT world_id,agent_id FROM world_members WHERE world_id=$1
    ON CONFLICT(world_id,agent_id) DO NOTHING`, [worldId]);
}

function reconciledPlans(state, context) {
  const plan = currentPlan(state);
  const options = { worldMinute: context.world.minute, state: context.resident,
    targetState: context.targetState, affordances: context.availableAffordances?.candidates || [],
    capabilities: context.capabilities || [], syncBalances: context.syncBalances || [] };
  return (state.plans || []).map((item) => reconcilePlan(item,
    item.id === plan?.id ? options : { ...options, targetState: null }));
}

async function reconcileResident(pool, worldId, agentId, leaseToken = null) {
  const { state, context } = await readCognitionContext(pool, { worldId, agentId });
  if (!state) return false;
  const plans = reconciledPlans(state, context);
  if (JSON.stringify(plans) === JSON.stringify(state.plans || [])) return false;
  const hasReplan = plans.some((plan) => plan.status === 'replan_required'
    && (plan.executionReplans || []).some((entry) => entry.status === 'pending'));
  const resumed = plans.some((plan) => plan.status === 'active'
    && (state.plans || []).find((item) => item.id === plan.id)?.status === 'replan_required');
  const terminalized = plans.find((plan) => ['completed','failed','abandoned'].includes(plan.status)
    && !['completed','failed','abandoned'].includes((state.plans || [])
      .find((item) => item.id === plan.id)?.status));
  const stalePendingAction = hasReplan && plans.some((plan) => plan.status === 'replan_required'
    && plan.id === state.pending_action?.planId);
  const updated = await pool.query(`UPDATE world_agent_cognition_state SET plans=$5::jsonb,
      revision=revision+1,review_reason=CASE WHEN $6 THEN 'execution_replan_required'
        WHEN $8 THEN 'plan_grounding' WHEN $10='completed' THEN 'plan_completed'
        WHEN $10 IS NOT NULL THEN 'major_failure' ELSE review_reason END,
      pending_action=CASE WHEN $9 THEN '{}'::jsonb ELSE pending_action END,
      next_review_world_minute=CASE WHEN $6 OR $8 OR $10 IS NOT NULL
        THEN LEAST(next_review_world_minute,$7)
        ELSE next_review_world_minute END,updated_at=now()
    WHERE world_id=$1 AND agent_id=$2 AND revision=$3
      AND ($4::uuid IS NULL AND (lease_token IS NULL OR lease_until<now()) OR lease_token=$4)`,
  [worldId, agentId, state.revision, leaseToken, JSON.stringify(plans), hasReplan,
    Number(context.world.minute), resumed, stalePendingAction, terminalized?.status || null]);
  return Boolean(updated.rowCount);
}

async function claimDueTurn(pool, worldId, ordinals) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query(`SELECT state.agent_id,state.revision,state.review_reason,
        state.next_review_world_minute,state.goals,state.plans,state.pending_action,
        state.available_affordances,state.affordances_world_minute,state.next_scheduled_at,
        state.last_material_fingerprint,runtime.world_minutes
      FROM world_agent_cognition_state state JOIN world_runtime_state runtime ON runtime.world_id=state.world_id
      WHERE state.world_id=$1 AND ((state.review_reason<>'scheduled'
          AND state.next_review_world_minute<=runtime.world_minutes)
          OR state.next_scheduled_at<=now())
        AND (state.budget_deferred_until IS NULL OR state.budget_deferred_until<=now())
        AND (state.lease_until IS NULL OR state.lease_until<now())
      ORDER BY CASE WHEN state.review_reason<>'scheduled'
          AND state.next_review_world_minute<=runtime.world_minutes THEN 0 ELSE 1 END,
        state.next_review_world_minute,state.agent_id
      FOR UPDATE OF state SKIP LOCKED LIMIT 1`, [worldId]);
    if (!due.rowCount) { await client.query('COMMIT'); return null; }
    const row = due.rows[0];
    const token = randomUUID();
    const eventDue = row.review_reason !== 'scheduled'
      && Number(row.next_review_world_minute) <= Number(row.world_minutes);
    const scheduled = !eventDue;
    const nextSlot = scheduled ? nextScheduledSlot(Date.now(), ordinals.get(row.agent_id), ordinals.size) : null;
    const plans = scheduled ? markProviderRecoveryAvailable(row.plans || [],
      { worldMinute: Number(row.world_minutes) }) : row.plans || [];
    const recovered = plans !== row.plans && JSON.stringify(plans) !== JSON.stringify(row.plans || []);
    await client.query(`UPDATE world_agent_cognition_state
      SET lease_token=$3,lease_until=now()+($4::int * interval '1 second'),
        next_scheduled_at=CASE WHEN $5::timestamptz IS NULL THEN next_scheduled_at ELSE $5 END,
        last_scheduled_at=CASE WHEN $6::boolean THEN now() ELSE last_scheduled_at END,
        plans=CASE WHEN $7::boolean THEN $8::jsonb ELSE plans END,
        revision=revision+CASE WHEN $7::boolean THEN 1 ELSE 0 END,
        updated_at=now()
      WHERE world_id=$1 AND agent_id=$2`, [worldId, row.agent_id, token, LEASE_SECONDS,
      nextSlot === null ? null : new Date(nextSlot), scheduled, recovered, JSON.stringify(plans)]);
    const executionReplanFingerprints = eligibleExecutionReplanFingerprints(plans);
    const pendingExecutionReplan = executionReplanFingerprints.length > 0;
    const fallbackReason = row.review_reason === 'execution_replan_required'
      ? 'provider_retry' : row.review_reason;
    const strategicTrigger = pendingExecutionReplan ? 'execution_replan_required' : scheduled ? 'scheduled'
      : ({ initial: 'initial', strategic_review: 'strategic_review',
      identity_revision: 'identity_revision', goal_conflict: 'goal_conflict',
      major_failure: 'major_failure' })[row.review_reason] || fallbackReason;
    const plan = currentPlan({ plans }) || plans.find((item) => item.status === 'replan_required');
    await client.query(`INSERT INTO world_agent_cognition_gate_decisions(world_id,agent_id,
        correlation_id,trigger_reason,plan_id,step_id,scheduled_slot,deferred_need_type,
        concurrency_admissible,decision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,true,'claimed')`,
    [worldId, row.agent_id, token, strategicTrigger, plan?.id || null,
      plan?.steps?.[plan.currentStep]?.stepId || null, row.next_scheduled_at,
      pendingExecutionReplan ? 'execution_replan' : null]);
    await client.query('COMMIT');
    return { agentId: row.agent_id, revision: Number(row.revision) + Number(recovered), goals: row.goals,
      plans, pendingAction: row.pending_action,
      availableAffordances: row.available_affordances,
      affordancesWorldMinute: row.affordances_world_minute,
      executionReplanFingerprints,
      trigger: strategicTrigger, scheduled,
      previousFingerprint: row.last_material_fingerprint,
      triggerKey: `${row.revision}:${scheduled ? row.next_scheduled_at : row.next_review_world_minute}:${strategicTrigger}`,
      observedWorldMinute: Number(row.world_minutes), token, correlationId: token };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function recordGateDecision(pool, claim, { decision, rejectionCode = null,
  materialFingerprint = null, materialChanged = null, budgetAdmissible = null,
  rateAdmissible = null, concurrencyAdmissible = null, nextEligibleAt = null } = {}) {
  await pool.query(`UPDATE world_agent_cognition_gate_decisions SET decision=$2,
      rejection_code=$3,material_fingerprint=COALESCE($4,material_fingerprint),
      material_changed=COALESCE($5,material_changed),
      budget_admissible=COALESCE($6,budget_admissible),
      rate_admissible=COALESCE($7,rate_admissible),
      concurrency_admissible=COALESCE($9,concurrency_admissible),
      next_eligible_at=$8,updated_at=now() WHERE correlation_id=$1`,
  [claim.correlationId, decision, rejectionCode, materialFingerprint, materialChanged,
    budgetAdmissible, rateAdmissible, nextEligibleAt, concurrencyAdmissible]);
}

async function deferredUntilFor(budgetGateway, error) {
  if (error?.nextAdmissionPossibleAt) return error.nextAdmissionPossibleAt;
  const admission = await budgetGateway.availability();
  return admission.nextAdmissionPossibleAt || admission.nextRateSlotAt
    || new Date(Date.now() + PROVIDER_RETRY_MINUTES * 60_000).toISOString();
}

async function postponeTurn(pool, worldId, claim, error = null, budgetGateway = null) {
  const failureCode = String(error?.code || error?.message || '');
  const budgetBlocked = failureCode === 'MODEL_DAILY_BUDGET_EXCEEDED'
    || failureCode === 'MODEL_HOURLY_RATE_LIMITED'
    || failureCode.startsWith('BAI_BUDGET_') || failureCode === 'BAI_PRICE_UNAVAILABLE';
  const deferredUntil = budgetBlocked && budgetGateway
    ? await deferredUntilFor(budgetGateway, error) : null;
  const strategicPending = ['strategic_review','identity_revision','goal_conflict',
    'major_failure','major_opportunity','initial'].includes(claim.trigger);
  const reason = budgetBlocked && claim.trigger === 'execution_replan_required'
    ? claim.trigger : budgetBlocked && !claim.scheduled ? claim.trigger
    : claim.scheduled ? 'scheduled' : strategicPending ? claim.trigger
      : failureCode === 'provider_insufficient_balance' ? 'provider_insufficient_balance'
        : 'provider_retry';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT revision,lease_token,plans
      FROM world_agent_cognition_state WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`,
    [worldId, claim.agentId]);
    if (!current.rowCount || Number(current.rows[0].revision) !== claim.revision
        || current.rows[0].lease_token !== claim.token) {
      await client.query('ROLLBACK');
      return;
    }
    let plans = Array.isArray(current.rows[0].plans) ? current.rows[0].plans : [];
    if (budgetBlocked && claim.deferredPlanId && claim.deferredStepId) {
      plans = plans.map((plan) => plan.id !== claim.deferredPlanId ? plan : {
        ...plan, steps: (plan.steps || []).map((step) => step.stepId !== claim.deferredStepId
          ? step : { ...step, modelDeferredReason: failureCode === 'MODEL_HOURLY_RATE_LIMITED'
            ? 'rate_limit' : 'budget', modelDeferredUntil: deferredUntil }) });
    }
    if (!budgetBlocked && claim.trigger === 'execution_replan_required' && claim.executionReplanFingerprints?.length) {
      const calls = await client.query(`SELECT id,status,failure_code FROM world_agent_cognition_model_calls
        WHERE world_id=$1 AND agent_id=$2 AND correlation_id=$3
        ORDER BY created_at,id LIMIT 32`, [worldId, claim.agentId, claim.correlationId]);
      const modelCallIds = calls.rows.map((row) => row.id).filter((id) => typeof id === 'string');
      const failureCategory = calls.rows.filter((row) => row.status === 'failed').at(-1)?.failure_code || null;
      plans = recordExecutionReplanAttempt(plans, { fingerprints: claim.executionReplanFingerprints,
        modelCallIds, modelCallAttempted: calls.rows.some((row) => row.status !== 'cached'),
        providerFailureCategory: failureCategory });
    }
    const isReplanRetry = !budgetBlocked && claim.trigger === 'execution_replan_required'
      && Boolean(claim.executionReplanFingerprints?.length);
    await client.query(`UPDATE world_agent_cognition_state
      SET revision=revision+CASE WHEN $8::boolean THEN 1 ELSE 0 END,
        plans=$4::jsonb,lease_token=NULL,lease_until=NULL,
        next_review_world_minute=CASE WHEN $12::boolean THEN
          (SELECT world_minutes FROM world_runtime_state WHERE world_id=$1)
          ELSE GREATEST(next_review_world_minute,
            (SELECT world_minutes+$5 FROM world_runtime_state WHERE world_id=$1)) END,
        review_reason=$6,budget_deferred_until=$9,
        pending_material_fingerprint=CASE WHEN $10::boolean THEN $11 ELSE pending_material_fingerprint END,
        updated_at=now()
      WHERE world_id=$1 AND agent_id=$2 AND lease_token=$3 AND revision=$7`,
    [worldId, claim.agentId, claim.token, JSON.stringify(plans),
      claim.scheduled && claim.trigger !== 'execution_replan_required'
        ? Math.ceil(SCHEDULE_PERIOD_MS / 1_000)
        : budgetBlocked ? 0 : PROVIDER_RETRY_MINUTES,
      reason, claim.revision, isReplanRetry || Boolean(budgetBlocked && claim.deferredPlanId), deferredUntil,
      budgetBlocked, claim.materialFingerprint || null,
      budgetBlocked && claim.trigger === 'execution_replan_required']);
    await client.query('COMMIT');
    await recordGateDecision(pool, claim, { decision: failureCode === 'BAI_MODEL_CALL_BUSY'
      ? 'concurrency_blocked' : budgetBlocked
        ? failureCode === 'MODEL_HOURLY_RATE_LIMITED' ? 'rate_blocked' : 'budget_blocked'
        : 'provider_deferred', rejectionCode: failureCode || null,
    budgetAdmissible: failureCode === 'MODEL_HOURLY_RATE_LIMITED' ? true
      : failureCode === 'MODEL_DAILY_BUDGET_EXCEEDED' ? false : null,
    rateAdmissible: failureCode === 'MODEL_HOURLY_RATE_LIMITED' ? false : null,
    concurrencyAdmissible: failureCode === 'BAI_MODEL_CALL_BUSY' ? false : null,
    nextEligibleAt: deferredUntil });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function recordModelCall(pool, worldId, event) {
  if (!event?.id) return;
  if (event.phase === 'telemetry_error') {
    throw Object.assign(new Error('APPLICATION_TELEMETRY_WRITE_FAILED'),
      { code: 'APPLICATION_TELEMETRY_WRITE_FAILED' });
  }
  if (event.phase === 'application') {
    await pool.query(`UPDATE world_agent_cognition_model_calls
      SET application_status=$2,application_failure_code=$3 WHERE id=$1 AND world_id=$4`,
    [event.id, event.applicationStatus, event.applicationFailureCode || null, worldId]);
    return;
  }
  if (!event.agentId) return;
  if (event.phase === 'started') {
    await pool.query(`INSERT INTO world_agent_cognition_model_calls(id,world_id,agent_id,correlation_id,
        tier,model,trigger,goal_id,plan_id,step_id,status,cache_hit,memory_candidates,
        memory_prefiltered,memory_selected,grounding_result,execution_result,context_fingerprint)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'started',$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT(id) DO NOTHING`, [event.id, worldId, event.agentId, event.correlationId,
      event.tier, event.model, event.trigger, event.goalId, event.planId, event.stepId,
      event.cacheHit === true, event.memoryCandidates, event.memoryPrefiltered,
      event.memorySelected, event.groundingResult, event.executionResult,
      event.contextFingerprint || null]);
    await recordGateDecision(pool, { correlationId: event.correlationId }, {
      decision: 'provider_admitted', budgetAdmissible: true, rateAdmissible: true });
    return;
  }
  await pool.query(`UPDATE world_agent_cognition_model_calls SET status=$2,model=COALESCE($10,model),
      input_tokens=$3,output_tokens=$4,total_tokens=$5,failure_code=$6,
      grounding_result=COALESCE($7,grounding_result),execution_result=COALESCE($8,execution_result),
      completed_at=now()
    WHERE id=$1 AND world_id=$9`, [event.id, event.phase === 'succeeded' ? 'succeeded' : 'failed',
    event.inputTokens ?? null, event.outputTokens ?? null, event.totalTokens ?? null,
    event.failureCode || null, event.groundingResult || null, event.executionResult || null, worldId, event.model || null]);
}

async function recordMemoryCacheHit(pool, worldId, claim, selection) {
  const agentId = claim.agentId;
  const plans = claim.plans || [];
  const activePlan = plans.find((plan) => plan.status === 'active'
    && Number.isInteger(plan.currentStep) && plan.currentStep < (plan.steps || []).length);
  const activeGoal = (claim.goals || []).find((goal) => goal.id === activePlan?.goalId);
  const inserted = await pool.query(`INSERT INTO world_agent_cognition_model_calls(world_id,agent_id,correlation_id,
      tier,model,trigger,goal_id,plan_id,step_id,status,cache_hit,memory_candidates,
      memory_prefiltered,memory_selected,grounding_result,context_fingerprint,created_at,completed_at)
    VALUES($1,$2,$3,'haiku',$4,'memory_selection',$5,$6,$7,'cached',true,$8,$9,$10,'cache_hit',$11,now(),now())
    RETURNING id`,
  [worldId, agentId, claim.correlationId, 'cache', activeGoal?.id || null,
    activePlan?.id || null, activePlan?.steps?.[activePlan.currentStep]?.stepId || null,
    selection.candidateCount,
    selection.prefilteredCount, selection.selectedCount, selection.cacheKey || null]);
  return inserted.rows[0]?.id || null;
}

async function recordMemorySelectionResult(pool, worldId, selection) {
  if (!selection.modelCallId) return;
  await pool.query(`UPDATE world_agent_cognition_model_calls SET memory_selected=$3
    WHERE world_id=$1 AND id=$2 AND status='succeeded'`,
  [worldId, selection.modelCallId, selection.selectedCount]);
}

async function persistMemorySelection(pool, worldId, claim, key, ids, modelCallId = null) {
  const updated = await pool.query(`UPDATE world_agent_cognition_state
    SET memory_selection_cache=$4::jsonb,updated_at=now()
    WHERE world_id=$1 AND agent_id=$2 AND lease_token=$3 AND revision=$5`,
  [worldId, claim.agentId, claim.token, JSON.stringify({ key, ids, modelCallId }), claim.revision]);
  if (!updated.rowCount) throw Object.assign(new Error('MEMORY_CACHE_PERSIST_FAILED'),
    { code: 'MEMORY_CACHE_PERSIST_FAILED' });
}

function currentPlan(state) {
  const plans = Array.isArray(state?.plans) ? state.plans : [];
  const plan = [...plans].sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active'))
    .find((item) => ['active','blocked'].includes(item?.status)
    && Number.isInteger(item.currentStep) && item.currentStep < (item.steps?.length || 0));
  if (!plan) return null;
  const steps = (plan.steps || []).map((step, index) => ({ ...step,
    stepId: typeof step.stepId === 'string' ? step.stepId : `${String(plan.id).slice(0, 50)}:step:${index}`,
    intentId: typeof step.intentId === 'string' ? step.intentId : `${String(plan.id).slice(0, 46)}:intent:${index}`,
    intent: step.intent || step.description,
    actionType: step.actionType || 'world_action' }));
  return { ...plan, steps };
}

function worldAffordanceFingerprint(context) {
  const capabilityVersion = createHash('sha256').update(JSON.stringify((context?.capabilities || [])
    .map((item) => [item.key,item.status,item.specification || null]))).digest('hex');
  return affordanceFingerprint(context?.availableAffordances?.candidates || [], {
    ...(context?.resident || {}), capabilityVersion,
    resourceVersion: createHash('sha256').update(JSON.stringify((context?.syncBalances || [])
      .map((account) => [account.account_type,account.account_key,account.balance_raw])
      .sort((a,b) => String(a[1]).localeCompare(String(b[1]))))).digest('hex') });
}

async function finishGroundingClaim(pool, worldId, claim, context, { grounding = null,
  blocked = null, plan, step, rejectedModelCallId = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT revision,lease_token,goals,plans,pending_action
      FROM world_agent_cognition_state WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`,
    [worldId, claim.agentId]);
    if (!current.rowCount || Number(current.rows[0].revision) !== claim.revision
        || current.rows[0].lease_token !== claim.token) {
      await client.query('ROLLBACK');
      return { committed: false, reason: 'stale_grounding' };
    }
    const minute = Number((await client.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`,
      [worldId])).rows[0].world_minutes);
    const plans = Array.isArray(current.rows[0].plans) ? current.rows[0].plans : [];
    let found = false;
    const updatedPlans = plans.map((item) => {
      const itemSteps = (item.steps || []).map((currentStep, index) => ({ ...currentStep,
        stepId: typeof currentStep.stepId === 'string' ? currentStep.stepId : `${String(item.id).slice(0, 50)}:step:${index}`,
        intentId: typeof currentStep.intentId === 'string' ? currentStep.intentId : `${String(item.id).slice(0, 46)}:intent:${index}`,
        intent: currentStep.intent || currentStep.description,
        actionType: currentStep.actionType || 'world_action' }));
      if (item.id !== plan.id || item.currentStep !== plan.currentStep
          || itemSteps?.[item.currentStep]?.stepId !== step.stepId) return item;
      found = true;
      const blockedFingerprint = blocked?.retryCondition?.fingerprint || blocked?.retryFingerprint || null;
      const priorReplan = blockedFingerprint
        ? (item.executionReplans || []).find((entry) => entry.fingerprint === blockedFingerprint) : null;
      const steps = itemSteps.map((currentStep, index) => index === item.currentStep
        ? { ...currentStep,
          status: blocked ? 'blocked' : grounding?.status === 'grounded' ? 'executable' : 'pending',
          modelDeferredReason: null, modelDeferredUntil: null,
          groundingTelemetry: { grounding_attempted: Boolean(grounding || rejectedModelCallId),
            grounding_succeeded: grounding?.status === 'grounded',
            grounding_status: grounding?.status === 'grounded' ? 'grounded'
              : rejectedModelCallId ? 'rejected' : blocked ? 'blocked' : 'not_attempted',
            blocked_reason: blocked?.reason || null,
            model_call_id: grounding?.modelCallId || rejectedModelCallId || null,
            model_field_warnings: grounding?.modelFieldWarnings || [] },
          groundingDiagnostics: nextGroundingDiagnostics(currentStep.groundingDiagnostics, {
            fingerprint: blocked?.retryCondition?.fingerprint || blocked?.retryFingerprint
              || grounding?.affordanceFingerprint || blocked?.affordanceFingerprint,
            fingerprintKind: blocked?.retryCondition?.fingerprint || blocked?.retryFingerprint
              ? 'retry' : 'affordance',
            worldMinute: minute, modelCallId: grounding?.modelCallId || rejectedModelCallId || null }),
          groundingBlocked: blocked ? { reason: blocked.reason,
            targetId: blocked.targetId ?? step.targetId ?? null,
            targetType: blocked.targetType ?? step.targetType ?? null,
            targetBindingMode: step.targetBindingMode || 'exact',
            targetStateVersion: blocked.targetStateVersion ?? null,
            affordanceSignature: blocked.affordanceSignature ?? blocked.retryCondition?.affordanceSignature ?? null,
            retryCondition: blocked.retryCondition || null,
            retryFingerprint: blockedFingerprint,
            replanRequired: blocked.replanRequired === true,
            replanTriggered: priorReplan ? Boolean(priorReplan.replanTriggered || priorReplan.modelCallIds?.length) : false,
            replanCompleted: priorReplan ? priorReplan.status === 'completed' : false,
            replanFailureCode: priorReplan?.providerFailureCategory || null,
            replanResult: priorReplan?.status === 'completed' ? 'completed'
              : blocked.replanRequired === true ? 'pending' : null,
            replanFingerprint: blockedFingerprint,
            observedWorldMinute: minute, affordanceFingerprint: blocked.affordanceFingerprint,
            requiredChange: blocked.requiredChange || 'A relevant target, permission, resource, location, or affordance state changes.' }
          : null } : currentStep);
      let updated = { ...item, steps, status: blocked
        ? blocked.replanRequired ? 'replan_required' : 'blocked' : 'active' };
      if (blocked?.replanRequired && blocked.retryCondition?.fingerprint) {
        updated = markExecutionReplanPending(updated, { fingerprint: blocked.retryCondition.fingerprint,
          reason: blocked.reason, targetId: blocked.targetId ?? step.targetId,
          targetType: blocked.targetType ?? step.targetType,
          targetStateVersion: blocked.targetStateVersion,
          affordanceSignature: blocked.affordanceSignature, worldMinute: minute });
      }
      return updated;
    });
    if (!found) { await client.query('ROLLBACK'); return { committed: false, reason: 'plan_step_changed' }; }
    let pendingAction = {};
    if (grounding?.status === 'grounded') pendingAction = { ...grounding,
      attributionModelCallIds: [...new Set([...(step.attributionModelCallIds || []),
        grounding.modelCallId].filter(Boolean))],
      attributionTurnId: step.attributionTurnId || null };
    await client.query(`UPDATE world_agent_cognition_state SET revision=revision+1,plans=$4::jsonb,
        pending_action=$5::jsonb,next_review_world_minute=$6,review_reason=$7,
        lease_token=NULL,lease_until=NULL,updated_at=now()
      WHERE world_id=$1 AND agent_id=$2 AND lease_token=$3`,
    [worldId, claim.agentId, claim.token, JSON.stringify(updatedPlans), JSON.stringify(pendingAction),
      blocked?.replanRequired ? minute : minute + RETRY_MINUTES,
      blocked?.replanRequired ? 'execution_replan_required' : blocked ? 'plan_blocked' : 'plan_grounded']);
    if (grounding?.modelCallId) await client.query(`UPDATE world_agent_cognition_model_calls
      SET grounding_result=$3 WHERE id=$1 AND world_id=$2`,
    [grounding.modelCallId, worldId, grounding.status === 'grounded' ? 'grounding_succeeded'
      : `blocked:${String(grounding.reason || 'unknown').slice(0, 64)}`]);
    if (grounding?.modelCallId) {
      for (const callId of pendingAction.attributionModelCallIds || [grounding.modelCallId]) {
        await client.query(`INSERT INTO bai_model_call_effects(model_call_id,effect_type,
            cognition_turn_id,goal_id,plan_id,step_id)
          VALUES($1,$2,$3,$4,$5,$6)`, [callId,
          grounding.status === 'grounded' ? 'grounding_succeeded' : 'grounding_attempted',
          step.attributionTurnId || null, plan.goalId || null, plan.id, step.stepId]);
      }
    }
    if (rejectedModelCallId) await client.query(`UPDATE world_agent_cognition_model_calls
      SET grounding_result='rejected' WHERE id=$1 AND world_id=$2`, [rejectedModelCallId, worldId]);
    await client.query('COMMIT');
    return { committed: true, grounded: grounding?.status === 'grounded',
      groundingAttempted: Boolean(grounding || rejectedModelCallId),
      groundingSucceeded: grounding?.status === 'grounded',
      groundingStatus: grounding?.status === 'grounded' ? 'grounded'
        : rejectedModelCallId ? 'rejected' : blocked ? 'blocked' : 'not_attempted',
      blocked: blocked?.reason || null, worldMinute: minute };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function deferUnchangedGrounding(pool, worldId, claim, minute,
  { planId = null, stepId = null, fingerprint = null } = {}) {
  if (!fingerprint) {
    await pool.query(`UPDATE world_agent_cognition_state SET lease_token=NULL,lease_until=NULL,
        next_review_world_minute=GREATEST(next_review_world_minute,$4),review_reason='plan_blocked',updated_at=now()
      WHERE world_id=$1 AND agent_id=$2 AND lease_token=$3 AND revision=$5`,
    [worldId, claim.agentId, claim.token, minute + RETRY_MINUTES, claim.revision]);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT revision,lease_token,plans
      FROM world_agent_cognition_state WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`,
    [worldId, claim.agentId]);
    if (!current.rowCount || Number(current.rows[0].revision) !== claim.revision
        || current.rows[0].lease_token !== claim.token) {
      await client.query('ROLLBACK');
      return;
    }
    const plans = Array.isArray(current.rows[0].plans) ? current.rows[0].plans : [];
    const updatedPlans = plans.map((plan) => {
      if (plan.id !== planId) return plan;
      const steps = (plan.steps || []).map((step, index) => {
        const currentStepId = typeof step.stepId === 'string' ? step.stepId
          : `${String(plan.id).slice(0, 50)}:step:${index}`;
        if (currentStepId !== stepId || plan.currentStep !== index) return step;
        return { ...step, groundingDiagnostics: nextRetryGateDiagnostics(step.groundingDiagnostics,
          { fingerprint, worldMinute: minute }) };
      });
      return { ...plan, steps };
    });
    await client.query(`UPDATE world_agent_cognition_state SET revision=revision+1,plans=$4::jsonb,
        lease_token=NULL,lease_until=NULL,
        next_review_world_minute=GREATEST(next_review_world_minute,$5),review_reason='plan_blocked',updated_at=now()
      WHERE world_id=$1 AND agent_id=$2 AND lease_token=$3 AND revision=$6`,
    [worldId, claim.agentId, claim.token, JSON.stringify(updatedPlans), minute + RETRY_MINUTES, claim.revision]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function releaseClaim(pool, worldId, claim) {
  await pool.query(`UPDATE world_agent_cognition_state
    SET lease_token=NULL,lease_until=NULL,updated_at=now()
    WHERE world_id=$1 AND agent_id=$2 AND lease_token=$3`,
  [worldId, claim.agentId, claim.token]);
}

async function skipUnchangedTurn(pool, worldId, claim, context, fingerprint) {
  await pool.query(`UPDATE world_agent_cognition_state SET
      lease_token=NULL,lease_until=NULL,last_material_fingerprint=$4,
      pending_material_fingerprint=NULL,budget_deferred_until=NULL,
      last_context_event_id=GREATEST(last_context_event_id,$5),
      last_context_tool_sequence=GREATEST(last_context_tool_sequence,$6),
      next_review_world_minute=GREATEST(next_review_world_minute,
        (SELECT world_minutes+$7 FROM world_runtime_state WHERE world_id=$1)),
      review_reason='scheduled',updated_at=now()
    WHERE world_id=$1 AND agent_id=$2 AND lease_token=$3 AND revision=$8`,
  [worldId, claim.agentId, claim.token, fingerprint,
    Number(context.world?.delta?.cursor || 0), Number(context.world?.delta?.toolCursor || 0),
    Math.ceil(SCHEDULE_PERIOD_MS / 1_000), claim.revision]);
}

async function commitTurn(pool, worldId, claim, context, result, selection) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT revision,lease_token,self_model,goals,plans,beliefs FROM world_agent_cognition_state
      WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`, [worldId, claim.agentId]);
    if (!current.rowCount || Number(current.rows[0].revision) !== claim.revision
        || current.rows[0].lease_token !== claim.token) {
      await client.query('ROLLBACK');
      return { committed: false, reason: 'stale_turn' };
    }
    const minute = Number((await client.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`,
      [worldId])).rows[0].world_minutes);
    const contextHash = createHash('sha256').update(JSON.stringify(context)).digest('hex');
    const revisedReplanPlans = new Set((result.intent.plans || []).filter((plan) => {
      const previous = (current.rows[0].plans || []).find((item) => item.id === plan.id);
      return previous && (previous.executionReplans || []).some((entry) =>
        claim.executionReplanFingerprints?.includes(entry.fingerprint))
        && planRevisionChanged(previous, plan);
    }).map((plan) => plan.id));
    const replanForNextAction = claim.trigger === 'execution_replan_required'
      && result.intent.nextAction && !(result.intent.plans || []).some((plan) =>
        plan.status === 'active' && plan.currentStep < (plan.steps || []).length)
      ? (result.intent.plans || []).find((plan) =>
        plan.status === 'replan_required'
        && (result.intent.goals || []).some((goal) => goal.id === plan.goalId && goal.status === 'active')
        && (plan.executionReplans || []).some((entry) =>
          claim.executionReplanFingerprints?.includes(entry.fingerprint))) : null;
    if (replanForNextAction) revisedReplanPlans.add(replanForNextAction.id);
    const decisionSource = claim.trigger === 'initial' ? 'open_cognition'
      : ['tool_result','research_result'].includes(claim.trigger) ? 'tool_result'
        : claim.trigger === 'strategic_review' ? 'strategic_review' : 'plan_revision';
    const turn = await client.query(`INSERT INTO world_agent_cognition_turns(world_id,agent_id,trigger_key,
        observed_world_minute,base_revision,result_revision,provider,model,model_tier,context_sha256,
        decision_source,intent,usage)
      VALUES($1,$2,$3,$4,$5,$6,'bai',$7,$8,$9,$10,$11::jsonb,$12::jsonb)
      ON CONFLICT(world_id,agent_id,trigger_key) DO NOTHING RETURNING id`,
    [worldId, claim.agentId, claim.triggerKey, claim.observedWorldMinute, claim.revision,
      claim.revision + 1, result.model, result.tier, contextHash, decisionSource,
      JSON.stringify({ ...result.intent.changes, nextAction: result.intent.nextAction,
        reasonSummary: result.intent.reasonSummary, uncertainty: result.intent.uncertainty }),
      JSON.stringify({ calls: result.usage, memorySelection: selection.selectionMode,
        memorySelectionUsage: selection.usage || null, escalated: result.escalated,
        toolCallGuard: { suppressed: result.toolCallGuard?.suppressed || [] },
        replanCompleted: claim.trigger === 'execution_replan_required'
          && revisedReplanPlans.size > 0 })]);
    if (!turn.rowCount) { await client.query('ROLLBACK'); return { committed: false, reason: 'duplicate_turn' }; }
    const priorGoalIds = new Set((current.rows[0].goals || []).map((goal) => goal.id));
    const priorPlanIds = new Set((current.rows[0].plans || []).map((plan) => plan.id));
    const relatedModelCallIds = [...new Set([selection.modelCallId, selection.telemetryId,
      ...result.usage.map((call) => call.callId)].filter((id) => typeof id === 'string'))];
    const paidCallIds = [...new Set([selection.modelCallId, selection.originModelCallId,
      ...result.usage.map((call) => call.callId)].filter((id) => typeof id === 'string'))];
    const goals = result.intent.goals.map((goal) => priorGoalIds.has(goal.id) ? goal
      : { ...goal, origin: { type: 'model_cognition', source: 'model', turnId: turn.rows[0].id } });
    for (const goal of [...result.intent.changes.goalUpdates]
      .sort((left, right) => Number(left.status === 'active') - Number(right.status === 'active'))) {
      if (!goal.category) continue; // Existing pre-category goals remain readable.
      const status = goal.status === 'failed' ? 'abandoned' : goal.status;
      const projection = await client.query(`UPDATE world_agent_goals SET
          description=$4,priority=$5,status=$6,updated_world_minutes=$7,updated_at=now(),
          metadata=metadata||$8::jsonb
        WHERE world_id=$1 AND agent_id=$2 AND source='model'
          AND metadata->>'cognitionGoalId'=$3 RETURNING id`,
      [worldId, claim.agentId, goal.id, goal.title.slice(0, 240),
        goal.priority / 100, status, minute,
        JSON.stringify({ why: goal.why, cognitionTurnId: turn.rows[0].id })]);
      if (!projection.rowCount && status === 'active') {
        const inserted = await client.query(`INSERT INTO world_agent_goals(
          world_id,agent_id,goal_type,category,description,priority,status,source,
          created_world_minutes,updated_world_minutes,metadata)
        VALUES($1,$2,'secondary',$3,$4,$5,'active','model',$6,$6,$7::jsonb)
        ON CONFLICT DO NOTHING RETURNING id`, [worldId, claim.agentId, goal.category,
        goal.title.slice(0, 240), goal.priority / 100, minute,
        JSON.stringify({ why: goal.why, cognitionGoalId: goal.id,
          cognitionTurnId: turn.rows[0].id })]);
        if (!inserted.rowCount) await client.query(`INSERT INTO world_agent_goals(
            world_id,agent_id,goal_type,category,description,priority,status,source,
            created_world_minutes,updated_world_minutes,metadata)
          VALUES($1,$2,'short',$3,$4,$5,'active','model',$6,$6,$7::jsonb)
          ON CONFLICT DO NOTHING`, [worldId, claim.agentId, goal.category,
          goal.title.slice(0, 240), goal.priority / 100, minute,
          JSON.stringify({ why: goal.why, cognitionGoalId: goal.id,
            cognitionTurnId: turn.rows[0].id })]);
      }
    }
    const previousSelfModel = current.rows[0].self_model || {};
    const nextSelfModel = result.intent.selfModel || previousSelfModel;
    const selfModelChanged = JSON.stringify(previousSelfModel) !== JSON.stringify(nextSelfModel);
    await client.query(`INSERT INTO world_agent_self_model_history(world_id,agent_id,world_minute,
        reason,before_state,after_state,evidence,action_id)
      SELECT $1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8
      WHERE $4<>'model_review_no_change' OR NOT EXISTS (
        SELECT 1 FROM world_agent_self_model_history
        WHERE world_id=$1 AND agent_id=$2 AND reason='model_review_no_change'
          AND created_at>now()-interval '24 hours')
      ON CONFLICT(world_id,agent_id,action_id) DO NOTHING`, [worldId, claim.agentId, minute,
      selfModelChanged ? 'model_review_change' : 'model_review_no_change',
      JSON.stringify({ cognitionSelfModel: previousSelfModel }),
      JSON.stringify({ cognitionSelfModel: nextSelfModel }),
      JSON.stringify({ source: 'model', cognitionTurnId: turn.rows[0].id,
        evidenceRefs: result.intent.changes.selfModelUpdate?.evidenceRefs || [] }),
      `model-review:${turn.rows[0].id}`]);
    let plans = result.intent.plans.map((plan) => priorPlanIds.has(plan.id) ? plan
      : { ...plan, origin: { type: 'model_cognition', source: 'model', turnId: turn.rows[0].id } });
    if (claim.trigger === 'execution_replan_required' && revisedReplanPlans.size) {
      plans = completePendingExecutionReplans(plans, { trigger: claim.trigger,
        turnId: turn.rows[0].id, worldMinute: minute,
        fingerprints: claim.executionReplanFingerprints || [], modelCallIds: relatedModelCallIds,
        planIds: [...revisedReplanPlans] });
    } else if (claim.trigger === 'execution_replan_required') {
      plans = recordExecutionReplanAttempt(plans, { fingerprints: claim.executionReplanFingerprints,
        modelCallIds: relatedModelCallIds, modelCallAttempted: true });
    }
    const activePlan = plans.find((plan) => plan.status === 'active'
      && plan.currentStep < (plan.steps?.length || 0));
    if (!activePlan && result.intent.nextAction) {
      const goal = goals.find((item) => item.id === replanForNextAction?.goalId
        && item.status === 'active') || [...goals].filter((item) => item.status === 'active')
        .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))[0];
      if (goal) {
        const action = result.intent.nextAction;
        const planId = replanForNextAction?.id || `intent-plan:${turn.rows[0].id}`;
        const replacement = { id: planId, goalId: goal.id,
          summary: result.intent.reasonSummary, status: 'active', currentStep: 0,
          origin: { type: 'model_cognition', source: 'model', turnId: turn.rows[0].id },
          steps: [{ stepId: `step:${turn.rows[0].id}`, intentId: action.intentId || `intent:${turn.rows[0].id}`,
            description: action.intent, intent: action.intent, actionType: 'world_action',
            targetId: action.targetId || null,
            targetBindingMode: action.targetBindingMode,
            targetType: action.targetType || null,
            ...(action.researchIntent ? { researchIntent: action.researchIntent } : {}),
            ...(action.projectProposal ? { projectProposal: action.projectProposal } : {}) }] };
        if (replanForNextAction) {
          plans = plans.map((plan) => plan.id !== planId ? plan : {
            ...plan, ...replacement, currentStep: plan.currentStep,
            steps: [...plan.steps.slice(0, plan.currentStep), ...replacement.steps],
            executionReplans: plan.executionReplans });
        } else plans = [...plans, replacement];
      }
    }
    const substantivePlanChanged = JSON.stringify(plans.map(cognitionPlanForPrompt))
      !== JSON.stringify((current.rows[0].plans || []).map(cognitionPlanForPrompt));
    plans = plans.map((plan) => {
      const previous = (current.rows[0].plans || []).find((item) => item.id === plan.id);
      return { ...plan, steps: (plan.steps || []).map((step, index) => {
        const old = previous?.steps?.find((item) => item.stepId === step.stepId);
        const clean = (value) => value ? cognitionPlanForPrompt({ steps: [value] }).steps[0] : null;
        const revised = previous?.status === 'replan_required' && plan.status === 'active'
          && index >= Number(previous.currentStep || 0)
          ? clearRevisedRuntime(old, step, { force: true })
          : clearRevisedRuntime(old, step);
        return JSON.stringify(clean(old)) === JSON.stringify(clean(revised))
          ? { ...step, attributionModelCallIds: old?.attributionModelCallIds || [],
            attributionTurnId: old?.attributionTurnId || previous?.origin?.turnId || null }
          : { ...revised, attributionModelCallIds: paidCallIds,
            attributionTurnId: turn.rows[0].id };
      }) };
    });
    const activeExecutionPlan = plans.some((plan) => plan.status === 'active'
      && plan.currentStep < (plan.steps?.length || 0));
    const executionPlan = plans.find((plan) => plan.status === 'active'
      && plan.currentStep < (plan.steps?.length || 0));
    const executionGoal = goals.find((goal) => goal.id === executionPlan?.goalId);
    const executionStep = executionPlan?.steps?.[executionPlan.currentStep];
    if (relatedModelCallIds.length) await client.query(`UPDATE world_agent_cognition_model_calls
      SET goal_id=COALESCE(goal_id,$3),plan_id=COALESCE(plan_id,$4),step_id=COALESCE(step_id,$5),
        cognition_turn_id=COALESCE(cognition_turn_id,$6)
      WHERE world_id=$1 AND id=ANY($2::uuid[])`,
    [worldId, relatedModelCallIds, executionGoal?.id || null, executionPlan?.id || null,
      executionStep?.stepId || null, turn.rows[0].id]);
    for (const callId of paidCallIds) {
      await client.query(`INSERT INTO bai_model_call_effects(model_call_id,effect_type,cognition_turn_id,
          goal_id,plan_id,step_id) VALUES($1,'turn_committed',$2,$3,$4,$5)`,
      [callId, turn.rows[0].id, executionGoal?.id || null, executionPlan?.id || null,
        executionStep?.stepId || null]);
      if (substantivePlanChanged) await client.query(`INSERT INTO bai_model_call_effects(
          model_call_id,effect_type,cognition_turn_id,goal_id,plan_id,step_id)
        VALUES($1,'plan_updated',$2,$3,$4,$5)`,
      [callId, turn.rows[0].id, executionGoal?.id || null, executionPlan?.id || null,
        executionStep?.stepId || null]);
      if (claim.trigger === 'execution_replan_required' && revisedReplanPlans.size) {
        await client.query(`INSERT INTO bai_model_call_effects(model_call_id,effect_type,
          cognition_turn_id,goal_id,plan_id,step_id)
          VALUES($1,'replan_completed',$2,$3,$4,$5)`,
        [callId, turn.rows[0].id, executionGoal?.id || null, executionPlan?.id || null,
          executionStep?.stepId || null]);
      }
    }
    const citedToolRefs = new Set([
      ...(result.intent.memoryUpdates || []).flatMap((memory) => memory.evidenceRefs || []),
      ...(result.intent.changes.beliefUpdates || []).flatMap((belief) =>
        [belief.evidence, belief.counterevidence]),
      ...(result.intent.changes.selfModelUpdate?.evidenceRefs || []),
      ...(result.intent.capabilityDecisions || []).flatMap((decision) => decision.evidenceRefs || [])
    ].filter((ref) => typeof ref === 'string' && ref.startsWith('tool:')));
    for (const tool of context.toolResults || []) {
      const toolCallId = tool.result?.modelCallId;
      if (typeof toolCallId !== 'string'
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(toolCallId)
          || !citedToolRefs.has(`tool:${tool.intent_key}`)) continue;
      await client.query(`INSERT INTO bai_model_call_effects(model_call_id,effect_type,
          cognition_turn_id,goal_id,plan_id,step_id,tool_attempt_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [toolCallId,
        substantivePlanChanged ? 'tool_result_used' : 'tool_result_cited',
        turn.rows[0].id, executionGoal?.id || null, executionPlan?.id || null,
        executionStep?.stepId || null, tool.id]);
    }
    const deltaBacklog = context.world?.delta?.hasMore === true;
    const pendingAction = {};
    let capabilityDecisionCount = 0;
    for (const [index, decision] of result.intent.capabilityDecisions.entries()) {
      await client.query('SAVEPOINT cognition_capability_decision');
      try {
        await applyCapabilityDecision(client, { worldId, agentId: claim.agentId,
          turnId: turn.rows[0].id, index, decision, worldMinute: minute });
        await client.query('RELEASE SAVEPOINT cognition_capability_decision');
        capabilityDecisionCount += 1;
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT cognition_capability_decision');
        await client.query('RELEASE SAVEPOINT cognition_capability_decision');
        const code = String(error?.code || error?.message || 'CAPABILITY_DECISION_REJECTED')
          .replace(/[^A-Z0-9_]/g, '_').slice(0, 80);
        await client.query(`INSERT INTO world_agent_cognition_memories(world_id,agent_id,memory_key,
            memory_type,summary,evidence,created_world_minute)
          VALUES($1,$2,$3,'failure',$4,$5::jsonb,$6)
          ON CONFLICT(world_id,agent_id,memory_key) DO NOTHING`,
        [worldId, claim.agentId, `capability-decision:${turn.rows[0].id}:${index}`,
          `My ${decision.type} capability decision was rejected by the World: ${code}.`,
          JSON.stringify({ cognitionTurnId: turn.rows[0].id, code,
            targetId: decision.gapId || decision.proposalId || decision.experimentId }), minute]);
      }
    }
    for (const request of result.intent.toolRequests) {
      await client.query(`INSERT INTO world_agent_cognition_tool_attempts(world_id,agent_id,intent_key,
          capability_key,status,request,created_world_minute,updated_world_minute)
        VALUES($1,$2,$3,$4,'requested',$5::jsonb,$6,$6)
        ON CONFLICT(world_id,agent_id,intent_key) DO NOTHING`,
      [worldId, claim.agentId, `turn:${turn.rows[0].id}:${request.id}`,
        request.capability, JSON.stringify(request), minute]);
    }
    let persistedMemoryUpdates = 0;
    await client.query(`INSERT INTO world_agent_cognition_memories(world_id,agent_id,
        memory_key,memory_type,summary,evidence,created_world_minute)
      VALUES($1,$2,$3,'episodic',$4,$5::jsonb,$6)
      ON CONFLICT(world_id,agent_id,memory_key) DO NOTHING`,
    [worldId, claim.agentId, `model-reflection:${turn.rows[0].id}`,
      result.intent.reasonSummary,
      JSON.stringify({ source: 'model', kind: 'reflection', cognitionTurnId: turn.rows[0].id }), minute]);
    for (const memory of result.intent.memoryUpdates) {
      const insertedMemory = await client.query(`INSERT INTO world_agent_cognition_memories(world_id,agent_id,memory_key,memory_type,
          summary,evidence,created_world_minute)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
        ON CONFLICT(world_id,agent_id,memory_key) DO NOTHING`,
      [worldId, claim.agentId, memory.id, memory.type, memory.summary,
        JSON.stringify({ source: 'model', refs: memory.evidenceRefs,
          cognitionTurnId: turn.rows[0].id }), minute]);
      persistedMemoryUpdates += insertedMemory.rowCount;
    }
    if (persistedMemoryUpdates || JSON.stringify(result.intent.beliefs)
        !== JSON.stringify(current.rows[0].beliefs || [])) {
      for (const callId of paidCallIds) await client.query(`INSERT INTO bai_model_call_effects(
          model_call_id,effect_type,cognition_turn_id) VALUES($1,'memory_or_belief_updated',$2)`,
      [callId, turn.rows[0].id]);
    }
    const nextMaterialFingerprint = materialCognitionFingerprint({ ...context,
      prior: { ...context.prior, goals, plans } });
    await client.query(`UPDATE world_agent_cognition_state SET revision=revision+1,self_model=$4::jsonb,
        goals=$5::jsonb,plans=$6::jsonb,beliefs=$7::jsonb,values_state=$8::jsonb,
        open_questions=$9::jsonb,pending_action=$10::jsonb,
        next_review_world_minute=$11,review_reason=$15,lease_token=NULL,lease_until=NULL,
        last_cognition_world_minute=$12,last_turn_id=$13,policy_experiments=$14::jsonb,
        last_context_event_id=GREATEST(last_context_event_id,$16),
        last_context_tool_sequence=GREATEST(last_context_tool_sequence,$17),
        last_material_fingerprint=$18,pending_material_fingerprint=NULL,
        budget_deferred_until=NULL,updated_at=now()
      WHERE world_id=$1 AND agent_id=$2 AND lease_token=$3`,
    [worldId, claim.agentId, claim.token, JSON.stringify(result.intent.selfModel),
      JSON.stringify(goals), JSON.stringify(plans),
      JSON.stringify(result.intent.beliefs), JSON.stringify(result.intent.values),
      JSON.stringify(result.intent.openQuestions), JSON.stringify(pendingAction),
      activeExecutionPlan ? minute : minute + Math.ceil(SCHEDULE_PERIOD_MS / 1_000),
      minute, turn.rows[0].id, JSON.stringify(result.intent.policyExperiments),
      activeExecutionPlan ? 'plan_grounding' : 'scheduled',
      Number(context.world?.delta?.cursor || 0), Number(context.world?.delta?.toolCursor || 0),
      nextMaterialFingerprint]);
    await client.query('COMMIT');
    return { committed: true, agentId: claim.agentId, turnId: turn.rows[0].id,
      model: result.model, tier: result.tier, worldMinute: minute };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function claimToolAttempts(pool, worldId, limit = 3) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pending = await client.query(`SELECT id,agent_id,capability_key,request
      FROM world_agent_cognition_tool_attempts
      WHERE world_id=$1 AND ((status='requested' AND (lease_until IS NULL OR lease_until<now()))
        OR (status='running' AND lease_until<now()))
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT $2`, [worldId, limit]);
    const attempts = [];
    for (const row of pending.rows) {
      const token = randomUUID();
      await client.query(`UPDATE world_agent_cognition_tool_attempts
        SET status='running',lease_token=$2,lease_until=now()+interval '90 seconds',updated_at=now()
        WHERE id=$1`, [row.id, token]);
      attempts.push({ ...row, token });
    }
    await client.query('COMMIT');
    return attempts;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function deferBudgetedTool(pool, worldId, attempt, budgetGateway, error) {
  const deferredUntil = await deferredUntilFor(budgetGateway, error);
  await pool.query(`UPDATE world_agent_cognition_tool_attempts SET status='requested',
      lease_token=NULL,lease_until=$5,updated_at=now()
    WHERE world_id=$1 AND agent_id=$2 AND id=$3 AND lease_token=$4`,
  [worldId, attempt.agent_id, attempt.id, attempt.token, deferredUntil]);
}

async function commitToolAttempt(pool, worldId, attempt, status, result) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const minute = Number((await client.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`,
      [worldId])).rows[0].world_minutes);
    const updated = await client.query(`UPDATE world_agent_cognition_tool_attempts
      SET status=$4,result=$5::jsonb,updated_world_minute=$6,
          lease_token=NULL,lease_until=NULL,updated_at=now()
      WHERE world_id=$1 AND agent_id=$2 AND id=$3 AND lease_token=$7 AND status='running'
      RETURNING id`, [worldId, attempt.agent_id, attempt.id, status, JSON.stringify(result), minute, attempt.token]);
    if (updated.rowCount) await client.query(`UPDATE world_agent_cognition_state
      SET next_review_world_minute=LEAST(next_review_world_minute,$3),
          review_reason='tool_result',updated_at=now()
      WHERE world_id=$1 AND agent_id=$2`, [worldId, attempt.agent_id, minute]);
    if (updated.rowCount && status === 'succeeded' && result?.modelCallId) {
      await client.query(`INSERT INTO bai_model_call_effects(model_call_id,effect_type,
          tool_attempt_id) VALUES($1,'tool_result_persisted',$2)`,
      [result.modelCallId, attempt.id]);
    }
    await client.query('COMMIT');
    return Boolean(updated.rowCount);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function startOpenCognitionWorker(pool, { worldId, apiKey = process.env.BAI_API_KEY,
  fetchImpl = fetch, isOwner = () => true, onError = () => {}, onTurn = () => {},
  intervalMs = 4_000, budgetGateway = null,
  model = process.env.OPEN_COGNITION_MODEL || DEFAULT_OPEN_COGNITION_MODEL } = {}) {
  if (!worldId || !apiKey) return { running: false, reason: 'world_or_provider_missing',
    stop: async () => {}, getStatus: () => ({ running: false, reason: 'world_or_provider_missing' }) };
  await ensureResidentRows(pool, worldId);
  const ordinals = await initializeScheduledSlots(pool, worldId);
  for (const agentId of ordinals.keys()) await reconcileResident(pool, worldId, agentId);
  const fixedCatalog = configuredCognitionCatalog(model);
  const catalog = fixedCatalog || selectConfiguredClaudeCatalog(
    await discoverBaiClaudeModels({ apiKey, fetchImpl }), model);
  await pool.query(`UPDATE world_agent_cognition_tool_attempts attempt SET lease_until=state.next_scheduled_at
    FROM world_agent_cognition_state state
    WHERE attempt.world_id=$1 AND attempt.world_id=state.world_id AND attempt.agent_id=state.agent_id
      AND attempt.capability_key='model_analysis' AND attempt.status='requested'
      AND (attempt.lease_until IS NULL OR attempt.lease_until<now())`, [worldId]);
  const gateway = budgetGateway || createBaiBudgetGateway(pool);
  const requestModel = createCognitionModelRouter({ apiKey, catalog, fetchImpl, worldId,
    budgetGateway: gateway,
    onCall: async (event) => {
      try { await recordModelCall(pool, worldId, event); }
      catch (error) { onError(Object.assign(new Error('COGNITION_TELEMETRY_WRITE_FAILED'),
        { code: error?.code || 'COGNITION_TELEMETRY_WRITE_FAILED' })); }
    } });
  let stopped = false;
  let inFlight = null;
  let completed = 0;
  let toolsCompleted = 0;
  let lastTurn = null;
  const gateCheckTimes = [];
  const cycle = async () => {
    if (stopped || inFlight || !isOwner()) return;
    inFlight = (async () => {
      const toolAttempts = await claimToolAttempts(pool, worldId, 1);
      if (toolAttempts.length) {
        await Promise.all(toolAttempts.map(async (attempt) => {
          let status = 'succeeded';
          let result;
          try {
            if (attempt.capability_key === 'github_public_read') {
              result = await readPublicGitHub(attempt.request, { fetchImpl });
            } else if (attempt.capability_key === 'model_analysis') {
              const { context, memoryCandidates } = await readCognitionContext(pool,
                { worldId, agentId: attempt.agent_id });
              context.memories = prefilterMemoryCandidates(memoryCandidates, context);
              context.evidenceRefs = evidenceRefsForContext(context);
              result = await runModelAnalysisSubtask({ requestModel, context,
                request: attempt.request, correlationId: attempt.id });
            } else throw Object.assign(new Error('TOOL_UNSUPPORTED'), { code: 'TOOL_UNSUPPORTED' });
          } catch (error) {
            if (attempt.capability_key === 'model_analysis'
                && (error?.code === 'MODEL_DAILY_BUDGET_EXCEEDED'
                  || error?.code === 'MODEL_HOURLY_RATE_LIMITED'
                  || String(error?.code || '').startsWith('BAI_BUDGET_'))) {
              await deferBudgetedTool(pool, worldId, attempt, gateway, error);
              return;
            }
            status = 'failed';
            result = { code: String(error?.code || 'TOOL_FAILED').replace(/[^A-Z0-9_]/g, '_').slice(0, 80) };
          }
          if (isOwner() && await commitToolAttempt(pool, worldId, attempt, status, result)) toolsCompleted += 1;
        }));
        return;
      }
      const claim = await claimDueTurn(pool, worldId, ordinals);
      if (!claim) return;
      claim.goals = claim.goals || [];
      claim.plans = claim.plans || [];
      let contextForFailure = null;
      let planForFailure = null;
      let stepForFailure = null;
      try {
        const { context, state, memoryCandidates } = await readCognitionContext(pool,
          { worldId, agentId: claim.agentId });
        contextForFailure = context;
        if (Number(state?.revision || 0) !== claim.revision) {
          await releaseClaim(pool, worldId, claim);
          return;
        }
        if (await reconcileResident(pool, worldId, claim.agentId, claim.token)) {
          await releaseClaim(pool, worldId, claim);
          return;
        }
        const material = shouldCallForMaterialChange({ context,
          previousFingerprint: claim.previousFingerprint, trigger: claim.trigger });
        gateCheckTimes.push(Date.now());
        while (gateCheckTimes[0] < Date.now() - 15 * 60_000) gateCheckTimes.shift();
        claim.materialFingerprint = material.fingerprint;
        const requestForClaim = (input) => requestModel({ ...input,
          callContext: { ...input.callContext, materialFingerprint: claim.materialFingerprint } });
        requestForClaim.recordApplicationResult = requestModel.recordApplicationResult;
        const plan = currentPlan(state);
        const cognitionTriggers = new Set(['initial','strategic_review','identity_revision',
          'goal_conflict','major_failure','major_opportunity','tool_result','research_result',
          'world_delta_backlog','execution_replan_required','scheduled','plan_completed']);
        const modelTurnRequested = (cognitionTriggers.has(claim.trigger) || !plan) && material.call;
        await recordGateDecision(pool, claim, { decision: modelTurnRequested
          ? 'provider_candidate' : plan ? 'deterministic_grounding' : 'no_material_event',
        materialFingerprint: material.fingerprint,
        materialChanged: claim.previousFingerprint !== material.fingerprint });
        if (plan && !modelTurnRequested) {
          const step = plan.steps[plan.currentStep];
          planForFailure = plan;
          stepForFailure = step;
          claim.deferredPlanId = plan.id;
          claim.deferredStepId = step.stepId;
          const goal = (state.goals || []).find((item) => item.id === plan.goalId);
          if (!goal) {
            const retryCondition = retryFingerprintFor({ reason: 'plan_goal_missing', step,
              state: context.resident, targetState: context.targetState,
              affordances: context.availableAffordances?.candidates || [],
              capabilities: context.capabilities || [], syncBalances: context.syncBalances || [],
              worldMinute: context.world.minute });
            const blocked = { reason: 'plan_goal_missing', retryCondition, replanRequired: true,
              affordanceFingerprint: worldAffordanceFingerprint(context),
              requiredChange: 'The active plan must reference an active goal.' };
            const result = await finishGroundingClaim(pool, worldId, claim, context, { blocked, plan, step });
            if (result.committed) { completed += 1; lastTurn = { ...result, agentId: claim.agentId }; }
            return;
          }
          const fingerprint = worldAffordanceFingerprint(context);
          const pending = state.pending_action && typeof state.pending_action === 'object'
            ? state.pending_action : {};
          const pendingMatchesStep = pending.planId === plan.id && pending.stepId === step.stepId
            && pending.intentId === step.intentId && typeof pending.candidateId === 'string';
          const pendingCandidateAvailable = pendingMatchesStep
            && (context.availableAffordances?.candidates || []).some((candidate) =>
              candidate.id === pending.candidateId && candidate.action === pending.executableAction);
          if (pendingCandidateAvailable && plan.status === 'active') {
            await deferUnchangedGrounding(pool, worldId, claim, Number(context.world.minute));
            return;
          }
          const blockedState = step.groundingBlocked || (pendingMatchesStep ? {
            reason: 'grounded_candidate_stale', affordanceFingerprint: pending.affordanceFingerprint
          } : null);
          const retryFingerprint = blockedState?.reason
            ? retryFingerprintFor({ reason: blockedState.reason, step, state: context.resident,
              targetState: context.targetState, affordances: context.availableAffordances?.candidates || [],
              capabilities: context.capabilities || [], syncBalances: context.syncBalances || [],
              worldMinute: context.world?.minute }).fingerprint
            : fingerprint;
          const boundedRetry = ['grounding_invalid','target_affordance_missing',
            'no_matching_affordance','grounded_candidate_stale'].includes(blockedState?.reason)
            && Number(step.groundingDiagnostics?.groundingChecks || 0) < 3;
          if (!shouldRetryBlockedGrounding(blockedState, retryFingerprint) && !boundedRetry) {
            await deferUnchangedGrounding(pool, worldId, claim, Number(context.world.minute), {
              planId: plan.id, stepId: step.stepId,
              fingerprint: blockedState.retryCondition?.fingerprint || blockedState.retryFingerprint
                || blockedState.affordanceFingerprint || null
            });
            return;
          }
          const ground = await groundPlanStep({ requestModel: requestForClaim, context, goal, plan, step,
            affordances: context.availableAffordances?.candidates || [],
            capabilities: context.capabilities || [], correlationId: claim.correlationId });
          const result = ground.status === 'grounded'
            ? await finishGroundingClaim(pool, worldId, claim, context, { grounding: ground, plan, step })
            : await finishGroundingClaim(pool, worldId, claim, context, { grounding: ground, plan, step,
              blocked: { reason: ground.reason, targetId: ground.targetId,
                targetType: ground.targetType, targetStateVersion: ground.targetStateVersion,
                affordanceSignature: ground.affordanceSignature,
                retryCondition: ground.retryCondition, terminal: ground.terminal,
                replanRequired: (ground.terminal === true
                  && !hasCompletedExecutionReplan(plan, ground.retryCondition?.fingerprint))
                  || shouldEscalateBlocked(step, ground.reason, context.world.minute,
                    ground.retryCondition?.fingerprint),
                affordanceFingerprint: ground.affordanceFingerprint,
                requiredChange: ground.requiredChange } });
          if (result.committed) { completed += 1; lastTurn = { ...result, agentId: claim.agentId,
            planId: plan.id, stepId: step.stepId, modelCallId: ground.modelCallId || null }; onTurn(lastTurn); }
          return;
        }
        if (!modelTurnRequested) {
          await skipUnchangedTurn(pool, worldId, claim, context, material.fingerprint);
          return;
        }
        const selection = await selectRelevantMemories({ requestModel: requestForClaim, catalog, context,
          candidates: memoryCandidates, correlationId: claim.correlationId,
          persistentCache: state?.memory_selection_cache,
          persistSelection: (key, ids, modelCallId) => persistMemorySelection(
            pool, worldId, claim, key, ids, modelCallId) });
        if (selection.modelDeferredReason) {
          await postponeTurn(pool, worldId, claim, {
            code: selection.modelDeferredReason,
            nextAdmissionPossibleAt: selection.modelDeferredUntil
          }, gateway);
          return;
        }
        if (selection.cacheHit) selection.telemetryId = await recordMemoryCacheHit(pool, worldId, claim, selection);
        await recordMemorySelectionResult(pool, worldId, selection);
        context.memorySelection = { cacheHit: selection.cacheHit,
          candidateCount: selection.candidateCount, prefilteredCount: selection.prefilteredCount,
          selectedCount: selection.selectedCount };
        context.memories = selection.memories;
        context.evidenceRefs = evidenceRefsForContext(context);
        const priorState = state ? { selfModel: state.self_model, goals: state.goals,
          plans: state.plans, beliefs: state.beliefs, values: state.values_state,
          policyExperiments: state.policy_experiments,
          openQuestions: state.open_questions } : null;
        const result = await runOpenCognition({ requestModel: requestForClaim, catalog, context, priorState,
          trigger: claim.trigger, correlationId: claim.correlationId });
        if (!isOwner()) {
          for (const call of result.usage) await requestModel.recordApplicationResult?.(
            call.callId, 'superseded', 'OWNER_LOST');
          await releaseClaim(pool, worldId, claim);
          return;
        }
        const committed = await commitTurn(pool, worldId, claim, context, result, selection);
        if (committed.committed) { completed += 1; lastTurn = committed; onTurn(committed);
          await recordGateDecision(pool, claim, { decision: 'turn_committed',
            budgetAdmissible: true, rateAdmissible: true }); }
        else for (const call of result.usage) await requestModel.recordApplicationResult?.(
          call.callId, 'superseded', String(committed.reason || 'TURN_NOT_COMMITTED'));
      } catch (error) {
        if (contextForFailure && planForFailure && stepForFailure
            && ['GROUNDING_RESULT_INVALID','GROUNDING_ARGUMENT_NOT_AUTHORIZED'].includes(error?.code)) {
          const retryCondition = retryFingerprintFor({ reason: 'grounding_invalid',
            step: stepForFailure, state: contextForFailure.resident,
            targetState: contextForFailure.targetState,
            affordances: contextForFailure.availableAffordances?.candidates || [],
            capabilities: contextForFailure.capabilities || [],
            syncBalances: contextForFailure.syncBalances || [],
            worldMinute: contextForFailure.world?.minute });
          await finishGroundingClaim(pool, worldId, claim, contextForFailure, {
            plan: planForFailure, step: stepForFailure, rejectedModelCallId: error.modelCallId,
            blocked: { reason: 'grounding_invalid', retryCondition,
              replanRequired: shouldEscalateBlocked(stepForFailure, 'grounding_invalid',
                contextForFailure.world.minute, retryCondition.fingerprint),
              affordanceFingerprint: worldAffordanceFingerprint(contextForFailure),
              requiredChange: 'World state or the available executable affordances must change before another proposal.' }
          }).catch(onError);
        } else await postponeTurn(pool, worldId, claim, error, gateway).catch(onError);
        onError(error);
      }
    })();
    try { await inFlight; }
    finally { inFlight = null; }
  };
  const timer = setInterval(() => { cycle().catch(onError); }, intervalMs);
  timer.unref?.();
  cycle().catch(onError);
  return { running: true, worldId, catalog: { haiku: catalog.haiku,
    sonnet: catalog.sonnet, opus: catalog.opus, discoveredAt: catalog.discoveredAt },
  getStatus: () => ({ running: !stopped, worldId, inFlight: Boolean(inFlight), completed, toolsCompleted, lastTurn,
    deterministicGateChecksLast15m: gateCheckTimes.filter((time) => time > Date.now() - 15 * 60_000).length,
    models: { haiku: catalog.haiku, sonnet: catalog.sonnet, opus: catalog.opus } }),
  stop: async () => { stopped = true; clearInterval(timer); if (inFlight) await inFlight; } };
}
