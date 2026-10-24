// drivefix1 stale targets (MIRRORTERRA_STALE_TARGET_FIX, default on; off = ctxfix2-perf1 behaviour exactly).
//
// Prod 24 h before drivefix1 (read-only, 10-24 02:10 UTC): 14,563 settled actions, 9,308 project actions
// (64%); 1,466 project actions abandoned (977 project_join PROJECT_NOT_RECRUITING + 489 project_contribute
// PROJECT_NOT_ACTIVE; the other 324 abandoned are business_service). Every rejected join had another
// resident's successful join within 30 world minutes, and no resident chose the same join target twice
// (the council4 back-off already parks a rejected target for 240 world minutes and the action for 60-720).
// The cause is a race: a project stops recruiting the moment it has 2 active members (joinWorldProject), and
// completes the moment its effort reaches the target (28 effort, ~8 per contribution), but the candidate
// snapshot is read once per tick and an action lands 10-25 s after it is chosen. Several residents pick the
// same new project in the same tick; the first lands, the rest are rejected.
//
// Fix: candidates count the actions already under way (walking/performing residents and choices made earlier
// in this tick). A project_join is dropped when its project is not proposed/recruiting, or when its active
// members plus joins already in flight reach the activation size (2) or its capacity. A project_contribute is
// dropped when the project is not active, or when the contributions already in flight are expected to finish
// it (each counted at CONTRIBUTION_EFFORT_ESTIMATE, the 24 h median 8.3 minus a margin). Invitations get the
// same status check. Nothing else changes; the existing back-off stays the same-target cool-down.
export const PROJECT_ACTIVATION_MEMBERS = 2;
export const CONTRIBUTION_EFFORT_ESTIMATE = 7.5;

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
function contextOf(value) {
  if (!value) return {};
  if (typeof value === 'string') { try { return JSON.parse(value) || {}; } catch { return {}; } }
  return typeof value === 'object' ? value : {};
}

export function createInFlight() { return new Map(); }

export function noteInFlight(inFlight, { agentId, action, projectId }) {
  if (!inFlight || !projectId || !['project_join', 'project_contribute'].includes(action)) return;
  const key = String(projectId);
  const entry = inFlight.get(key) || { joins: new Set(), contributes: new Set() };
  (action === 'project_join' ? entry.joins : entry.contributes).add(String(agentId));
  inFlight.set(key, entry);
}

// From the tick's member rows: residents walking to or performing a project action.
export function collectInFlight(rows = []) {
  const inFlight = createInFlight();
  for (const row of rows) {
    if (!['walking', 'performing'].includes(row?.status)) continue;
    const context = contextOf(row.planned_context);
    if (context.decision === 'reject') continue;
    noteInFlight(inFlight, { agentId: row.agent_id, action: row.planned_action, projectId: context.projectId });
  }
  return inFlight;
}

function othersCount(set, agentId) {
  if (!set) return 0;
  return [...set].filter((id) => id !== String(agentId)).length;
}

// Pure. Returns { candidates, dropped: [{ id, action, projectId, reason }] }.
export function filterStaleProjectCandidates(candidates = [], { agentId, projects = [], inFlight = null } = {}) {
  const byId = new Map();
  for (const project of projects || []) if (project?.id) byId.set(String(project.id), project);
  const kept = [], dropped = [];
  for (const candidate of candidates) {
    const action = candidate?.action;
    const isJoin = action === 'project_join' && candidate.decision !== 'reject';
    if (!(isJoin || action === 'project_contribute') || !candidate.projectId) { kept.push(candidate); continue; }
    const project = byId.get(String(candidate.projectId));
    if (!project) { kept.push(candidate); continue; }
    const flight = inFlight?.get(String(candidate.projectId));
    let reason = null;
    if (isJoin) {
      const members = finite(project.participantCount);
      const pending = othersCount(flight?.joins, agentId);
      const capacity = finite(project.capacity, 4) || 4;
      if (!['proposed', 'recruiting'].includes(project.status)) reason = 'not_recruiting';
      else if (members + pending >= capacity) reason = 'full';
      else if (members + pending >= PROJECT_ACTIVATION_MEMBERS) reason = 'closing';
    } else {
      const target = finite(project.required_resources?.effortPoints ?? project.requiredResources?.effortPoints, 30) || 30;
      const progress = finite(project.progressValue ?? project.progress);
      const remaining = Math.max(0, target * (1 - progress / 100));
      const pending = othersCount(flight?.contributes, agentId);
      if (project.status !== 'active' || project.settled_at) reason = 'not_active';
      else if (pending > 0 && pending * CONTRIBUTION_EFFORT_ESTIMATE >= remaining) reason = 'finishing';
    }
    if (reason) dropped.push({ id: candidate.id, action, projectId: String(candidate.projectId), reason });
    else kept.push(candidate);
  }
  return { candidates: kept, dropped };
}
