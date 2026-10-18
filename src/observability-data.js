import { aggregateIntelligence, normalizeObservable,
  observableHistoryCategory, parseObservabilityPage, projectEventPage,
  validObservabilityUuid } from './observability.js';
import { formatGenesisTokenRaw, readActiveGenesisTokenAssets,
  readGenesisCurrencyActivation } from './genesis-economy.js';

const HISTORY_TYPES = ['agent_goal_created','goal_created','goal_completed','goal_abandoned',
  'project_proposed','project_started',
  'project_completed','project_failed','project_invested','project_revenue','opportunity_created',
  'organization_founded','organization_joined','organization_left','cooperation_completed',
  'agreement_accepted','agreement_completed','agreement_breached','agreement_rejected','norm_formed',
  'ownership_transferred','business_founded','business_closed','business_reopened',
  'business_first_customer','business_employment','business_invested','business_token_wage_accepted',
  'place_created','world_epoch_started','milestone','sync_work_order_completed'];
const MEANINGFUL_ACTIONS = ['project_contribute','business_work','business_service','cooperate',
  'capability_use','goal_review','information_share','business_found','project_propose'];

const emptyPage = { items: [], nextCursor: null };
const noWorld = { world: null, worldId: null };
const realDate = (value) => value ? new Date(value).toISOString() : null;
const text = (value, max = 240) => typeof value === 'string' ? value.slice(0, max) : null;

export async function currentObservableWorld(pool) {
  const result = await pool.query(`SELECT world.id,world.name,world.created_at,runtime.world_minutes,
      runtime.last_tick_at,runtime.tick_count
    FROM worlds world LEFT JOIN world_runtime_state runtime ON runtime.world_id=world.id
    WHERE world.open=true ORDER BY world.created_at DESC LIMIT 1`);
  return result.rows[0] || noWorld;
}

// Each source is bounded before merging. The cursor compares the same global (created_at, source:id) key.
export async function readObservableEvents(pool, { worldId, agentId = null, limit = 20,
  cursor = null, since = null, category = 'all', minImportance = 'low' }) {
  const cap = Math.max(100, limit * 5);
  const at = cursor?.at || null;
  const key = cursor?.id || null;
  const common = [worldId, agentId, since, at, key, cap];
  const [history, events, uses, attempts, jobs, artifacts] = await Promise.all([
    pool.query(`SELECT 'h' AS source,h.id::text AS id,h.created_at,h.actor_agent_id AS agent_id,
        a.name AS agent_name,h.world_time AS world_minute,h.event_type,h.title,h.detail,
        h.entity_type,h.entity_id,NULL::jsonb AS data,NULL::text AS status,
        NULL::boolean AS success,NULL::text AS capability_name,NULL::text AS decision_source,
        NULL::text AS capability_key,NULL::text AS research_question,NULL::text AS display_name
      FROM world_history h LEFT JOIN agents a ON a.id=h.actor_agent_id
      WHERE h.world_id=$1 AND ($2::uuid IS NULL OR h.actor_agent_id=$2)
        AND ($3::timestamptz IS NULL OR h.created_at >= $3)
        AND ($4::timestamptz IS NULL OR h.created_at < $4
          OR (h.created_at=$4 AND ('h:'||h.id::text)<$5))
        AND (h.event_type=ANY($7::text[]) OR h.event_type ~ '^(genesis_|arc_|sync_|world_epoch_)')
      ORDER BY h.created_at DESC,h.id DESC LIMIT $6`, [...common, HISTORY_TYPES]),
    pool.query(`SELECT 'e' AS source,e.id::text AS id,e.created_at,e.actor_id AS agent_id,
        a.name AS agent_name,(e.data->>'worldMinutes')::bigint AS world_minute,e.event_type,
        NULL::text AS title,NULL::text AS detail,NULL::text AS entity_type,NULL::uuid AS entity_id,
        e.data,NULL::text AS status,NULL::boolean AS success,NULL::text AS capability_name,
        NULL::text AS decision_source,NULL::text AS capability_key,NULL::text AS research_question,
        NULL::text AS display_name
      FROM world_events e JOIN agents a ON a.id=e.actor_id
      WHERE e.world_id=$1 AND ($2::uuid IS NULL OR e.actor_id=$2)
        AND ($3::timestamptz IS NULL OR e.created_at >= $3)
        AND ($4::timestamptz IS NULL OR e.created_at < $4
          OR (e.created_at=$4 AND ('e:'||e.id::text)<$5))
        AND (e.event_type <> 'world.action_completed' OR e.data->>'action'=ANY($7::text[]))
        AND e.event_type IN ('world.action_completed','world.goal_milestone',
          'world.goal_replanned','world.goal_updated')
      ORDER BY e.created_at DESC,e.id DESC LIMIT $6`, [...common, MEANINGFUL_ACTIONS]),
    pool.query(`SELECT 'u' AS source,u.id::text AS id,u.created_at,u.actor_agent_id AS agent_id,
        a.name AS agent_name,u.world_minute,u.status,u.success,u.decision_source,
        c.name AS capability_name,NULL::text AS event_type,NULL::text AS title,NULL::text AS detail,
        NULL::text AS entity_type,NULL::uuid AS entity_id,NULL::jsonb AS data,
        NULL::text AS capability_key,NULL::text AS research_question,NULL::text AS display_name
      FROM world_capability_uses u JOIN agents a ON a.id=u.actor_agent_id
      JOIN world_capabilities c ON c.id=u.capability_id AND c.world_id=u.world_id
      WHERE u.world_id=$1 AND ($2::uuid IS NULL OR u.actor_agent_id=$2)
        AND ($3::timestamptz IS NULL OR u.created_at >= $3)
        AND ($4::timestamptz IS NULL OR u.created_at < $4
          OR (u.created_at=$4 AND ('u:'||u.id::text)<$5))
        AND u.status IN ('completed','failed')
      ORDER BY u.created_at DESC,u.id DESC LIMIT $6`, common),
    pool.query(`SELECT 't' AS source,t.id::text AS id,t.updated_at AS created_at,t.agent_id,
        a.name AS agent_name,t.updated_world_minute AS world_minute,t.status,t.capability_key,
        NULL::text AS event_type,NULL::text AS title,NULL::text AS detail,NULL::text AS entity_type,
        NULL::uuid AS entity_id,NULL::jsonb AS data,NULL::boolean AS success,
        NULL::text AS capability_name,NULL::text AS decision_source,
        NULL::text AS research_question,NULL::text AS display_name
      FROM world_agent_cognition_tool_attempts t JOIN agents a ON a.id=t.agent_id
      WHERE t.world_id=$1 AND ($2::uuid IS NULL OR t.agent_id=$2)
        AND ($3::timestamptz IS NULL OR t.updated_at >= $3)
        AND ($4::timestamptz IS NULL OR t.updated_at < $4
          OR (t.updated_at=$4 AND ('t:'||t.id::text)<$5))
        AND t.status IN ('succeeded','failed','blocked')
      ORDER BY t.updated_at DESC,t.id DESC LIMIT $6`, common),
    pool.query(`SELECT 'j' AS source,j.id::text AS id,j.completed_at AS created_at,
        j.actor_agent_id AS agent_id,a.name AS agent_name,j.completed_world_minute AS world_minute,
        j.status,j.research_question,NULL::text AS event_type,NULL::text AS title,NULL::text AS detail,
        NULL::text AS entity_type,NULL::uuid AS entity_id,NULL::jsonb AS data,NULL::boolean AS success,
        NULL::text AS capability_name,NULL::text AS decision_source,NULL::text AS capability_key,
        NULL::text AS display_name
      FROM world_research_jobs j JOIN agents a ON a.id=j.actor_agent_id
      WHERE j.world_id=$1 AND ($2::uuid IS NULL OR j.actor_agent_id=$2)
        AND ($3::timestamptz IS NULL OR j.completed_at >= $3)
        AND ($4::timestamptz IS NULL OR j.completed_at < $4
          OR (j.completed_at=$4 AND ('j:'||j.id::text)<$5))
        AND j.status IN ('completed','failed','timed_out')
      ORDER BY j.completed_at DESC,j.id DESC LIMIT $6`, common),
    pool.query(`SELECT 'a' AS source,r.id::text AS id,r.created_at,
        r.created_by_agent_id AS agent_id,a.name AS agent_name,NULL::bigint AS world_minute,
        r.display_name,NULL::text AS event_type,NULL::text AS title,NULL::text AS detail,
        NULL::text AS entity_type,NULL::uuid AS entity_id,NULL::jsonb AS data,NULL::text AS status,
        NULL::boolean AS success,NULL::text AS capability_name,NULL::text AS decision_source,
        NULL::text AS capability_key,NULL::text AS research_question
      FROM world_research_artifacts r LEFT JOIN agents a ON a.id=r.created_by_agent_id
      WHERE r.world_id=$1 AND ($2::uuid IS NULL OR r.created_by_agent_id=$2)
        AND ($3::timestamptz IS NULL OR r.created_at >= $3)
        AND ($4::timestamptz IS NULL OR r.created_at < $4
          OR (r.created_at=$4 AND ('a:'||r.id::text)<$5))
      ORDER BY r.created_at DESC,r.id DESC LIMIT $6`, common)
  ]);
  const rows = [history, events, uses, attempts, jobs, artifacts].flatMap((result) => result.rows);
  return projectEventPage(rows, { limit, category, cursor, minImportance });
}

export async function readWorldFeed(pool, query = {}, { agentId = null } = {}) {
  const page = parseObservabilityPage(query);
  const world = await currentObservableWorld(pool);
  if (!world.id) return emptyPage;
  const since = page.period === 'all' ? null : new Date(Date.now()
    - (page.period === 'today' ? 86_400_000 : 7 * 86_400_000)).toISOString();
  return readObservableEvents(pool, { worldId: world.id, agentId, limit: page.limit,
    cursor: page.cursor, since, category: page.category,
    minImportance: agentId ? 'low' : 'medium' });
}

export async function readResidents(pool) {
  const world = await currentObservableWorld(pool);
  if (!world.id) return [];
  const result = await pool.query(`SELECT a.id,a.name,m.location,s.status AS activity,
      p.dominant_role AS role,goal.description AS current_goal,
      cognition.last_cognition_world_minute,cognition.plans,
      latest.model AS recent_model,latest.created_at AS last_model_at,
      action.title AS latest_action,action.created_at AS latest_action_at,
      tool.capability_key AS latest_tool,artifact.display_name AS latest_artifact,
      project.title AS current_project,collaborators.names AS collaborators
    FROM world_members m JOIN agents a ON a.id=m.agent_id
    LEFT JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
    LEFT JOIN world_social_profiles p ON p.world_id=m.world_id AND p.agent_id=m.agent_id
    LEFT JOIN LATERAL (SELECT description FROM world_agent_goals g
      WHERE g.world_id=m.world_id AND g.agent_id=m.agent_id AND g.status='active'
      ORDER BY (g.goal_type='primary') DESC,g.priority DESC LIMIT 1) goal ON true
    LEFT JOIN world_agent_cognition_state cognition ON cognition.world_id=m.world_id AND cognition.agent_id=m.agent_id
    LEFT JOIN LATERAL (SELECT model,created_at FROM world_agent_cognition_model_calls call
      WHERE call.world_id=m.world_id AND call.agent_id=m.agent_id AND call.status='succeeded'
      ORDER BY call.created_at DESC LIMIT 1) latest ON true
    LEFT JOIN LATERAL (SELECT title,created_at FROM world_history h
      WHERE h.world_id=m.world_id AND h.actor_agent_id=m.agent_id
        AND h.event_type=ANY($2::text[])
      ORDER BY h.created_at DESC LIMIT 1) action ON true
    LEFT JOIN LATERAL (SELECT capability_key FROM world_agent_cognition_tool_attempts t
      WHERE t.world_id=m.world_id AND t.agent_id=m.agent_id AND t.status='succeeded'
      ORDER BY t.updated_at DESC LIMIT 1) tool ON true
    LEFT JOIN LATERAL (SELECT display_name FROM world_research_artifacts r
      WHERE r.world_id=m.world_id AND r.created_by_agent_id=m.agent_id
      ORDER BY r.created_at DESC LIMIT 1) artifact ON true
    LEFT JOIN LATERAL (SELECT p.title FROM world_project_members pm JOIN world_projects p
      ON p.world_id=pm.world_id AND p.id=pm.project_id
      WHERE pm.world_id=m.world_id AND pm.agent_id=m.agent_id AND pm.status='active'
        AND p.status IN ('active','recruiting') ORDER BY p.updated_world_time DESC LIMIT 1) project ON true
    LEFT JOIN LATERAL (SELECT string_agg(other.name,', ' ORDER BY r.familiarity DESC) AS names
      FROM (SELECT agent_a_id,agent_b_id,familiarity FROM world_relationships
        WHERE world_id=m.world_id AND (agent_a_id=m.agent_id OR agent_b_id=m.agent_id)
        ORDER BY familiarity DESC LIMIT 3) r
      JOIN agents other ON other.id=CASE WHEN r.agent_a_id=m.agent_id THEN r.agent_b_id ELSE r.agent_a_id END) collaborators ON true
    WHERE m.world_id=$1 ORDER BY a.name,a.id LIMIT 100`, [world.id, HISTORY_TYPES]);
  return result.rows.map((row) => ({ id: row.id, name: row.name, location: row.location,
    activity: row.activity, role: row.role, currentGoal: row.current_goal,
    currentPlan: activePlan(row.plans)?.summary || null,
    lastCognitionWorldMinute: row.last_cognition_world_minute == null ? null : Number(row.last_cognition_world_minute),
    recentModel: row.recent_model || null, lastModelAt: realDate(row.last_model_at),
    latestMeaningfulAction: row.latest_action || null, latestActionAt: realDate(row.latest_action_at),
    latestTool: row.latest_tool || null, latestArtifact: row.latest_artifact || null,
    currentProject: row.current_project || null, collaborators: row.collaborators || null }));
}

function activePlan(plans) {
  return (Array.isArray(plans) ? plans : []).find((plan) => ['active','blocked'].includes(plan?.status)) || null;
}

export async function readAgentSummary(pool, agentId) {
  if (!validObservabilityUuid(agentId)) throw Object.assign(new Error('AGENT_ID_INVALID'), { statusCode: 400 });
  const world = await currentObservableWorld(pool);
  if (!world.id) return null;
  const [resident, goals, state, relationships, artifact, tool, economy, project, lastAction] = await Promise.all([
    pool.query(`SELECT a.id,a.name,m.location,s.status AS activity,p.dominant_role AS role
      FROM world_members m JOIN agents a ON a.id=m.agent_id
      LEFT JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
      LEFT JOIN world_social_profiles p ON p.world_id=m.world_id AND p.agent_id=m.agent_id
      WHERE m.world_id=$1 AND m.agent_id=$2`, [world.id, agentId]),
    pool.query(`SELECT id,description,category,goal_type,progress,status,source
      FROM world_agent_goals WHERE world_id=$1 AND agent_id=$2 AND status='active'
      ORDER BY (goal_type='primary') DESC,priority DESC LIMIT 8`, [world.id, agentId]),
    pool.query(`SELECT goals,plans,last_cognition_world_minute,next_review_world_minute,
      next_scheduled_at FROM world_agent_cognition_state WHERE world_id=$1 AND agent_id=$2`, [world.id, agentId]),
    pool.query(`SELECT other.id,other.name,r.trust,r.familiarity FROM world_relationships r
      JOIN agents other ON other.id=CASE WHEN r.agent_a_id=$2 THEN r.agent_b_id ELSE r.agent_a_id END
      WHERE r.world_id=$1 AND (r.agent_a_id=$2 OR r.agent_b_id=$2)
      ORDER BY r.familiarity DESC LIMIT 5`, [world.id, agentId]),
    pool.query(`SELECT id,display_name,created_at FROM world_research_artifacts
      WHERE world_id=$1 AND created_by_agent_id=$2 ORDER BY created_at DESC LIMIT 1`, [world.id, agentId]),
    pool.query(`SELECT capability_key,status,updated_at FROM world_agent_cognition_tool_attempts
      WHERE world_id=$1 AND agent_id=$2 AND status IN ('succeeded','failed','blocked')
      ORDER BY updated_at DESC LIMIT 1`, [world.id, agentId]),
    pool.query(`SELECT asset_symbol,balance::text FROM world_economic_accounts
      WHERE world_id=$1 AND account_type='resident' AND owner_id=$2 ORDER BY asset_symbol LIMIT 8`, [world.id, agentId]),
    pool.query(`SELECT p.id,p.title,p.status,p.progress FROM world_project_members pm
      JOIN world_projects p ON p.world_id=pm.world_id AND p.id=pm.project_id
      WHERE pm.world_id=$1 AND pm.agent_id=$2 AND pm.status='active'
        AND p.status IN ('active','recruiting') ORDER BY p.updated_world_time DESC LIMIT 1`, [world.id, agentId]),
    pool.query(`SELECT title,created_at,world_time FROM world_history
      WHERE world_id=$1 AND actor_agent_id=$2 AND event_type=ANY($3::text[])
      ORDER BY created_at DESC LIMIT 1`, [world.id, agentId, HISTORY_TYPES])
  ]);
  if (!resident.rowCount) return null;
  const cognition = state.rows[0] || {};
  const plan = activePlan(cognition.plans);
  const steps = (Array.isArray(plan?.steps) ? plan.steps : []).slice(0, 30);
  const genesisCurrency = await readGenesisCurrencyActivation(pool, world.id);
  const activeAssets = genesisCurrency ? await readActiveGenesisTokenAssets(pool, { worldId: world.id,
    ownerAgentId: agentId }) : [];
  return { ...resident.rows[0], currentGoal: goals.rows[0] ? { id: String(goals.rows[0].id),
    title: text(goals.rows[0].description), category: goals.rows[0].category,
    progress: Number(goals.rows[0].progress), source: goals.rows[0].source } : null,
  otherGoals: (Array.isArray(cognition.goals) ? cognition.goals : []).filter((g) => g.status === 'active')
    .slice(0, 8).map((g) => ({ id: text(g.id, 100), title: text(g.title, 240), status: g.status })),
  activePlan: plan ? { id: text(plan.id, 100), summary: text(plan.summary, 240), status: plan.status,
    currentStep: plan.currentStep, steps: steps.map((step, index) => ({ id: text(step.stepId, 100),
      description: text(step.description, 240), status: index < plan.currentStep && step.executionEvidence?.success
        ? 'completed' : index === plan.currentStep ? plan.status : 'pending',
      blocker: index === plan.currentStep ? text(step.groundingBlocked?.reason, 120) : null })) } : null,
  collaborators: relationships.rows.map((r) => ({ id: r.id, name: r.name,
    familiarity: Number(r.familiarity), trust: Number(r.trust) })),
  latestArtifact: artifact.rows[0] ? { id: artifact.rows[0].id,
    name: artifact.rows[0].display_name, at: realDate(artifact.rows[0].created_at) } : null,
  latestTool: tool.rows[0] ? { name: tool.rows[0].capability_key,
    status: tool.rows[0].status, at: realDate(tool.rows[0].updated_at) } : null,
  currentProject: project.rows[0] ? { id: project.rows[0].id, title: project.rows[0].title,
    status: project.rows[0].status, progress: Number(project.rows[0].progress) } : null,
  lastMeaningfulAction: lastAction.rows[0] ? { title: lastAction.rows[0].title,
    at: realDate(lastAction.rows[0].created_at), worldMinute: Number(lastAction.rows[0].world_time) } : null,
  lastCognitionWorldMinute: cognition.last_cognition_world_minute == null ? null
    : Number(cognition.last_cognition_world_minute),
  nextEligibleWorldMinute: cognition.next_review_world_minute == null ? null
    : Number(cognition.next_review_world_minute),
  economicBalances: genesisCurrency ? activeAssets.map((asset) => ({ asset: asset.symbol,
    balance: asset.available && asset.balanceRaw != null
      ? formatGenesisTokenRaw(asset.balanceRaw, Number(asset.decimals)) : null,
    source: asset.available ? 'arc_chain_snapshot' : 'unavailable' }))
    : economy.rows.map((r) => ({ asset: r.asset_symbol, balance: r.balance,
      source: 'simulated_internal_ledger' })) };
}

export async function readWorldIntelligence(pool) {
  const world = await currentObservableWorld(pool);
  if (!world.id) return { available: false };
  const [calls, states, turnCounts] = await Promise.all([
    pool.query(`SELECT model,returned_model,tier,status,provider_started_at,created_at,
        input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cached_input_tokens,
        effective_cost_nano_usd,cost_source,agent_id
      FROM bai_model_budget_calls WHERE world_id=$1 AND created_at>=now()-interval '24 hours'
      ORDER BY created_at DESC LIMIT 2000`, [world.id]),
    pool.query(`SELECT agent_id,last_cognition_world_minute,next_review_world_minute,
        next_scheduled_at,lease_until,budget_deferred_until FROM world_agent_cognition_state WHERE world_id=$1`, [world.id]),
    pool.query(`SELECT agent_id,count(*)::int AS calls FROM world_agent_cognition_turns
      WHERE world_id=$1 AND created_at>=now()-interval '24 hours' GROUP BY agent_id`, [world.id])
  ]);
  const result = aggregateIntelligence(calls.rows);
  const perAgent = new Map(turnCounts.rows.map((row) => [row.agent_id, row.calls]));
  const byAgentCost = new Map();
  for (const row of calls.rows) if (row.agent_id && row.provider_started_at
    && ['usage_priced','provider_reported'].includes(row.cost_source)) {
    byAgentCost.set(row.agent_id, (byAgentCost.get(row.agent_id) || 0)
      + Number(row.effective_cost_nano_usd) / 1e9);
  }
  return { ...result, available: true, costByAgentUsd24h: Object.fromEntries(byAgentCost),
    scheduler: { active: states.rows.filter((r) => r.lease_until && new Date(r.lease_until) > new Date()).length,
      queued: states.rows.filter((r) => r.next_scheduled_at && new Date(r.next_scheduled_at) <= new Date()).length,
      lastCognitionWorldMinute: Math.max(0, ...states.rows.map((r) => Number(r.last_cognition_world_minute || 0))),
      agents: states.rows.map((r) => ({ agentId: r.agent_id,
        lastCognitionWorldMinute: r.last_cognition_world_minute == null ? null : Number(r.last_cognition_world_minute),
        nextEligibleWorldMinute: Number(r.next_review_world_minute), count24h: perAgent.get(r.agent_id) || 0 })) } };
}

export async function readWorldAutonomy(pool, period = '24h') {
  if (!['24h','7d'].includes(period)) throw Object.assign(new Error('PERIOD_INVALID'), { statusCode: 400 });
  const world = await currentObservableWorld(pool);
  if (!world.id) return { available: false };
  const since = new Date(Date.now() - (period === '24h' ? 1 : 7) * 86_400_000).toISOString();
  const [history, events, uses, turns, research] = await Promise.all([
    pool.query(`SELECT event_type,count(*)::int AS count FROM world_history
      WHERE world_id=$1 AND created_at>=$2 AND event_type=ANY($3::text[])
      GROUP BY event_type`, [world.id, since, HISTORY_TYPES]),
    pool.query(`SELECT event_type,
        CASE WHEN event_type='world.action_completed' THEN data->>'action' ELSE NULL END AS action,
        CASE WHEN event_type='world.action_completed'
          THEN data->'cognitionExecution'->>'cognitionTurnId' IS NOT NULL ELSE false END AS attributed,
        count(*)::int AS count
      FROM world_events WHERE world_id=$1 AND created_at>=$2
        AND (event_type IN ('world.goal_milestone','world.goal_replanned','world.goal_updated')
          OR (event_type='world.action_completed' AND data->>'status'='completed'
            AND data->>'action'=ANY($3::text[])))
      GROUP BY event_type,action,attributed`, [world.id, since, MEANINGFUL_ACTIONS]),
    pool.query(`SELECT status,success,decision_source,count(*)::int AS count FROM world_capability_uses
      WHERE world_id=$1 AND created_at>=$2 AND status IN ('completed','failed')
      GROUP BY status,success,decision_source`, [world.id, since]),
    pool.query(`SELECT count(*)::int AS eligible FROM world_agent_cognition_turns
      WHERE world_id=$1 AND created_at>=$2 AND decision_source='open_cognition'
        AND intent->'selectedAction'->>'actionType'='world_action'`, [world.id, since]),
    pool.query(`SELECT count(*) FILTER (WHERE status='completed')::int AS completed_jobs,
        count(DISTINCT target_artifact_id) FILTER (WHERE status='completed')::int AS artifacts_produced,
        count(*) FILTER (WHERE status IN ('running','completed','failed','timed_out'))::int AS jobs_progressed
      FROM world_research_jobs WHERE world_id=$1 AND updated_at>=$2`, [world.id, since])
  ]);
  return { available: true, period,
    ...aggregateAutonomyCounts({ history: history.rows, events: events.rows, uses: uses.rows,
      eligibleTurns: turns.rows[0]?.eligible,
      research: research.rows[0] }), complete: true };
}

export function aggregateAutonomyCounts({ history = [], events = [], uses = [], eligibleTurns = null,
  research = {} } = {}) {
  const h = (type) => history.filter((row) => row.event_type === type)
    .reduce((sum, row) => sum + Number(row.count), 0);
  const e = (type) => events.filter((row) => row.event_type === type)
    .reduce((sum, row) => sum + Number(row.count), 0);
  const action = events.filter((row) => row.event_type === 'world.action_completed');
  const source = (name) => uses.filter((row) => row.decision_source === name)
    .reduce((sum, row) => sum + Number(row.count), 0);
  return { goals: { formed: h('agent_goal_created') + h('goal_created') + e('world.goal_updated'),
      revised: e('world.goal_replanned'), completed: h('goal_completed'), abandoned: h('goal_abandoned') },
    plans: { created: null, advanced: null, completed: null, replans: null,
      blocked: null, reason: 'historical_plan_transitions_not_durable' },
    projects: { proposed: h('project_proposed'), started: h('project_started'),
      completed: h('project_completed'), failed: h('project_failed') },
    cognitionToAction: { eligibleTurns: eligibleTurns == null ? null : Number(eligibleTurns),
      meaningfulWorldActions: action.reduce((sum, row) => sum + Number(row.count), 0),
      successfulWorldActions: action.filter((row) => row.attributed === true)
        .reduce((sum, row) => sum + Number(row.count), 0),
      failedGroundings: null, groundingRate: null },
    tools: { calls: uses.reduce((sum, row) => sum + Number(row.count), 0),
      succeeded: uses.filter((row) => row.success === true).reduce((sum, row) => sum + Number(row.count), 0),
      failed: uses.filter((row) => row.success === false).reduce((sum, row) => sum + Number(row.count), 0),
      artifactsProduced: research.artifacts_produced ?? null,
      jobsProgressed: research.jobs_progressed ?? null },
    fruitfly: { available: false, reason: 'historical_decision_traces_are_pruned',
      autonomousActions: null, fruitflyAssisted: null, fallbackActions: null,
      capabilityUsesBySource: { agentCognition: source('agent_cognition'),
        agentApi: source('agent_api'), fruitfly: source('fruitfly'), utilityFallback: source('utility_fallback') } } };
}

export async function readWorldSummary(pool) {
  const world = await currentObservableWorld(pool);
  if (!world.id) return { world: null, today: null };
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const [page, history, actions, uses, jobs, artifacts] = await Promise.all([
    readObservableEvents(pool, { worldId: world.id, limit: 20, since, minImportance: 'medium' }),
    pool.query(`SELECT event_type,count(*)::int AS count FROM world_history
      WHERE world_id=$1 AND created_at>=$2 AND (event_type=ANY($3::text[])
        OR event_type ~ '^(genesis_|arc_|sync_|world_epoch_)')
      GROUP BY event_type`, [world.id, since, HISTORY_TYPES]),
    pool.query(`SELECT data->>'action' AS action,count(*)::int AS count FROM world_events
      WHERE world_id=$1 AND created_at>=$2 AND event_type='world.action_completed'
        AND data->>'status'='completed' AND data->>'action'=ANY($3::text[])
      GROUP BY data->>'action'`, [world.id, since, MEANINGFUL_ACTIONS]),
    pool.query(`SELECT count(*)::int AS count FROM world_capability_uses
      WHERE world_id=$1 AND created_at>=$2 AND status IN ('completed','failed')`, [world.id, since]),
    pool.query(`SELECT count(*)::int AS count FROM world_research_jobs
      WHERE world_id=$1 AND completed_at>=$2 AND status IN ('completed','failed','timed_out')`, [world.id, since]),
    pool.query(`SELECT count(*)::int AS count FROM world_research_artifacts
      WHERE world_id=$1 AND created_at>=$2`, [world.id, since])
  ]);
  const counts = {};
  for (const row of history.rows) {
    const category = observableHistoryCategory(row.event_type);
    if (category) counts[category] = (counts[category] || 0) + row.count;
  }
  for (const row of actions.rows) {
    const category = row.action === 'cooperate' ? 'relationships' : 'work';
    counts[category] = (counts[category] || 0) + row.count;
  }
  counts.tools = (counts.tools || 0) + uses.rows[0].count;
  counts.work = (counts.work || 0) + jobs.rows[0].count + artifacts.rows[0].count;
  return { world: { id: world.id, name: world.name, worldMinute: Number(world.world_minutes) },
    today: { counts, topEvents: page.items.filter((event) => ['high','critical'].includes(event.importance)).slice(0, 5),
      sampled: false } };
}

export async function readWorldHealth(pool, { engineRunning = false, mainnetWriteGate = false } = {}) {
  const world = await currentObservableWorld(pool);
  if (!world.id) return { available: false, mainnetWriteGate };
  const [counts, last] = await Promise.all([
    pool.query(`SELECT count(*)::int AS agents,
      count(*) FILTER (WHERE s.status IN ('walking','performing'))::int AS active_agents
      FROM world_members m LEFT JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
      WHERE m.world_id=$1`, [world.id]),
    pool.query(`SELECT created_at,event_type FROM world_history WHERE world_id=$1
      AND (event_type=ANY($2::text[]) OR event_type ~ '^(genesis_|arc_|sync_|world_epoch_)')
      ORDER BY created_at DESC,id DESC LIMIT 1`, [world.id, HISTORY_TYPES])
  ]);
  return { available: true, worldId: world.id, worldName: world.name,
    worldUptimeSeconds: Math.floor((Date.now() - new Date(world.created_at).getTime()) / 1000),
    worldMinute: Number(world.world_minutes), agents: counts.rows[0].agents,
    activeAgents: counts.rows[0].active_agents, engineRunning,
    lastTickAt: realDate(world.last_tick_at), databaseFreshAt: realDate(world.last_tick_at),
    lastMeaningfulEventAt: realDate(last.rows[0]?.created_at),
    eventIngestion: 'direct database projection', mainnetWriteGate };
}
