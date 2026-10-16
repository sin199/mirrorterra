import { CAPABILITY_GAP_MIN_AGE_MINUTES, CAPABILITY_GAP_MIN_OBSERVATIONS } from './world-capabilities.js';
import { capabilityGraphDepth } from './world-v7.js';

export const PUBLIC_HISTORY_DEFAULT_LIMIT = 20;
export const PUBLIC_HISTORY_MAX_LIMIT = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function historyInputError(code) {
  const error = new Error(code);
  error.statusCode = 400;
  error.code = code;
  return error;
}

export function parsePublicHistoryPage(query = {}, kind) {
  if (!['proposals', 'gaps'].includes(kind)) throw new TypeError('PUBLIC_HISTORY_KIND_INVALID');
  let limit = PUBLIC_HISTORY_DEFAULT_LIMIT;
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'string' || !/^\d+$/.test(query.limit)) throw historyInputError('PUBLIC_HISTORY_LIMIT_INVALID');
    limit = Number(query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PUBLIC_HISTORY_MAX_LIMIT) {
      throw historyInputError('PUBLIC_HISTORY_LIMIT_OUT_OF_RANGE');
    }
  }
  let cursor = null;
  if (query.cursor !== undefined) {
    if (typeof query.cursor !== 'string' || query.cursor.length > 512) throw historyInputError('PUBLIC_HISTORY_CURSOR_INVALID');
    try {
      const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      const minute = Number(decoded.minute);
      if (decoded.version !== 1 || decoded.kind !== kind || !Number.isSafeInteger(minute) || minute < 0
          || typeof decoded.id !== 'string' || !UUID_RE.test(decoded.id)) throw new Error('invalid cursor');
      cursor = { minute, id: decoded.id };
    } catch {
      throw historyInputError('PUBLIC_HISTORY_CURSOR_INVALID');
    }
  }
  return { limit, cursor };
}

function encodeCursor(kind, minute, id) {
  return Buffer.from(JSON.stringify({ version: 1, kind, minute: Number(minute), id })).toString('base64url');
}

function jsonValue(value, fallback = {}) {
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value && typeof value === 'object' ? value : fallback;
}

function maturityForGap(gap, worldMinute) {
  const blockers = [];
  const observations = Number(gap.observationCount) || 0;
  const age = Math.max(0, worldMinute - Number(gap.firstObservedWorldMinute));
  if (gap.status === 'stale') blockers.push('gap_status_stale');
  if (observations < CAPABILITY_GAP_MIN_OBSERVATIONS) blockers.push('needs_repeated_observation');
  if (age < CAPABILITY_GAP_MIN_AGE_MINUTES) blockers.push('minimum_world_age_not_reached');
  return { mature: blockers.length === 0, ageWorldMinutes: age, blockers };
}

const PUBLIC_GAP_PAGE_SQL = `
  WITH page AS (
    SELECT gap.id,gap.gap_key AS "gapKey",gap.category,gap.problem_statement AS "problemStatement",gap.status,
      gap.observation_count AS "observationCount",gap.first_observed_world_minute AS "firstObservedWorldMinute",
      gap.last_observed_world_minute AS "latestObservedWorldMinute"
    FROM world_capability_gaps gap
    WHERE gap.world_id=$1
      AND ($2::bigint IS NULL OR (gap.last_observed_world_minute,gap.id)<($2::bigint,$3::uuid))
    ORDER BY gap.last_observed_world_minute DESC,gap.id DESC
    LIMIT $4
  )
  SELECT page.*,
    awareness."awareResidentCount",awareness."awareOrganizationCount",awareness."awarenessSources",
    funnel."decisionEventCount",funnel."candidateCycles",funnel."residentIgnoreEvents",
    funnel."organizationRetainEvents",funnel."selectedCandidate",
    proposal_count."proposalCount"
  FROM page
  CROSS JOIN LATERAL (
    SELECT count(DISTINCT observation.agent_id)::int AS "awareResidentCount",
      count(DISTINCT organization.id)::int AS "awareOrganizationCount",
      COALESCE(array_agg(DISTINCT observation.observation_path)
        FILTER (WHERE observation.observation_path IS NOT NULL),ARRAY[]::text[]) AS "awarenessSources"
    FROM world_capability_observations observation
    LEFT JOIN world_organization_members membership ON membership.world_id=observation.world_id
      AND membership.agent_id=observation.agent_id AND membership.status='active'
    LEFT JOIN world_organizations organization ON organization.world_id=membership.world_id
      AND organization.id=membership.organization_id AND organization.status='active'
    WHERE observation.world_id=$1 AND observation.gap_id=page.id
  ) awareness
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS "decisionEventCount",
      count(*) FILTER (WHERE event.event_type='capability_innovation_considered'
        AND CASE WHEN event.details->>'optionCount' ~ '^[0-9]+$'
          THEN (event.details->>'optionCount')::int>1 ELSE false END
        OR event.event_type='organization_capability_innovation_considered')::int AS "candidateCycles",
      count(*) FILTER (WHERE event.event_type='capability_innovation_considered'
        AND event.details->>'selectedOption'='ignore')::int AS "residentIgnoreEvents",
      count(*) FILTER (WHERE event.event_type='organization_capability_innovation_considered'
        AND event.details->>'decision'='retain_current_approach')::int AS "organizationRetainEvents",
      COALESCE(bool_or(event.details->>'selectedOption' IS NOT NULL
        AND event.details->>'selectedOption'<>'ignore'),false) AS "selectedCandidate"
    FROM world_capability_events event
    WHERE event.world_id=$1 AND event.gap_id=page.id
      AND event.event_type IN ('capability_innovation_considered','organization_capability_innovation_considered')
  ) funnel
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS "proposalCount"
    FROM world_capability_proposals proposal WHERE proposal.world_id=$1 AND proposal.gap_id=page.id
  ) proposal_count
  ORDER BY page."latestObservedWorldMinute" DESC,page.id DESC`;

const PUBLIC_PROPOSAL_PAGE_SQL = `
  WITH page AS (
    SELECT proposal.id,proposal.name,proposal.category,
      proposal.problem_statement AS "problemStatement",proposal.expected_benefit AS "expectedBenefit",
      proposal.status,proposal.revision,proposal.support_count AS "supportCount",
      proposal.opposition_count AS "oppositionCount",proposal.created_world_minute AS "createdWorldMinute",
      proposal.updated_world_minute AS "updatedWorldMinute",proposal.creator_agent_id,proposal.creator_organization_id
    FROM world_capability_proposals proposal
    WHERE proposal.world_id=$1
      AND ($2::bigint IS NULL OR (proposal.created_world_minute,proposal.id)<($2::bigint,$3::uuid))
    ORDER BY proposal.created_world_minute DESC,proposal.id DESC
    LIMIT $4
  )
  SELECT page.id,page.name,page.category,page."problemStatement",page."expectedBenefit",page.status,page.revision,
    page."supportCount",page."oppositionCount",page."createdWorldMinute",page."updatedWorldMinute",
    creator.name AS "creatorName",organization.name AS "creatorOrganizationName",
    count(review.id)::int AS "reviewCount",
    count(review.id) FILTER (WHERE review.reviewer_organization_id IS NOT NULL)::int AS "organizationReviewCount",
    max(review.created_world_minute) AS "latestReviewWorldMinute"
  FROM page
  LEFT JOIN agents creator ON creator.id=page.creator_agent_id
  LEFT JOIN world_organizations organization ON organization.id=page.creator_organization_id
  LEFT JOIN world_capability_reviews review ON review.world_id=$1 AND review.proposal_id=page.id
  GROUP BY page.id,page.name,page.category,page."problemStatement",page."expectedBenefit",page.status,page.revision,
    page."supportCount",page."oppositionCount",page."createdWorldMinute",page."updatedWorldMinute",
    creator.name,organization.name
  ORDER BY page."createdWorldMinute" DESC,page.id DESC`;

function publicGapRow(row, worldMinute) {
  const maturity = maturityForGap(row, worldMinute);
  const blockers = [...maturity.blockers];
  if (maturity.mature && Number(row.awareResidentCount) === 0) blockers.push('no_resident_awareness_recorded');
  if (maturity.mature && Number(row.decisionEventCount) === 0) blockers.push('no_decision_event_recorded');
  if (row.selectedCandidate && Number(row.proposalCount) === 0) blockers.push('selected_candidate_without_proposal');
  return {
    id: row.id,
    gapKey: row.gapKey,
    category: row.category,
    problemStatement: row.problemStatement,
    status: row.status,
    observationCount: Number(row.observationCount),
    firstObservedWorldMinute: Number(row.firstObservedWorldMinute),
    latestObservedWorldMinute: Number(row.latestObservedWorldMinute),
    awareResidentCount: Number(row.awareResidentCount),
    awareOrganizationCount: Number(row.awareOrganizationCount),
    awarenessSources: row.awarenessSources || [],
    mature: maturity.mature,
    ageWorldMinutes: maturity.ageWorldMinutes,
    maturityBlockers: maturity.blockers,
    decisionEventCount: Number(row.decisionEventCount),
    candidateCycles: Number(row.candidateCycles),
    residentIgnoreEvents: Number(row.residentIgnoreEvents),
    organizationRetainEvents: Number(row.organizationRetainEvents),
    validNoAction: Number(row.residentIgnoreEvents) + Number(row.organizationRetainEvents),
    proposalCount: Number(row.proposalCount),
    blockers: [...new Set(blockers)]
  };
}

function publicProposalRow(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    problemStatement: row.problemStatement,
    expectedBenefit: row.expectedBenefit,
    status: row.status,
    revision: Number(row.revision),
    supportCount: Number(row.supportCount),
    oppositionCount: Number(row.oppositionCount),
    createdWorldMinute: Number(row.createdWorldMinute),
    updatedWorldMinute: Number(row.updatedWorldMinute),
    creatorName: row.creatorName || null,
    creatorOrganizationName: row.creatorOrganizationName || null,
    reviewCount: Number(row.reviewCount),
    organizationReviewCount: Number(row.organizationReviewCount),
    latestReviewWorldMinute: row.latestReviewWorldMinute === null ? null : Number(row.latestReviewWorldMinute)
  };
}

async function fetchGapRows(client, { worldId, limit, cursor = null }) {
  const result = await client.query(PUBLIC_GAP_PAGE_SQL,
    [worldId, cursor?.minute ?? null, cursor?.id ?? null, limit + 1]);
  return result.rows;
}

async function fetchProposalRows(client, { worldId, limit, cursor = null }) {
  const result = await client.query(PUBLIC_PROPOSAL_PAGE_SQL,
    [worldId, cursor?.minute ?? null, cursor?.id ?? null, limit + 1]);
  return result.rows;
}

export async function readPublicCapabilityGapPage(client, { worldId, limit, cursor = null, worldMinute = null }) {
  let effectiveWorldMinute = worldMinute;
  if (effectiveWorldMinute === null || effectiveWorldMinute === undefined) {
    const clock = await client.query('SELECT world_minutes AS "worldMinute" FROM world_runtime_state WHERE world_id=$1', [worldId]);
    effectiveWorldMinute = clock.rows[0]?.worldMinute ?? 0;
  }
  const rows = await fetchGapRows(client, { worldId, limit, cursor });
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => publicGapRow(row, Number(effectiveWorldMinute) || 0));
  const last = rows[limit - 1];
  const minute = last?.latestObservedWorldMinute;
  return { items, nextCursor: hasMore && last ? encodeCursor('gaps', minute, last.id) : null };
}

export async function readPublicCapabilityProposalPage(client, { worldId, limit, cursor = null }) {
  const rows = await fetchProposalRows(client, { worldId, limit, cursor });
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(publicProposalRow);
  const last = rows[limit - 1];
  return { items, nextCursor: hasMore && last
    ? encodeCursor('proposals', last.createdWorldMinute, last.id) : null };
}

export async function readPublicWorldV6Lifecycle(client, { worldId, worldMinute: requestedWorldMinute = null }) {
  const [schemaResult, clockResult] = await Promise.all([
    client.query(`SELECT to_regclass('world_capability_dependencies') IS NOT NULL AS dependencies,
        to_regclass('world_agent_concepts') IS NOT NULL AS v7`),
    client.query(`SELECT runtime.world_minutes AS "worldMinute",
        (SELECT jsonb_agg(jsonb_build_object('code',epoch_code,'name',name,'status',status,
          'startedWorldMinute',started_world_minute) ORDER BY started_world_minute,id)
         FROM world_epochs WHERE world_id=$1 AND epoch_code IN ('V6','V7')) AS epochs
      FROM world_runtime_state runtime WHERE runtime.world_id=$1`, [worldId])
  ]);
  const schema = schemaResult.rows[0] || {};
  const worldMinute = Math.max(0, Math.trunc(Number(requestedWorldMinute ?? clockResult.rows[0]?.worldMinute) || 0));
  const dependencyIntegrityCount = schema.dependencies
    ? `+ (SELECT count(*)::int FROM world_capability_dependencies dependency
        LEFT JOIN world_capabilities child ON child.world_id=dependency.world_id AND child.id=dependency.capability_id
        LEFT JOIN world_capabilities parent ON parent.world_id=dependency.world_id AND parent.id=dependency.depends_on_capability_id
        WHERE dependency.world_id=$1 AND (child.id IS NULL OR parent.id IS NULL))`
    : '';
  const [countsResult, reviewsResult, v7Result, capabilityResult,
    dependencyResult, integrityResult, recentGapRows, recentProposalRows] = await Promise.all([
    client.query(`WITH gap_counts AS (
        SELECT count(*)::int AS gaps,
          count(*) FILTER (WHERE status='stale')::int AS "staleGaps",
          count(*) FILTER (WHERE status<>'stale' AND observation_count >= ${CAPABILITY_GAP_MIN_OBSERVATIONS}
            AND GREATEST(0,$2::bigint-first_observed_world_minute) >= ${CAPABILITY_GAP_MIN_AGE_MINUTES})::int AS "matureGaps",
          count(*) FILTER (WHERE status<>'stale' AND NOT (observation_count >= ${CAPABILITY_GAP_MIN_OBSERVATIONS}
            AND GREATEST(0,$2::bigint-first_observed_world_minute) >= ${CAPABILITY_GAP_MIN_AGE_MINUTES}))::int AS "immatureGaps",
          COALESCE(sum(observation_count),0)::int AS "observationCount"
        FROM world_capability_gaps WHERE world_id=$1
      ), proposal_counts AS (
        SELECT count(*)::int AS proposals,
          count(*) FILTER (WHERE proposal.status IN ('reviewed','revised') AND NOT EXISTS (
            SELECT 1 FROM world_capability_experiments experiment
            WHERE experiment.world_id=proposal.world_id AND experiment.proposal_id=proposal.id))::int AS "proposedAwaitingExperiment"
        FROM world_capability_proposals proposal WHERE proposal.world_id=$1
      ), event_counts AS (
        SELECT (count(*) FILTER (WHERE event_type='capability_innovation_considered'
            AND CASE WHEN details->>'optionCount' ~ '^[0-9]+$'
              THEN (details->>'optionCount')::int>1 ELSE false END)
          + count(*) FILTER (WHERE event_type='organization_capability_innovation_considered'))::int AS "candidateCycles",
          (count(*) FILTER (WHERE event_type='capability_innovation_considered'
            AND details->>'selectedOption'='ignore')
          + count(*) FILTER (WHERE event_type='organization_capability_innovation_considered'
            AND details->>'decision'='retain_current_approach'))::int AS "validNoAction"
        FROM world_capability_events WHERE world_id=$1 AND gap_id IS NOT NULL
      ), experiment_counts AS (
        SELECT count(*)::int AS experiments,
          count(*) FILTER (WHERE status='running')::int AS "runningExperiments",
          count(*) FILTER (WHERE status IN ('evaluated','adopted','revised','rejected','abandoned'))::int AS "completedExperiments",
          count(*) FILTER (WHERE status IN ('rejected','abandoned'))::int AS "failedExperiments",
          count(*) FILTER (WHERE evaluated_world_minute IS NOT NULL)::int AS "evaluatedExperiments"
        FROM world_capability_experiments WHERE world_id=$1
      ), capability_counts AS (
        SELECT count(*) FILTER (WHERE status='active' AND adopted_world_minute IS NOT NULL)::int AS "adoptedCapabilities"
        FROM world_capabilities WHERE world_id=$1
      ), experiment_participants AS (
        SELECT DISTINCT experiment.id AS "experimentId",participant.value AS "agentId"
        FROM world_capability_experiments experiment,
          LATERAL jsonb_array_elements_text(experiment.participant_agent_ids) participant
        WHERE experiment.world_id=$1
      ), usage_counts AS (
        SELECT count(*)::int AS "capabilityUses",
          count(*) FILTER (WHERE usage.success)::int AS "capabilityUseSuccesses",
          count(*) FILTER (WHERE NOT usage.success)::int AS "capabilityUseFailures",
          count(*) FILTER (WHERE usage.experiment_id IS NOT NULL)::int AS "experimentUses",
          count(*) FILTER (WHERE usage.experiment_id IS NOT NULL AND NOT usage.success)::int AS "experimentFailures",
          count(*) FILTER (WHERE usage.experiment_id IS NOT NULL AND participant."experimentId" IS NOT NULL)::int AS "experimentParticipantUses",
          count(*) FILTER (WHERE usage.experiment_id IS NOT NULL AND participant."experimentId" IS NULL)::int AS "experimentNonParticipantUses",
          count(*) FILTER (WHERE capability.adopted_world_minute IS NOT NULL
            AND usage.world_minute>=capability.adopted_world_minute)::int AS "postAdoptionUses",
          count(*) FILTER (WHERE capability.adopted_world_minute IS NOT NULL
            AND usage.world_minute>=capability.adopted_world_minute AND usage.success)::int AS "postAdoptionSuccesses",
          count(*) FILTER (WHERE capability.adopted_world_minute IS NOT NULL
            AND usage.world_minute>=capability.adopted_world_minute AND NOT usage.success)::int AS "postAdoptionFailures"
        FROM world_capability_uses usage
        LEFT JOIN experiment_participants participant ON participant."experimentId"=usage.experiment_id
          AND participant."agentId"=usage.actor_agent_id::text
        LEFT JOIN world_capabilities capability ON capability.world_id=usage.world_id AND capability.id=usage.capability_id
        WHERE usage.world_id=$1
      )
      SELECT gap_counts.*,proposal_counts.proposals,event_counts."candidateCycles",event_counts."validNoAction",
        experiment_counts.experiments,capability_counts."adoptedCapabilities",usage_counts.*,
        experiment_counts."runningExperiments",experiment_counts."completedExperiments",
        experiment_counts."failedExperiments",experiment_counts."evaluatedExperiments",
        proposal_counts."proposedAwaitingExperiment"
      FROM gap_counts CROSS JOIN proposal_counts CROSS JOIN event_counts CROSS JOIN experiment_counts
        CROSS JOIN capability_counts CROSS JOIN usage_counts`,
    [worldId, worldMinute]),
    client.query(`SELECT review.review_stage AS stage,review.decision,
        (review.reviewer_organization_id IS NOT NULL)::boolean AS "organizationResponse",count(*)::int AS count
      FROM world_capability_reviews review WHERE review.world_id=$1
      GROUP BY review.review_stage,review.decision,(review.reviewer_organization_id IS NOT NULL)`, [worldId]),
    schema.v7 ? client.query(`SELECT
        (SELECT count(*)::int FROM world_agent_concepts WHERE world_id=$1) AS concepts,
        (SELECT count(*)::int FROM world_agent_goals WHERE world_id=$1 AND source='self_generated'
          AND metadata ? 'goalGrammar') AS "selfGeneratedGoals",
        (SELECT count(*)::int FROM world_agent_policy_experiments WHERE world_id=$1) AS "policyExperiments",
        (SELECT count(*)::int FROM world_extension_requests WHERE world_id=$1) AS "extensionRequests",
        (SELECT count(*)::int FROM world_v7_events WHERE world_id=$1 AND entity_type='capability') AS "v7CapabilityEvents"`, [worldId])
      : Promise.resolve({ rows: [{ concepts: 0, selfGeneratedGoals: 0,
        policyExperiments: 0, extensionRequests: 0, v7CapabilityEvents: 0 }] }),
    client.query(`SELECT id,name,creator_type AS "creatorType",created_world_minute AS "createdWorldMinute",
        adopted_world_minute AS "adoptedWorldMinute",status,parent_capability_id AS "parentCapabilityId"
      FROM world_capabilities WHERE world_id=$1`, [worldId]),
    client.query(`SELECT dependency.capability_id AS "capabilityId",
        dependency.depends_on_capability_id AS "dependsOnCapabilityId",
        child.name AS "capabilityName",parent.name AS "dependencyName"
      FROM world_capability_dependencies dependency
      LEFT JOIN world_capabilities child ON child.world_id=dependency.world_id AND child.id=dependency.capability_id
      LEFT JOIN world_capabilities parent ON parent.world_id=dependency.world_id AND parent.id=dependency.depends_on_capability_id
      WHERE dependency.world_id=$1`, [worldId])
      .catch((error) => {
        if (error.code === '42P01') return { rows: [] };
        throw error;
      }),
    client.query(`WITH gap_findings AS (
        SELECT gap.id,
          (gap.status<>'stale' AND gap.observation_count >= ${CAPABILITY_GAP_MIN_OBSERVATIONS}
            AND GREATEST(0,$2::bigint-gap.first_observed_world_minute) >= ${CAPABILITY_GAP_MIN_AGE_MINUTES}) AS mature,
          (SELECT count(DISTINCT observation.agent_id)::int FROM world_capability_observations observation
            LEFT JOIN world_organization_members membership ON membership.world_id=observation.world_id
              AND membership.agent_id=observation.agent_id AND membership.status='active'
            LEFT JOIN world_organizations organization ON organization.world_id=membership.world_id
              AND organization.id=membership.organization_id AND organization.status='active'
            WHERE observation.world_id=gap.world_id AND observation.gap_id=gap.id) AS aware_residents,
          (SELECT count(*)::int FROM world_capability_events event WHERE event.world_id=gap.world_id
            AND event.gap_id=gap.id AND event.event_type IN ('capability_innovation_considered',
              'organization_capability_innovation_considered')) AS decision_events,
          EXISTS (SELECT 1 FROM world_capability_events event WHERE event.world_id=gap.world_id
            AND event.gap_id=gap.id AND event.event_type IN ('capability_innovation_considered',
              'organization_capability_innovation_considered')
            AND event.details->>'selectedOption' IS NOT NULL AND event.details->>'selectedOption'<>'ignore') AS selected_candidate,
          EXISTS (SELECT 1 FROM world_capability_proposals proposal WHERE proposal.world_id=gap.world_id
            AND proposal.gap_id=gap.id) AS has_proposal
        FROM world_capability_gaps gap WHERE gap.world_id=$1
      )
      SELECT (SELECT COALESCE(sum((mature AND aware_residents=0)::int
          + (mature AND decision_events=0)::int
          + (selected_candidate AND NOT has_proposal)::int),0)::int FROM gap_findings)
        + (SELECT count(*)::int FROM world_capability_proposals WHERE world_id=$1
          AND status IN ('proposed','reviewed') AND expires_world_minute IS NOT NULL AND expires_world_minute<=$2)
        + (SELECT count(*)::int FROM world_capability_experiments WHERE world_id=$1
          AND status='running' AND ends_world_minute<=$2)
        + (SELECT count(*)::int FROM world_capabilities capability WHERE capability.world_id=$1
          AND capability.status='active' AND capability.adopted_world_minute IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM world_capability_uses usage WHERE usage.world_id=capability.world_id
            AND usage.capability_id=capability.id AND usage.world_minute>=capability.adopted_world_minute))
        ${dependencyIntegrityCount}
        + (SELECT count(*)::int FROM (SELECT 1 FROM world_capability_events WHERE world_id=$1
            AND event_type IN ('capability_adopted','capability_rejected','capability_abandoned')
            GROUP BY event_type,proposal_id,experiment_id,capability_id,gap_id HAVING count(*)>1) duplicates) AS count`,
    [worldId, worldMinute]),
    fetchGapRows(client, { worldId, limit: 20 }),
    fetchProposalRows(client, { worldId, limit: 20 })
  ]);

  const counts = countsResult.rows[0] || {};
  const reviews = { proposal: { support: 0, oppose: 0, ignore: 0, revision: 0, organizationResponses: 0 },
    experiment: { support: 0, oppose: 0, ignore: 0, revision: 0, organizationResponses: 0 } };
  for (const row of reviewsResult.rows) {
    const stage = reviews[row.stage];
    if (!stage) continue;
    const key = row.decision === 'modify' ? 'revision' : row.decision;
    stage[key] += Number(row.count);
    if (row.organizationResponse) stage.organizationResponses += Number(row.count);
  }

  const capabilities = capabilityResult.rows.map((row) => ({ ...row,
    createdWorldMinute: Number(row.createdWorldMinute),
    adoptedWorldMinute: row.adoptedWorldMinute === null ? null : Number(row.adoptedWorldMinute) }));
  const validDependencies = dependencyResult.rows.filter((row) => row.capabilityName && row.dependencyName);
  const edges = validDependencies.map((row) => ({ capabilityId: row.capabilityId,
    dependsOnCapabilityId: row.dependsOnCapabilityId }));
  for (const capability of capabilities) {
    if (capability.parentCapabilityId && !edges.some((edge) => edge.capabilityId === capability.id
        && edge.dependsOnCapabilityId === capability.parentCapabilityId)) {
      edges.push({ capabilityId: capability.id, dependsOnCapabilityId: capability.parentCapabilityId });
    }
  }
  const genealogy = capabilityGraphDepth(capabilities, edges);
  const epochs = jsonValue(clockResult.rows[0]?.epochs, []);
  const v7Start = epochs.find((epoch) => epoch.code === 'V7')?.startedWorldMinute;
  const v7Counts = v7Result.rows[0] || {};
  const recentGaps = recentGapRows.slice(0, 20).map((row) => publicGapRow(row, worldMinute));
  const recentProposalFunnel = recentGaps.map((gap) => ({
    gapId: gap.id,
    mature: gap.mature,
    candidateCycles: gap.candidateCycles,
    decisionEventCount: gap.decisionEventCount,
    proposalCount: gap.proposalCount,
    validNoAction: gap.validNoAction,
    residentIgnoreEvents: gap.residentIgnoreEvents,
    organizationRetainEvents: gap.organizationRetainEvents,
    blockers: gap.blockers
  }));
  const integrityFindingCount = Number(integrityResult.rows[0]?.count || 0)
    + genealogy.filter((item) => item.cyclic).length;
  const experimentLifecycleCounts = {
    proposed: Number(counts.proposedAwaitingExperiment || 0),
    running: Number(counts.runningExperiments || 0),
    completed: Number(counts.completedExperiments || 0),
    failed: Number(counts.failedExperiments || 0),
    evaluated: Number(counts.evaluatedExperiments || 0),
    failedUses: Number(counts.experimentFailures || 0),
    semantics: { proposed: 'reviewed_or_revised_proposals_without_experiment',
      failed: 'rejected_or_abandoned_experiment_outcomes', evaluated: 'evaluated_world_minute_is_set' }
  };

  return {
    worldId,
    worldMinute,
    schema: { v7TablesPresent: Boolean(schemaResult.rows[0]?.v7),
      dependencyTablePresent: Boolean(schemaResult.rows[0]?.dependencies) },
    epochs,
    counts: Object.fromEntries(['gaps','staleGaps','matureGaps','immatureGaps','observationCount','proposals',
      'candidateCycles','validNoAction','experiments','adoptedCapabilities','capabilityUses','capabilityUseSuccesses',
      'capabilityUseFailures'].map((key) => [key, Number(counts[key] || 0)])),
    recentProposals: recentProposalRows.slice(0, 20).map(publicProposalRow),
    recentGaps,
    proposalFunnel: recentProposalFunnel,
    reviews,
    experiments: { counts: { running: experimentLifecycleCounts.running }, lifecycleCounts: experimentLifecycleCounts },
    usage: {
      total: Number(counts.capabilityUses || 0),
      successes: Number(counts.capabilityUseSuccesses || 0),
      failures: Number(counts.capabilityUseFailures || 0),
      experimentUses: Number(counts.experimentUses || 0),
      experimentParticipantUses: Number(counts.experimentParticipantUses || 0),
      experimentNonParticipantUses: Number(counts.experimentNonParticipantUses || 0),
      postAdoptionUses: Number(counts.postAdoptionUses || 0),
      postAdoptionSuccesses: Number(counts.postAdoptionSuccesses || 0),
      postAdoptionFailures: Number(counts.postAdoptionFailures || 0)
    },
    genealogy: {
      maximumDepth: Math.max(0, ...genealogy.map((item) => item.depth)),
      secondOrderCapabilities: genealogy.filter((item) => item.depth >= 2 && item.creatorType !== 'system').length,
      v7SecondOrderCapabilities: genealogy.filter((item) => item.depth >= 2 && item.creatorType !== 'system'
        && v7Start !== undefined && capabilities.find((capability) => capability.id === item.id)?.createdWorldMinute >= Number(v7Start)).length
    },
    integrity: { findingCount: integrityFindingCount, findings: [] },
    v7: { concepts: Number(v7Counts.concepts) || 0,
      selfGeneratedGoals: Number(v7Counts.selfGeneratedGoals) || 0,
      policyExperiments: Number(v7Counts.policyExperiments) || 0,
      extensionRequests: Number(v7Counts.extensionRequests) || 0,
      capabilityEvents: Number(v7Counts.v7CapabilityEvents) || 0 }
  };
}
