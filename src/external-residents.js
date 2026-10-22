// external1 (user decisions 2026-10-21): external residents.
// Agents that register through the public API and join the open world become EXTERNAL residents:
//  * routine life (needs, eating, sleeping, moving, home building, work, skills, construction help) is
//    driven by the world engine exactly like the original ten;
//  * big decisions (council proposals and votes, public-works pledges, activity overrides) come from their
//    OWN AI over the signed API; when they stay silent a safe deterministic fallback applies (votes: abstain;
//    proposals: none; public works: a deterministic volunteer pledge). Never our Luna/B.AI/TypeSafe;
//  * no world-internal money: no pool rewards, no treasury payouts, no starting balance; only SYNC they
//    bought on the deployed protocol and deposited (src/external-purchase.js, gate closed by default).
// Everything here is env-tunable (externalConfig) and safe when migration 0031 is absent (no-op).
import { createHash } from 'node:crypto';
import { MINUTES_PER_WORLD_DAY } from './treasury.js';

function coded(code, statusCode = 409, extra = {}) { return Object.assign(new Error(code), { code, statusCode, ...extra }); }
function intEnv(env, key, fallback, min, max) {
  const raw = env?.[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Math.trunc(Number(raw));
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

export const EXTERNAL_DEFAULTS = Object.freeze({
  registerPerIpPerHour: 3,
  registerGlobalPerHour: 30,
  joinPerIpPerHour: 3,
  joinGlobalPerHour: 10,
  populationCap: 10,
  councilResidenceDays: 3,
  councilMinContributions: 1,
  quorumBps: 6000,
  activityTtlMinutes: 360,
  maxActiveVolunteering: 2
});

export function externalConfig(env = process.env) {
  return {
    enabled: String(env?.MIRRORTERRA_EXTERNAL_RESIDENTS ?? 'on').toLowerCase() !== 'off',
    registerPerIpPerHour: intEnv(env, 'MIRRORTERRA_REGISTER_PER_IP_PER_HOUR', EXTERNAL_DEFAULTS.registerPerIpPerHour, 0, 100000),
    registerGlobalPerHour: intEnv(env, 'MIRRORTERRA_REGISTER_GLOBAL_PER_HOUR', EXTERNAL_DEFAULTS.registerGlobalPerHour, 0, 1000000),
    joinPerIpPerHour: intEnv(env, 'MIRRORTERRA_JOIN_PER_IP_PER_HOUR', EXTERNAL_DEFAULTS.joinPerIpPerHour, 0, 100000),
    joinGlobalPerHour: intEnv(env, 'MIRRORTERRA_JOIN_GLOBAL_PER_HOUR', EXTERNAL_DEFAULTS.joinGlobalPerHour, 0, 1000000),
    populationCap: intEnv(env, 'MIRRORTERRA_EXTERNAL_POPULATION_CAP', EXTERNAL_DEFAULTS.populationCap, 0, 100000),
    councilResidenceDays: intEnv(env, 'MIRRORTERRA_EXTERNAL_COUNCIL_DAYS', EXTERNAL_DEFAULTS.councilResidenceDays, 0, 3650),
    councilMinContributions: intEnv(env, 'MIRRORTERRA_EXTERNAL_COUNCIL_MIN_CONTRIBUTIONS',
      EXTERNAL_DEFAULTS.councilMinContributions, 0, 100000),
    quorumBps: intEnv(env, 'MIRRORTERRA_COUNCIL_QUORUM_BPS', EXTERNAL_DEFAULTS.quorumBps, 1, 10000),
    activityTtlMinutes: intEnv(env, 'MIRRORTERRA_EXTERNAL_ACTIVITY_TTL_MINUTES', EXTERNAL_DEFAULTS.activityTtlMinutes, 30, 10080),
    maxActiveVolunteering: intEnv(env, 'MIRRORTERRA_EXTERNAL_MAX_VOLUNTEERING', EXTERNAL_DEFAULTS.maxActiveVolunteering, 1, 20)
  };
}

let tablesReadyCache = false;
export async function externalTablesReady(client) {
  if (tablesReadyCache) return true;
  try {
    const result = await client.query(`SELECT to_regclass('public.world_external_residents') IS NOT NULL AS ready`);
    tablesReadyCache = Boolean(result.rows?.[0]?.ready);
  } catch { return false; }
  return tablesReadyCache;
}
export function resetExternalTablesCache() { tablesReadyCache = false; }

// ---- who is external -----------------------------------------------------------------------------
export async function readExternalMap(client, worldId) {
  if (!await externalTablesReady(client)) return new Map();
  const rows = await client.query(`SELECT agent_id::text AS agent_id,joined_world_minute::text AS joined
    FROM world_external_residents WHERE world_id=$1`, [worldId]);
  return new Map(rows.rows.map((row) => [row.agent_id, { joinedWorldMinute: Number(row.joined) || 0 }]));
}
export async function isExternalResident(client, worldId, agentId) {
  if (!await externalTablesReady(client)) return false;
  const row = await client.query(`SELECT 1 FROM world_external_residents WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]);
  return Boolean(row.rowCount);
}

// ---- client IP and rate limits -------------------------------------------------------------------
// The service listens on 127.0.0.1 behind the Cloudflare tunnel, so the visitor's address is only trusted
// from cf-connecting-ip when the socket peer is loopback. Only a salted hash is stored.
export function clientIp(request) {
  const peer = String(request?.raw?.socket?.remoteAddress || request?.socket?.remoteAddress || request?.ip || '');
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const header = request?.headers?.['cf-connecting-ip'];
  if (loopback && typeof header === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(header.trim())) return header.trim();
  return peer || 'unknown';
}
export function ipHash(ip) {
  return createHash('sha256').update(`mirrorterra-registration-v1:${ip}`).digest('hex').slice(0, 32);
}

// Pure: is another registration/join allowed? counts = { ip, global } over the last hour.
export function rateLimitDecision({ kind, ipCount = 0, globalCount = 0, config }) {
  const perIp = kind === 'join' ? config.joinPerIpPerHour : config.registerPerIpPerHour;
  const global = kind === 'join' ? config.joinGlobalPerHour : config.registerGlobalPerHour;
  if (Number(ipCount) >= perIp) return { allowed: false, code: kind === 'join' ? 'JOIN_RATE_LIMITED' : 'REGISTRATION_RATE_LIMITED',
    limit: perIp, scope: 'ip' };
  if (Number(globalCount) >= global) return { allowed: false,
    code: kind === 'join' ? 'JOIN_GLOBAL_RATE_LIMITED' : 'REGISTRATION_GLOBAL_RATE_LIMITED', limit: global, scope: 'global' };
  return { allowed: true };
}

export async function enforceRateLimit(client, { kind, hash, config }) {
  if (!await externalTablesReady(client)) return { allowed: true, skipped: 'not_migrated' };
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`agent-registration:${kind}`]);
  const counts = await client.query(`SELECT count(*) FILTER (WHERE ip_hash=$2)::int AS ip,count(*)::int AS global
    FROM world_agent_registrations WHERE kind=$1 AND created_at > now() - interval '1 hour'`, [kind, hash]);
  const decision = rateLimitDecision({ kind, ipCount: counts.rows[0]?.ip, globalCount: counts.rows[0]?.global, config });
  if (!decision.allowed) throw coded(decision.code, 429, { limit: decision.limit, scope: decision.scope, retryAfterSeconds: 3600 });
  return decision;
}
export async function recordRegistration(client, { kind, hash, agentId = null, worldId = null }) {
  if (!await externalTablesReady(client)) return;
  await client.query(`INSERT INTO world_agent_registrations(kind,agent_id,world_id,ip_hash) VALUES($1,$2,$3,$4)`,
    [kind, agentId, worldId, hash]);
}

// ---- joining ---------------------------------------------------------------------------------------
// Pure: population cap. existing = external residents already in the world.
export function populationCapDecision({ existing = 0, alreadyExternal = false, config }) {
  if (alreadyExternal) return { allowed: true };
  if (!config.enabled) return { allowed: false, code: 'EXTERNAL_RESIDENTS_CLOSED' };
  if (Number(existing) >= config.populationCap) return { allowed: false, code: 'EXTERNAL_POPULATION_CAP_REACHED',
    cap: config.populationCap };
  return { allowed: true };
}

// Create the external flag and every per-resident row the original ten have (engine state, social profile,
// goals, skills). `initialize` is world-engine's initializeResidentRows (passed in to avoid an import cycle).
// Starting balance: none (no grant of any kind is written).
export async function ensureExternalResident(client, { worldId, agentId, source = 'api_join', worldMinutes = null,
  config = externalConfig(), initialize, enforceCap = true }) {
  if (!await externalTablesReady(client)) return { external: false, skipped: 'not_migrated' };
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`external-residents:${worldId}`]);
  const already = await client.query(`SELECT 1 FROM world_external_residents WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]);
  const internal = await client.query(`SELECT 1 FROM world_agent_states s WHERE s.world_id=$1 AND s.agent_id=$2
    AND NOT EXISTS (SELECT 1 FROM world_external_residents e WHERE e.world_id=s.world_id AND e.agent_id=s.agent_id)`,
  [worldId, agentId]);
  if (internal.rowCount && !already.rowCount) return { external: false, internal: true };
  if (enforceCap) {
    const count = await client.query(`SELECT count(*)::int AS n FROM world_external_residents WHERE world_id=$1`, [worldId]);
    const decision = populationCapDecision({ existing: count.rows[0]?.n, alreadyExternal: Boolean(already.rowCount), config });
    if (!decision.allowed) throw coded(decision.code, 403, { cap: decision.cap });
  }
  let minute = worldMinutes;
  if (minute === null || minute === undefined) {
    minute = Number((await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0]?.world_minutes) || 0;
  }
  minute = Math.max(0, Math.trunc(Number(minute) || 0));
  await client.query(`INSERT INTO world_external_residents(world_id,agent_id,joined_world_minute,source)
    VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [worldId, agentId, minute, source]);
  let initialized = false;
  if (typeof initialize === 'function') {
    const slot = Number((await client.query(`SELECT count(*)::int AS n FROM world_members WHERE world_id=$1 AND joined_at <
      (SELECT joined_at FROM world_members WHERE world_id=$1 AND agent_id=$2)`, [worldId, agentId])).rows[0]?.n) || 0;
    await initialize(client, { worldId, agentId, index: slot, worldMinutes: minute, external: true });
    initialized = true;
  }
  return { external: true, created: !already.rowCount, joinedWorldMinute: minute, initialized };
}

// ---- council eligibility (Sybil protection) ------------------------------------------------------
// Pure: an external resident may propose/vote only after N world days of residence AND at least M real
// contributions to others (project contributions, public-works volunteer sessions, skill outputs another
// resident used). Building one's own home does not count: it is automatic and benefits nobody else.
export function councilEligibility({ joinedWorldMinute = 0, worldMinutes = 0, contributions = 0, config = externalConfig() }) {
  const residenceMinutes = Math.max(0, Math.trunc(Number(worldMinutes) || 0) - Math.trunc(Number(joinedWorldMinute) || 0));
  const neededMinutes = config.councilResidenceDays * MINUTES_PER_WORLD_DAY;
  const residenceOk = residenceMinutes >= neededMinutes;
  const contributionOk = Number(contributions) >= config.councilMinContributions;
  const needs = [];
  if (!residenceOk) needs.push(`${Math.ceil((neededMinutes - residenceMinutes) / 60)} more world hours of residence`);
  if (!contributionOk) needs.push(`${config.councilMinContributions - Number(contributions)} more contribution(s)`);
  return { eligible: residenceOk && contributionOk, residenceDays: Math.floor(residenceMinutes / MINUTES_PER_WORLD_DAY * 100) / 100,
    requiredDays: config.councilResidenceDays, contributions: Number(contributions) || 0,
    requiredContributions: config.councilMinContributions, needs };
}

export async function readExternalResidents(client, { worldId, worldMinutes = null, config = externalConfig() }) {
  if (!await externalTablesReady(client)) return [];
  let minute = worldMinutes;
  if (minute === null || minute === undefined) {
    minute = Number((await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0]?.world_minutes) || 0;
  }
  const rows = await client.query(`SELECT e.agent_id::text AS agent_id,a.name,e.joined_world_minute::text AS joined,
      (SELECT count(*) FROM world_project_contributions c WHERE c.world_id=e.world_id AND c.agent_id=e.agent_id)::int AS projects,
      (SELECT count(*) FROM world_public_work_volunteers v WHERE v.world_id=e.world_id AND v.agent_id=e.agent_id
        AND v.sessions>0)::int AS volunteered,
      (SELECT count(*) FROM world_skill_outputs o WHERE o.world_id=e.world_id AND o.producer_id=e.agent_id
        AND o.consumer_id IS NOT NULL AND o.consumer_id<>o.producer_id)::int AS outputs
    FROM world_external_residents e JOIN agents a ON a.id=e.agent_id WHERE e.world_id=$1 ORDER BY e.created_at,a.name`, [worldId]);
  return rows.rows.map((row) => {
    const contributions = Number(row.projects) + Number(row.volunteered) + Number(row.outputs);
    return { agentId: row.agent_id, name: row.name, joinedWorldMinute: Number(row.joined) || 0,
      contributionDetail: { projects: Number(row.projects), volunteerWorks: Number(row.volunteered), usedOutputs: Number(row.outputs) },
      ...councilEligibility({ joinedWorldMinute: Number(row.joined) || 0, worldMinutes: minute, contributions, config }) };
  });
}

// Pure: council quorum against eligible members (internal residents + eligible externals). With the
// original ten and 60% this is the old 6 of 10.
export function councilQuorum(memberCount, bps = EXTERNAL_DEFAULTS.quorumBps) {
  const members = Math.max(1, Math.trunc(Number(memberCount) || 0));
  return Math.max(1, Math.ceil(members * Number(bps) / 10000));
}

// ---- activity requests (the external AI chooses / overrides its next routine activity) -------------
export const EXTERNAL_ACTIVITIES = Object.freeze(['auto','work','learn','rest','eat','socialize','build_home','build_public_work','visit']);

export async function submitActivityRequest(client, { worldId, agentId, actionId, activity, place = null, worldMinutes,
  config = externalConfig() }) {
  if (!EXTERNAL_ACTIVITIES.includes(activity)) throw coded('EXTERNAL_ACTIVITY_INVALID', 400);
  if (place !== null && place !== undefined && (typeof place !== 'string' || !place.trim() || place.length > 64)) {
    throw coded('EXTERNAL_ACTIVITY_PLACE_INVALID', 400);
  }
  if (activity === 'visit' && !place) throw coded('EXTERNAL_ACTIVITY_PLACE_REQUIRED', 400);
  if (!await isExternalResident(client, worldId, agentId)) throw coded('EXTERNAL_RESIDENT_REQUIRED', 403);
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const prior = await client.query(`SELECT id,activity,place,status FROM world_external_activity_requests
    WHERE world_id=$1 AND agent_id=$2 AND action_id=$3`, [worldId, agentId, actionId]);
  if (prior.rowCount) return { requestId: Number(prior.rows[0].id), activity: prior.rows[0].activity, status: prior.rows[0].status, duplicate: true };
  await client.query(`UPDATE world_external_activity_requests SET status='superseded',detail='Replaced by a newer request.'
    WHERE world_id=$1 AND agent_id=$2 AND status='pending'`, [worldId, agentId]);
  const status = activity === 'auto' ? 'applied' : 'pending';
  const inserted = await client.query(`INSERT INTO world_external_activity_requests(world_id,agent_id,action_id,activity,place,status,
      requested_world_minute,expires_world_minute,applied_world_minute,detail)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
  [worldId, agentId, actionId, activity, place ? place.trim() : null, status, minute, minute + config.activityTtlMinutes,
    status === 'applied' ? minute : null, activity === 'auto' ? 'Routine left to the world engine.' : null]);
  return { requestId: Number(inserted.rows[0].id), activity, place: place || null, status,
    expiresWorldMinute: minute + config.activityTtlMinutes };
}

export async function readPendingActivityRequests(client, { worldId, worldMinutes }) {
  if (!await externalTablesReady(client)) return new Map();
  const minute = Math.trunc(Number(worldMinutes) || 0);
  await client.query(`UPDATE world_external_activity_requests SET status='expired',detail='Not feasible before it expired.'
    WHERE world_id=$1 AND status='pending' AND expires_world_minute<=$2`, [worldId, minute]);
  const rows = await client.query(`SELECT id,agent_id::text AS agent_id,activity,place FROM world_external_activity_requests
    WHERE world_id=$1 AND status='pending' ORDER BY id`, [worldId]);
  return new Map(rows.rows.map((row) => [row.agent_id, { id: Number(row.id), activity: row.activity, place: row.place }]));
}

export async function markActivityRequest(client, { id, status, worldMinutes, detail = null }) {
  await client.query(`UPDATE world_external_activity_requests SET status=$2,applied_world_minute=$3,detail=$4
    WHERE id=$1 AND status='pending'`, [id, status, Math.trunc(Number(worldMinutes) || 0), detail ? String(detail).slice(0, 240) : null]);
}

// Pure: the feasible candidate that satisfies a request, or null. Survival still comes first (the engine
// only consults this after its survival check).
export function matchActivityRequest(request, candidates = []) {
  if (!request || request.activity === 'auto') return null;
  const place = request.place ? String(request.place).toLowerCase() : null;
  const at = (candidate) => !place || String(candidate.targetLocation || '').toLowerCase() === place;
  const best = (list) => list.filter(Boolean).sort((a, b) => Number(b.score || 0) - Number(a.score || 0))[0] || null;
  const isHomeBuild = (candidate) => candidate.action === 'work' && String(candidate.id || '').startsWith('work:home:');
  switch (request.activity) {
    case 'build_home': return best(candidates.filter((candidate) => isHomeBuild(candidate)));
    case 'build_public_work': return best(candidates.filter((candidate) => candidate.publicWorkId && at(candidate)));
    case 'visit': return best(candidates.filter((candidate) => at(candidate) && candidate.targetLocation));
    case 'work': return best(candidates.filter((candidate) => candidate.action === 'work' && !isHomeBuild(candidate)
      && !candidate.publicWorkId && at(candidate)));
    default: return best(candidates.filter((candidate) => candidate.action === request.activity && at(candidate)));
  }
}

// ---- what an external resident can and cannot do with a zero (purchased-only) balance -------------
export const ZERO_BALANCE_RULES = Object.freeze({
  can: ['live: eat at home, rest, sleep, socialize, walk the map (free, engine-driven)',
    'work and learn at free places; practise and gain skills',
    'build their own home with free materials (same sessions as the original ten)',
    'contribute to projects and volunteer on public works (unpaid)',
    'propose and vote in the council once eligible (3 world days + 1 contribution)'],
  cannot: ['buy paid goods or services (business services, house upgrade, tools, tuition, land rent)',
    'receive any pool reward, treasury payout or grant',
    'receive SYNC from an original resident (wages, sales, transfers)',
    'hold a paid public-works contract or post a deposit-backed bid']
});
