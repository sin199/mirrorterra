// Read-only projections over the existing World records. No simulation module imports this file.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set(['all','goals','plans','tools','work','relationships','economy','world']);
const HISTORY = {
  agent_goal_created: ['goals','high'], goal_created: ['goals','high'], goal_completed: ['goals','high'],
  project_proposed: ['plans','medium'], project_started: ['plans','high'], project_completed: ['plans','high'],
  project_failed: ['plans','high'], project_invested: ['economy','medium'], project_revenue: ['economy','high'],
  opportunity_created: ['plans','medium'], organization_founded: ['relationships','high'],
  organization_joined: ['relationships','medium'], organization_left: ['relationships','medium'],
  cooperation_completed: ['relationships','high'], agreement_accepted: ['relationships','high'],
  agreement_completed: ['relationships','high'], agreement_breached: ['relationships','high'],
  agreement_rejected: ['relationships','medium'], norm_formed: ['relationships','high'],
  ownership_transferred: ['economy','high'], business_founded: ['economy','high'],
  business_closed: ['economy','high'], business_first_customer: ['economy','high'],
  business_employment: ['work','high'], business_invested: ['economy','medium'],
  business_reopened: ['economy','high'],
  business_token_wage_accepted: ['economy','medium'], place_created: ['world','high'],
  world_epoch_started: ['world','critical'], milestone: ['world','high'],
  sync_work_order_completed: ['world','high']
};
export const observableHistoryCategory = (type) => HISTORY[type]?.[0]
  || (/^(?:genesis_|arc_|sync_|world_epoch_)/.test(type) ? 'world' : null);
const ACTIONS = new Set(['project_contribute','business_work','business_service','cooperate',
  'capability_use','goal_review','information_share','business_found','project_propose']);
const IMPORTANCE = { low: 0, medium: 1, high: 2, critical: 3 };
const text = (value, max = 240) => typeof value === 'string' ? value.slice(0, max) : '';
const n = (value) => value == null ? null : Number(value);
const stamp = (value) => new Date(value).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
const timestamp = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value)
  && Number.isFinite(Date.parse(value));
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function parseObservabilityPage(query = {}) {
  const limit = query.limit == null ? 20 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw Object.assign(new Error('LIMIT_INVALID'), { statusCode: 400 });
  const category = query.category || 'all';
  if (!CATEGORIES.has(category)) throw Object.assign(new Error('CATEGORY_INVALID'), { statusCode: 400 });
  const period = query.period || 'all';
  if (!['today','7d','all'].includes(period)) throw Object.assign(new Error('PERIOD_INVALID'), { statusCode: 400 });
  let cursor = null;
  if (query.cursor != null) {
    try {
      if (typeof query.cursor !== 'string' || query.cursor.length > 16384) throw new Error();
      const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (typeof decoded.at !== 'string' || !Number.isFinite(Date.parse(decoded.at))
        || !/^(?:h|e|u|t|j|a):[a-zA-Z0-9-]+$/.test(decoded.id)) throw new Error();
      const at = timestamp(decoded.at) ? decoded.at : stamp(decoded.at);
      const until = decoded.until || stamp(new Date());
      const since = decoded.since ?? null;
      if (!timestamp(until) || since !== null && !timestamp(since)) throw new Error();
      // Legacy seen arrays are deliberately discarded. Identity is the persisted source key.
      cursor = { at, id: decoded.id, until, since };
    } catch { throw Object.assign(new Error('CURSOR_INVALID'), { statusCode: 400 }); }
  }
  return { limit, category, period, cursor };
}

export function normalizeObservable(row) {
  const base = { id: `${row.source}:${row.id}`, timestamp: row.sort_at || stamp(row.created_at), agentId: row.agent_id || null,
    agentName: row.agent_name || null, worldMinute: n(row.world_minute), source: row.source,
    sourceId: String(row.id), relatedAgentIds: [], relatedArtifactIds: [], relatedJobIds: [],
    relatedBusinessIds: [], metadata: {} };
  if (row.source === 'h') {
    const classification = HISTORY[row.event_type]
      || (/^(?:genesis_|arc_|sync_|world_epoch_)/.test(row.event_type) ? ['world','high'] : null);
    if (!classification) return null;
    return { ...base, type: row.event_type, category: classification[0], importance: classification[1],
      title: text(row.title, 120), summary: text(row.detail, 400),
      metadata: { entityType: row.entity_type || null, entityId: row.entity_id || null } };
  }
  if (row.source === 'e') {
    const data = row.data || {};
    if (row.event_type === 'world.action_completed') {
      const action = data.action || data.initiativeAction;
      if (!ACTIONS.has(action) || data.abandoned || data.status !== 'completed') return null;
      return { ...base, type: 'world_action_completed', category: action === 'cooperate' ? 'relationships' : 'work',
        importance: 'medium', title: `${text(action, 60).replaceAll('_', ' ')} completed`,
        summary: text(data.initiative?.title || data.work?.output || '', 180),
        metadata: { worldEventId: n(row.id), action, modelCallId: data.cognitionExecution?.modelCallId || null,
          cognitionTurnId: data.cognitionExecution?.cognitionTurnId || null } };
    }
    if (row.event_type === 'world.goal_milestone' || row.event_type === 'world.goal_replanned'
      || row.event_type === 'world.goal_updated') {
      return { ...base, type: row.event_type.replace('world.', ''), category: 'goals',
        importance: row.event_type === 'world.goal_milestone' ? 'medium' : 'high',
        title: text(data.description || data.goalCategory || data.goal || row.event_type.replace('world.', '').replaceAll('_', ' '), 120),
        summary: row.event_type === 'world.goal_milestone' ? `Goal progress ${n(data.progress) ?? 'unavailable'}%` : '',
        metadata: { worldEventId: n(row.id), goalId: data.goalId || null } };
    }
    return null;
  }
  if (row.source === 'u') {
    if (!['completed','failed'].includes(row.status)) return null;
    return { ...base, type: row.success ? 'tool_succeeded' : 'tool_failed', category: 'tools',
      importance: row.success ? 'medium' : 'low', title: `${text(row.capability_name || 'Capability', 90)} ${row.success ? 'used' : 'failed'}`,
      summary: '', metadata: { executionSource: row.decision_source || null, capabilityUseId: n(row.id) } };
  }
  if (row.source === 't') {
    if (!['succeeded','failed','blocked'].includes(row.status)) return null;
    return { ...base, type: `tool_${row.status}`, category: 'tools', importance: row.status === 'succeeded' ? 'medium' : 'low',
      title: `${text(row.capability_key, 90)} ${row.status}`, summary: '', metadata: { toolAttemptId: row.id } };
  }
  if (row.source === 'j') {
    if (!['completed','failed','timed_out'].includes(row.status)) return null;
    return { ...base, type: row.status === 'completed' ? 'job_completed' : 'job_failed', category: 'work',
      importance: row.status === 'completed' ? 'high' : 'medium',
      title: text(row.research_question || 'Research job', 120), summary: `Research ${row.status}`,
      relatedJobIds: [row.id], metadata: { status: row.status } };
  }
  if (row.source === 'a') return { ...base, type: 'artifact_created', category: 'work', importance: 'high',
    title: text(row.display_name, 120), summary: 'Research artifact created',
    relatedArtifactIds: [row.id] };
  return null;
}

export function projectEventPage(rows, { limit = 20, category = 'all', cursor = null,
  minImportance = 'low', since = null, until = stamp(new Date()) } = {}) {
  const upper = cursor?.until || until;
  const bound = cursor?.since ?? since;
  const lower = bound ? (timestamp(bound) ? bound : stamp(bound)) : null;
  const seenIds = new Set();
  const events = rows.map(normalizeObservable).filter(Boolean)
    .filter((item) => (category === 'all' || item.category === category)
      && IMPORTANCE[item.importance] >= IMPORTANCE[minImportance]
      && item.timestamp <= upper && (!lower || item.timestamp >= lower)
      && (!cursor || item.timestamp < cursor.at || item.timestamp === cursor.at && item.id < cursor.id))
    .sort((a, b) => compare(b.timestamp, a.timestamp) || compare(b.id, a.id))
    .filter((item) => !seenIds.has(item.id) && seenIds.add(item.id));
  const items = events.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: events.length > limit && last
    ? Buffer.from(JSON.stringify({ v: 2, at: last.timestamp, id: last.id,
      until: upper, since: lower })).toString('base64url') : null };
}

export function aggregateIntelligence(calls = [], now = new Date(), { truncated = false } = {}) {
  const start24 = now.getTime() - 86_400_000;
  const startToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const paid = calls.filter((row) => row.provider_started_at && row.status !== 'blocked');
  const within = (time) => paid.filter((row) => new Date(row.created_at).getTime() >= time);
  const byModel = {};
  const byTier = {};
  let input = 0, output = 0, knownCostNano = 0n, costKnown = 0;
  let todayCostNano = 0n, todayCostKnown = 0;
  let cacheRead = 0, cacheWrite = 0, cachedInput = 0;
  let inputKnown = 0, outputKnown = 0, cacheReadKnown = 0, cacheWriteKnown = 0, cachedKnown = 0;
  const last24 = within(start24);
  for (const row of last24) {
    byModel[row.returned_model || row.model] = (byModel[row.returned_model || row.model] || 0) + 1;
    byTier[row.tier] = (byTier[row.tier] || 0) + 1;
    if (row.input_tokens != null) { input += Number(row.input_tokens); inputKnown++; }
    if (row.output_tokens != null) { output += Number(row.output_tokens); outputKnown++; }
    if (row.cache_read_tokens != null) { cacheRead += Number(row.cache_read_tokens); cacheReadKnown++; }
    if (row.cache_write_tokens != null) { cacheWrite += Number(row.cache_write_tokens); cacheWriteKnown++; }
    if (row.cached_input_tokens != null) { cachedInput += Number(row.cached_input_tokens); cachedKnown++; }
    if (row.effective_cost_nano_usd != null && ['usage_priced','provider_reported'].includes(row.cost_source)) {
      knownCostNano += BigInt(row.effective_cost_nano_usd); costKnown++;
      if (new Date(row.created_at).getTime() >= startToday) {
        todayCostNano += BigInt(row.effective_cost_nano_usd); todayCostKnown++;
      }
    }
  }
  const completed = last24.filter((row) => ['failed','succeeded'].includes(row.status));
  const failedCalls = completed.filter((row) => row.status === 'failed').length;
  const correlations = new Map();
  let explicitChanges = 0;
  for (const row of [...last24].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))) {
    const key = row.correlation_id && `${row.agent_id}:${row.correlation_id}`;
    const model = row.returned_model || row.model;
    if (key && ['resident_escalation','resident_strategic_review'].includes(row.trigger)
        && correlations.has(key) && correlations.get(key) !== model) explicitChanges++;
    if (key) correlations.set(key, model);
  }
  return { callsToday: within(startToday).length, calls24h: last24.length,
    window: { truncated, complete: !truncated, limit: 2000, sampledCalls: last24.length,
      oldestIncludedAt: last24.length ? new Date(Math.min(...last24.map((r) => new Date(r.created_at).getTime()))).toISOString() : null },
    completedCalls24h: completed.length, failureRate: completed.length ? failedCalls / completed.length : null,
    failedCalls24h: last24.filter((row) => row.status === 'failed').length,
    byModel, byTier, escalationCount: explicitChanges, escalationEvidence: 'explicit_trigger_and_model_change',
    escalationReasons: null, usage: { inputTokens: inputKnown === last24.length ? input : null,
      outputTokens: outputKnown === last24.length ? output : null, totalTokens: inputKnown === last24.length && outputKnown === last24.length ? input + output : null,
      knownInputTokens: inputKnown ? input : null, knownOutputTokens: outputKnown ? output : null,
      coverage: { calls: last24.length, input: inputKnown, output: outputKnown, cacheRead: cacheReadKnown, cacheWrite: cacheWriteKnown },
      cacheReadTokens: cacheReadKnown === last24.length ? cacheRead : null, cacheWriteTokens: cacheWriteKnown === last24.length ? cacheWrite : null,
      cachedInputTokens: cachedKnown === last24.length ? cachedInput : null },
    cost: { knownUsdToday: todayCostKnown ? Number(todayCostNano) / 1e9 : null,
      knownUsd24h: costKnown ? Number(knownCostNano) / 1e9 : null,
      knownCalls: costKnown, unknownCalls: last24.length - costKnown,
      complete: !truncated && costKnown === last24.length, estimatedMonthlyRunRateUsd: !truncated && costKnown === last24.length
        ? Number(knownCostNano) / 1e9 * 30 : null,
      label: 'usage-derived or provider-reported; not an invoice' } };
}

export function aggregateAutonomy(facts = {}) {
  const value = (key) => facts[key] == null ? null : Number(facts[key]);
  const succeeded = value('grounded_calls');
  const outcomes = value('grounding_outcomes');
  const attributed = value('attributed_actions');
  const worldActions = value('world_actions');
  return {
    goals: { formed: value('model_goals'), revised: null, completed: null, abandoned: null },
    plans: { created: value('model_plans'), advanced: value('completed_steps'),
      completed: value('completed_plans'), replans: value('replans'), blocked: null },
    cognitionToAction: { eligibleTurns: null, proposalTurns: value('proposal_turns'),
      successfulWorldActions: attributed, unattributedWorldActions: worldActions == null || attributed == null
        ? null : Math.max(0, worldActions - attributed),
      failedGroundings: value('rejected_groundings'),
      groundingRate: outcomes > 0 ? succeeded / outcomes : null,
      unknownGroundingOutcomes: value('unknown_groundings') },
    tools: { calls: value('tool_calls'), succeeded: value('tool_succeeded'), failed: value('tool_failed') },
    fruitfly: { autonomousActions: attributed, fruitflyAssisted: null, fallbackActions: null },
    evidence: { status: attributed > 0 ? 'persisted_attribution' : 'no_attributed_execution_evidence',
      goalTransitions: 'unavailable; no canonical model goal transition ledger',
      plans: 'current retained plans with model origin linked to a persisted cognition turn; completions require execution effects',
      actions: 'budget call -> cognition turn -> execution effect -> matching authoritative World event',
      unlinkedActions: 'unknown attribution; never counted as autonomous',
      fruitfly: 'all-action Fruitfly/fallback attribution unavailable' }
  };
}

export const validObservabilityUuid = (value) => UUID.test(value);
