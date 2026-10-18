// Read-only projections over the existing World records. No simulation module imports this file.
import { currentDisplayText, currentResidentDisplayName } from './public-display.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORIES = new Set(['all','goals','plans','tools','work','relationships','economy','world']);
const HISTORY = {
  agent_goal_created: ['goals','high'], goal_created: ['goals','high'], goal_completed: ['goals','high'],
  goal_abandoned: ['goals','medium'],
  project_proposed: ['plans','medium'], project_started: ['plans','high'], project_completed: ['plans','high'],
  project_failed: ['plans','high'], project_invested: ['economy','medium'], project_revenue: ['economy','high'],
  opportunity_created: ['plans','medium'], organization_founded: ['relationships','high'],
  organization_joined: ['relationships','medium'], organization_left: ['relationships','medium'],
  agreement_accepted: ['relationships','high'],
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
const ACTIONS = new Set(['project_contribute','business_service']);
const IMPORTANCE = { low: 0, medium: 1, high: 2, critical: 3 };
const text = (value, max = 240) => typeof value === 'string' ? value.slice(0, max) : '';
const n = (value) => value == null ? null : Number(value);

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
      if (typeof query.cursor !== 'string' || query.cursor.length > 2048) throw new Error();
      const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (typeof decoded.at !== 'string' || !Number.isFinite(Date.parse(decoded.at))
        || !/^(?:h|e|u|t|j|a):[a-zA-Z0-9-]+$/.test(decoded.id)) throw new Error();
      cursor = { at: decoded.at, id: decoded.id,
        seen: Array.isArray(decoded.seen) ? decoded.seen.filter((value) => typeof value === 'string'
          && value.length < 240).slice(-100) : [] };
    } catch { throw Object.assign(new Error('CURSOR_INVALID'), { statusCode: 400 }); }
  }
  return { limit, category, period, cursor };
}

export function normalizeObservable(row) {
  const base = { id: `${row.source}:${row.id}`, timestamp: new Date(row.created_at).toISOString(), agentId: row.agent_id || null,
    agentName: currentResidentDisplayName(row.agent_name) || null, worldMinute: n(row.world_minute), source: row.source,
    sourceId: String(row.id), relatedAgentIds: [], relatedArtifactIds: [], relatedJobIds: [],
    relatedBusinessIds: [], metadata: {} };
  if (row.source === 'h') {
    if (row.event_type === 'opportunity_created' && !row.agent_id) return null;
    const classification = HISTORY[row.event_type]
      || (/^(?:genesis_|arc_|sync_|world_epoch_)/.test(row.event_type) ? ['world','high'] : null);
    if (!classification) return null;
    return { ...base, type: row.event_type, category: classification[0], importance: classification[1],
      title: currentDisplayText(text(row.title, 120)), summary: currentDisplayText(text(row.detail, 400)),
      metadata: { entityType: row.entity_type || null, entityId: row.entity_id || null } };
  }
  if (row.source === 'e') {
    const data = row.data || {};
    if (row.event_type === 'world.action_completed') {
      const action = data.action || data.initiativeAction;
      if (!ACTIONS.has(action) || data.abandoned || data.status !== 'completed'
        || data.initiative?.idempotent === true
        || (action === 'business_service' && data.initiative?.status !== 'fulfilled')) return null;
      return { ...base, type: 'world_action_completed', category: 'work',
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
  minImportance = 'low' } = {}) {
  const events = rows.map(normalizeObservable).filter(Boolean)
    .filter((item) => (category === 'all' || item.category === category)
      && IMPORTANCE[item.importance] >= IMPORTANCE[minImportance])
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
  const fingerprintFor = (item) => item.metadata.entityId && item.agentId
    ? `${item.agentId}:${item.category}:${item.metadata.entityId}:${Math.floor(Date.parse(item.timestamp) / 60_000)}`
    : item.metadata.worldEventId ? `world:${item.metadata.worldEventId}` : item.id;
  const seen = new Set(cursor?.seen || []);
  const unique = events.filter((item) => {
    // Same authoritative action can also produce a history milestone; prefer the history row.
    const fingerprint = fingerprintFor(item);
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  }).filter((item) => !cursor || item.timestamp < cursor.at
    || (item.timestamp === cursor.at && item.id < cursor.id));
  const items = unique.slice(0, limit);
  const last = items.at(-1);
  return { items, nextCursor: unique.length > limit && last
    ? Buffer.from(JSON.stringify({ at: last.timestamp, id: last.id,
      seen: [...(cursor?.seen || []), ...items.map(fingerprintFor)].slice(-100) })).toString('base64url') : null };
}

export function aggregateIntelligence(calls = [], now = new Date()) {
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
    if (['usage_priced','provider_reported'].includes(row.cost_source)) {
      knownCostNano += BigInt(row.effective_cost_nano_usd); costKnown++;
      if (new Date(row.created_at).getTime() >= startToday) {
        todayCostNano += BigInt(row.effective_cost_nano_usd); todayCostKnown++;
      }
    }
  }
  return { callsToday: within(startToday).length, calls24h: last24.length,
    failedCalls24h: last24.filter((row) => row.status === 'failed').length,
    byModel, byTier, escalationCount: last24.filter((row) => ['sonnet','opus'].includes(row.tier)).length,
    escalationReasons: null, usage: { inputTokens: inputKnown ? input : null,
      outputTokens: outputKnown ? output : null, totalTokens: inputKnown && outputKnown ? input + output : null,
      cacheReadTokens: cacheReadKnown ? cacheRead : null, cacheWriteTokens: cacheWriteKnown ? cacheWrite : null,
      cachedInputTokens: cachedKnown ? cachedInput : null },
    cost: { knownUsdToday: todayCostKnown ? Number(todayCostNano) / 1e9 : null,
      knownUsd24h: costKnown ? Number(knownCostNano) / 1e9 : null,
      complete: costKnown === last24.length, estimatedMonthlyRunRateUsd: costKnown === last24.length
        ? Number(knownCostNano) / 1e9 * 30 : null,
      label: 'usage-derived or provider-reported; not an invoice' } };
}

export function aggregateAutonomy(events = [], uses = [], turns = []) {
  const count = (types) => events.filter((item) => types.includes(item.type)).length;
  const success = uses.filter((row) => row.success === true);
  const failed = uses.filter((row) => row.success === false);
  const source = (name) => uses.filter((row) => row.decision_source === name).length;
  const actionTurns = turns.filter((row) => row.decision_source === 'open_cognition'
    && row.intent?.selectedAction?.actionType === 'world_action');
  return { goals: { formed: count(['agent_goal_created','goal_created','goal_updated']),
    revised: count(['goal_replanned']), completed: count(['goal_completed']),
    abandoned: count(['goal_abandoned']) },
  plans: { created: count(['project_proposed','project_started']), advanced: count(['goal_milestone']),
    completed: count(['project_completed']), replans: count(['goal_replanned']),
    blocked: count(['project_failed']) },
  cognitionToAction: { eligibleTurns: actionTurns.length, successfulWorldActions: count(['world_action_completed']),
    failedGroundings: null, groundingRate: null },
  tools: { calls: uses.length, succeeded: success.length, failed: failed.length },
  fruitfly: { autonomousActions: source('agent_cognition') + source('agent_api'),
    fruitflyAssisted: source('fruitfly'), fallbackActions: source('utility_fallback') } };
}

export const validObservabilityUuid = (value) => UUID.test(value);
