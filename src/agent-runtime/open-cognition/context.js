import { WORLD_SKILLS } from '../skills.js';
import { listResearchInputsByWorld, RESEARCH_CAPABILITY_KEY } from '../../research/research-jobs.js';
import { targetReferenceForStep } from './grounding.js';
import { cognitionPlanForPrompt } from './diagnostics.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BUILTIN_CAPABILITIES = Object.freeze([
  ['world.work','work','Contribute real work where the World permits it.'],
  ['world.learn','learn','Study and develop knowledge at an available place.'],
  ['world.socialize','socialize','Meet another resident when both are available.'],
  ['world.opportunity','opportunity','Evaluate and accept a current World opportunity under its fixed terms.'],
  ['world.project_propose','project_propose','Propose a resident-authored project.'],
  ['world.project_contribute','project_contribute','Contribute to an active project.'],
  ['world.business_found','business_found','Found a business when the existing economic prerequisites hold.'],
  ['world.business_work','business_work','Complete an authorized employment or service action.'],
  ['world.information_share','information_share','Share evidence or information with another resident.'],
  ['world.capability_use','capability_use','Use an adopted or experimental World capability under its specification.']
]);
const RESIDENT_SKILL_ACTIONS = Object.freeze({
  // Skills describe resident experience. Current executable actions come only
  // from the live World affordance snapshot and are never inferred here.
  research: [], engineering: [], trading: [], social: []
});

export function buildCapabilityGraph({ worldCapabilities = [], skills = [],
  reaAvailable = false, githubPublicRead = true } = {}) {
  const nodes = BUILTIN_CAPABILITIES.map(([key, actionType, description]) => ({
    key, actionType, description, execution: 'world_validated', permission: 'existing_world_rules',
    inputs: 'World action arguments and current feasible target', outputs: 'Authoritative World event and state',
    requiredState: 'World primitive accepts this resident and target'
  }));
  for (const row of worldCapabilities) nodes.push({ key: `world-capability:${row.id}`,
    actionType: 'capability_use', description: row.description, name: row.name,
    specification: row.specification, execution: 'world_validated', permission: row.status,
    successHistory: { uses: Number(row.usage_count) || 0, successes: Number(row.success_count) || 0,
      failures: Number(row.failure_count) || 0 } });
  for (const skill of skills) nodes.push({ key: `skill:${skill.name}`, actionType: null,
    description: WORLD_SKILLS[skill.name]?.focus || `Resident skill ${skill.name}`,
    level: Number(skill.value), relatedActions: RESIDENT_SKILL_ACTIONS[skill.name] || [],
    successHistory: { actionsCompleted: Number(skill.actions_completed) || 0 },
    execution: 'resident_experience', permission: 'resident_owned' });
  if (reaAvailable) nodes.push({ key: 'tool:rea', actionType: 'capability_use',
    description: 'Research a resident-authored question using an already authorized artifact and the REA evidence path.',
    execution: 'existing_research_worker', permission: 'artifact_grant_required',
    inputs: 'researchQuestion, objective, desiredInvestigation, expectedResult, candidateId',
    outputs: 'Evidence-backed findings and research memory', latency: 'asynchronous',
    requiredState: 'Active relation binding and artifact grant' });
  if (githubPublicRead) nodes.push({ key: 'tool:github_public_read', actionType: null,
    description: 'Read public GitHub repositories, code, documentation and issues for research; no write access.',
    execution: 'read_only_external', permission: 'public_read_only',
    operations: ['search_repositories','repository','contents','issues'],
    inputs: 'operation and public repository coordinates', outputs: 'Bounded source-backed evidence',
    latency: 'network', cost: 'public API rate limit' });
  nodes.push({ key: 'tool:model_analysis', actionType: null,
    description: 'Delegate a bounded advisory analysis to a selected Claude tier; the main resident retains the decision.',
    execution: 'model_subtask', permission: 'resident_cognition_only',
    inputs: 'question, objective, tier', outputs: 'Evidence-backed summary, uncertainty, suggested next steps',
    relatedTools: ['tool:rea','tool:github_public_read'], cost: 'model tokens', latency: 'network' });
  return nodes;
}

export function evidenceRefsForContext(context) {
  return [`world:${context.world.minute}`,
    ...(context.recentEvents || []).map((row) => `event:${row.id}`),
    ...(context.memories || []).map((row) => `memory:${row.id}`),
    ...(context.research || []).map((row) => `research:${row.id}`),
    ...(context.toolResults || []).map((row) => `tool:${row.intent_key}`),
    ...(context.projects || []).map((row) => `project:${row.id}`),
    ...(context.workOrders || []).map((row) => `work_order:${row.id}`),
    ...(context.capabilityGaps || []).map((row) => `capability_gap:${row.id}`),
    ...(context.capabilityProposals || []).map((row) => `capability_proposal:${row.id}`),
    ...(context.capabilityExperiences || []).map((row) => `capability_use:${row.useId}`)];
}

function compactJson(value, maxBytes = 120_000) {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > maxBytes) throw Object.assign(new Error('COGNITION_CONTEXT_TOO_LARGE'),
    { code: 'COGNITION_CONTEXT_TOO_LARGE' });
  return value;
}

function promptPrior(state) {
  if (!state) return { revision: 0, selfModel: {}, goals: [], plans: [], beliefs: [],
    values: [], policyExperiments: [], openQuestions: [], pendingAction: {} };
  const goals = Array.isArray(state.goals) ? state.goals : [];
  const plans = Array.isArray(state.plans) ? state.plans : [];
  const { attributionModelCallIds: _attributionModelCallIds,
    attributionTurnId: _attributionTurnId,
    ...visiblePendingAction } = state.pending_action || {};
  return { revision: Number(state.revision), selfModel: state.self_model,
    goals: [...goals.filter((goal) => ['active','paused'].includes(goal.status)),
      ...goals.filter((goal) => !['active','paused'].includes(goal.status)).slice(-6)],
    plans: [...plans.filter((plan) => ['active','blocked','paused'].includes(plan.status)),
      ...plans.filter((plan) => !['active','blocked','paused'].includes(plan.status)).slice(-4)]
      .map((plan) => ({ ...cognitionPlanForPrompt(plan), totalSteps: plan.steps?.length || 0 })),
    beliefs: state.beliefs || [], values: state.values_state || [],
    policyExperiments: [...(state.policy_experiments || []).filter((item) => ['active','paused'].includes(item.status)),
      ...(state.policy_experiments || []).filter((item) => !['active','paused'].includes(item.status)).slice(-6)],
    openQuestions: [...(state.open_questions || []).filter((question) => ['open','exploring'].includes(question.status)),
      ...(state.open_questions || []).filter((question) => !['open','exploring','abandoned'].includes(question.status)).slice(-6)],
    pendingAction: visiblePendingAction };
}

function tokens(value) {
  return new Set((String(value || '').toLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]{1,}/gu) || [])
    .filter((token) => token.length > 1));
}

function retrieveCapabilityGraph(graph, state) {
  const plans = Array.isArray(state?.plans) ? state.plans : [];
  const plan = [...plans].sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active'))
    .find((item) => ['active','blocked'].includes(item.status)
      && Number.isInteger(item.currentStep) && item.currentStep < (item.steps || []).length);
  const goal = (state?.goals || []).find((item) => item.id === plan?.goalId && item.status === 'active');
  const step = plan?.steps?.[plan.currentStep];
  const intentTokens = tokens([goal?.title, goal?.why, plan?.summary, step?.intent,
    step?.description].filter(Boolean).join(' '));
  if (!intentTokens.size) return graph;
  const affordanceActions = new Set((state?.available_affordances || []).map((item) => item.action));
  const scored = graph.map((capability) => {
    const capabilityTokens = tokens(`${capability.key} ${capability.name || ''} ${capability.description || ''}`);
    let overlap = 0;
    for (const token of capabilityTokens) if (intentTokens.has(token)) overlap += 1;
    const actionMatch = capability.actionType && affordanceActions.has(capability.actionType) ? 1 : 0;
    const toolMatch = (capability.key === 'tool:rea' && /research|study|evidence|source|investigat|研究|证据|资料/u.test(step?.intent || ''))
      || (capability.key === 'tool:github_public_read' && /github|repository|source code|code|文档|代码/u.test(step?.intent || ''));
    return { capability, score: overlap + actionMatch * 1.5 + Number(Boolean(toolMatch)) * 2 };
  });
  const relevant = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score
    || String(a.capability.key).localeCompare(String(b.capability.key))).map((item) => item.capability);
  return relevant.length ? relevant : graph.filter((item) => item.actionType
    && affordanceActions.has(item.actionType));
}

function retrieveResearchOpportunities(rows, state) {
  const plan = [...(state?.plans || [])]
    .sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active'))
    .find((item) => ['active','blocked'].includes(item.status)
      && Number.isInteger(item.currentStep) && item.currentStep < (item.steps || []).length);
  const goal = (state?.goals || []).find((item) => item.id === plan?.goalId && item.status === 'active');
  const step = plan?.steps?.[plan.currentStep];
  const query = tokens([goal?.title, goal?.why, plan?.summary, step?.intent, step?.description].filter(Boolean).join(' '));
  if (!query.size) return rows;
  const ranked = rows.map((row) => {
    const evidence = tokens([row.artifactName,row.targetType,row.relationLabel,row.relevanceDescription]
      .filter(Boolean).join(' '));
    let score = 0;
    for (const token of evidence) if (query.has(token)) score += 1;
    return { row, score };
  }).filter((item) => item.score > 0)
    .sort((left,right) => right.score-left.score || String(left.row.candidateId).localeCompare(String(right.row.candidateId)));
  return ranked.length ? ranked.map((item) => item.row) : rows;
}

async function querySequentially(queries) {
  const results = [];
  for (const query of queries) results.push(await query());
  return results;
}

function activePlanTarget(state) {
  const plans = Array.isArray(state?.plans) ? state.plans : [];
  const plan = [...plans].sort((left, right) => Number(right.status === 'active') - Number(left.status === 'active'))
    .find((item) => ['active','blocked'].includes(item?.status)
      && Number.isInteger(item.currentStep) && item.currentStep < (item.steps || []).length);
  const step = plan?.steps?.[plan.currentStep];
  if (!step || (step.targetBindingMode && step.targetBindingMode !== 'exact')) return null;
  const reference = targetReferenceForStep(step);
  return reference ? { planId: plan.id, stepId: step.stepId, step, reference } : null;
}

async function readBoundTargetState(client, worldId, agentId, state, worldMinute) {
  const binding = activePlanTarget(state);
  if (!binding) return null;
  const { reference, step } = binding;
  if (!UUID.test(reference.id)) return { lookupSupported: false, type: reference.type,
    id: reference.id, targetAction: reference.targetAction || null };
  let result;
  if (reference.type === 'project') {
    result = await client.query(`SELECT project.id::text AS id,project.status,
        project.updated_world_time::text AS state_version,
        project.deadline_world_time::text AS deadline_world_minute,
        project.result->>'failureReason' AS failure_reason,
        COALESCE(member.status,'not_member') AS permission_status,scene.name AS location
      FROM world_projects project LEFT JOIN world_project_members member
        ON member.world_id=project.world_id AND member.project_id=project.id AND member.agent_id=$3
      LEFT JOIN world_opportunities origin_opportunity
        ON origin_opportunity.world_id=project.world_id AND origin_opportunity.id=project.opportunity_id
      LEFT JOIN world_scenes scene
        ON scene.world_id=origin_opportunity.world_id AND scene.id=origin_opportunity.scene_id
      WHERE project.world_id=$1 AND project.id=$2`, [worldId, reference.id, agentId]);
  } else if (reference.type === 'opportunity') {
    result = await client.query(`SELECT opportunity.id::text AS id,opportunity.status,
        opportunity.updated_at::text AS state_version,
        opportunity.expires_world_time::text AS deadline_world_minute,
        participant.status AS permission_status,scene.name AS location
      FROM world_opportunities opportunity LEFT JOIN world_opportunity_participants participant
        ON participant.world_id=opportunity.world_id AND participant.opportunity_id=opportunity.id
          AND participant.agent_id=$3
      LEFT JOIN world_scenes scene ON scene.world_id=opportunity.world_id AND scene.id=opportunity.scene_id
      WHERE opportunity.world_id=$1 AND opportunity.id=$2`, [worldId, reference.id, agentId]);
  } else if (reference.type === 'world_work_order') {
    result = await client.query(`SELECT work_order.id::text AS id,work_order.status,
        work_order.updated_at::text AS state_version,
        work_order.deadline_world_minute::text AS deadline_world_minute,
        work_order.accepted_agent_id::text AS accepted_agent_id,
        CASE WHEN work_order.accepted_agent_id IS NULL THEN 'not_accepted'
          WHEN work_order.accepted_agent_id<>$3 THEN 'accepted_by_other'
          ELSE 'accepted_by_agent' END AS permission_status,
        target.status AS target_status,target.id::text AS cleanup_target_id,
        target.location,target.cleared_by_agent_id::text AS cleared_by_agent_id
      FROM world_sync_work_orders work_order LEFT JOIN world_sync_cleanup_targets target
        ON target.world_id=work_order.world_id AND target.id=work_order.target_id
      WHERE work_order.world_id=$1 AND work_order.id=$2`, [worldId, reference.id]);
  } else if (reference.type === 'cleanup_target') {
    result = await client.query(`SELECT target.id::text AS id,target.status,
        COALESCE(target.cleared_world_minute,target.created_world_minute)::text AS state_version,
        target.location,target.cleared_by_agent_id::text AS cleared_by_agent_id,
        work_order.status AS work_order_status,work_order.deadline_world_minute::text AS deadline_world_minute,
        work_order.accepted_agent_id::text AS accepted_agent_id,
        CASE WHEN work_order.accepted_agent_id IS NULL THEN 'not_accepted'
          WHEN work_order.accepted_agent_id<>$3 THEN 'accepted_by_other'
          ELSE 'accepted_by_agent' END AS permission_status
      FROM world_sync_cleanup_targets target LEFT JOIN world_sync_work_orders work_order
        ON work_order.world_id=target.world_id AND work_order.target_id=target.id
      WHERE target.world_id=$1 AND target.id=$2`, [worldId, reference.id, agentId]);
  } else if (reference.type === 'information_share') {
    result = await client.query(`SELECT share.id::text AS id,share.status,
        share.updated_at::text AS state_version,share.expires_world_time::text AS deadline_world_minute,
        CASE WHEN share.recipient_agent_id=$3 THEN 'recipient' ELSE 'not_recipient' END AS permission_status
      FROM world_information_shares share WHERE share.world_id=$1 AND share.id=$2`,
    [worldId, reference.id, agentId]);
  } else if (reference.type === 'organization') {
    result = await client.query(`SELECT organization.id::text AS id,organization.status,
        organization.updated_world_time::text AS state_version,
        COALESCE(member.status,'not_member') AS permission_status
      FROM world_organizations organization LEFT JOIN world_organization_members member
        ON member.world_id=organization.world_id AND member.organization_id=organization.id AND member.agent_id=$3
      WHERE organization.world_id=$1 AND organization.id=$2`, [worldId, reference.id, agentId]);
  } else if (reference.type === 'business') {
    result = await client.query(`SELECT business.id::text AS id,business.status,
        business.updated_at::text AS state_version,scene.name AS location
      FROM world_businesses business LEFT JOIN world_scenes scene
        ON scene.world_id=business.world_id AND scene.id=business.place_id
      WHERE business.world_id=$1 AND business.id=$2`, [worldId, reference.id]);
  } else if (reference.type === 'service') {
    result = await client.query(`SELECT service.id::text AS id,
        CASE WHEN service.active AND business.status='active' THEN 'active' ELSE 'inactive' END AS status,
        concat(service.created_world_time,'|',service.active,'|',business.status) AS state_version,
        business.status AS target_status,scene.name AS location
      FROM world_business_services service JOIN world_businesses business
        ON business.world_id=service.world_id AND business.id=service.business_id
      LEFT JOIN world_scenes scene ON scene.world_id=business.world_id AND scene.id=business.place_id
      WHERE service.world_id=$1 AND service.id=$2`, [worldId, reference.id]);
  } else if (reference.type === 'job') {
    result = await client.query(`SELECT job.id::text AS id,job.status,
        concat(job.created_world_time,'|',business.status) AS state_version,
        business.status AS target_status,scene.name AS location
      FROM world_business_jobs job JOIN world_businesses business
        ON business.world_id=job.world_id AND business.id=job.business_id
      LEFT JOIN world_scenes scene ON scene.world_id=business.world_id AND scene.id=business.place_id
      WHERE job.world_id=$1 AND job.id=$2`, [worldId, reference.id]);
  } else if (reference.type === 'capability') {
    result = await client.query(`SELECT capability.id::text AS id,capability.status,
        concat(capability.version,'|',capability.updated_at::text) AS state_version
      FROM world_capabilities capability WHERE capability.world_id=$1 AND capability.id=$2`,
    [worldId, reference.id]);
  } else if (reference.type === 'resident') {
    result = await client.query(`SELECT member.agent_id::text AS id,'active' AS status,
        member.joined_at::text AS state_version,member.location
      FROM world_members member WHERE member.world_id=$1 AND member.agent_id=$2`, [worldId, reference.id]);
  } else if (reference.type === 'agreement') {
    result = await client.query(`SELECT agreement.id::text AS id,agreement.status,
        agreement.updated_world_time::text AS state_version,
        agreement.expires_world_time::text AS deadline_world_minute,
        COALESCE(participant.response,'not_participant') AS permission_status
      FROM world_agreements agreement LEFT JOIN world_agreement_participants participant
        ON participant.world_id=agreement.world_id AND participant.agreement_id=agreement.id
          AND participant.agent_id=$3
      WHERE agreement.world_id=$1 AND agreement.id=$2`, [worldId, reference.id, agentId]);
  } else {
    return { lookupSupported: false, type: reference.type, id: reference.id,
      targetAction: reference.targetAction || null };
  }
  const row = result.rows[0];
  if (!row) return { lookupSupported: true, type: reference.type, id: reference.id,
    exists: false, targetAction: reference.targetAction || null };
  const targetState = { ...row, lookupSupported: true, type: reference.type,
    exists: true, targetAction: reference.targetAction || null,
    deadlineWorldMinute: row.deadline_world_minute == null ? null : Number(row.deadline_world_minute),
    targetStatus: row.target_status || null, workOrderStatus: row.work_order_status || null,
    failureReason: row.failure_reason || null,
    permissionStatus: row.permission_status || row.permissionStatus || null,
    stateVersion: [row.state_version || null, row.status || null, row.permission_status || null,
      row.target_status || null, row.work_order_status || null, row.deadline_world_minute || null].join('|') };
  delete targetState.state_version;
  delete targetState.deadline_world_minute;
  delete targetState.target_status;
  delete targetState.work_order_status;
  delete targetState.permission_status;
  return targetState;
}

// All queries share one repeatable-read snapshot. Tool text, memories and social
// messages are evidence, never instructions or a permission source.
export async function readCognitionContext(pool, { worldId, agentId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '8s'");
    const [clock, resident, cognition, oldGoals, memories, newMemories, relationships,
      projects, skills, capabilities, research, workOrders, balances, toolAttempts, researchInputs,
      recentEvents, peers, capabilityGaps, capabilityProposals, capabilityExperiences] = await querySequentially([
      () => client.query(`SELECT world_minutes,tick_count,environment FROM world_runtime_state WHERE world_id=$1`, [worldId]),
      () => client.query(`SELECT a.name,m.energy,m.food,m.social,m.location,s.status,s.goal,s.risk_tolerance,
          s.knowledge,s.happiness,sm.current_identity_summary,sm.uncertainty AS self_uncertainty
        FROM world_members m JOIN agents a ON a.id=m.agent_id
        JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
        LEFT JOIN world_agent_self_models sm ON sm.world_id=m.world_id AND sm.agent_id=m.agent_id
        WHERE m.world_id=$1 AND m.agent_id=$2`, [worldId, agentId]),
      () => client.query(`SELECT * FROM world_agent_cognition_state WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]),
      () => client.query(`SELECT id,goal_type,category,description,status,source,metadata
        FROM world_agent_goals WHERE world_id=$1 AND agent_id=$2 AND status='active'
        ORDER BY priority DESC,id DESC LIMIT 20`, [worldId, agentId]),
      () => client.query(`SELECT id,memory_type,summary,importance::text,world_minutes,metadata
        FROM agent_memories WHERE world_id=$1 AND agent_id=$2
        ORDER BY long_term DESC,importance DESC,world_minutes DESC,id DESC`, [worldId, agentId]),
      () => client.query(`SELECT id,memory_key,memory_type,summary,evidence,created_world_minute
        FROM world_agent_cognition_memories WHERE world_id=$1 AND agent_id=$2
        ORDER BY created_world_minute DESC,id DESC`, [worldId, agentId]),
      () => client.query(`SELECT CASE WHEN r.agent_a_id=$2 THEN r.agent_b_id ELSE r.agent_a_id END AS agent_id,
          a.name,r.familiarity::text,r.trust::text,r.affinity::text,r.interaction_count
        FROM world_relationships r JOIN agents a ON a.id=CASE WHEN r.agent_a_id=$2 THEN r.agent_b_id ELSE r.agent_a_id END
        WHERE r.world_id=$1 AND (r.agent_a_id=$2 OR r.agent_b_id=$2)
        ORDER BY r.interaction_count DESC LIMIT 20`, [worldId, agentId]),
      () => client.query(`SELECT p.id,p.title,p.goal,p.status,p.project_type,p.progress::text
        FROM world_projects p LEFT JOIN world_project_members member
          ON member.world_id=p.world_id AND member.project_id=p.id AND member.agent_id=$2
        WHERE p.world_id=$1 AND (p.creator_agent_id=$2 OR member.agent_id IS NOT NULL)
        ORDER BY p.updated_world_time DESC LIMIT 20`, [worldId, agentId]),
      () => client.query(`SELECT skill_name AS name,skill_value::text AS value,actions_completed
        FROM world_agent_skills WHERE world_id=$1 AND agent_id=$2 ORDER BY skill_name`, [worldId, agentId]),
      () => client.query(`SELECT id,name,description,status,specification,usage_count,success_count,failure_count
        FROM world_capabilities WHERE world_id=$1 AND status IN ('active','experimental')
        ORDER BY usage_count DESC,name`, [worldId]),
      () => client.query(`SELECT id,research_question,status,normalized_findings,created_world_minute
        FROM world_research_jobs WHERE world_id=$1 AND actor_agent_id=$2
        ORDER BY created_world_minute DESC LIMIT 12`, [worldId, agentId]),
      () => client.query(`SELECT work_order.id,work_order.opportunity_id,work_order.target_id,
          work_order.status,work_order.updated_at::text AS "targetStateVersion",
          work_order.raw_sync_reward::text AS "rawSyncReward",
          work_order.deadline_world_minute AS "deadlineWorldMinute",
          work_order.acceptance_criteria,target.location AS "targetLocation",
          target.kind AS "targetKind",target.status AS "cleanupTargetStatus"
        FROM world_sync_work_orders work_order JOIN world_sync_cleanup_targets target
          ON target.world_id=work_order.world_id AND target.id=work_order.target_id
        WHERE work_order.world_id=$1 AND (work_order.status='open'
          OR (work_order.status='accepted' AND work_order.accepted_agent_id=$2))
        ORDER BY work_order.deadline_world_minute LIMIT 12`, [worldId, agentId]),
      () => client.query(`SELECT account.account_type,account.account_key,
          (account.opening_balance_raw+COALESCE(sum(posting.amount_raw),0))::text AS balance_raw
        FROM arc_sync_ledger_accounts account LEFT JOIN arc_sync_ledger_postings posting
          ON posting.world_id=account.world_id AND posting.account_id=account.id
        WHERE account.world_id=$1 AND (account.agent_id=$2 OR account.account_type='operating_pool')
        GROUP BY account.id,account.account_type,account.account_key,account.opening_balance_raw`, [worldId, agentId]),
      () => client.query(`SELECT id,cognition_sequence,intent_key,capability_key,status,request,result,created_world_minute,updated_world_minute
        FROM world_agent_cognition_tool_attempts WHERE world_id=$1 AND agent_id=$2
          AND (cognition_sequence>COALESCE((SELECT last_context_tool_sequence FROM world_agent_cognition_state
            WHERE world_id=$1 AND agent_id=$2),0) OR status IN ('requested','running'))
        ORDER BY cognition_sequence`, [worldId, agentId]),
      () => listResearchInputsByWorld(client, { worldId }),
      () => client.query(`WITH last_seen AS (
          SELECT COALESCE((SELECT last_context_event_id FROM world_agent_cognition_state
            WHERE world_id=$1 AND agent_id=$2),0)::bigint AS id
        ), scanned AS (
          SELECT COALESCE(max(event.id),(SELECT id FROM last_seen)) AS scan_cursor
          FROM world_events event WHERE event.world_id=$1 AND event.actor_id=$2
            AND event.id>(SELECT id FROM last_seen)
        ), relevant AS (
          SELECT event.id,event.event_type,event.data,event.action_id,event.created_at
          FROM world_events event WHERE event.world_id=$1 AND event.actor_id=$2
            AND event.id>(SELECT id FROM last_seen)
            AND event.event_type NOT IN ('world.action_started','world.movement_started')
            AND NOT (event.event_type='world.action_completed'
              AND event.data->>'action' IN ('eat','rest','move'))
        ), picked AS (
          SELECT relevant.*,count(*) OVER() AS relevant_count
          FROM relevant ORDER BY id LIMIT 100
        )
        SELECT picked.*,scanned.scan_cursor FROM scanned LEFT JOIN picked ON true
        ORDER BY picked.id NULLS LAST`, [worldId, agentId]),
      () => client.query(`SELECT member.agent_id,agent.name,member.location,
          COALESCE((SELECT jsonb_object_agg(skill.skill_name,skill.skill_value)
            FROM world_agent_skills skill WHERE skill.world_id=member.world_id
              AND skill.agent_id=member.agent_id),'{}'::jsonb) AS skills
        FROM world_members member JOIN agents agent ON agent.id=member.agent_id
        WHERE member.world_id=$1 AND member.agent_id<>$2 ORDER BY member.joined_at LIMIT 9`,
      [worldId, agentId]),
      () => client.query(`SELECT DISTINCT ON (gap.id) gap.id,gap.category,
          gap.problem_statement AS "problemStatement",gap.status,gap.evidence,
          gap.observation_count AS "observationCount",
          gap.first_observed_world_minute AS "firstObservedWorldMinute",
          observation.observed_world_minute AS "observedWorldMinute"
        FROM world_capability_observations observation JOIN world_capability_gaps gap
          ON gap.world_id=observation.world_id AND gap.id=observation.gap_id
        WHERE observation.world_id=$1 AND observation.agent_id=$2 AND gap.status IN ('open','addressed')
        ORDER BY gap.id,observation.observed_world_minute DESC LIMIT 16`, [worldId, agentId]),
      () => client.query(`SELECT proposal.id,proposal.gap_id AS "gapId",
          proposal.creator_agent_id AS "creatorAgentId",proposal.name,proposal.category,
          proposal.problem_statement AS "problemStatement",
          proposal.proposed_capability AS specification,
          proposal.expected_benefit AS "expectedBenefit",proposal.expected_cost AS "expectedCost",
          proposal.support_count AS "supportCount",proposal.opposition_count AS "oppositionCount",
          proposal.expires_world_minute AS "expiresWorldMinute"
        FROM world_capability_proposals proposal
        WHERE proposal.world_id=$1 AND proposal.status IN ('proposed','reviewed')
          AND proposal.creator_agent_id<>$2
          AND NOT EXISTS (SELECT 1 FROM world_capability_reviews review
            WHERE review.world_id=proposal.world_id AND review.proposal_id=proposal.id
              AND review.reviewer_agent_id=$2 AND review.review_stage='proposal')
        ORDER BY proposal.created_world_minute,proposal.id LIMIT 12`, [worldId, agentId]),
      () => client.query(`SELECT use.id AS "useId",use.experiment_id AS "experimentId",
          experiment.proposal_id AS "proposalId",use.status,use.success,use.costs,use.effects,use.result
        FROM world_capability_uses use JOIN world_capability_experiments experiment
          ON experiment.world_id=use.world_id AND experiment.id=use.experiment_id
        WHERE use.world_id=$1 AND experiment.status='running'
          AND experiment.participant_agent_ids ? ($2::uuid)::text
          AND (use.actor_agent_id=$2 OR use.partner_agent_id=$2)
          AND NOT EXISTS (SELECT 1 FROM world_capability_reviews review
            WHERE review.world_id=use.world_id AND review.experiment_id=use.experiment_id
              AND review.reviewer_agent_id=$2 AND review.evidence->>'useId'=use.id::text)
        ORDER BY use.world_minute DESC,use.id DESC LIMIT 8`, [worldId, agentId])
    ]);
    if (!clock.rowCount || !resident.rowCount) throw Object.assign(new Error('COGNITION_RESIDENT_MISSING'),
      { code: 'COGNITION_RESIDENT_MISSING' });
    const state = cognition.rows[0] || null;
    const targetState = await readBoundTargetState(client, worldId, agentId, state,
      Number(clock.rows[0].world_minutes));
    const researchCapability = capabilities.rows.find((row) => row.specification?.systemKey === RESEARCH_CAPABILITY_KEY);
    const allResearch = (researchInputs.researchOpportunitiesByAgent.get(agentId) || [])
      .map((row) => ({ candidateId: researchCapability
        ? `research:${researchCapability.id}:${row.id}:${row.relationType}:${row.relationId}` : null,
        capabilityId: researchCapability?.id || null, artifactId: row.id,
        artifactName: row.displayName, targetType: row.targetType,
        relationType: row.relationType, relationId: row.relationId, relationLabel: row.label,
        relevanceDescription: row.relevanceDescription }));
    const availableResearch = retrieveResearchOpportunities(allResearch, state);
    const completeGraph = buildCapabilityGraph({ worldCapabilities: capabilities.rows, skills: skills.rows,
      reaAvailable: allResearch.some((row) => row.candidateId) });
    const graph = retrieveCapabilityGraph(completeGraph, state);
    const memoryCandidates = [
      ...memories.rows.map((row) => ({ id: `legacy:${row.id}`, type: row.memory_type,
        summary: row.summary, worldMinute: Number(row.world_minutes), importance: Number(row.importance) })),
      ...newMemories.rows.map((row) => ({ id: `cognition:${row.id}`, type: row.memory_type,
        summary: row.summary, worldMinute: Number(row.created_world_minute), evidence: row.evidence }))
    ];
    const deltaRows = recentEvents.rows.filter((row) => row.id != null);
    const deltaEvents = deltaRows.map((row) => ({ id: Number(row.id), type: row.event_type,
      actionId: row.action_id, at: row.created_at,
      dataExcerpt: JSON.stringify(row.data || {}).slice(0, 600) }));
    const relevantCount = Number(deltaRows[0]?.relevant_count || 0);
    const deltaHasMore = relevantCount > deltaRows.length;
    const deltaCursor = deltaHasMore ? deltaEvents.at(-1).id
      : Number(recentEvents.rows[0]?.scan_cursor || stateCursor(state));
    const pendingToolSequences = toolAttempts.rows.filter((row) => ['requested','running'].includes(row.status))
      .map((row) => Number(row.cognition_sequence));
    const toolAttemptCursor = pendingToolSequences.length
      ? Math.min(toolSequenceCursor(state), Math.min(...pendingToolSequences) - 1)
      : toolAttempts.rows.length ? Number(toolAttempts.rows.at(-1).cognition_sequence) : toolSequenceCursor(state);
    const context = compactJson({ world: { id: worldId, minute: Number(clock.rows[0].world_minutes),
      tick: Number(clock.rows[0].tick_count), environment: clock.rows[0].environment,
      delta: { eventIds: deltaEvents.map((event) => event.id), eventCount: deltaEvents.length, cursor: deltaCursor,
        hasMore: deltaHasMore,
        toolAttemptIds: toolAttempts.rows.map((row) => String(row.id)), toolCursor: toolAttemptCursor } },
    resident: { id: agentId, ...resident.rows[0] }, prior: promptPrior(state),
    targetState,
    availableAffordances: { worldMinute: state?.affordances_world_minute ?? null,
      candidates: Array.isArray(state?.available_affordances) ? state.available_affordances : [],
      authority: 'advisory_snapshot_world_revalidates_on_execution' },
    existingWorldGoals: oldGoals.rows, relationships: relationships.rows,
    peers: peers.rows, projects: projects.rows,
    recentEvents: deltaEvents,
    research: research.rows, researchOpportunities: availableResearch,
    toolResults: toolAttempts.rows.map((row) => {
      const value = JSON.stringify(row.result);
      return { ...row, result: value.length > 5_000
        ? { excerpt: value.slice(0, 5_000), truncated: true } : row.result };
    }), workOrders: workOrders.rows, syncBalances: balances.rows,
    capabilities: graph, capabilityGaps: capabilityGaps.rows,
    capabilityProposals: capabilityProposals.rows, capabilityExperiences: capabilityExperiences.rows });
    await client.query('COMMIT');
    return { context, state, memoryCandidates };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function stateCursor(state) {
  const value = Number(state?.last_context_event_id || 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function toolSequenceCursor(state) {
  const value = Number(state?.last_context_tool_sequence || 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
