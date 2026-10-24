// island1: database side of the ferry + resort island (rules in src/ferry-island.js). Every entry point checks
// the master switch (MIRRORTERRA_FERRY_ISLAND) first and returns a no-op result WITHOUT touching the database when
// it is off, so behaviour with the switch off equals 4cfa80c-observer2. Nothing here creates or destroys SYNC:
// a fare is one internal transfer passenger -> operator (DB-checked against the passenger's backed balance, the
// external guard and the 0036 trip trigger); builders are paid by the unchanged public-works milestones.
import { createHash } from 'node:crypto';
import { ferryIslandEnabled, ferryIslandFlags, ferryIslandPhaseEnabled } from './ferry-island-flags.js';
import { CROSSING_MINUTES, DEPARTURES, ISLAND_NAME, ISLAND_TYPES, MAX_FERRY_LEVEL, PIER_CAPACITY, VISITOR_DEPARTURES,
  bookableSailing, boatState, ferryFareRaw, ferrySeats, islandBuildingCapacity, islandVisitEffect, isIslandType,
  pierStrollEffect } from './ferry-island.js';

const DAY = 1440;
const EMPTY_MAP = new Map();
const USE_WEAR = 0.15;
const sha = (value) => createHash('sha256').update(String(value)).digest('hex');

// ---- guarded reads ----------------------------------------------------------------------------------------------
// A failed island read must never abort the caller's transaction (the tick, a commission): inside a checked-out
// client it runs under its own savepoint; on a pool (autocommit) it simply returns the fallback.
export async function guardedIsland(client, fallback, fn) {
  const checkedOut = typeof client?.release === 'function';
  let savepoint = false;
  if (checkedOut) {
    try { await client.query('SAVEPOINT ferry_island_guard'); savepoint = true; } catch { /* not inside a transaction */ }
  }
  try {
    const out = await fn();
    if (savepoint) await client.query('RELEASE SAVEPOINT ferry_island_guard');
    return out;
  } catch {
    if (savepoint) {
      await client.query('ROLLBACK TO SAVEPOINT ferry_island_guard').catch(() => {});
      await client.query('RELEASE SAVEPOINT ferry_island_guard').catch(() => {});
    }
    return fallback;
  }
}

// ---- readiness ----------------------------------------------------------------------------------------------
let readyCache = { ready: false, checkedAt: -Infinity };
export async function ferryIslandReady(client) {
  if (readyCache.ready) return true;
  const now = Date.now();
  if (now - readyCache.checkedAt < 60_000) return false;
  readyCache.checkedAt = now;
  readyCache.ready = await guardedIsland(client, false, async () => {
    const row = await client.query(`SELECT to_regclass('public.world_island_works') IS NOT NULL
      AND to_regclass('public.world_ferry_trips') IS NOT NULL AND to_regclass('public.world_island_demand_hours') IS NOT NULL
      AND to_regclass('public.world_public_work_meta') IS NOT NULL AND to_regclass('public.world_public_work_uses') IS NOT NULL AS ready`);
    return row.rows?.[0]?.ready === true;
  });
  return readyCache.ready;
}
export function resetFerryIslandReadyCache() { readyCache = { ready: false, checkedAt: -Infinity }; }
async function active(client, env = process.env) {
  return ferryIslandEnabled(env) && await ferryIslandReady(client);
}

// ---- island type overrides -----------------------------------------------------------------------------------
// workId -> { islandType, phase }. Empty (and no query) when the master switch is off or 0036 is missing.
export async function readIslandTypeMap(client, worldId, env = process.env) {
  if (!await active(client, env)) return EMPTY_MAP;
  return guardedIsland(client, EMPTY_MAP, async () => {
    const rows = await client.query(`SELECT work_id::text AS work_id,island_type,phase FROM world_island_works WHERE world_id=$1`, [worldId]);
    return new Map(rows.rows.map((row) => [row.work_id, { islandType: row.island_type, phase: row.phase }]));
  });
}
// Rows keep their stored (legacy) type unless the work has an island record. Builds take the island type;
// an expansion (cruise ship) takes its target's island type.
export function applyIslandTypes(rows = [], map = EMPTY_MAP, { idKey = 'id', typeKey = 'building_type', targetKey = 'target_work_id' } = {}) {
  if (!map?.size) return rows;
  for (const row of rows) {
    const own = map.get(row?.[idKey]);
    const target = row?.[targetKey] ? map.get(row[targetKey]) : null;
    const island = own || target;
    if (island) { row[typeKey] = island.islandType; row.island_type = island.islandType; row.island_phase = own?.phase || island.phase; }
  }
  return rows;
}

// ---- hourly beach-cove samples ------------------------------------------------------------------------------
export async function recordIslandDemandHour(client, { worldId, worldMinutes, env = process.env }) {
  if (!await active(client, env)) return null;
  const hour = Math.floor(Math.trunc(Number(worldMinutes) || 0) / 60) - 1;
  if (hour < 0) return null;
  const exists = await client.query(`SELECT 1 FROM world_island_demand_hours WHERE world_id=$1 AND world_hour=$2`, [worldId, hour]);
  if (exists.rowCount) return null;
  const beaches = await client.query(`SELECT name FROM world_scenes WHERE world_id=$1 AND scene_type='beach'`, [worldId]);
  const names = new Set(beaches.rows.map((row) => row.name));
  const rows = await client.query(`SELECT recent.data->>'place' AS place,recent.actor_id::text AS agent_id FROM (
      SELECT data,actor_id FROM world_events WHERE world_id=$1 AND event_type='world.action_completed' ORDER BY id DESC LIMIT 2000) recent
    WHERE COALESCE((recent.data->>'worldMinutes')::numeric,-1) >= $2 AND COALESCE((recent.data->>'worldMinutes')::numeric,-1) < $3`,
  [worldId, hour * 60, hour * 60 + 60]);
  const at = rows.rows.filter((row) => names.has(row.place));
  const agents = [...new Set(at.map((row) => row.agent_id).filter(Boolean))].slice(0, 200);
  await client.query(`INSERT INTO world_island_demand_hours(world_id,world_hour,beach_sessions,beach_agents,sampled_actions)
    VALUES($1,$2,$3,$4::uuid[],$5) ON CONFLICT DO NOTHING`, [worldId, hour, at.length, agents, rows.rowCount]);
  return { hour, beachSessions: at.length, residents: agents.length, sampled: rows.rowCount };
}

// ---- state ----------------------------------------------------------------------------------------------------
const known = (value) => value !== null && value !== undefined;
async function readIslandWorks(client, worldId) {
  const rows = await client.query(`SELECT iw.work_id::text AS work_id,iw.island_type,iw.phase,work.status,work.kind,work.name,
      work.target_work_id::text AS target_work_id,work.completed_world_minute::text AS completed_minute,
      work.commissioned_world_minute::text AS commissioned_minute,work.builder_agent_id::text AS builder_id,
      builder.name AS builder_name,work.scene_id::text AS scene_id,scene.name AS scene_name,work.progress,
      COALESCE((scene.features->'publicWork'->>'level')::int,1) AS level,cond.condition::float8 AS condition
    FROM world_island_works iw JOIN world_public_works work ON work.id=iw.work_id
    LEFT JOIN agents builder ON builder.id=work.builder_agent_id
    LEFT JOIN world_scenes scene ON scene.id=work.scene_id
    LEFT JOIN world_public_work_conditions cond ON cond.work_id=work.id
    WHERE iw.world_id=$1 AND work.status<>'cancelled' ORDER BY work.commissioned_world_minute,work.id`, [worldId]);
  return rows.rows;
}
function stageOf(row) { return row.status === 'completed' ? 'built' : row.status === 'building' ? 'building' : 'bidding'; }
export function summarizeIslandWorks(rows = []) {
  const builds = rows.filter((row) => row.kind !== 'expansion');
  const facility = (row) => row ? { workId: row.work_id, type: row.island_type, name: row.scene_name || row.name, stage: stageOf(row),
    progress: Number(row.progress) || 0, level: Number(row.level) || 1, condition: known(row.condition) ? Number(row.condition) : 100,
    completedMinute: known(row.completed_minute) ? Number(row.completed_minute) : null, sceneId: row.scene_id || null,
    builderId: row.builder_id || null, builderName: row.builder_name || null } : null;
  const pier = facility(builds.find((row) => row.island_type === 'pier'));
  const ferry = facility(builds.find((row) => row.island_type === 'ferry'));
  const buildings = builds.filter((row) => ISLAND_TYPES[row.island_type]?.onIsland).map(facility);
  const pending = { island_transport: 0, island_resort: 0 };
  const lastChange = { island_transport: null, island_resort: null };
  for (const row of rows) {
    const category = ISLAND_TYPES[row.island_type]?.category;
    if (!category) continue;
    if (row.status === 'bidding' || row.status === 'building') {
      // repairs never count as capacity changes (only builds and the cruise expansion are stored here)
      pending[category] += 1;
    }
    if (row.status === 'completed' && known(row.completed_minute)) {
      lastChange[category] = Math.max(lastChange[category] ?? -Infinity, Number(row.completed_minute));
    }
  }
  const cruisePending = rows.some((row) => row.kind === 'expansion' && ['bidding', 'building'].includes(row.status));
  return { pier, ferry, buildings, pending, lastChange, cruisePending };
}
const windowCounts = (minute) => [[minute - DAY, minute], [minute - 2 * DAY, minute - DAY]];
export async function readIslandState(client, { worldId, worldMinutes, env = process.env }) {
  if (!await active(client, env)) return null;
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const works = summarizeIslandWorks(await readIslandWorks(client, worldId));
  const hourNow = Math.floor(minute / 60);
  const hours = await client.query(`SELECT world_hour::bigint AS hour,beach_sessions,beach_agents::text[] AS agents
    FROM world_island_demand_hours WHERE world_id=$1 AND world_hour >= $2 AND world_hour < $3`, [worldId, hourNow - 48, hourNow]);
  const beachDays = [0, 1].map((day) => {
    const from = hourNow - 24 * (day + 1), to = hourNow - 24 * day;
    const rows = hours.rows.filter((row) => Number(row.hour) >= from && Number(row.hour) < to);
    return { sessions: rows.reduce((sum, row) => sum + (Number(row.beach_sessions) || 0), 0),
      residents: new Set(rows.flatMap((row) => row.agents || [])).size, hours: rows.length };
  });
  const usesIn = async (workId) => {
    if (!workId) return [null, null];
    const out = [];
    for (const [from, to] of windowCounts(minute)) {
      const row = await client.query(`SELECT count(*)::int AS n FROM world_public_work_uses WHERE world_id=$1 AND work_id=$2
        AND world_minute >= $3 AND world_minute < $4`, [worldId, workId, from, to]);
      out.push(Number(row.rows[0]?.n) || 0);
    }
    return out;
  };
  // Pier strolls only (boardings of ferry passengers are logged too, but the ferry rule counts strolls).
  const pierUseDays = [];
  if (works.pier?.workId && works.pier.stage === 'built') {
    for (const [from, to] of windowCounts(minute)) {
      const row = await client.query(`SELECT count(*)::int AS n FROM world_public_work_uses WHERE world_id=$1 AND work_id=$2
        AND activity<>'ferry_boarding' AND world_minute >= $3 AND world_minute < $4`, [worldId, works.pier.workId, from, to]);
      pierUseDays.push(Number(row.rows[0]?.n) || 0);
    }
  }
  for (const building of works.buildings) building.usesDays = building.stage === 'built' ? await usesIn(building.workId) : [null, null];
  const visitDays = [], sailingDays = [];
  if (works.ferry?.stage === 'built') {
    for (const [from, to] of windowCounts(minute)) {
      const visits = await client.query(`SELECT count(*)::int AS n FROM world_ferry_trips WHERE world_id=$1 AND status='completed'
        AND return_arrive_world_minute >= $2 AND return_arrive_world_minute < $3`, [worldId, from, to]);
      visitDays.push(Number(visits.rows[0]?.n) || 0);
      const loads = await client.query(`SELECT depart_world_minute::bigint AS depart,count(*)::int AS n,max(seats)::int AS seats
        FROM world_ferry_trips WHERE world_id=$1 AND depart_world_minute >= $2 AND depart_world_minute < $3 GROUP BY 1`, [worldId, from, to]);
      const opened = works.ferry.completedMinute ?? Infinity;
      let sailings = 0;
      for (let day = Math.floor(from / DAY); day <= Math.floor((to - 1) / DAY); day += 1) {
        for (const slot of VISITOR_DEPARTURES) { const at = day * DAY + slot; if (at >= from && at < to && at >= opened) sailings += 1; }
      }
      const full = loads.rows.filter((row) => Number(row.n) >= Number(row.seats || ferrySeats(works.ferry.level))).length;
      sailingDays.push(sailings > 0 ? { sailings, full } : null);
    }
  }
  return { worldMinutes: minute, flags: ferryIslandFlags(env), ...works, beachDays, pierUseDays, visitDays, sailingDays };
}

// ---- hourly engine cache ----------------------------------------------------------------------------------------
let ferryContext = { worldId: null, hour: null, enabled: false };
export function currentFerryContext() { return ferryContext; }
export function setFerryContext(next) { ferryContext = next; }
export async function refreshFerryContext(client, { worldId, worldMinutes = 0, force = false, env = process.env }) {
  const hour = Math.floor((Number(worldMinutes) || 0) / 60);
  if (!ferryIslandEnabled(env)) { ferryContext = { worldId, hour, enabled: false }; return ferryContext; }
  if (!force && ferryContext.worldId === worldId && ferryContext.hour === hour) return ferryContext;
  if (!await ferryIslandReady(client)) { ferryContext = { worldId, hour, enabled: false }; return ferryContext; }
  ferryContext = await guardedIsland(client, { worldId, hour, enabled: false }, async () => {
    const works = summarizeIslandWorks(await readIslandWorks(client, worldId));
    const minute = Math.trunc(Number(worldMinutes) || 0);
    const next = { worldId, hour, enabled: Boolean(works.pier), sailings: ferryIslandPhaseEnabled('sailings', env),
      strolls: ferryIslandPhaseEnabled('sailings', env), pier: works.pier, ferry: works.ferry, buildings: works.buildings,
      pierSceneName: works.pier?.stage === 'built' ? works.pier.name : null, operatorId: works.ferry?.builderId || null,
      fareRaw: works.ferry ? ferryFareRaw(works.ferry.level) : null, balances: new Map(), recentVisitors: new Map(),
      seats: new Map(), returnSeats: new Map() };
    if (works.ferry?.stage === 'built' && next.sailings) {
      const balances = await client.query(`SELECT agent_id::text AS agent_id,spendable_raw::text AS spendable FROM arc_sync_internal_balances
        WHERE world_id=$1`, [worldId]);
      next.balances = new Map(balances.rows.map((row) => [row.agent_id, BigInt(row.spendable || '0')]));
      const trips = await client.query(`SELECT agent_id::text AS agent_id,depart_world_minute::bigint AS depart,
          return_sailing_world_minute::bigint AS back FROM world_ferry_trips WHERE world_id=$1 AND depart_world_minute >= $2`,
      [worldId, minute - DAY]);
      for (const row of trips.rows) {
        const depart = Number(row.depart), back = Number(row.back);
        next.seats.set(depart, (next.seats.get(depart) || 0) + 1);
        next.returnSeats.set(back, (next.returnSeats.get(back) || 0) + 1);
        next.recentVisitors.set(row.agent_id, Math.max(next.recentVisitors.get(row.agent_id) ?? -Infinity, depart));
      }
    }
    return next;
  });
  return ferryContext;
}

// ---- booking -------------------------------------------------------------------------------------------------
function coded(code) { return Object.assign(new Error(code), { code, statusCode: 409 }); }
async function readFerry(client, worldId) {
  const row = (await client.query(`SELECT work.id::text AS work_id,work.builder_agent_id::text AS operator_id,
      COALESCE((scene.features->'publicWork'->>'level')::int,1) AS level,scene.name AS scene_name
    FROM world_island_works iw JOIN world_public_works work ON work.id=iw.work_id
    LEFT JOIN world_scenes scene ON scene.id=work.scene_id
    WHERE iw.world_id=$1 AND iw.island_type='ferry' AND work.kind<>'expansion' AND work.status='completed'
    ORDER BY work.completed_world_minute LIMIT 1`, [worldId])).rows[0];
  return row ? { workId: row.work_id, operatorId: row.operator_id, level: Math.min(MAX_FERRY_LEVEL, Number(row.level) || 1), name: row.scene_name } : null;
}
export async function bookFerryTrip(client, { worldId, agentId, worldMinutes, walkMinutes = 10, env = process.env }) {
  if (!ferryIslandPhaseEnabled('sailings', env) || !await ferryIslandReady(client)) throw coded('FERRY_SWITCHED_OFF');
  const minute = Math.trunc(Number(worldMinutes) || 0);
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('mirrorterra_ferry:' || $1::text))`, [worldId]);
  const ferry = await readFerry(client, worldId);
  if (!ferry) throw coded('FERRY_NOT_BUILT');
  const trip = bookableSailing(minute, walkMinutes);
  if (!trip) throw coded('FERRY_NO_SAILING');
  const seats = ferrySeats(ferry.level);
  const load = await client.query(`SELECT
      (SELECT count(*)::int FROM world_ferry_trips WHERE world_id=$1 AND depart_world_minute=$2) AS outbound,
      (SELECT count(*)::int FROM world_ferry_trips WHERE world_id=$1 AND return_sailing_world_minute=$3) AS inbound,
      (SELECT count(*)::int FROM world_ferry_trips WHERE world_id=$1 AND agent_id=$4 AND status='booked') AS mine`,
  [worldId, trip.departMinute, trip.returnSailingMinute, agentId]);
  const counts = load.rows[0] || {};
  if (Number(counts.mine) > 0) throw coded('FERRY_ALREADY_BOOKED');
  if (Number(counts.outbound) >= seats || Number(counts.inbound) >= seats) throw coded('FERRY_FULL');
  const operatorRides = !ferry.operatorId || String(ferry.operatorId) === String(agentId);
  const fare = operatorRides ? 0n : ferryFareRaw(ferry.level);
  let transferId = null;
  if (fare > 0n) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`sync-internal:${worldId}:${agentId}`]);
    const balance = await client.query(`SELECT spendable_raw::text AS spendable FROM arc_sync_internal_balances
      WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]);
    if (BigInt(balance.rows[0]?.spendable || '0') < fare) throw coded('FERRY_FARE_UNAFFORDABLE');
    await client.query('SAVEPOINT ferry_fare_transfer');
    try {
      const inserted = await client.query(`INSERT INTO arc_sync_internal_transfers(world_id,action_id,from_agent_id,to_agent_id,
          amount_raw,kind,source_ref,world_minute) VALUES($1,$2,$3,$4,$5::numeric,'business_service_payment',$6,$7) RETURNING id::text AS id`,
      [worldId, `ferry-fare:${sha(`${worldId}:${agentId}:${trip.departMinute}`)}`, agentId, ferry.operatorId, fare.toString(),
        `ferry:${ferry.workId.slice(0, 8)}:${trip.departMinute}`, minute]);
      transferId = inserted.rows[0].id;
      await client.query('RELEASE SAVEPOINT ferry_fare_transfer');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT ferry_fare_transfer');
      await client.query('RELEASE SAVEPOINT ferry_fare_transfer');
      throw coded('FERRY_FARE_REJECTED');
    }
  }
  const row = await client.query(`INSERT INTO world_ferry_trips(world_id,agent_id,ferry_work_id,operator_agent_id,ferry_level,seats,
      depart_world_minute,arrive_island_world_minute,return_sailing_world_minute,return_depart_world_minute,return_arrive_world_minute,
      fare_raw,transfer_id,booked_world_minute) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::numeric,$13,$14) RETURNING id::text AS id`,
  [worldId, agentId, ferry.workId, ferry.operatorId, ferry.level, seats, trip.departMinute, trip.arriveIslandMinute,
    trip.returnSailingMinute, trip.returnDepartMinute, trip.returnArriveMinute, fare.toString(), transferId, minute]);
  if (ferryContext.worldId === worldId && ferryContext.seats) {
    ferryContext.seats.set(trip.departMinute, (ferryContext.seats.get(trip.departMinute) || 0) + 1);
    ferryContext.returnSeats.set(trip.returnSailingMinute, (ferryContext.returnSeats.get(trip.returnSailingMinute) || 0) + 1);
    ferryContext.recentVisitors.set(agentId, trip.departMinute);
    if (fare > 0n && ferryContext.balances?.has(agentId)) ferryContext.balances.set(agentId, ferryContext.balances.get(agentId) - fare);
  }
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'world.ferry_trip_booked',$3::jsonb,$4)
    ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`, [worldId, agentId,
    JSON.stringify({ place: ferry.name, island: ISLAND_NAME, departMinute: trip.departMinute, returnArriveMinute: trip.returnArriveMinute,
      fareRaw: fare.toString(), seats, worldMinutes: minute }), `ferry-trip:${row.rows[0].id}:booked`]);
  return { tripId: row.rows[0].id, ferryWorkId: ferry.workId, operatorId: ferry.operatorId, level: ferry.level, seats,
    fareRaw: fare.toString(), transferId, ...trip };
}

// ---- trip completion and pier strolls ---------------------------------------------------------------------------
async function isExternal(client, worldId, agentId) {
  return guardedIsland(client, false, async () => (await client.query(`SELECT 1 FROM world_external_residents
    WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId])).rowCount > 0);
}
async function logUse(client, { worldId, workId, sceneId, agentId, type, activity, useKind, external, minute, effect }) {
  await client.query(`INSERT INTO world_public_work_uses(world_id,work_id,scene_id,agent_id,building_type,activity,use_kind,external,
      world_minute,effect) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
  [worldId, workId, sceneId, agentId, type, activity, useKind, external, minute, JSON.stringify(effect || {})]);
  await client.query(`UPDATE world_public_work_conditions SET condition=GREATEST(0,condition-$3),uses_total=uses_total+1
    WHERE world_id=$1 AND work_id=$2`, [worldId, workId, USE_WEAR]);
}
export async function completeFerryTrip(client, { worldId, agentId, tripId, worldMinutes, env = process.env }) {
  if (!await active(client, env) || !tripId) return null;
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const trip = (await client.query(`SELECT id::text AS id,ferry_work_id::text AS ferry_work_id,ferry_level,return_arrive_world_minute::bigint AS back
    FROM world_ferry_trips WHERE world_id=$1 AND id=$2 AND agent_id=$3 AND status='booked' FOR UPDATE`, [worldId, tripId, agentId])).rows[0];
  if (!trip) return null;
  const works = summarizeIslandWorks(await readIslandWorks(client, worldId));
  for (const building of works.buildings) {
    if (building.stage !== 'built') continue;
    const row = await client.query(`SELECT count(*)::int AS n FROM world_public_work_uses WHERE world_id=$1 AND work_id=$2 AND world_minute >= $3`,
      [worldId, building.workId, minute - DAY]);
    building.usesToday = Number(row.rows[0]?.n) || 0;
  }
  const effect = islandVisitEffect({ buildings: works.buildings, ferryLevel: trip.ferry_level });
  const external = await isExternal(client, worldId, agentId);
  for (const used of effect.used) {
    await logUse(client, { worldId, workId: used.workId, sceneId: used.sceneId, agentId, type: used.type, activity: 'rest',
      useKind: used.useKind, external, minute, effect: { island: ISLAND_NAME, factor: used.factor, tripId: Number(trip.id) } });
  }
  if (works.ferry?.workId) await logUse(client, { worldId, workId: works.ferry.workId, sceneId: works.ferry.sceneId, agentId, type: 'ferry',
    activity: 'ferry_crossing', useKind: 'leisure', external, minute, effect: { tripId: Number(trip.id), level: Number(trip.ferry_level) } });
  if (works.pier?.workId) await logUse(client, { worldId, workId: works.pier.workId, sceneId: works.pier.sceneId, agentId, type: 'pier',
    activity: 'ferry_boarding', useKind: 'leisure', external, minute, effect: { tripId: Number(trip.id) } });
  await client.query(`UPDATE world_ferry_trips SET status='completed',completed_world_minute=$3,effect=$4::jsonb
    WHERE world_id=$1 AND id=$2 AND status='booked'`, [worldId, trip.id, minute,
    JSON.stringify({ needs: effect.needs, used: effect.used.map((item) => item.type) })]);
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id) VALUES($1,$2,'world.ferry_trip_completed',$3::jsonb,$4)
    ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`, [worldId, agentId,
    JSON.stringify({ island: ISLAND_NAME, needs: effect.needs, used: effect.used.map((item) => item.type), worldMinutes: minute }),
    `ferry-trip:${trip.id}:completed`]);
  return { tripId: trip.id, place: ISLAND_NAME, type: 'island_visit', useKind: 'leisure', needs: effect.needs,
    used: effect.used.map((item) => item.type) };
}
export async function applyPierStroll(client, { worldId, agentId, scene, activity, worldMinutes, env = process.env }) {
  if (!['rest', 'socialize'].includes(activity) || scene?.features?.islandType !== 'pier') return null;
  if (!ferryIslandPhaseEnabled('sailings', env) || !await ferryIslandReady(client)) return null;
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const row = (await client.query(`SELECT work.id::text AS id,cond.condition::float8 AS condition,
      (SELECT count(*)::int FROM world_public_work_uses used WHERE used.world_id=work.world_id AND used.work_id=work.id
        AND used.activity<>'ferry_boarding' AND used.world_minute >= $3) AS today
    FROM world_public_works work JOIN world_island_works iw ON iw.work_id=work.id
    LEFT JOIN world_public_work_conditions cond ON cond.work_id=work.id
    WHERE work.world_id=$1 AND work.scene_id=$2 AND work.status='completed' AND work.kind<>'expansion' AND iw.island_type='pier' LIMIT 1`,
  [worldId, scene.id, minute - DAY])).rows[0];
  if (!row) return null;
  const effect = pierStrollEffect({ condition: row.condition ?? 100, usesToday: row.today });
  if (!effect.used) return null;
  await logUse(client, { worldId, workId: row.id, sceneId: scene.id, agentId, type: 'pier', activity, useKind: 'leisure',
    external: await isExternal(client, worldId, agentId), minute, effect: { needs: effect.needs, factor: effect.factor } });
  return { workId: row.id, place: scene.name, type: 'pier', useKind: 'leisure', needs: effect.needs, capacity: PIER_CAPACITY };
}
// Booked trips whose return is long past and that never completed (the resident never boarded): marked missed.
// The fare stays with the operator (a no-show ticket); nothing else changes.
export async function sweepMissedFerryTrips(client, { worldId, worldMinutes, env = process.env }) {
  if (!await active(client, env)) return 0;
  const result = await client.query(`UPDATE world_ferry_trips trip SET status='missed',completed_world_minute=$2
    WHERE trip.world_id=$1 AND trip.status='booked' AND trip.return_arrive_world_minute < $2 - 180
      AND NOT EXISTS (SELECT 1 FROM world_agent_states state WHERE state.world_id=trip.world_id AND state.agent_id=trip.agent_id
        AND state.status='performing' AND state.planned_context->'ferryTrip'->>'tripId' = trip.id::text)`,
  [worldId, Math.trunc(Number(worldMinutes) || 0)]);
  return result.rowCount || 0;
}

// ---- public map block -----------------------------------------------------------------------------------------
export async function readFerryMapBlock(pool, { worldId, worldMinutes, env = process.env }) {
  if (!ferryIslandEnabled(env) || !await ferryIslandReady(pool)) return null;
  return guardedIsland(pool, null, () => readFerryMapBlockUnguarded(pool, { worldId, worldMinutes }));
}
async function readFerryMapBlockUnguarded(pool, { worldId, worldMinutes }) {
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const works = summarizeIslandWorks(await readIslandWorks(pool, worldId));
  const trips = works.ferry ? (await pool.query(`SELECT agent_id::text AS agent_id,depart_world_minute::bigint AS depart,
      arrive_island_world_minute::bigint AS arrive,return_depart_world_minute::bigint AS back_depart,
      return_arrive_world_minute::bigint AS back_arrive,status FROM world_ferry_trips
    WHERE world_id=$1 AND status='booked' AND return_arrive_world_minute >= $2 ORDER BY depart_world_minute LIMIT 80`, [worldId, minute - 10])).rows : [];
  const pub = (item) => item ? { type: item.type, name: item.name, stage: item.stage, progress: item.progress, level: item.level,
    condition: Math.round(item.condition) } : null;
  return { island: { name: ISLAND_NAME }, worldMinutes: minute, timetable: { departures: DEPARTURES, crossingMinutes: CROSSING_MINUTES },
    pier: pub(works.pier),
    ferry: works.ferry ? { ...pub(works.ferry), seats: ferrySeats(works.ferry.level), cruise: works.ferry.level >= 2,
      operatorName: works.ferry.builderName || null, fareSync: Number(ferryFareRaw(works.ferry.level)) / 1e6,
      expansionPending: works.cruisePending } : null,
    boat: works.ferry?.stage === 'built' ? boatState(minute) : null,
    buildings: works.buildings.map(pub),
    trips: trips.map((row) => ({ agentId: row.agent_id, departMinute: Number(row.depart), arriveIslandMinute: Number(row.arrive),
      returnDepartMinute: Number(row.back_depart), returnArriveMinute: Number(row.back_arrive) })) };
}
export { isIslandType };
