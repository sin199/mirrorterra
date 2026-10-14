import { createHash, randomUUID } from 'node:crypto';
import { discoverBaiClaudeModels } from './provider.js';
import { evidenceRefsForContext, readCognitionContext } from './context.js';
import { runModelAnalysisSubtask, runOpenCognition, selectRelevantMemories } from './prompt.js';
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
        state.next_review_world_minute,runtime.world_minutes
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
    return { agentId: row.agent_id, revision: Number(row.revision),
      trigger: row.review_reason === 'initial' ? 'initial' : row.review_reason,
      triggerKey: `${row.revision}:${row.next_review_world_minute}:${row.review_reason}`,
      observedWorldMinute: Number(row.world_minutes), token };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function postponeTurn(pool, worldId, claim) {
  await pool.query(`UPDATE world_agent_cognition_state
    SET lease_token=NULL,lease_until=NULL,
      next_review_world_minute=GREATEST(next_review_world_minute,
        (SELECT world_minutes+$4 FROM world_runtime_state WHERE world_id=$1)),
      review_reason='provider_retry',updated_at=now()
    WHERE world_id=$1 AND agent_id=$2 AND lease_token=$3 AND revision=$5`,
  [worldId, claim.agentId, claim.token, RETRY_MINUTES, claim.revision]);
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
    const goals = result.intent.goals.map((goal) => priorGoalIds.has(goal.id) ? goal
      : { ...goal, origin: { type: 'model_cognition', turnId: turn.rows[0].id } });
    const plans = result.intent.plans.map((plan) => priorPlanIds.has(plan.id) ? plan
      : { ...plan, origin: { type: 'model_cognition', turnId: turn.rows[0].id } });
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
        last_cognition_world_minute=$12,last_turn_id=$13,policy_experiments=$14::jsonb,updated_at=now()
      WHERE world_id=$1 AND agent_id=$2 AND lease_token=$3`,
    [worldId, claim.agentId, claim.token, JSON.stringify(result.intent.selfModel),
      JSON.stringify(goals), JSON.stringify(plans),
      JSON.stringify(result.intent.beliefs), JSON.stringify(result.intent.values),
      JSON.stringify(result.intent.openQuestions), JSON.stringify(result.intent.nextAction || {}),
      capabilityDecisionCount || result.intent.capabilityDecisions.length
        ? Math.min(minute + 60, minute + result.intent.reviewAfterWorldMinutes)
        : minute + result.intent.reviewAfterWorldMinutes,
      minute, turn.rows[0].id, JSON.stringify(result.intent.policyExperiments),
      result.intent.capabilityDecisions.length ? 'capability_result' : 'scheduled']);
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
              context.memories = memoryCandidates.slice(0, 8);
              context.evidenceRefs = evidenceRefsForContext(context);
              result = await runModelAnalysisSubtask({ apiKey, catalog, context,
                request: attempt.request, fetchImpl });
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
      try {
        const { context, state, memoryCandidates } = await readCognitionContext(pool,
          { worldId, agentId: claim.agentId });
        if (Number(state?.revision || 0) !== claim.revision) {
          await releaseClaim(pool, worldId, claim);
          return;
        }
        const selection = await selectRelevantMemories({ apiKey, catalog, context,
          candidates: memoryCandidates, fetchImpl });
        context.memories = selection.memories;
        context.evidenceRefs = evidenceRefsForContext(context);
        const priorState = state ? { selfModel: state.self_model, goals: state.goals,
          plans: state.plans, beliefs: state.beliefs, values: state.values_state,
          policyExperiments: state.policy_experiments,
          openQuestions: state.open_questions } : null;
        const result = await runOpenCognition({ apiKey, catalog, context, priorState,
          trigger: claim.trigger, fetchImpl });
        if (!isOwner()) { await releaseClaim(pool, worldId, claim); return; }
        const committed = await commitTurn(pool, worldId, claim, context, result, selection);
        if (committed.committed) { completed += 1; lastTurn = committed; onTurn(committed); }
      } catch (error) {
        await postponeTurn(pool, worldId, claim).catch(onError);
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
