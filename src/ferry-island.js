// island1: a ferry and a neighbouring resort island (Lantern Isle), built up by the residents through the
// existing public-works path (user decisions 2026-10-24 14:13 CST). Pure rules only (no database):
//   - the island starts EMPTY (sand and trees); nothing on it is pre-placed;
//   - phase A, the pier on the main shore by the beach cove, is commissioned only after SUSTAINED beach use;
//   - phase B, the ferry, only after the pier is really used (strolls out on the pier);
//   - phase C, island buildings (beach resort, boardwalk, island cafe), only after crossings are measured,
//     one at a time, each next one only while the existing ones are used;
//   - phase D, the cruise ship (ferry level 2), only after sailings ran full on two world days.
// Town rules hold for every phase: build only what residents use, one expansion level at a time, no new build
// of a category while one is pending, 48 world hours between capacity changes of a category, no repairs of
// unused buildings (the growth2 repair rule applies to island buildings unchanged).
// Money: the treasury pays builders through the unchanged tender -> contract -> milestone path. A ferry fare is
// a resident-to-resident internal SYNC transfer to the ferry's operator (the resident who built and runs it):
// nothing here mints, burns or moves SYNC by itself; fareSettlement() only describes the transfer.
import { conditionFactor, levelFactor } from './public-works-growth.js';

// ---- types ------------------------------------------------------------------------------------------
// storedKind: the legacy world_public_works.kind / world_public_work_meta.building_type the row is stored under
// (both CHECKs unchanged; the real type lives in world_island_works, migration 0036). The rollback release
// (observer2) sees a pier/ferry as a road (infrastructure, no use spec, no passive buff because the scene kind
// is 'pier'/'ferry'), the resort and boardwalk as parks and the cafe as a community hall.
export const ISLAND_NAME = 'Lantern Isle';
export const ISLAND_TYPES = Object.freeze({
  pier: { label: 'Cove Pier', baseSync: 12, skill: 'engineering', archetype: 'island_pier', accent: '#b0814f', icon: '⚓',
    storedKind: 'road', phase: 'pier', category: 'island_transport', onIsland: false,
    benefit: { pier: 1 }, effect: 'Pier: a stroll out over the water; later the ferry to Lantern Isle docks here.' },
  ferry: { label: 'Lantern Ferry', baseSync: 22, skill: 'engineering', archetype: 'island_ferry', accent: '#2f7fb8', icon: '⛴',
    storedKind: 'road', phase: 'ferry', category: 'island_transport', onIsland: false,
    benefit: { ferry: 1 }, effect: 'Ferry: scheduled sailings to Lantern Isle (about 75 world minutes each way); fares go to the resident who runs it.' },
  resort: { label: 'Lantern Isle Beach Resort', baseSync: 24, skill: 'social', archetype: 'island_resort', accent: '#e07a5f', icon: '☀',
    storedKind: 'park', phase: 'resort', category: 'island_resort', onIsland: true, islandSlot: 0,
    useKind: 'leisure', capacity: 10, gains: { energy: 18, fun: 10, hygiene: 10, happiness: 6 },
    benefit: { resort: 1 }, effect: 'Beach resort: island visitors rest in a real retreat (energy, hygiene, fun and happiness).' },
  boardwalk: { label: 'Lantern Isle Boardwalk', baseSync: 9, skill: 'engineering', archetype: 'island_boardwalk', accent: '#c9a36b', icon: '≋',
    storedKind: 'park', phase: 'resort', category: 'island_resort', onIsland: true, islandSlot: 1,
    useKind: 'leisure', capacity: 14, gains: { fun: 10, social: 6, happiness: 3 },
    benefit: { boardwalk: 1 }, effect: 'Boardwalk: island visitors stroll together along the shore (fun and company).' },
  island_cafe: { label: 'Lantern Isle Cafe', baseSync: 12, skill: 'social', archetype: 'island_cafe', accent: '#3fa7a0', icon: '☕',
    storedKind: 'public_building', phase: 'resort', category: 'island_resort', onIsland: true, islandSlot: 2,
    useKind: 'social', capacity: 12, gains: { food: 30, social: 12, happiness: 3 },
    benefit: { cafe: 1 }, effect: 'Island cafe: visitors share a meal by the sea (food and company).' }
});
export const ISLAND_TYPE_LIST = Object.freeze(Object.keys(ISLAND_TYPES));
export const RESORT_SEQUENCE = Object.freeze(['resort', 'boardwalk', 'island_cafe']);
export const isIslandType = (type) => Object.prototype.hasOwnProperty.call(ISLAND_TYPES, type);
export const CRUISE_PRICE_SYNC = 30;           // the cruise ship (ferry level 2) is a new, bigger vessel
export const MAX_FERRY_LEVEL = 2;              // level 2 = cruise ship; nothing beyond it in this release

// ---- geometry (server coordinates; the 3D map lays the island out itself) ---------------------------------
// The beach cove is at (0.35, 1.45). The pier sits on the shore just past it; the island lies across a narrow
// strait in the same direction. Island scenes carry district 0 (the ring math ignores them: no road/bridge
// demand, no outer-district count) and civic=true; features.island names the island district.
export const MAIN_PIER_POSITION = Object.freeze({ x: 0.4, z: 1.62, district: 0, civic: true, coastal: true, island: null });
export const ISLAND_CENTER = Object.freeze({ x: 0.62, z: 2.55 });
export function islandSlotPosition(type) {
  const slot = ISLAND_TYPES[type]?.islandSlot ?? 0;
  const angle = -2.2 + slot * 1.25;
  return { x: Math.round((ISLAND_CENTER.x + Math.cos(angle) * 0.07) * 1000) / 1000,
    z: Math.round((ISLAND_CENTER.z + Math.sin(angle) * 0.07) * 1000) / 1000, district: 0, civic: true, island: 'lantern' };
}
export function islandPosition(type) {
  return ISLAND_TYPES[type]?.onIsland ? islandSlotPosition(type) : { ...MAIN_PIER_POSITION };
}

// ---- timetable (world minutes; one boat cycles all day) ---------------------------------------------------
// Departures from the main pier 07:00, 10:00, 13:00, 16:00, 19:00. Each leg takes 75 world minutes; the boat
// waits 15 minutes at the island and returns, arriving back 165 minutes after it left. A visitor goes out on
// one sailing and comes back on the NEXT sailing's return leg (about 3 h 15 min on the island), so the last
// visitor departure is 16:00 (back at 21:45). The whole trip costs ~5 h 45 min plus the walk and the wait.
export const CROSSING_MINUTES = 75;
export const ISLAND_LAYOVER_MINUTES = 15;
export const SAILING_PERIOD_MINUTES = 180;
export const DEPARTURES = Object.freeze([420, 600, 780, 960, 1140]);
export const VISITOR_DEPARTURES = Object.freeze(DEPARTURES.slice(0, -1));
export const BOARDING_BUFFER_MINUTES = 8;       // a resident books a sailing at least walk + 8 minutes ahead
export const MAX_WAIT_MINUTES = 100;            // ... and at most 100 minutes after arriving at the pier
const DAY = 1440;
export function sailingLegs(departMinute) {
  const d = Math.trunc(Number(departMinute));
  return { departMinute: d, outbound: { depart: d, arrive: d + CROSSING_MINUTES },
    inbound: { depart: d + CROSSING_MINUTES + ISLAND_LAYOVER_MINUTES, arrive: d + 2 * CROSSING_MINUTES + ISLAND_LAYOVER_MINUTES } };
}
// The next departure from the main pier at or after `minute` (absolute world minutes), or null.
export function nextDeparture(minute, { visitor = true } = {}) {
  const m = Math.trunc(Number(minute) || 0);
  const list = visitor ? VISITOR_DEPARTURES : DEPARTURES;
  const dayStart = Math.floor(m / DAY) * DAY;
  for (let day = 0; day < 2; day += 1) for (const slot of list) {
    const at = dayStart + day * DAY + slot;
    if (at >= m) return at;
  }
  return null;
}
// A visitor trip: out on `departMinute`, back on the next sailing's return leg.
export function visitorTrip(departMinute) {
  const out = sailingLegs(departMinute);
  const back = sailingLegs(Number(departMinute) + SAILING_PERIOD_MINUTES);
  return { departMinute: out.outbound.depart, arriveIslandMinute: out.outbound.arrive, returnDepartMinute: back.inbound.depart,
    returnArriveMinute: back.inbound.arrive, islandMinutes: back.inbound.depart - out.outbound.arrive,
    returnSailingMinute: back.departMinute };
}
// The sailing a resident leaving now could take (or null): departs >= now + walk + buffer, <= arrival + MAX_WAIT.
export function bookableSailing(worldMinutes, walkMinutes = 10) {
  const ready = Math.trunc(Number(worldMinutes) || 0) + Math.max(0, Math.round(Number(walkMinutes) || 0)) + BOARDING_BUFFER_MINUTES;
  const depart = nextDeparture(ready, { visitor: true });
  if (depart === null || depart - ready > MAX_WAIT_MINUTES) return null;
  return visitorTrip(depart);
}
// Where the boat is at `minute` (map): { state: 'docked_main'|'outbound'|'docked_island'|'inbound', progress,
// departMinute }. Outside the timetable it rests at the main pier.
export function boatState(minute) {
  const m = Number(minute) || 0;
  const dayStart = Math.floor(m / DAY) * DAY;
  for (const slot of [...DEPARTURES].reverse()) {
    const legs = sailingLegs(dayStart + slot);
    if (m < legs.outbound.depart) continue;
    if (m < legs.outbound.arrive) return { state: 'outbound', progress: (m - legs.outbound.depart) / CROSSING_MINUTES, departMinute: legs.departMinute };
    if (m < legs.inbound.depart) return { state: 'docked_island', progress: 1, departMinute: legs.departMinute };
    if (m < legs.inbound.arrive) return { state: 'inbound', progress: (m - legs.inbound.depart) / CROSSING_MINUTES, departMinute: legs.departMinute };
    return { state: 'docked_main', progress: 0, departMinute: legs.departMinute };
  }
  return { state: 'docked_main', progress: 0, departMinute: null };
}
// The phase of one visitor's trip at `minute` (map: where to draw the resident).
export function tripPhase(trip, minute) {
  const m = Number(minute) || 0;
  if (!trip) return null;
  if (m < trip.departMinute) return 'waiting';
  if (m < trip.arriveIslandMinute) return 'outbound';
  if (m < trip.returnDepartMinute) return 'island';
  if (m < trip.returnArriveMinute) return 'inbound';
  return 'back';
}

// ---- seats and fares --------------------------------------------------------------------------------------
export function ferrySeats(level = 1) {
  const L = Math.max(1, Math.min(MAX_FERRY_LEVEL, Math.trunc(Number(level) || 1)));
  return L >= 2 ? 16 : 6;
}
export const FARE_RAW = Object.freeze({ 1: 300_000n, 2: 450_000n });   // 0.30 / 0.45 SYNC round trip
export function ferryFareRaw(level = 1) {
  const L = Math.max(1, Math.min(MAX_FERRY_LEVEL, Math.trunc(Number(level) || 1)));
  return FARE_RAW[L];
}
// The fare as a transfer: who pays whom how much. Conserving by construction (one debit, one equal credit).
// The operator rides free (no self-transfer). Returns null when the payer cannot pay.
export function fareSettlement({ passengerId, operatorId, fareRaw, passengerSpendableRaw }) {
  const fare = BigInt(fareRaw ?? 0n);
  if (!operatorId || fare <= 0n) return { transfer: null, free: true, reason: 'no_fare' };
  if (String(passengerId) === String(operatorId)) return { transfer: null, free: true, reason: 'operator_rides_free' };
  if (BigInt(passengerSpendableRaw ?? 0n) < fare) return null;
  return { transfer: { from: String(passengerId), to: String(operatorId), amountRaw: fare, kind: 'business_service_payment' }, free: false };
}
export function applyTransfers(balances = {}, transfers = []) {
  const out = Object.fromEntries(Object.entries(balances).map(([key, value]) => [key, BigInt(value)]));
  for (const transfer of transfers) {
    if (!transfer) continue;
    out[transfer.from] = (out[transfer.from] ?? 0n) - BigInt(transfer.amountRaw);
    out[transfer.to] = (out[transfer.to] ?? 0n) + BigInt(transfer.amountRaw);
  }
  return out;
}

// ---- island visit effect ----------------------------------------------------------------------------------
// The empty island already has its beach (a natural attraction); each built island building adds its on-site
// gains while it has capacity left that day (level/condition factors as for every public building). On the
// cruise ship the crossing itself is social. A full island visit gives far more than a park visit (park: fun 14,
// social 6, happiness 4), at the cost of ~6 world hours away.
export const BEACH_GAINS = Object.freeze({ fun: 18, social: 8, happiness: 5 });
export const CRUISE_GAINS = Object.freeze({ fun: 5, social: 6 });
export function islandBuildingCapacity(type, level = 1) {
  const spec = ISLAND_TYPES[type];
  if (!spec?.capacity) return 0;
  return Math.max(1, Math.round(spec.capacity * Math.max(1, Math.trunc(Number(level) || 1)) ** 0.75));
}
export function islandVisitEffect({ buildings = [], ferryLevel = 1 } = {}) {
  const needs = { ...BEACH_GAINS };
  const add = (gains, factor = 1) => {
    for (const [key, value] of Object.entries(gains)) needs[key] = (needs[key] || 0) + Math.max(1, Math.round(value * factor));
  };
  const used = [];
  for (const building of buildings) {
    const spec = ISLAND_TYPES[building?.type];
    if (!spec?.onIsland || building.stage !== 'built') continue;
    const capacity = islandBuildingCapacity(building.type, building.level);
    if ((Number(building.usesToday) || 0) >= capacity) continue;
    const factor = levelFactor(building.level) * conditionFactor(building.condition ?? 100);
    add(spec.gains, factor);
    used.push({ type: building.type, workId: building.workId || null, sceneId: building.sceneId || null, useKind: spec.useKind,
      factor: Math.round(factor * 1000) / 1000 });
  }
  if ((Number(ferryLevel) || 1) >= 2) add(CRUISE_GAINS);
  for (const key of Object.keys(needs)) needs[key] = Math.min(60, needs[key]);
  return { needs, used };
}

// ---- demand rules (phase decisions) ----------------------------------------------------------------------
export const SUSTAIN_DAYS = 2;
export const CHANGE_COOLDOWN_MINUTES = 2880;    // 48 world hours between capacity changes of a category
export const PIER_BEACH_SESSIONS_MIN = 12;      // beach sessions per world day, both of the last two days
export const PIER_BEACH_RESIDENTS_MIN = 4;      // distinct residents at the beach per day
export const MEASURED_HOURS_MIN = 20;           // a day counts as measured with >= 20 hourly samples
export const FERRY_PIER_USES_MIN = 8;           // pier strolls per world day, both days
export const RESORT_VISITS_MIN = 6;             // island visits (completed crossings) per world day, both days
export const RESORT_BUSY = 0.6;                 // every island building >= 60% used before the next one
export const CRUISE_FULL_SAILINGS_MIN = 2;      // full sailings per world day, both days ...
export const CRUISE_FULL_SHARE = 0.5;           // ... and at least half of the sailings that ran
export const ISLAND_REPAIR_THRESHOLD = 70;
const known = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
const days = (list) => (Array.isArray(list) ? list.slice(0, SUSTAIN_DAYS) : []);
function cooldownLeft(lastChangeMinute, worldMinutes) {
  if (!known(lastChangeMinute)) return 0;
  return Math.max(0, CHANGE_COOLDOWN_MINUTES - (Number(worldMinutes) - Number(lastChangeMinute)));
}
// Phase A. beachDays: [{ sessions, residents, hours }] newest first (index 0 = the last 24 world h).
export function pierDecision({ flags = {}, pier = null, pending = {}, beachDays = [], worldMinutes = 0 } = {}) {
  if (!flags.master || !flags.pier) return { ok: false, reason: 'switched_off' };
  if (pier) return { ok: false, reason: 'pier_exists' };
  if ((pending.island_transport || 0) > 0) return { ok: false, reason: 'pending_change' };
  const d = days(beachDays);
  if (d.length < SUSTAIN_DAYS || d.some((day) => (Number(day?.hours) || 0) < MEASURED_HOURS_MIN)) return { ok: false, reason: 'no_measurement' };
  if (d.some((day) => Number(day.sessions) < PIER_BEACH_SESSIONS_MIN || Number(day.residents) < PIER_BEACH_RESIDENTS_MIN)) {
    return { ok: false, reason: 'not_sustained', days: d };
  }
  return { ok: true, days: d,
    reason: `Beach cove used on both of the last two world days: ${d[0].sessions} sessions by ${d[0].residents} residents in 24 h and ${d[1].sessions} by ${d[1].residents} the day before (need ${PIER_BEACH_SESSIONS_MIN} by ${PIER_BEACH_RESIDENTS_MIN}+ each day).` };
}
// Phase B. pierUseDays: [n24h, nPrev24h] strolls on the pier.
export function ferryDecision({ flags = {}, pier = null, ferry = null, pending = {}, pierUseDays = [], lastChange = {}, worldMinutes = 0 } = {}) {
  if (!flags.master || !flags.ferry) return { ok: false, reason: 'switched_off' };
  if (!pier || pier.stage !== 'built') return { ok: false, reason: 'no_pier' };
  if (ferry) return { ok: false, reason: 'ferry_exists' };
  if ((pending.island_transport || 0) > 0) return { ok: false, reason: 'pending_change' };
  const wait = cooldownLeft(lastChange.island_transport ?? pier.completedMinute, worldMinutes);
  if (wait > 0) return { ok: false, reason: 'cooldown', waitMinutes: wait };
  const d = days(pierUseDays);
  if (d.length < SUSTAIN_DAYS || d.some((value) => !known(value))) return { ok: false, reason: 'no_measurement' };
  if (d.some((value) => Number(value) < FERRY_PIER_USES_MIN)) return { ok: false, reason: 'not_sustained', days: d };
  return { ok: true, days: d,
    reason: `Cove Pier used ${d[0]} times in 24 h and ${d[1]} the day before (need ${FERRY_PIER_USES_MIN}+ on both days); residents look across to ${ISLAND_NAME} but cannot get there.` };
}
// Phase C. buildings: island buildings (built or pending); visitDays: [n24h, nPrev24h] completed island visits.
// Each building: { type, stage, usesDays: [n24h, nPrev24h], level }.
export function resortDecision({ flags = {}, ferry = null, buildings = [], pending = {}, visitDays = [], lastChange = {}, worldMinutes = 0 } = {}) {
  if (!flags.master || !flags.resort) return { ok: false, reason: 'switched_off' };
  if (!ferry || ferry.stage !== 'built') return { ok: false, reason: 'no_ferry' };
  if ((pending.island_resort || 0) > 0) return { ok: false, reason: 'pending_change' };
  const next = RESORT_SEQUENCE.find((type) => !buildings.some((building) => building.type === type));
  if (!next) return { ok: false, reason: 'island_complete' };
  const wait = cooldownLeft(lastChange.island_resort ?? ferry.completedMinute, worldMinutes);
  if (wait > 0) return { ok: false, reason: 'cooldown', waitMinutes: wait };
  const d = days(visitDays);
  if (d.length < SUSTAIN_DAYS || d.some((value) => !known(value))) return { ok: false, reason: 'no_measurement' };
  if (d.some((value) => Number(value) < RESORT_VISITS_MIN)) return { ok: false, reason: 'not_sustained', days: d };
  for (const building of buildings.filter((item) => item.stage === 'built')) {
    const capacity = islandBuildingCapacity(building.type, building.level);
    const use = days(building.usesDays);
    if (use.length < SUSTAIN_DAYS || use.some((value) => !known(value) || Number(value) / capacity < RESORT_BUSY)) {
      return { ok: false, reason: 'existing_not_used', building: building.type, usesDays: use, capacity };
    }
  }
  return { ok: true, type: next, days: d,
    reason: `${d[0]} island visits in 24 h and ${d[1]} the day before by ferry (need ${RESORT_VISITS_MIN}+ on both days)`
      + `${buildings.length ? '; every island building is at least 60% used' : '; the island has no building yet'}.` };
}
// Phase D. sailingDays: [{ sailings, full }] newest first; ferry: { level, condition, stage, completedMinute }.
export function cruiseDecision({ flags = {}, ferry = null, pending = {}, sailingDays = [], lastChange = {}, worldMinutes = 0 } = {}) {
  if (!flags.master || !flags.cruise) return { ok: false, reason: 'switched_off' };
  if (!ferry || ferry.stage !== 'built') return { ok: false, reason: 'no_ferry' };
  if ((Number(ferry.level) || 1) >= MAX_FERRY_LEVEL) return { ok: false, reason: 'max_level' };
  if ((pending.island_transport || 0) > 0) return { ok: false, reason: 'pending_change' };
  if (Number(ferry.condition ?? 100) < ISLAND_REPAIR_THRESHOLD) return { ok: false, reason: 'needs_repair' };
  const wait = cooldownLeft(lastChange.island_transport ?? ferry.completedMinute, worldMinutes);
  if (wait > 0) return { ok: false, reason: 'cooldown', waitMinutes: wait };
  const d = days(sailingDays);
  if (d.length < SUSTAIN_DAYS || d.some((day) => !day || !known(day.sailings))) return { ok: false, reason: 'no_measurement' };
  const sustained = d.every((day) => Number(day.full) >= CRUISE_FULL_SAILINGS_MIN
    && Number(day.sailings) > 0 && Number(day.full) / Number(day.sailings) >= CRUISE_FULL_SHARE);
  if (!sustained) return { ok: false, reason: 'not_sustained', days: d };
  return { ok: true, days: d,
    reason: `Lantern Ferry sailed full ${d[0].full} of ${d[0].sailings} times in 24 h and ${d[1].full} of ${d[1].sailings} the day before (${ferrySeats(ferry.level)} seats; need ${CRUISE_FULL_SAILINGS_MIN}+ full and half of all sailings on both days).` };
}

// ---- needs (same shape as publicWorksNeeds) ----------------------------------------------------------------
const RAW = 1_000_000n;
const syncRaw = (sync) => BigInt(Math.round(Number(sync) * 1000)) * RAW / 1000n;
function need(type, { workType = 'build', projectKey, name, score, reason, demand, extra = {} }) {
  const spec = ISLAND_TYPES[type];
  const base = workType === 'expand' ? syncRaw(CRUISE_PRICE_SYNC) : syncRaw(spec.baseSync);
  return { kind: workType === 'build' ? spec.storedKind : 'expansion', buildingType: type, workType, island: true,
    islandType: type, islandPhase: workType === 'expand' ? 'cruise' : spec.phase, storedType: spec.storedKind,
    projectKey, name: String(name).slice(0, 64), score, reason: String(reason).slice(0, 240),
    baseRaw: base.toString(), minRaw: (base * 5_000n / 10_000n).toString(), maxRaw: (base * 20_000n / 10_000n).toString(),
    effect: workType === 'expand' ? 'Cruise ship: the ferry is replaced by a larger ship (16 seats, an on-board lounge: the crossing itself is social).' : spec.effect,
    skill: spec.skill, demand: { island: ISLAND_NAME, ...demand }, ...(workType === 'build' ? { position: islandPosition(type), district: null } : {}), ...extra };
}
// state: readIslandState() output. Returns [] whenever the master switch is off.
export function islandNeeds(state = {}, flags = {}) {
  if (!flags?.master || !state) return [];
  const out = [];
  const minute = Number(state.worldMinutes) || 0;
  const pier = pierDecision({ flags, pier: state.pier, pending: state.pending || {}, beachDays: state.beachDays, worldMinutes: minute });
  if (pier.ok) out.push(need('pier', { projectKey: 'island:pier:1', name: ISLAND_TYPES.pier.label, score: 52, reason: pier.reason,
    demand: { phase: 'pier', beachDays: pier.days } }));
  const ferry = ferryDecision({ flags, pier: state.pier, ferry: state.ferry, pending: state.pending || {}, pierUseDays: state.pierUseDays,
    lastChange: state.lastChange || {}, worldMinutes: minute });
  if (ferry.ok) out.push(need('ferry', { projectKey: 'island:ferry:1', name: ISLAND_TYPES.ferry.label, score: 54, reason: ferry.reason,
    demand: { phase: 'ferry', pierUseDays: ferry.days } }));
  const resort = resortDecision({ flags, ferry: state.ferry, buildings: state.buildings || [], pending: state.pending || {},
    visitDays: state.visitDays, lastChange: state.lastChange || {}, worldMinutes: minute });
  if (resort.ok) out.push(need(resort.type, { projectKey: `island:${resort.type}:1`, name: ISLAND_TYPES[resort.type].label, score: 53,
    reason: resort.reason, demand: { phase: 'resort', visitDays: resort.days } }));
  const cruise = cruiseDecision({ flags, ferry: state.ferry, pending: state.pending || {}, sailingDays: state.sailingDays,
    lastChange: state.lastChange || {}, worldMinutes: minute });
  if (cruise.ok && state.ferry?.workId) {
    const next = (Number(state.ferry.level) || 1) + 1;
    out.push(need('ferry', { workType: 'expand', projectKey: `island:cruise:${next}`, name: 'Lantern Star Cruise Ship', score: 55,
      reason: cruise.reason, demand: { phase: 'cruise', sailingDays: cruise.days },
      extra: { targetWorkId: state.ferry.workId, targetName: state.ferry.name, targetKind: ISLAND_TYPES.ferry.storedKind,
        targetType: 'ferry', targetLevel: next, targetBaseSync: CRUISE_PRICE_SYNC } }));
  }
  return out;
}

// ---- resident affordances ----------------------------------------------------------------------------------
// context: the hourly ferry cache (refreshFerryContext): { enabled, sailings, pierSceneName, ferry: {level, stage},
// fareRaw, operatorId, balances: Map, recentVisitors: Map(agentId -> minute), seats: Map(departMinute -> booked),
// returnSeats: Map(returnSailingMinute -> booked), buildings }.
export const VISIT_COOLDOWN_MINUTES = 1200;     // one island trip per resident per ~day
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
export function islandTripCandidates(agent, context = null, { worldMinutes = 0, walkMinutes = 10 } = {}) {
  if (!context?.enabled || !context.sailings || !context.pierSceneName || context.ferry?.stage !== 'built') return [];
  const energy = num(agent?.energy, 60), food = num(agent?.food, 60), fun = num(agent?.fun, 70);
  const social = num(agent?.social, 50), happiness = num(agent?.happiness, 60);
  if (energy < 35 || food < 40) return [];
  const last = context.recentVisitors?.get?.(agent?.agentId);
  if (last !== undefined && worldMinutes - Number(last) < VISIT_COOLDOWN_MINUTES) return [];
  const trip = bookableSailing(worldMinutes, walkMinutes);
  if (!trip) return [];
  const seats = ferrySeats(context.ferry?.level);
  if ((context.seats?.get?.(trip.departMinute) || 0) >= seats) return [];
  if ((context.returnSeats?.get?.(trip.returnSailingMinute) || 0) >= seats) return [];
  const fare = BigInt(context.fareRaw ?? ferryFareRaw(context.ferry?.level));
  const isOperator = context.operatorId && String(context.operatorId) === String(agent?.agentId);
  if (!isOperator && BigInt(context.balances?.get?.(agent?.agentId) ?? 0n) < fare) return [];
  const built = (context.buildings || []).filter((building) => building.stage === 'built' && ISLAND_TYPES[building.type]?.onIsland).length;
  const wait = trip.departMinute - (worldMinutes + walkMinutes);
  const score = 18 + Math.max(0, 85 - fun) * 0.55 + Math.max(0, 75 - social) * 0.35 + Math.max(0, 80 - happiness) * 0.25
    + built * 4 + ((Number(context.ferry?.level) || 1) >= 2 ? 3 : 0) - Math.max(0, wait - 20) / 6;
  const goal = `Take the ${trip.departMinute % 1440 === 420 ? 'morning' : 'next'} ferry to ${ISLAND_NAME} for a few hours at the beach${built ? ' and the resort' : ''}.`;
  return [{ id: `island_trip:${trip.departMinute}`, action: 'rest', targetLocation: context.pierSceneName, goal, description: goal,
    score: Math.round(score * 10) / 10, plannedPaidMeal: false, side: null, asset: null, quoteUnits: null, socialPartnerId: null,
    socialPartnerName: null, publicWorkUse: 'island_trip', islandTrip: { departMinute: trip.departMinute } }];
}
// Before the ferry exists (and while it runs), the pier itself is a small leisure place: a stroll over the
// water with a view of the island. Its measured use is what justifies the ferry.
export const PIER_STROLL_GAINS = Object.freeze({ fun: 8, social: 3, happiness: 2 });
export const PIER_CAPACITY = 12;
export function pierStrollCandidates(agent, context = null) {
  if (!context?.enabled || !context.strolls || !context.pierSceneName || context.pier?.stage !== 'built') return [];
  const energy = num(agent?.energy, 60), fun = num(agent?.fun, 70), social = num(agent?.social, 50);
  if (energy < 10 || fun >= 85) return [];
  const goal = `Stroll out on ${context.pierSceneName} and look across the strait to ${ISLAND_NAME}.`;
  return [{ id: `pier_stroll:${context.pierSceneName}`, action: 'rest', targetLocation: context.pierSceneName, goal, description: goal,
    score: Math.round((20 + Math.max(0, 80 - fun) * 0.45 + Math.max(0, 65 - social) * 0.2) * 10) / 10, plannedPaidMeal: false,
    side: null, asset: null, quoteUnits: null, socialPartnerId: null, socialPartnerName: null, publicWorkUse: 'pier_stroll' }];
}
export function pierStrollEffect({ condition = 100, usesToday = 0 } = {}) {
  if ((Number(usesToday) || 0) >= PIER_CAPACITY) return { needs: {}, used: false };
  const factor = conditionFactor(condition);
  const needs = {};
  for (const [key, value] of Object.entries(PIER_STROLL_GAINS)) needs[key] = Math.max(1, Math.round(value * factor));
  return { needs, used: true, factor };
}
// Scenes that are on the island (residents only get there by ferry).
export const isIslandScene = (scene) => Boolean(scene?.features?.island) && isIslandType(scene?.features?.islandType || scene?.features?.kind);
