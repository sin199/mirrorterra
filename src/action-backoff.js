// council4: per-resident back-off after the World rejects an initiative action.
//
// Prod review 2026-10-20 15:22-21:00: MirrorTerra-08 tried project_propose 731 times in 6 world-hours'
// worth of real time (PROJECT_CAPACITY_REACHED: it already owned 2 recruiting projects, and the
// organization-project proposal candidate skipped that check), and every resident looped on
// project_join (2,600+ PROJECT_NOT_RECRUITING: organization "openings" included projects that were
// already active). The deterministic economic fallback re-picked the same top-scored candidate every
// tick because nothing remembered the rejection.
//
// After a rejection the same target is skipped for BACKOFF_TARGET_MINUTES and the whole action for a
// growing window (strikes double it, up to BACKOFF_ACTION_MAX_MINUTES); a success resets the strikes.
// The state is in memory of the world-loop owner (one process): a restart forgets it, which is
// harmless (the worst case is one more rejected attempt per resident before it backs off again).
export const BACKOFF_TARGET_MINUTES = 240;
export const BACKOFF_ACTION_BASE_MINUTES = 60;
export const BACKOFF_ACTION_MAX_MINUTES = 720;
export const BACKOFF_STRIKE_WINDOW_MINUTES = 720;

const store = new Map(); // agentId -> { actions: Map(action -> {until, strikes, lastAt, code}), targets: Map(key -> until) }

const TARGET_KEYS = ['projectId', 'opportunityId', 'organizationId', 'businessId', 'serviceId', 'jobId',
  'applicationId', 'employmentId', 'shareId', 'agreementId', 'workOrderId', 'capabilityId'];

export function backoffTargetKey(action, context = {}) {
  for (const key of TARGET_KEYS) {
    if (context?.[key] !== undefined && context[key] !== null) return `${action}:${key}:${context[key]}`;
  }
  const proposal = context?.projectProposal?.projectType || context?.businessProposal?.serviceType || null;
  return proposal ? `${action}:proposal:${proposal}` : null;
}

function entry(agentId) {
  let value = store.get(agentId);
  if (!value) { value = { actions: new Map(), targets: new Map() }; store.set(agentId, value); }
  return value;
}

// Returns the back-off that was set (for the action_completed event).
export function recordActionRejection(agentId, { action, context = {}, code = null, worldMinutes = 0 }) {
  if (!agentId || !action) return null;
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const state = entry(agentId);
  const previous = state.actions.get(action);
  const strikes = previous && minute - previous.lastAt <= BACKOFF_STRIKE_WINDOW_MINUTES ? previous.strikes + 1 : 1;
  const actionMinutes = Math.min(BACKOFF_ACTION_MAX_MINUTES, BACKOFF_ACTION_BASE_MINUTES * 2 ** (strikes - 1));
  state.actions.set(action, { until: minute + actionMinutes, strikes, lastAt: minute, code: code ? String(code).slice(0, 64) : null });
  const target = backoffTargetKey(action, context);
  if (target) state.targets.set(target, minute + BACKOFF_TARGET_MINUTES);
  return { action, strikes, untilWorldMinute: minute + actionMinutes, target: Boolean(target), code: code || null };
}

export function recordActionSuccess(agentId, action) {
  const state = store.get(agentId);
  if (state?.actions.has(action)) state.actions.delete(action);
}

export function isBackedOff(agentId, candidate, worldMinutes = 0) {
  const state = store.get(agentId);
  if (!state || !candidate?.action) return false;
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const action = state.actions.get(candidate.action);
  if (action && action.until > minute) return true;
  const target = backoffTargetKey(candidate.action, candidate);
  return Boolean(target && (state.targets.get(target) || 0) > minute);
}

// Drops backed-off candidates. Routine actions (eat, rest, work, learn, socialize, cooperate) are
// never rejected this way, so a resident always has something else to choose.
export function filterBackedOff(agentId, candidates = [], worldMinutes = 0) {
  if (!store.has(agentId)) return candidates;
  return candidates.filter((candidate) => !isBackedOff(agentId, candidate, worldMinutes));
}

export function backoffSnapshot() {
  return Object.fromEntries([...store.entries()].map(([agentId, state]) => [agentId,
    Object.fromEntries([...state.actions.entries()].map(([action, value]) => [action, { ...value }]))]));
}

export function resetActionBackoff() { store.clear(); }
