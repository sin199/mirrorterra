// placewear1 (user decision 2026-10-24 00:50 CST, option 2): places built by resident projects
// (world-places.js createProjectPlace, world_scenes.created_by_project_id) join the public works wear and
// repair system, so the user's rule "do not repair unused non-road/bridge buildings" applies to them too:
// a place nobody uses slowly decays and loses effect; a place residents use is repaired by the treasury.
//
// Same rules as public works (public-works-growth.js), no new numbers:
//   * condition 0-100; standing wear BASE_WEAR_PER_HOUR (2 points per world day) + USE_WEAR per use;
//   * full effect from FULL_EFFECT_CONDITION (60) up, then linearly down to 35% at 0 (conditionFactor);
//     the place is never closed or deleted;
//   * below REPAIR_THRESHOLD (70) a repair is tendered, but only if the place was used in the last
//     REPAIR_USE_WINDOW_MINUTES (72 world hours) (repairEligible), paid by the treasury through the normal
//     tender -> contract -> milestone path (postTreasuryEntry 'public_works'); externals never hold a contract.
//
// Storage: no schema change. world_public_work_conditions cannot hold these rows (its work_id is a foreign
// key to world_public_works and a project place has no public work), so the condition lives in the scene's
// own features JSON, features.placeWear, created lazily the first time the hourly step touches the place
// (condition 100 = the conditions table's default; no manual backfill). The same invariants as the
// conditions table are kept in code: condition only falls (LEAST) except through a completed repair
// (repairs + 1), counters only grow.
//
// Uses: counted hourly from the world event log (world.action_completed at the place's name, actions
// work / business_work / cooperate; construction sessions excluded), read incrementally by event id from a
// cursor kept in features.placeWear, so the tick itself does no extra write per action.
import { BASE_WEAR_PER_HOUR, FULL_EFFECT_CONDITION, REPAIR_THRESHOLD, REPAIR_USE_WINDOW_MINUTES, USE_WEAR,
  conditionFactor, repairEligible } from './public-works-growth.js';
import { projectPlaceWearEnabled, projectPlaceWearSetting } from './project-place-wear-flags.js';

export const PLACE_WEAR_KEY = 'placeWear';
export const PLACE_USE_ACTIONS = Object.freeze(['work', 'business_work', 'cooperate']);
export const PLACE_USE_HOURS_KEPT = Math.ceil(REPAIR_USE_WINDOW_MINUTES / 60) + 24; // 96 world hours of buckets
export const PLACE_EVENT_SCAN_LIMIT = 20_000;
// Repair contracts are stored under the closest public building type (world_public_work_meta CHECK); its
// base price and required skill come from that type (a studio repairs like a workshop: 20 SYNC base).
export const PROJECT_PLACE_REPAIR_TYPE = Object.freeze({
  studio: 'workshop', workshop: 'workshop', data_center: 'workshop', library: 'library', observatory: 'library',
  cafe: 'public_building', commons: 'public_building', garden: 'park'
});
export { REPAIR_THRESHOLD, FULL_EFFECT_CONDITION };

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const round2 = (value) => Math.round(Number(value) * 100) / 100;

export function isProjectPlaceScene(scene) {
  return Boolean(scene && scene.features && typeof scene.features === 'object' && scene.features[PLACE_WEAR_KEY]
    && typeof scene.features[PLACE_WEAR_KEY] === 'object');
}
export function placeWearOf(scene) { return isProjectPlaceScene(scene) ? scene.features[PLACE_WEAR_KEY] : null; }

// Pure: the effect factor of a project place (1 when it has no wear state or the switch is off).
export function projectPlaceEffectFactor(scene, { enabled = true } = {}) {
  const wear = placeWearOf(scene);
  if (!enabled || !wear) return 1;
  return conditionFactor(wear.condition ?? 100);
}

// Pure: the initial wear state (conditions-table default: 100, no age penalty, nothing counted before).
export function initialPlaceWear({ worldMinutes, eventCursor = 0 }) {
  const minute = Math.trunc(num(worldMinutes));
  return { condition: 100, initialCondition: 100, wearWorldMinute: minute, usesTotal: 0, repairs: 0,
    lastRepairWorldMinute: null, lastUseWorldMinute: null, useHours: {}, eventCursor: Math.trunc(num(eventCursor)),
    since: minute };
}

// Pure: one hourly step. uses: [{ worldMinutes }] new uses of this place since the cursor.
// Standing wear for each whole world hour since wearWorldMinute, then USE_WEAR per new use; never rises.
export function stepPlaceWear(state, { worldMinutes, uses = [], eventCursor = null }) {
  const minute = Math.trunc(num(worldMinutes));
  const before = num(state?.condition, 100);
  const wearMinute = Math.trunc(num(state?.wearWorldMinute, minute));
  const hours = Math.max(0, Math.floor((minute - wearMinute) / 60));
  let condition = Math.max(0, before - BASE_WEAR_PER_HOUR * hours);
  condition = Math.max(0, condition - USE_WEAR * uses.length);
  condition = Math.min(before, round2(condition));
  const useHours = {};
  const oldestHour = Math.floor(minute / 60) - PLACE_USE_HOURS_KEPT;
  for (const [hour, count] of Object.entries(state?.useHours || {})) {
    if (Number(hour) >= oldestHour && num(count) > 0) useHours[hour] = num(count);
  }
  let lastUse = state?.lastUseWorldMinute ?? null;
  for (const use of uses) {
    const at = Math.trunc(num(use.worldMinutes, minute));
    const hour = Math.floor(at / 60);
    if (hour >= oldestHour) useHours[hour] = (useHours[hour] || 0) + 1;
    if (lastUse === null || at > Number(lastUse)) lastUse = at;
  }
  return { ...state, condition, wearWorldMinute: wearMinute + hours * 60, usesTotal: num(state?.usesTotal) + uses.length,
    useHours, lastUseWorldMinute: lastUse,
    eventCursor: eventCursor === null ? num(state?.eventCursor) : Math.max(num(state?.eventCursor), Math.trunc(num(eventCursor))) };
}

// Pure: uses in the last `windowMinutes` from the hourly buckets (an hour bucket counts when it overlaps).
export function placeUsesSince(state, worldMinutes, windowMinutes) {
  const fromHour = Math.floor((num(worldMinutes) - num(windowMinutes)) / 60);
  return Object.entries(state?.useHours || {}).reduce((sum, [hour, count]) => sum + (Number(hour) >= fromHour ? num(count) : 0), 0);
}

// Pure: the facility view of a project place for the repair rules (same shape as readGrowthDemand facilities).
export function projectPlaceFacility(scene, worldMinutes) {
  const wear = placeWearOf(scene);
  if (!wear) return null;
  const type = PROJECT_PLACE_REPAIR_TYPE[scene.sceneType] || 'workshop';
  return { projectPlace: true, sceneId: scene.id, name: scene.name, sceneType: scene.sceneType, type, level: 1,
    condition: num(wear.condition, 100), repairs: num(wear.repairs), usesTotal: num(wear.usesTotal),
    uses24h: placeUsesSince(wear, worldMinutes, 1440), uses72h: placeUsesSince(wear, worldMinutes, REPAIR_USE_WINDOW_MINUTES),
    lastUseWorldMinute: wear.lastUseWorldMinute ?? null, effectFactor: conditionFactor(num(wear.condition, 100)) };
}

// drivefix1 (user decision 2026-10-24 10:06 CST): a project place is repaired only when it was used at least
// PROJECT_PLACE_REPAIR_MIN_USES times in the last 72 world hours (default 3; MIRRORTERRA_PROJECT_PLACE_REPAIR_MIN_USES,
// env or tickfix-flags.json). Rarely used studios really decay. Public buildings keep the "> 0 uses" rule.
export const PROJECT_PLACE_REPAIR_MIN_USES_KEY = 'MIRRORTERRA_PROJECT_PLACE_REPAIR_MIN_USES';
export const PROJECT_PLACE_REPAIR_MIN_USES_DEFAULT = 3;
export function projectPlaceRepairMinUses(env = process.env) {
  let raw;
  try { raw = projectPlaceWearSetting(PROJECT_PLACE_REPAIR_MIN_USES_KEY, env); } catch { raw = undefined; }
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(value) && value >= 1
    ? Math.min(1000, Math.trunc(value)) : PROJECT_PLACE_REPAIR_MIN_USES_DEFAULT;
}

// Pure: is a repair due and allowed (same threshold as public buildings; never exempt; at least minUses uses
// in the last 72 world hours).
export function projectPlaceRepairDue(facility, { minUses = projectPlaceRepairMinUses() } = {}) {
  if (!facility) return { due: false, reason: 'no_state' };
  if (!(Number(facility.condition) < REPAIR_THRESHOLD)) return { due: false, reason: 'condition_ok' };
  const eligibility = repairEligible({ type: 'project_place', uses72h: facility.uses72h });
  if (!eligibility.eligible) return { due: false, reason: eligibility.reason };
  return Number(facility.uses72h) >= minUses ? { due: true } : { due: false, reason: 'below_min_uses_72h' };
}

// ---- database ---------------------------------------------------------------------------------------
async function readProjectPlaceScenes(client, worldId) {
  const rows = await client.query(`SELECT id::text AS id,name,scene_type AS "sceneType",status,features
    FROM world_scenes WHERE world_id=$1 AND created_by_project_id IS NOT NULL AND status='active' ORDER BY created_at,id`, [worldId]);
  return rows.rows;
}

// Hourly: create missing wear states, count new uses since each place's cursor, apply wear. One UPDATE
// statement for all places. Returns { places, created, uses, cursor }.
export async function runProjectPlaceWearHour(client, { worldId, worldMinutes, env = process.env }) {
  if (!projectPlaceWearEnabled(env)) return { skipped: 'disabled' };
  const minute = Math.trunc(num(worldMinutes));
  const scenes = await readProjectPlaceScenes(client, worldId);
  if (!scenes.length) return { places: 0, created: 0, uses: 0 };
  const head = await client.query(`SELECT COALESCE(max(id),0)::bigint AS id FROM world_events`);
  const headId = Math.trunc(num(head.rows[0]?.id));
  let created = 0;
  const states = new Map();
  for (const scene of scenes) {
    const wear = placeWearOf(scene);
    if (wear) states.set(scene.id, wear);
    else { states.set(scene.id, initialPlaceWear({ worldMinutes: minute, eventCursor: headId })); created += 1; }
  }
  const cursor = Math.min(...[...states.values()].map((state) => Math.trunc(num(state.eventCursor))));
  const usesBy = new Map(scenes.map((scene) => [scene.name, []]));
  let scannedTo = headId;
  if (cursor < headId) {
    const events = await client.query(`SELECT id::bigint AS id,data->>'place' AS place,
        COALESCE((data->>'worldMinutes')::numeric,$4)::bigint AS minute
      FROM world_events WHERE world_id=$1 AND id>$2 AND id<=$3 AND event_type='world.action_completed'
        AND data->>'place' = ANY($5::text[]) AND data->>'action' = ANY($6::text[])
        AND NOT (COALESCE(data->'work','{}'::jsonb) ? 'publicWork')
      ORDER BY id LIMIT ${PLACE_EVENT_SCAN_LIMIT}`,
    [worldId, cursor, headId, minute, scenes.map((scene) => scene.name), PLACE_USE_ACTIONS]);
    if (events.rowCount >= PLACE_EVENT_SCAN_LIMIT) scannedTo = Math.trunc(num(events.rows[events.rows.length - 1].id));
    for (const row of events.rows) {
      const list = usesBy.get(row.place);
      if (list) list.push({ id: Math.trunc(num(row.id)), worldMinutes: num(row.minute, minute) });
    }
  }
  const updates = [];
  let usesCounted = 0;
  for (const scene of scenes) {
    const state = states.get(scene.id);
    const own = (usesBy.get(scene.name) || []).filter((use) => use.id > num(state.eventCursor) && use.id <= scannedTo);
    usesCounted += own.length;
    const next = stepPlaceWear(state, { worldMinutes: minute, uses: own, eventCursor: scannedTo });
    updates.push({ id: scene.id, wear: next });
  }
  // Condition never rises here (LEAST against the stored value) and counters never fall (GREATEST). If a
  // repair completed after this step read the place (stored repairs grew), the stored state is kept as is.
  await client.query(`UPDATE world_scenes scene SET features=jsonb_set(scene.features,'{${PLACE_WEAR_KEY}}',
      CASE WHEN scene.features ? '${PLACE_WEAR_KEY}'
          AND COALESCE((scene.features->'${PLACE_WEAR_KEY}'->>'repairs')::int,0) > COALESCE((upd.wear->>'repairs')::int,0)
        THEN scene.features->'${PLACE_WEAR_KEY}'
      WHEN scene.features ? '${PLACE_WEAR_KEY}' THEN upd.wear
        || jsonb_build_object('condition', LEAST(upd.wear->'condition', scene.features->'${PLACE_WEAR_KEY}'->'condition'),
          'repairs', GREATEST(upd.wear->'repairs', scene.features->'${PLACE_WEAR_KEY}'->'repairs'),
          'usesTotal', GREATEST(upd.wear->'usesTotal', scene.features->'${PLACE_WEAR_KEY}'->'usesTotal'))
      ELSE upd.wear END,true)
    FROM jsonb_to_recordset($2::jsonb) AS upd(id uuid, wear jsonb)
    WHERE scene.world_id=$1 AND scene.id=upd.id`, [worldId, JSON.stringify(updates)]);
  return { places: scenes.length, created, uses: usesCounted, cursor: scannedTo };
}

// The project places as repair facilities (after the hourly step), for the repair tender.
export async function readProjectPlaceFacilities(client, { worldId, worldMinutes, env = process.env }) {
  if (!projectPlaceWearEnabled(env)) return [];
  const scenes = await readProjectPlaceScenes(client, worldId);
  return scenes.map((scene) => projectPlaceFacility(scene, worldMinutes)).filter(Boolean);
}

// A completed repair restores the place to full condition (repairs + 1), like a public building.
export async function completeProjectPlaceRepair(client, { worldId, sceneId, worldMinutes }) {
  const minute = Math.trunc(num(worldMinutes));
  const updated = await client.query(`UPDATE world_scenes SET features=jsonb_set(features,'{${PLACE_WEAR_KEY}}',
      features->'${PLACE_WEAR_KEY}' || jsonb_build_object('condition',100,
        'repairs',COALESCE((features->'${PLACE_WEAR_KEY}'->>'repairs')::int,0)+1,'lastRepairWorldMinute',$3::bigint,
        'wearWorldMinute',GREATEST(COALESCE((features->'${PLACE_WEAR_KEY}'->>'wearWorldMinute')::bigint,0),$3::bigint)),true)
    WHERE world_id=$1 AND id=$2 AND features ? '${PLACE_WEAR_KEY}' RETURNING id`, [worldId, sceneId, minute]);
  return updated.rowCount > 0;
}
