// Places that grow out of what residents actually practise. Every O*NET Generalized Work
// Activity (the 41 roots of the skill library) has a kind of place. When enough residents keep
// practising a skill family, the most practised of them founds a place for it; when demand keeps
// growing, more places of the same kind appear. There is no total cap: the n-th place of a kind
// needs PLACE_DEMAND_BASE * n^2 practices, so the town keeps growing as long as residents do.
// No money, ledger, wallet or chain logic is touched here.
import { writeWorldHistory } from './world-domain.js';

export const PLACE_DEMAND_BASE = 100;
export const PLACE_MIN_RESIDENTS = 2;
export const PLACE_GROWTH_COOLDOWN_MS = 15 * 60 * 1000;
export const BEACH_NAME = 'Moonrise Beach';
export const BEACH_SKILL_GROUP = 'onet:gwa:4.A.3.a.1';

const DAY = { weekday: [[7, 21]], weekend: [[9, 19]] };
const LATE = { weekday: [[9, 23]], weekend: [[10, 24]] };
const ALL = { weekday: [[0, 24]], weekend: [[0, 24]] };

// gwa -> kind (scene_type slug), archetype (3D model), base name, practice action, accent colour.
export const SKILL_PLACE_KINDS = Object.freeze({
  'onet:gwa:4.A.1.a.1': { kind: 'archive', archetype: 'hall', label: 'Archive', action: 'learn', accent: '#7d8fb3', hours: DAY },
  'onet:gwa:4.A.1.a.2': { kind: 'watch_station', archetype: 'tower', label: 'Watch Station', action: 'work', accent: '#5c8a9e', hours: ALL },
  'onet:gwa:4.A.1.b.1': { kind: 'field_station', archetype: 'lab', label: 'Field Station', action: 'learn', accent: '#5fa37a', hours: DAY },
  'onet:gwa:4.A.1.b.2': { kind: 'inspection_yard', archetype: 'yard', label: 'Inspection Yard', action: 'work', accent: '#c98b3a', hours: DAY },
  'onet:gwa:4.A.1.b.3': { kind: 'survey_office', archetype: 'tower', label: 'Survey Office', action: 'work', accent: '#8a7fb8', hours: DAY },
  'onet:gwa:4.A.2.a.1': { kind: 'gallery', archetype: 'atelier', label: 'Gallery', action: 'learn', accent: '#d46a8c', hours: LATE },
  'onet:gwa:4.A.2.a.2': { kind: 'records_office', archetype: 'tower', label: 'Records Office', action: 'learn', accent: '#6f86a8', hours: DAY },
  'onet:gwa:4.A.2.a.3': { kind: 'standards_bureau', archetype: 'hall', label: 'Standards Bureau', action: 'learn', accent: '#8c8f99', hours: DAY },
  'onet:gwa:4.A.2.a.4': { kind: 'analytics_lab', archetype: 'lab', label: 'Analytics Lab', action: 'learn', accent: '#3fa7c9', hours: LATE },
  'onet:gwa:4.A.2.b.1': { kind: 'think_tank', archetype: 'lab', label: 'Think Tank', action: 'learn', accent: '#4c7fd0', hours: LATE },
  'onet:gwa:4.A.2.b.2': { kind: 'atelier', archetype: 'atelier', label: 'Atelier', action: 'learn', accent: '#e07a5f', hours: LATE },
  'onet:gwa:4.A.2.b.3': { kind: 'academy', archetype: 'school', label: 'Academy', action: 'learn', accent: '#5b6fd6', hours: DAY },
  'onet:gwa:4.A.2.b.4': { kind: 'strategy_house', archetype: 'hall', label: 'Strategy House', action: 'cooperate', accent: '#7a6bb0', hours: DAY },
  'onet:gwa:4.A.2.b.5': { kind: 'dispatch_office', archetype: 'tower', label: 'Dispatch Office', action: 'work', accent: '#d9a441', hours: ALL },
  'onet:gwa:4.A.2.b.6': { kind: 'planning_bureau', archetype: 'tower', label: 'Planning Bureau', action: 'work', accent: '#9a8c6a', hours: DAY },
  'onet:gwa:4.A.3.a.1': { kind: 'training_ground', archetype: 'arena', label: 'Training Ground', action: 'work', accent: '#e05a4f', hours: DAY },
  'onet:gwa:4.A.3.a.2': { kind: 'warehouse', archetype: 'yard', label: 'Warehouse', action: 'work', accent: '#b07a45', hours: DAY },
  'onet:gwa:4.A.3.a.3': { kind: 'mill', archetype: 'yard', label: 'Mill', action: 'work', accent: '#a0663a', hours: DAY },
  'onet:gwa:4.A.3.a.4': { kind: 'vehicle_depot', archetype: 'depot', label: 'Vehicle Depot', action: 'work', accent: '#e0b23c', hours: ALL },
  'onet:gwa:4.A.3.b.1': { kind: 'code_lab', archetype: 'lab', label: 'Code Lab', action: 'work', accent: '#36c2a8', hours: ALL },
  'onet:gwa:4.A.3.b.2': { kind: 'drafting_studio', archetype: 'atelier', label: 'Drafting Studio', action: 'work', accent: '#4b9be0', hours: DAY },
  'onet:gwa:4.A.3.b.4': { kind: 'repair_yard', archetype: 'depot', label: 'Repair Yard', action: 'work', accent: '#d27a2c', hours: DAY },
  'onet:gwa:4.A.3.b.5': { kind: 'electronics_shop', archetype: 'market', label: 'Electronics Shop', action: 'work', accent: '#3fb6e0', hours: DAY },
  'onet:gwa:4.A.3.b.6': { kind: 'press_house', archetype: 'hall', label: 'Press House', action: 'work', accent: '#6d6a8f', hours: DAY },
  'onet:gwa:4.A.4.a.1': { kind: 'interpreters_house', archetype: 'school', label: "Interpreters' House", action: 'socialize', accent: '#c0789f', hours: LATE },
  'onet:gwa:4.A.4.a.2': { kind: 'meeting_hall', archetype: 'hall', label: 'Meeting Hall', action: 'socialize', accent: '#9fb04a', hours: LATE },
  'onet:gwa:4.A.4.a.3': { kind: 'post_office', archetype: 'hall', label: 'Post Office', action: 'socialize', accent: '#d65b4a', hours: DAY },
  'onet:gwa:4.A.4.a.4': { kind: 'tea_house', archetype: 'market', label: 'Tea House', action: 'socialize', accent: '#7fae5a', hours: LATE },
  'onet:gwa:4.A.4.a.5': { kind: 'clinic', archetype: 'clinic', label: 'Clinic', action: 'socialize', accent: '#e05d6f', hours: ALL },
  'onet:gwa:4.A.4.a.6': { kind: 'market', archetype: 'market', label: 'Market', action: 'socialize', accent: '#f08a3c', hours: DAY },
  'onet:gwa:4.A.4.a.7': { kind: 'mediation_court', archetype: 'hall', label: 'Mediation Court', action: 'socialize', accent: '#8b6f4e', hours: DAY },
  'onet:gwa:4.A.4.a.8': { kind: 'theater', archetype: 'stage', label: 'Theater', action: 'socialize', accent: '#c94f8a', hours: LATE },
  'onet:gwa:4.A.4.b.1': { kind: 'town_hall', archetype: 'hall', label: 'Town Hall', action: 'cooperate', accent: '#b58d3d', hours: DAY },
  'onet:gwa:4.A.4.b.2': { kind: 'guild_hall', archetype: 'hall', label: 'Guild Hall', action: 'cooperate', accent: '#a1653f', hours: LATE },
  'onet:gwa:4.A.4.b.3': { kind: 'school', archetype: 'school', label: 'School', action: 'learn', accent: '#e0a63c', hours: DAY },
  'onet:gwa:4.A.4.b.4': { kind: 'leaders_lodge', archetype: 'hall', label: "Leaders' Lodge", action: 'cooperate', accent: '#6b8e5a', hours: DAY },
  'onet:gwa:4.A.4.b.5': { kind: 'coaching_center', archetype: 'arena', label: 'Coaching Center', action: 'socialize', accent: '#4fb06f', hours: DAY },
  'onet:gwa:4.A.4.b.6': { kind: 'advice_bureau', archetype: 'tower', label: 'Advice Bureau', action: 'learn', accent: '#5d8fc9', hours: DAY },
  'onet:gwa:4.A.4.c.1': { kind: 'civic_office', archetype: 'tower', label: 'Civic Office', action: 'work', accent: '#7c8aa0', hours: DAY },
  'onet:gwa:4.A.4.c.2': { kind: 'job_center', archetype: 'hall', label: 'Job Center', action: 'work', accent: '#5ca0a8', hours: DAY },
  'onet:gwa:4.A.4.c.3': { kind: 'supply_office', archetype: 'yard', label: 'Supply Office', action: 'work', accent: '#9a7b4f', hours: DAY }
});

const NAME_PREFIX = Object.freeze(['Harbor', 'Hillside', 'Riverside', 'Lantern', 'Cedar', 'Old Town', 'Northgate',
  'Southbank', 'Maple', 'Seaview', 'Sunrise', 'Willow', 'Granite', 'Meadow', 'Copper', 'Bayside', 'Orchard',
  'Lighthouse', 'Juniper', 'Pinecrest']);

const LEGACY_SOCIAL = new Set(['cafe', 'garden', 'commons']);
const LEGACY_COOPERATIVE = new Set(['workshop', 'data_center']);

function features(scene) {
  return scene?.features && typeof scene.features === 'object' && !Array.isArray(scene.features) ? scene.features : {};
}

export function sceneAction(scene) { return features(scene).action || null; }
export function isSkillPlace(scene) { return Boolean(features(scene).skillGroup) && scene?.sceneType !== 'beach'; }
export function isBeach(scene) { return (scene?.sceneType || scene?.scene_type) === 'beach'; }
export function isSocialScene(scene) {
  const type = scene?.sceneType || scene?.scene_type;
  return LEGACY_SOCIAL.has(type) || type === 'beach' || sceneAction(scene) === 'socialize';
}
export function isCooperativeScene(scene) {
  const type = scene?.sceneType || scene?.scene_type;
  return LEGACY_COOPERATIVE.has(type) || (isSkillPlace(scene) && sceneAction(scene) === 'cooperate');
}

export function placeDemandThreshold(ordinal) {
  const n = Math.max(1, Math.trunc(Number(ordinal) || 1));
  return PLACE_DEMAND_BASE * n * n;
}

// The single most over-served skill family, or null when no family has outgrown its places.
export function pickPlaceToFound(demand = [], existing = {}) {
  let best = null;
  for (const row of demand) {
    if (!SKILL_PLACE_KINDS[row.gwa]) continue;
    const next = (Number(existing[row.gwa]) || 0) + 1;
    const practices = Number(row.practices) || 0;
    if (practices < placeDemandThreshold(next) || (Number(row.residents) || 0) < PLACE_MIN_RESIDENTS) continue;
    const pressure = practices / placeDemandThreshold(next);
    if (!best || pressure > best.pressure || (pressure === best.pressure && row.gwa < best.gwa)) {
      best = { ...row, ordinal: next, pressure };
    }
  }
  return best;
}

export function skillPlaceName(kind, ordinal) {
  if (ordinal <= 1) return `MirrorTerra ${kind.label}`;
  const prefix = NAME_PREFIX[(ordinal - 2) % NAME_PREFIX.length];
  const round = Math.floor((ordinal - 2) / NAME_PREFIX.length);
  return `${prefix} ${kind.label}${round ? ` ${round + 1}` : ''}`.slice(0, 64);
}

// Skill places sit in outer districts beyond the residents' cottages. Ring k holds 10 + 6k
// places; normalised radius 1.3 + 0.35k (the original town lives inside 0.92).
export function skillPlacePosition(index) {
  let ring = 0, start = 0;
  while (index >= start + 10 + 6 * ring) { start += 10 + 6 * ring; ring += 1; }
  const slots = 10 + 6 * ring, slot = index - start;
  const angle = (slot / slots) * Math.PI * 2 + ring * 0.37 + 0.21;
  const radius = 1.3 + ring * 0.35;
  return { x: Math.round(Math.cos(angle) * radius * 1000) / 1000, z: Math.round(Math.sin(angle) * radius * 1000) / 1000,
    district: ring + 1 };
}

async function sceneCreatedEvent(client, { worldId, actorId, scene, actionId, extra = {} }) {
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,'scene.created',$3::jsonb,$4) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, actorId, JSON.stringify({ id: scene.id, name: scene.name, sceneType: scene.sceneType, ...extra }), actionId]);
}

export async function ensureBeach(client, { worldId, worldMinutes = 0 }) {
  const existing = await client.query(`SELECT id FROM world_scenes WHERE world_id=$1 AND scene_type='beach' LIMIT 1`, [worldId]);
  if (existing.rowCount) return null;
  const founder = await client.query(`SELECT agent_id FROM world_members WHERE world_id=$1 ORDER BY joined_at,agent_id LIMIT 1`, [worldId]);
  if (!founder.rowCount) return null;
  const actorId = founder.rows[0].agent_id;
  const inserted = await client.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description,status,
      purpose,capacity,features,position,created_world_minutes)
    VALUES($1,$2,$3,'beach',$4,'active',$5,24,$6::jsonb,$7::jsonb,$8)
    ON CONFLICT(world_id,name) DO NOTHING
    RETURNING id,name,scene_type AS "sceneType"`,
  [worldId, actorId, BEACH_NAME,
    'A sandy cove on the island shore with umbrellas, a pier, a lifeguard tower and an evening bonfire.',
    'Swim, lounge, fish, play beach volleyball, keep watch as a lifeguard and gather around the bonfire.',
    JSON.stringify({ archetype: 'beach', kind: 'beach', coastal: true, skillGroup: BEACH_SKILL_GROUP, action: 'work',
      accent: '#f2c46b', origin: 'requested_landmark', openingHours: { weekday: [[6, 24]], weekend: [[6, 25]] } }),
    JSON.stringify({ x: 0.35, z: 1.45, coastal: true }), worldMinutes]);
  const scene = inserted.rows[0];
  if (!scene) return null;
  await writeWorldHistory(client, { worldId, eventKey: `place:beach:${scene.id}:created`, eventType: 'place_created',
    actorAgentId: actorId, entityType: 'place', entityId: scene.id, worldTime: worldMinutes, title: BEACH_NAME,
    detail: 'The island opened a beach on its southern shore.', metadata: { sceneType: 'beach' } });
  await sceneCreatedEvent(client, { worldId, actorId, scene, actionId: 'landmark:beach', extra: { worldTime: worldMinutes } });
  return scene;
}

export async function growSkillPlaces(client, { worldId, worldMinutes = 0, now = new Date() }) {
  const recent = await client.query(`SELECT max(created_at) AS at FROM world_scenes
    WHERE world_id=$1 AND features ? 'skillGroup' AND scene_type<>'beach'`, [worldId]);
  const last = recent.rows[0]?.at ? new Date(recent.rows[0].at).getTime() : 0;
  if (last && now.getTime() - last < PLACE_GROWTH_COOLDOWN_MS) return null;
  const demand = await client.query(`SELECT l.root_gwa AS gwa, sum(p.practice_count)::int AS practices,
      count(DISTINCT p.agent_id)::int AS residents,
      (array_agg(p.agent_id ORDER BY p.practice_count DESC, p.agent_id))[1] AS founder
    FROM world_agent_library_skills p JOIN world_skill_library l ON l.skill_id=p.skill_id
    JOIN world_members m ON m.world_id=p.world_id AND m.agent_id=p.agent_id
    WHERE p.world_id=$1 AND l.root_gwa IS NOT NULL GROUP BY l.root_gwa`, [worldId]);
  const counts = await client.query(`SELECT features->>'skillGroup' AS gwa, count(*)::int AS n FROM world_scenes
    WHERE world_id=$1 AND features ? 'skillGroup' AND scene_type<>'beach' GROUP BY 1`, [worldId]);
  const existing = Object.fromEntries(counts.rows.map((row) => [row.gwa, row.n]));
  const pick = pickPlaceToFound(demand.rows, existing);
  if (!pick) return null;
  const kind = SKILL_PLACE_KINDS[pick.gwa];
  const total = Object.values(existing).reduce((sum, n) => sum + n, 0);
  const family = await client.query('SELECT name FROM world_skill_library WHERE skill_id=$1', [pick.gwa]);
  const familyName = family.rows[0]?.name || kind.label;
  let name = null;
  for (let ordinal = pick.ordinal; ordinal < pick.ordinal + 200 && !name; ordinal++) {
    const candidate = skillPlaceName(kind, ordinal);
    const taken = await client.query('SELECT 1 FROM world_scenes WHERE world_id=$1 AND lower(name)=lower($2)', [worldId, candidate]);
    if (!taken.rowCount) name = candidate;
  }
  if (!name) return null;
  const description = `${kind.label} founded because ${pick.residents} residents keep practising ${familyName}.`.slice(0, 240);
  const purpose = `A place to practise ${familyName}: residents come here to ${kind.action === 'learn' ? 'study'
    : kind.action === 'socialize' ? 'meet people and serve others' : kind.action === 'cooperate' ? 'work together' : 'work'} with these skills.`.slice(0, 400);
  const inserted = await client.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description,status,
      purpose,capacity,features,position,created_world_minutes)
    VALUES($1,$2,$3,$4,$5,'active',$6,10,$7::jsonb,$8::jsonb,$9)
    ON CONFLICT(world_id,name) DO NOTHING RETURNING id,name,scene_type AS "sceneType"`,
  [worldId, pick.founder, name, kind.kind, description.length >= 12 ? description : `${kind.label} for residents.`, purpose,
    JSON.stringify({ skillGroup: pick.gwa, skillFamily: familyName, kind: kind.kind, archetype: kind.archetype,
      action: kind.action, accent: kind.accent, origin: 'skill_demand', ordinal: pick.ordinal,
      practicesAtFounding: pick.practices, residentsAtFounding: pick.residents, openingHours: kind.hours,
      source: 'O*NET 31.0 (CC BY 4.0)' }),
    JSON.stringify(skillPlacePosition(total)), worldMinutes]);
  const scene = inserted.rows[0];
  if (!scene) return null;
  await writeWorldHistory(client, { worldId, eventKey: `place:skill:${scene.id}:created`, eventType: 'place_created',
    actorAgentId: pick.founder, entityType: 'place', entityId: scene.id, worldTime: worldMinutes, title: name,
    detail: description, metadata: { sceneType: kind.kind, skillGroup: pick.gwa, practices: pick.practices } });
  await sceneCreatedEvent(client, { worldId, actorId: pick.founder, scene,
    actionId: `skill-place:${pick.gwa}:${pick.ordinal}`,
    extra: { purpose, skillGroup: pick.gwa, skillFamily: familyName, worldTime: worldMinutes } });
  return { ...scene, skillGroup: pick.gwa, founder: pick.founder, practices: pick.practices };
}

// Isolated in a savepoint: place growth can never break a world tick.
export async function growWorldPlacesSafely(client, input) {
  if (String(process.env.MIRRORTERRA_SKILL_PLACES || '').toLowerCase() === 'off') return null;
  try { await client.query('SAVEPOINT world_skill_places'); } catch { return null; }
  try {
    const beach = await ensureBeach(client, input);
    const place = await growSkillPlaces(client, input);
    await client.query('RELEASE SAVEPOINT world_skill_places');
    return { beach, place };
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT world_skill_places');
      await client.query('RELEASE SAVEPOINT world_skill_places');
    } catch { /* surrounding transaction reports its own failure */ }
    return { error: error?.message || String(error) };
  }
}
