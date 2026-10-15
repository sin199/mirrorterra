import { createHash, randomUUID } from 'node:crypto';
import { createCognitionModelRouter, discoverBaiClaudeModels } from './provider.js';
import { evidenceRefsForContext, readCognitionContext } from './context.js';
import { runModelAnalysisSubtask, runOpenCognition, selectRelevantMemories } from './prompt.js';
import { affordanceFingerprint, completePendingExecutionReplans, groundPlanStep,
  hasCompletedExecutionReplan, markExecutionReplanPending, retryFingerprintFor,
  shouldRetryBlockedGrounding } from './grounding.js';
import { nextGroundingDiagnostics, nextRetryGateDiagnostics,
  recordExecutionReplanAttempt } from './diagnostics.js';
import { prefilterMemoryCandidates } from './memory-retrieval.js';
import { readPublicGitHub } from './github-public-read.js';
import { createWorldCapabilityProposal, reviewWorldCapabilityProposal,
  reviewWorldCapabilityExperiment } from '../../world-capabilities.js';

const LEASE_SECONDS = 180;
const RETRY_MINUTES = 60;

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

async function claimDueTurn(pool, worldId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const due = await client.query(`SELECT state.agent_id,state.revision,state.review_reason,
        state.next_review_world_minute,state.goals,state.plans,state.pending_action,
        state.available_affordances,state.affordances_world_minute,runtime.world_minutes
      FROM world_agent_cognition_state state JOIN world_runtime_state runtime ON runtime.world_id=state.world_id
      WHERE state.world_id=$1 AND state.next_review_world_minute<=runtime.world_minutes
        AND (state.lease_until IS NULL OR state.lease_until<now())
      ORDER BY state.next_review_world_minute,state.agent_id
      FOR UPDATE OF state SKIP LOCKED LIMIT 1`, [worldId]);
    if (!due.rowCount) { await client.query('COMMIT'); return null; }
    const row = due.rows[0];
    const token = randomUUID();
    await client.query(`UPDATE world_agent_cognition_state
      SET lease_token=$3,lease_until=now()+($4::int * interval '1 second'),updated_at=now()
      WHERE world_id=$1 AND agent_id=$2`, [worldId, row.agent_id, token, LEASE_SECONDS]);
    await client.query('COMMIT');
    const executionReplanFingerprints = [...new Set((row.plans || []).flatMap((plan) =>
      (plan.executionReplans || []).filter((entry) => entry.status === 'pending')
        .map((entry) => entry.fingerprint).filter((value) => typeof value === 'string')))];
    const pendingExecutionReplan = executionReplanFingerprints.length > 0;
    const strategicTrigger = pendingExecutionReplan ? 'execution_replan_required'
      : ({ initial: 'initial', strategic_review: 'strategic_review',
      identity_revision: 'identity_revision', goal_conflict: 'goal_conflict',
      major_failure: 'major_failure', new_work_order: 'major_opportunity' })[row.review_reason] || row.review_reason;
    return { agentId: row.agent_id, revision: Number(row.revision), goals: row.goals,
      plans: row.plans, pendingAction: row.pending_action,
      availableAffordances: row.available_affordances,
      affordancesWorldMinute: row.affordances_world_minute,
      executionReplanFingerprints,
      trigger: strategicTrigger,
      triggerKey: `${row.revision}:${row.next_review_world_minute}:${row.review_reason}`,
      observedWorldMinute: Number(row.world_minutes), token, correlationId: randomUUID() };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function postponeTurn(pool, worldId, claim, error = null) {
  const failureCode = String(error?.code || error?.message || '');
  const reason = failureCode === 'provider_insufficient_balance'
    ? 'provider_insufficient_balance' : 'provider_retry';
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
    if (claim.trigger === 'execution_replan_required' && claim.executionReplanFingerprints?.length) {
      const calls = await client.query(`SELECT id,status,failure_code FROM world_agent_cognition_model_calls
        WHERE world_id=$1 AND agent_id=$2 AND correlation_id=$3
        ORDER BY created_at,id LIMIT 32`, [worldId, claim.agentId, claim.correlationId]);
      const modelCallIds = calls.rows.map((row) => row.id).filter((id) => typeof id === 'string');
      const failureCategory = calls.rows.filter((row) => row.status === 'failed').at(-1)?.failure_code || null;
      plans = recordExecutionReplanAttempt(plans, { fingerprints: claim.executionReplanFingerprints,
        modelCallIds, modelCallAttempted: calls.rows.some((row) => row.status !== 'cached'),
        providerFailureCategory: failureCategory });
    }
    const isReplanRetry = claim.trigger === 'execution_replan_required'
      && Boolean(claim.executionReplanFingerprints?.length);
    await client.query(`UPDATE world_agent_cognition_state
      SET revision=revision+CASE WHEN $8::boolean THEN 1 ELSE 0 END,
        plans=$4::jsonb,lease_token=NULL,lease_until=NULL,
        next_review_world_minute=GREATEST(next_review_world_minute,
          (SELECT world_minutes+$5 FROM world_runtime_state WHERE world_id=$1)),
        review_reason=$6,updated_at=now()
      WHERE world_id=$1 AND agent_id=$2 AND lease_token=$3 AND revision=$7`,
    [worldId, claim.agentId, claim.token, JSON.stringify(plans), RETRY_MINUTES, reason,
      claim.revision, isReplanRetry]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function recordModelCall(pool, worldId, event) {
  if (!event?.id || !event?.agentId) return;
  if (event.phase === 'started') {
    await pool.query(`INSERT INTO world_agent_cognition_model_calls(id,world_id,agent_id,correlation_id,
        tier,model,trigger,goal_id,plan_id,step_id,status,cache_hit,memory_candidates,
        memory_prefiltered,memory_selected,grounding_result,execution_result)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'started',$11,$12,$13,$14,$15,$16)
      ON CONFLICT(id) DO NOTHING`, [event.id, worldId, event.agentId, event.correlationId,
      event.tier, event.model, event.trigger, event.goalId, event.planId, event.stepId,
      event.cacheHit === true, event.memoryCandidates, event.memoryPrefiltered,
      event.memorySelected, event.groundingResult, event.executionResult]);
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
      memory_prefiltered,memory_selected,grounding_result,created_at,completed_at)
    VALUES($1,$2,$3,'haiku',$4,'memory_selection',$5,$6,$7,'cached',true,$8,$9,$10,'cache_hit',now(),now())
    RETURNING id`,
  [worldId, agentId, claim.correlationId, 'cache', activeGoal?.id || null,
    activePlan?.id || null, activePlan?.steps?.[activePlan.currentStep]?.stepId || null,
    selection.candidateCount,
    selection.prefilteredCount, selection.selectedCount]);
  return inserted.rows[0]?.id || null;
}

async function recordMemorySelectionResult(pool, worldId, selection) {
  if (!selection.modelCallId) return;
  await pool.query(`UPDATE world_agent_cognition_model_calls SET memory_selected=$3
    WHERE world_id=$1 AND id=$2 AND status='succeeded'`,
  [worldId, selection.modelCallId, selection.selectedCount]);
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
          groundingTelemetry: { grounding_attempted: Boolean(grounding || rejectedModelCallId),
            grounding_succeeded: grounding?.status === 'grounded',
            grounding_status: grounding?.status === 'grounded' ? 'grounded'
              : rejectedModelCallId ? 'rejected' : blocked ? 'blocked' : 'not_attempted',
            blocked_reason: blocked?.reason || null,
            model_call_id: grounding?.modelCallId || rejectedModelCallId || null },
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
      let updated = { ...item, steps, status: blocked ? 'blocked' : 'active' };
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
    if (grounding?.status === 'grounded') pendingAction = { ...grounding };
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

async function commitTurn(pool, worldId, claim, context, result, selection) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`SELECT revision,lease_token,goals,plans FROM world_agent_cognition_state
      WHERE world_id=$1 AND agent_id=$2 FOR UPDATE`, [worldId, claim.agentId]);
    if (!current.rowCount || Number(current.rows[0].revision) !== claim.revision
        || current.rows[0].lease_token !== claim.token) {
      await client.query('ROLLBACK');
      return { committed: false, reason: 'stale_turn' };
    }
    const minute = Number((await client.query(`SELECT world_minutes FROM world_runtime_state WHERE world_id=$1`,
      [worldId])).rows[0].world_minutes);
    const contextHash = createHash('sha256').update(JSON.stringify(context)).digest('hex');
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
        memorySelectionUsage: selection.usage || null, escalated: result.escalated })]);
    if (!turn.rowCount) { await client.query('ROLLBACK'); return { committed: false, reason: 'duplicate_turn' }; }
    const priorGoalIds = new Set((current.rows[0].goals || []).map((goal) => goal.id));
    const priorPlanIds = new Set((current.rows[0].plans || []).map((plan) => plan.id));
    const relatedModelCallIds = [...new Set([selection.modelCallId, selection.telemetryId,
      ...result.usage.map((call) => call.callId)].filter((id) => typeof id === 'string'))];
    const goals = result.intent.goals.map((goal) => priorGoalIds.has(goal.id) ? goal
      : { ...goal, origin: { type: 'model_cognition', turnId: turn.rows[0].id } });
    let plans = result.intent.plans.map((plan) => priorPlanIds.has(plan.id) ? plan
      : { ...plan, origin: { type: 'model_cognition', turnId: turn.rows[0].id } });
    if (claim.trigger === 'execution_replan_required') {
      plans = completePendingExecutionReplans(plans, { trigger: claim.trigger,
        turnId: turn.rows[0].id, worldMinute: minute,
        fingerprints: claim.executionReplanFingerprints || [], modelCallIds: relatedModelCallIds });
    }
    const activePlan = plans.find((plan) => plan.status === 'active'
      && plan.currentStep < (plan.steps?.length || 0));
    if (!activePlan && result.intent.nextAction) {
      const goal = [...goals].filter((item) => item.status === 'active')
        .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0))[0];
      if (goal) {
        const action = result.intent.nextAction;
        const planId = `intent-plan:${turn.rows[0].id}`;
        plans = [...plans, { id: planId, goalId: goal.id,
          summary: result.intent.reasonSummary, status: 'active', currentStep: 0,
          origin: { type: 'model_cognition', turnId: turn.rows[0].id },
          steps: [{ stepId: `step:${turn.rows[0].id}`, intentId: action.intentId || `intent:${turn.rows[0].id}`,
            description: action.intent, intent: action.intent, actionType: 'world_action',
            targetId: action.targetId || null,
            targetBindingMode: action.targetBindingMode,
            targetType: action.targetType || null,
            ...(action.researchIntent ? { researchIntent: action.researchIntent } : {}),
            ...(action.projectProposal ? { projectProposal: action.projectProposal } : {}) }] }];
      }
    }
    const activeExecutionPlan = plans.some((plan) => plan.status === 'active'
      && plan.currentStep < (plan.steps?.length || 0));
    const executionPlan = plans.find((plan) => plan.status === 'active'
      && plan.currentStep < (plan.steps?.length || 0));
    const executionGoal = goals.find((goal) => goal.id === executionPlan?.goalId);
    const executionStep = executionPlan?.steps?.[executionPlan.currentStep];
    if (relatedModelCallIds.length) await client.query(`UPDATE world_agent_cognition_model_calls
      SET goal_id=COALESCE(goal_id,$3),plan_id=COALESCE(plan_id,$4),step_id=COALESCE(step_id,$5)
      WHERE world_id=$1 AND id=ANY($2::uuid[])`,
    [worldId, relatedModelCallIds, executionGoal?.id || null, executionPlan?.id || null,
      executionStep?.stepId || null]);
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
    for (const memory of result.intent.memoryUpdates) {
      await client.query(`INSERT INTO world_agent_cognition_memories(world_id,agent_id,memory_key,memory_type,
          summary,evidence,created_world_minute)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
        ON CONFLICT(world_id,agent_id,memory_key) DO NOTHING`,
      [worldId, claim.agentId, memory.id, memory.type, memory.summary,
        JSON.stringify({ refs: memory.evidenceRefs, cognitionTurnId: turn.rows[0].id }), minute]);
    }
    await client.query(`UPDATE world_agent_cognition_state SET revision=revision+1,self_model=$4::jsonb,
        goals=$5::jsonb,plans=$6::jsonb,beliefs=$7::jsonb,values_state=$8::jsonb,
        open_questions=$9::jsonb,pending_action=$10::jsonb,
        next_review_world_minute=$11,review_reason=$15,lease_token=NULL,lease_until=NULL,
        last_cognition_world_minute=$12,last_turn_id=$13,policy_experiments=$14::jsonb,
        last_context_event_id=GREATEST(last_context_event_id,$16),
        last_context_tool_sequence=GREATEST(last_context_tool_sequence,$17),updated_at=now()
      WHERE world_id=$1 AND agent_id=$2 AND lease_token=$3`,
    [worldId, claim.agentId, claim.token, JSON.stringify(result.intent.selfModel),
      JSON.stringify(goals), JSON.stringify(plans),
      JSON.stringify(result.intent.beliefs), JSON.stringify(result.intent.values),
      JSON.stringify(result.intent.openQuestions), JSON.stringify(pendingAction),
      deltaBacklog || activeExecutionPlan ? minute : capabilityDecisionCount || result.intent.capabilityDecisions.length
        ? Math.min(minute + 60, minute + result.intent.reviewAfterWorldMinutes)
        : minute + result.intent.reviewAfterWorldMinutes,
      minute, turn.rows[0].id, JSON.stringify(result.intent.policyExperiments),
      deltaBacklog ? 'world_delta_backlog' : activeExecutionPlan ? 'plan_grounding'
        : result.intent.capabilityDecisions.length ? 'capability_result' : 'scheduled',
      Number(context.world?.delta?.cursor || 0), Number(context.world?.delta?.toolCursor || 0)]);
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
      WHERE world_id=$1 AND (status='requested' OR (status='running' AND lease_until<now()))
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
    await client.query('COMMIT');
    return Boolean(updated.rowCount);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function startOpenCognitionWorker(pool, { worldId, apiKey = process.env.BAI_API_KEY,
  fetchImpl = fetch, isOwner = () => true, onError = () => {}, onTurn = () => {}, intervalMs = 4_000 } = {}) {
  if (!worldId || !apiKey) return { running: false, reason: 'world_or_provider_missing',
    stop: async () => {}, getStatus: () => ({ running: false, reason: 'world_or_provider_missing' }) };
  const catalog = await discoverBaiClaudeModels({ apiKey, fetchImpl });
  await ensureResidentRows(pool, worldId);
  const requestModel = createCognitionModelRouter({ apiKey, catalog, fetchImpl,
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
  const cycle = async () => {
    if (stopped || inFlight || !isOwner()) return;
    inFlight = (async () => {
      const toolAttempts = await claimToolAttempts(pool, worldId);
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
            status = 'failed';
            result = { code: String(error?.code || 'TOOL_FAILED').replace(/[^A-Z0-9_]/g, '_').slice(0, 80) };
          }
          if (isOwner() && await commitToolAttempt(pool, worldId, attempt, status, result)) toolsCompleted += 1;
        }));
        return;
      }
      const claim = await claimDueTurn(pool, worldId);
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
        const plan = currentPlan(state);
        const cognitionTriggers = new Set(['initial','strategic_review','identity_revision',
          'goal_conflict','major_failure','major_opportunity','tool_result','research_result',
          'world_delta_backlog','execution_replan_required']);
        if (plan && !cognitionTriggers.has(claim.trigger)) {
          const step = plan.steps[plan.currentStep];
          planForFailure = plan;
          stepForFailure = step;
          const goal = (state.goals || []).find((item) => item.id === plan.goalId);
          if (!goal) {
            const blocked = { reason: 'plan_goal_missing', affordanceFingerprint: worldAffordanceFingerprint(context),
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
          if (!shouldRetryBlockedGrounding(blockedState, retryFingerprint)) {
            await deferUnchangedGrounding(pool, worldId, claim, Number(context.world.minute), {
              planId: plan.id, stepId: step.stepId,
              fingerprint: blockedState.retryCondition?.fingerprint || blockedState.retryFingerprint
                || blockedState.affordanceFingerprint || null
            });
            return;
          }
          const ground = await groundPlanStep({ requestModel, context, goal, plan, step,
            affordances: context.availableAffordances?.candidates || [],
            capabilities: context.capabilities || [], correlationId: claim.correlationId });
          const result = ground.status === 'grounded'
            ? await finishGroundingClaim(pool, worldId, claim, context, { grounding: ground, plan, step })
            : await finishGroundingClaim(pool, worldId, claim, context, { grounding: ground, plan, step,
              blocked: { reason: ground.reason, targetId: ground.targetId,
                targetType: ground.targetType, targetStateVersion: ground.targetStateVersion,
                affordanceSignature: ground.affordanceSignature,
                retryCondition: ground.retryCondition, terminal: ground.terminal,
                replanRequired: ground.terminal === true
                  && !hasCompletedExecutionReplan(plan, ground.retryCondition?.fingerprint),
                affordanceFingerprint: ground.affordanceFingerprint,
                requiredChange: ground.requiredChange } });
          if (result.committed) { completed += 1; lastTurn = { ...result, agentId: claim.agentId,
            planId: plan.id, stepId: step.stepId, modelCallId: ground.modelCallId || null }; onTurn(lastTurn); }
          return;
        }
        const selection = await selectRelevantMemories({ requestModel, catalog, context,
          candidates: memoryCandidates, correlationId: claim.correlationId });
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
        const result = await runOpenCognition({ requestModel, catalog, context, priorState,
          trigger: claim.trigger, correlationId: claim.correlationId });
        if (!isOwner()) { await releaseClaim(pool, worldId, claim); return; }
        const committed = await commitTurn(pool, worldId, claim, context, result, selection);
        if (committed.committed) { completed += 1; lastTurn = committed; onTurn(committed); }
      } catch (error) {
        if (contextForFailure && planForFailure && stepForFailure
            && ['GROUNDING_RESULT_INVALID','GROUNDING_ARGUMENT_NOT_AUTHORIZED'].includes(error?.code)) {
          await finishGroundingClaim(pool, worldId, claim, contextForFailure, {
            plan: planForFailure, step: stepForFailure, rejectedModelCallId: error.modelCallId,
            blocked: { reason: 'grounding_invalid', affordanceFingerprint: worldAffordanceFingerprint(contextForFailure),
              requiredChange: 'World state or the available executable affordances must change before another proposal.' }
          }).catch(onError);
        } else await postponeTurn(pool, worldId, claim, error).catch(onError);
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
    models: { haiku: catalog.haiku, sonnet: catalog.sonnet, opus: catalog.opus } }),
  stop: async () => { stopped = true; clearInterval(timer); if (inFlight) await inFlight; } };
}
