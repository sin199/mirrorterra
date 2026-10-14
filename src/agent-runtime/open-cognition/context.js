import { WORLD_SKILLS } from '../skills.js';
import { listResearchInputsByWorld, RESEARCH_CAPABILITY_KEY } from '../../research/research-jobs.js';

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
  research: ['learn','capability_use','project_contribute'],
  engineering: ['work','project_contribute','capability_use'],
  trading: ['business_market_observe','business_service','business_price'],
  social: ['socialize','cooperate','information_share','organization_invite']
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
  return { revision: Number(state.revision), selfModel: state.self_model,
    goals: [...goals.filter((goal) => ['active','paused'].includes(goal.status)).slice(0, 24),
      ...goals.filter((goal) => !['active','paused'].includes(goal.status)).slice(-6)],
    plans: [...plans.filter((plan) => ['active','blocked','paused'].includes(plan.status)).slice(0, 12),
      ...plans.filter((plan) => !['active','blocked','paused'].includes(plan.status)).slice(-4)]
      .map((plan) => ({ ...plan, totalSteps: plan.steps?.length || 0,
        steps: (plan.steps || []).slice(Math.max(0, (plan.currentStep || 0) - 2),
          (plan.currentStep || 0) + 10),
        stepsStartIndex: Math.max(0, (plan.currentStep || 0) - 2) })),
    beliefs: (state.beliefs || []).slice(-32), values: (state.values_state || []).slice(-24),
    policyExperiments: (state.policy_experiments || []).slice(-16),
    openQuestions: (state.open_questions || []).filter((question) => question.status !== 'abandoned').slice(-24),
    pendingAction: state.pending_action };
}

async function querySequentially(queries) {
  const results = [];
  for (const query of queries) results.push(await query());
  return results;
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
        ORDER BY long_term DESC,importance DESC,world_minutes DESC,id DESC LIMIT 50`, [worldId, agentId]),
      () => client.query(`SELECT id,memory_key,memory_type,summary,evidence,created_world_minute
        FROM world_agent_cognition_memories WHERE world_id=$1 AND agent_id=$2
        ORDER BY created_world_minute DESC,id DESC LIMIT 80`, [worldId, agentId]),
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
        ORDER BY usage_count DESC,name LIMIT 40`, [worldId]),
      () => client.query(`SELECT id,research_question,status,normalized_findings,created_world_minute
        FROM world_research_jobs WHERE world_id=$1 AND actor_agent_id=$2
        ORDER BY created_world_minute DESC LIMIT 12`, [worldId, agentId]),
      () => client.query(`SELECT work_order.id,work_order.opportunity_id,work_order.target_id,
          work_order.status,work_order.raw_sync_reward::text,work_order.deadline_world_minute,
          work_order.acceptance_criteria,target.location AS target_location,
          target.kind AS target_kind,target.status AS target_status
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
      () => client.query(`SELECT intent_key,capability_key,status,request,result,created_world_minute,updated_world_minute
        FROM world_agent_cognition_tool_attempts WHERE world_id=$1 AND agent_id=$2
        ORDER BY created_at DESC LIMIT 6`, [worldId, agentId]),
      () => listResearchInputsByWorld(client, { worldId }),
      () => client.query(`SELECT id,event_type,data,action_id,created_at FROM world_events
        WHERE world_id=$1 AND actor_id=$2 ORDER BY id DESC LIMIT 16`, [worldId, agentId]),
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
    const researchCapability = capabilities.rows.find((row) => row.specification?.systemKey === RESEARCH_CAPABILITY_KEY);
    const availableResearch = (researchInputs.researchOpportunitiesByAgent.get(agentId) || []).slice(0, 20)
      .map((row) => ({ candidateId: researchCapability
        ? `research:${researchCapability.id}:${row.id}:${row.relationType}:${row.relationId}` : null,
        capabilityId: researchCapability?.id || null, artifactId: row.id,
        artifactName: row.displayName, targetType: row.targetType,
        relationType: row.relationType, relationId: row.relationId, relationLabel: row.label,
        relevanceDescription: row.relevanceDescription }));
    const graph = buildCapabilityGraph({ worldCapabilities: capabilities.rows, skills: skills.rows,
      reaAvailable: availableResearch.some((row) => row.candidateId) });
    const memoryCandidates = [
      ...memories.rows.map((row) => ({ id: `legacy:${row.id}`, type: row.memory_type,
        summary: row.summary, worldMinute: Number(row.world_minutes), importance: Number(row.importance) })),
      ...newMemories.rows.map((row) => ({ id: `cognition:${row.id}`, type: row.memory_type,
        summary: row.summary, worldMinute: Number(row.created_world_minute), evidence: row.evidence }))
    ];
    const context = compactJson({ world: { id: worldId, minute: Number(clock.rows[0].world_minutes),
      tick: Number(clock.rows[0].tick_count), environment: clock.rows[0].environment },
    resident: { id: agentId, ...resident.rows[0] }, prior: promptPrior(state),
    availableAffordances: { worldMinute: state?.affordances_world_minute ?? null,
      candidates: Array.isArray(state?.available_affordances) ? state.available_affordances : [],
      authority: 'advisory_snapshot_world_revalidates_on_execution' },
    existingWorldGoals: oldGoals.rows, relationships: relationships.rows,
    peers: peers.rows, projects: projects.rows,
    recentEvents: recentEvents.rows.map((row) => ({ id: row.id, type: row.event_type,
      actionId: row.action_id, at: row.created_at,
      dataExcerpt: JSON.stringify(row.data || {}).slice(0, 1000) })),
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
