import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SKILL_PLACE_KINDS, pickPlaceToFound, placeDemandThreshold, skillPlaceName, skillPlacePosition,
  isSocialScene, isCooperativeScene, isSkillPlace, isBeach, growSkillPlaces, ensureBeach, growWorldPlacesSafely,
  PLACE_GROWTH_COOLDOWN_MS } from '../src/world-skill-places.js';
import { rankSkillChoices } from '../src/world-skill-library.js';
import { activityVariant, activityNeedEffects, placeSchedule } from '../src/world-environment.js';
import { buildActivityCandidates } from '../src/world-engine.js';
import { canSocializePair } from '../src/social-world.js';

test('every one of the 41 O*NET work-activity roots has a place kind with a valid slug', () => {
  const kinds = Object.values(SKILL_PLACE_KINDS);
  assert.equal(kinds.length, 41);
  assert.equal(new Set(kinds.map((kind) => kind.kind)).size, 41);
  for (const kind of kinds) {
    assert.match(kind.kind, /^[a-z][a-z_]{2,39}$/);
    assert.ok(['learn', 'work', 'cooperate', 'socialize'].includes(kind.action));
    assert.match(kind.accent, /^#[0-9a-f]{6}$/i);
  }
});

test('place demand has no total cap and grows quadratically per kind', () => {
  assert.equal(placeDemandThreshold(1), 100);
  assert.equal(placeDemandThreshold(3), 900);
  const gwa = 'onet:gwa:4.A.4.a.5';
  assert.equal(pickPlaceToFound([{ gwa, practices: 99, residents: 5 }], {}), null);
  assert.equal(pickPlaceToFound([{ gwa, practices: 500, residents: 1 }], {}), null);
  assert.equal(pickPlaceToFound([{ gwa, practices: 120, residents: 2 }], {}).ordinal, 1);
  assert.equal(pickPlaceToFound([{ gwa, practices: 120, residents: 2 }], { [gwa]: 1 }), null);
  assert.equal(pickPlaceToFound([{ gwa, practices: 1_000_000, residents: 9 }], { [gwa]: 99 }).ordinal, 100);
  const pick = pickPlaceToFound([{ gwa, practices: 450, residents: 3 }, { gwa: 'onet:gwa:4.A.4.a.6', practices: 150, residents: 3 }], { [gwa]: 1 });
  assert.equal(pick.gwa, 'onet:gwa:4.A.4.a.6');
  assert.equal(pickPlaceToFound([{ gwa: 'unknown', practices: 1e6, residents: 9 }], {}), null);
});

test('names stay unique-looking and within 64 chars; positions fill outer rings', () => {
  const kind = SKILL_PLACE_KINDS['onet:gwa:4.A.4.a.5'];
  assert.equal(skillPlaceName(kind, 1), 'MirrorTerra Clinic');
  assert.equal(skillPlaceName(kind, 2), 'Harbor Clinic');
  assert.notEqual(skillPlaceName(kind, 22), skillPlaceName(kind, 2));
  for (let i = 1; i < 300; i += 1) assert.ok(skillPlaceName(SKILL_PLACE_KINDS['onet:gwa:4.A.1.b.3'], i).length <= 64);
  const first = skillPlacePosition(0), tenth = skillPlacePosition(9), eleventh = skillPlacePosition(10);
  assert.equal(first.district, 1); assert.equal(tenth.district, 1); assert.equal(eleventh.district, 2);
  assert.ok(Math.hypot(first.x, first.z) > 1.05);
  assert.ok(Math.hypot(eleventh.x, eleventh.z) > Math.hypot(first.x, first.z));
  assert.equal(skillPlacePosition(500).district > 5, true);
});

test('scene helpers recognise beach, social and cooperative skill places', () => {
  const clinic = { sceneType: 'clinic', status: 'active', features: { skillGroup: 'onet:gwa:4.A.4.a.5', action: 'socialize' } };
  const hall = { sceneType: 'town_hall', status: 'active', features: { skillGroup: 'onet:gwa:4.A.4.b.1', action: 'cooperate' } };
  const beach = { sceneType: 'beach', status: 'active', features: { skillGroup: 'onet:gwa:4.A.3.a.1', action: 'work' } };
  assert.ok(isSocialScene(clinic) && isSocialScene(beach) && isSocialScene({ sceneType: 'cafe' }));
  assert.ok(!isSocialScene(hall) && isCooperativeScene(hall) && isCooperativeScene({ sceneType: 'workshop' }));
  assert.ok(isSkillPlace(clinic) && !isSkillPlace(beach) && isBeach(beach));
  const pair = canSocializePair({ actor: { agentId: 'a', status: 'idle', location: 'Moonrise Beach' },
    partner: { agentId: 'b', status: 'idle', location: 'Moonrise Beach' }, scene: { ...beach, name: 'Moonrise Beach' }, worldMinutes: 100000 });
  assert.equal(pair, true);
});

test('beach variants, effects and opening hours', () => {
  const calendar = { minuteOfDay: 14 * 60, weekdayIndex: 2, phase: 'afternoon', isNight: false, isWeekend: false };
  assert.equal(activityVariant({ action: 'rest', location: 'Moonrise Beach', sceneType: 'beach', calendar, weather: { outdoorComfort: 0.8 } }), 'beach_swim');
  assert.equal(activityVariant({ action: 'socialize', location: 'Moonrise Beach', sceneType: 'beach', calendar: { ...calendar, phase: 'evening' }, weather: {} }), 'beach_bonfire');
  assert.equal(activityVariant({ action: 'work', location: 'X', sceneType: 'clinic', calendar, weather: {}, skillPlace: true }), 'skill_shift');
  assert.ok(activityNeedEffects({ action: 'rest', variant: 'beach_swim', weather: { outdoorComfort: 0.8 } }).fun >= 14);
  const open = placeSchedule({ name: 'Moonrise Beach', sceneType: 'beach', status: 'active' }, calendar, { condition: 'clear' });
  assert.equal(open.open, true);
  const night = placeSchedule({ name: 'Moonrise Beach', sceneType: 'beach', status: 'active' }, { ...calendar, minuteOfDay: 3 * 60 }, { condition: 'clear' });
  assert.equal(night.open, false);
});

test('residents get options to go to skill places and the beach', () => {
  const scenes = [
    { id: 's1', name: 'MirrorTerra Clinic', sceneType: 'clinic', status: 'active', capacity: 10,
      features: { skillGroup: 'onet:gwa:4.A.4.a.5', skillFamily: 'Assisting and Caring for Others', action: 'socialize' } },
    { id: 's2', name: 'MirrorTerra Academy', sceneType: 'academy', status: 'active', capacity: 10,
      features: { skillGroup: 'onet:gwa:4.A.2.b.3', skillFamily: 'Updating and Using Relevant Knowledge', action: 'learn' } },
    { id: 's3', name: 'Moonrise Beach', sceneType: 'beach', status: 'active', capacity: 24, features: { action: 'work' } }
  ];
  const options = buildActivityCandidates({ agentId: 'a1', energy: 80, food: 80, social: 60, happiness: 50,
    knowledge: 30, fun: 30, location: 'Elsewhere', goal: 'balanced' }, scenes, { worldMinutes: 1000, tick: 1 });
  const ids = options.map((option) => option.id);
  assert.ok(ids.includes('work:s1'));
  assert.ok(ids.includes('learn:s2'));
  assert.ok(ids.includes('rest:s3') && ids.includes('eat:s3') && ids.includes('work:s3'));
});

test('a place focus boosts that skill family when ranking practice', () => {
  const drives = { survival: 0, security: 0, belonging: 0, esteem: 0, curiosity: 0, creation: 0, mastery: 0, contribution: 0 };
  const learning = [
    { skillId: 'a', rootGwa: 'g1', drives: [], level: 0, practiceCount: 0 },
    { skillId: 'b', rootGwa: 'g2', drives: [], level: 0, practiceCount: 0 }];
  const ranked = rankSkillChoices({ learning, drives, agentId: 'x', focusGroup: 'g2' });
  assert.equal(ranked[0].skillId, 'b');
});

function fakeClient(handlers) {
  const calls = [];
  return { calls, async query(sql, params) {
    calls.push(sql);
    for (const [pattern, result] of handlers) if (pattern.test(sql)) return typeof result === 'function' ? result(params) : result;
    return { rowCount: 0, rows: [] };
  } };
}

test('growth founds a place for the most over-served family and respects the cooldown', async () => {
  const now = new Date('2026-10-19T12:00:00Z');
  const inserted = [];
  const client = fakeClient([
    [/SELECT max\(created_at\)/, { rowCount: 1, rows: [{ at: null }] }],
    [/GROUP BY l\.root_gwa/, { rowCount: 1, rows: [{ gwa: 'onet:gwa:4.A.4.a.5', practices: 250, residents: 4, founder: 'agent-1' }] }],
    [/features->>'skillGroup' AS gwa/, { rowCount: 0, rows: [] }],
    [/SELECT name FROM world_skill_library/, { rowCount: 1, rows: [{ name: 'Assisting and Caring for Others' }] }],
    [/INSERT INTO world_scenes/, (params) => { inserted.push(params); return { rowCount: 1, rows: [{ id: 'scene-1', name: params[2], sceneType: params[3] }] }; }]
  ]);
  const place = await growSkillPlaces(client, { worldId: 'w', worldMinutes: 5, now });
  assert.equal(place.name, 'MirrorTerra Clinic');
  assert.equal(inserted[0][3], 'clinic');
  assert.equal(JSON.parse(inserted[0][6]).skillGroup, 'onet:gwa:4.A.4.a.5');
  const cooling = fakeClient([[/SELECT max\(created_at\)/, { rowCount: 1, rows: [{ at: new Date(now.getTime() - PLACE_GROWTH_COOLDOWN_MS / 2) }] }]]);
  assert.equal(await growSkillPlaces(cooling, { worldId: 'w', now }), null);
  assert.equal(cooling.calls.length, 1);
});

test('the beach is created once and growth errors never escape', async () => {
  const client = fakeClient([
    [/scene_type='beach' LIMIT 1/, { rowCount: 0, rows: [] }],
    [/FROM world_members WHERE world_id=\$1 ORDER BY joined_at/, { rowCount: 1, rows: [{ agent_id: 'agent-1' }] }],
    [/INSERT INTO world_scenes/, (params) => ({ rowCount: 1, rows: [{ id: 'b1', name: params[2], sceneType: 'beach' }] })]
  ]);
  const beach = await ensureBeach(client, { worldId: 'w' });
  assert.equal(beach.name, 'Moonrise Beach');
  const existing = fakeClient([[/scene_type='beach' LIMIT 1/, { rowCount: 1, rows: [{ id: 'b1' }] }]]);
  assert.equal(await ensureBeach(existing, { worldId: 'w' }), null);
  const broken = { async query(sql) { if (/SAVEPOINT/.test(sql)) return {}; throw new Error('boom'); } };
  const result = await growWorldPlacesSafely(broken, { worldId: 'w' });
  assert.equal(result.error, 'boom');
});

test('migration 0025 keeps legacy types valid and allows open slugs', () => {
  const sql = readFileSync(new URL('../migrations/0025_world_skill_places.sql', import.meta.url), 'utf8');
  assert.match(sql, /data_center/);
  assert.match(sql, /\^\[a-z\]\[a-z_\]\{2,39\}\$/);
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|TRUNCATE/i);
});
