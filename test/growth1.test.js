// growth1: the town grows from what residents really use (unit tests, no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DROPPED_TYPES, GROWTH_TYPES, LEVEL_EFFECT_MAX, REPAIR_THRESHOLD, USE_SPECS, apartmentBeds, conditionFactor,
  districtUnlockDecision, expansionPriceRaw, facilityCapacity, growthPosition, initialCondition, levelFactor, marketListingBonus,
  onSiteEffect, publicWorkUseCandidates, repairPriceRaw, setGrowthCache, useCounts, wornCondition } from '../src/public-works-growth.js';
import { NOT_CAPACITY_SKIP, PASSIVE_LEVEL_CAP, applyPublicWorkUse, applyPublicWorksNeedBonus, buildingSpec, districtOfPosition,
  fallbackCommission, publicWorksEffectsFromScenes, publicWorksNeeds, repairNeeds, summarizeGrowthDemand,
  validateCommission } from '../src/public-works.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const code = (text) => text.split('\n').filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('--')).join('\n');
const SYNC = 1_000_000n;
const W = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const category = (over = {}) => ({ buildings: 0, uses24h: 0, capacity: 0, minUtilization: 0, latent: 0, ...over });
// growth2: demand now also carries where residents go (reach) and the world minute (expansion cooldown).
const spot = growthPosition(1, 0);
const reachEverywhere = () => ({ districtTraffic: Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, { visits: 50, residents: 12 }])),
  anchors: Array.from({ length: 12 }, (_, i) => ({ agentId: `r${i}`, home: { x: spot.x, z: spot.z }, work: null })),
  points: { all: Array.from({ length: 40 }, () => ({ x: spot.x, z: spot.z })) }, taken: [] });
const quiet = () => ({ worldMinutes: 100_000, residents: 12, lowEnergy: 0, lowEnergyFarByDistrict: {}, housing: { homeless: 0, beds: 0 }, facilities: [],
  categories: Object.fromEntries(['care','learn','leisure','social','market','craft','housing'].map((key) => [key, category()])),
  districtTrips: [], newestDistrict: 4, uses24h: 0, saturated: [], reach: reachEverywhere() });
const facility = (n, type, uses24h, { level = 3, condition = 90, district = 1, name = `${type} ${n}` } = {}) => {
  const capacity = facilityCapacity(type, level);
  return { workId: W(n), type, storedKind: GROWTH_TYPES[type]?.storedKind || type, name, sceneId: W(100 + n), sceneName: name,
    level, district, condition, uses24h, usesTotal: uses24h * 5, repairs: 0, capacity, utilization: Math.round(uses24h / capacity * 1000) / 1000,
    uses72h: uses24h * 3, usesPrev24h: uses24h, renewedMinute: 0 };
};

test('demand gate: nothing measured or nothing used -> nothing commissioned; low use never expands', () => {
  assert.deepEqual(publicWorksNeeds({}), []);
  const demand = quiet();
  demand.facilities = [facility(1, 'clinic', 3), facility(2, 'school', 2), facility(3, 'park', 0)];
  demand.categories.care = category({ buildings: 1, uses24h: 3, capacity: demand.facilities[0].capacity, minUtilization: demand.facilities[0].utilization });
  assert.deepEqual(publicWorksNeeds({ demand }), [], 'a quiet town with all 17 buildings needs nothing new');
  // The old fixed checklist is gone: 0 roads/parks/clinics alone justify nothing.
  assert.deepEqual(publicWorksNeeds({ demand: quiet(), completed: [] }), []);
});

test('demand gate: a building near capacity is expanded, with the measured numbers in the reason; cost rises with level', () => {
  const demand = quiet();
  const busy = facility(1, 'clinic', 16, { level: 3 }); // capacity 18 at level 3
  demand.facilities = [busy, facility(2, 'clinic', 4, { level: 3 })];
  const needs = publicWorksNeeds({ demand });
  const expansion = needs.find((need) => need.workType === 'expand');
  assert.equal(expansion.targetWorkId, busy.workId);
  assert.equal(expansion.targetLevel, 4, 'no level-3 cap any more');
  assert.match(expansion.reason, /16 visits in 24 h and 16 the day before vs capacity 18 \(89%\/89%\)/);
  assert.equal(needs.filter((need) => need.workType === 'expand').length, 1, 'the little-used clinic gets no expansion');
  assert.equal(BigInt(expansion.baseRaw), expansionPriceRaw(10, 3));
  assert.ok(expansionPriceRaw(10, 3) > expansionPriceRaw(10, 2) && expansionPriceRaw(10, 2) > expansionPriceRaw(10, 1));
  assert.equal(expansionPriceRaw(10, 1), 6n * SYNC);
  // A worn building is repaired before it is expanded.
  demand.facilities = [{ ...busy, condition: 50 }];
  assert.equal(publicWorksNeeds({ demand }).filter((need) => need.workType === 'expand').length, 0);
});

test('demand gate: new building only when every one of its kind is busy and the category is near capacity; larger kind next', () => {
  const demand = quiet();
  const a = facility(1, 'clinic', 16), b = facility(2, 'clinic', 15);
  demand.facilities = [a, b];
  demand.categories.care = category({ buildings: 2, uses24h: 31, capacity: a.capacity + b.capacity, minUtilization: b.utilization,
    usesPrev24h: 31, minUtilizationPrev: b.utilization, lastChangeMinute: 0 });
  const needs = publicWorksNeeds({ demand });
  const hospital = needs.find((need) => need.workType === 'build');
  assert.equal(hospital.buildingType, 'hospital', 'two busy clinics -> a hospital');
  assert.equal(hospital.kind, 'clinic', 'stored under the closest legacy kind (rollback-safe)');
  assert.match(hospital.reason, /served 31 visits in 24 h and 31 the day before vs capacity 36 \(86%\/86%\)/);
  // One quiet clinic blocks a new building even if the other is full.
  demand.facilities = [a, facility(2, 'clinic', 4)];
  demand.categories.care = category({ buildings: 2, uses24h: 20, capacity: 36, minUtilization: 0.222 });
  assert.equal(publicWorksNeeds({ demand }).filter((need) => need.workType === 'build').length, 0);
});

test('demand gate: homeless residents -> apartment; low energy far from care -> clinic there; trips -> road then bridge', () => {
  const demand = quiet();
  demand.housing = { homeless: 4, beds: 0 };
  demand.lowEnergyFarByDistrict = { 3: 4, 4: 1 };
  demand.districtTrips = [{ district: 5, trips24h: 22, walkMinutes: 30, hasRoad: false, hasBridge: false },
    { district: 4, trips24h: 40, walkMinutes: 27, hasRoad: true, hasBridge: true },
    { district: 3, trips24h: 8, walkMinutes: 23, hasRoad: false, hasBridge: false }];
  const needs = publicWorksNeeds({ demand });
  const apartment = needs.find((need) => need.buildingType === 'apartment');
  assert.match(apartment.reason, /4 residents have no finished home and the town has 0 apartment beds/);
  const clinic = needs.find((need) => need.buildingType === 'clinic');
  assert.equal(clinic.district, 3);
  assert.match(clinic.reason, /4 residents with energy below 35 are in District 3/);
  assert.ok(!needs.some((need) => /District 4 Clinic/.test(need.name)), '1 tired resident is not enough');
  const road = needs.find((need) => need.buildingType === 'road');
  assert.match(road.reason, /22 trips into District 5 in 24 h .*30 walking minutes/);
  assert.ok(!needs.some((need) => need.buildingType === 'road' && need.district === 3), '8 trips/day is below the threshold');
  assert.ok(!needs.some((need) => need.buildingType === 'bridge'), 'district 5 gets its road first; district 4 is served');
  // Beds cover the homeless -> no apartment; a full apartment is expanded instead of building a second one.
  assert.ok(!publicWorksNeeds({ demand: { ...quiet(), housing: { homeless: 4, beds: 4 } } }).length);
  const full = { ...quiet(), housing: { homeless: 6, beds: 4 }, facilities: [facility(9, 'apartment', 8, { level: 1 })] };
  const grow = publicWorksNeeds({ demand: full });
  assert.equal(grow[0].workType, 'expand');
  assert.equal(grow[0].targetType, 'apartment');
  for (const need of needs) assert.ok(/\d/.test(need.reason), `${need.projectKey} states measured numbers`);
  // The fallback and validation work on these needs unchanged (full price must be funded).
  assert.equal(fallbackCommission({ needs, freeRaw: 1n * SYNC }), null);
  assert.throws(() => validateCommission({ needs, freeRaw: 1n * SYNC, projectKey: road.projectKey, priceRaw: 8n * SYNC }), /UNFUNDED/);
});

test('use effects: on-site use is clearly better than the passive buff; diminishing returns; neglect reduces effect', () => {
  assert.equal(levelFactor(1), 1);
  assert.ok(levelFactor(2) > levelFactor(1) && levelFactor(10) > levelFactor(5));
  assert.ok(levelFactor(5) - levelFactor(4) < levelFactor(2) - levelFactor(1), 'diminishing');
  assert.ok(levelFactor(1000) <= LEVEL_EFFECT_MAX, 'bounded however far expanded');
  assert.ok(facilityCapacity('clinic', 16) < 16 * facilityCapacity('clinic', 1), 'capacity grows sub-linearly');
  const clinic = onSiteEffect('clinic', { level: 3, condition: 100 });
  const passive = applyPublicWorksNeedBonus({ energy: 30, food: 50, social: 40, hygiene: 50, fun: 50 },
    publicWorksEffectsFromScenes([{ status: 'active', features: { origin: 'public_works', publicWork: { stage: 'built', kind: 'clinic', level: 3 } } }]), 1);
  assert.ok(clinic.needs.energy >= 3 * (passive.energy - 30), `one clinic visit (+${clinic.needs.energy}) beats an hour of passive buff (+${passive.energy - 30})`);
  assert.ok(onSiteEffect('hospital').needs.energy > onSiteEffect('clinic').needs.energy);
  assert.ok(onSiteEffect('school', { level: 3 }).skills.research > 0.5, 'school: on-site research gain on top of the normal 0.5');
  assert.ok(onSiteEffect('workshop').skills.engineering > 0 && onSiteEffect('harbor').listing > onSiteEffect('market_hall').listing);
  assert.equal(conditionFactor(100), 1);
  assert.equal(conditionFactor(60), 1);
  assert.ok(conditionFactor(30) < 1 && conditionFactor(0) === 0.35, 'neglected buildings lose effect but never vanish');
  const worn = onSiteEffect('clinic', { level: 3, condition: 10 });
  assert.ok(worn.needs.energy < clinic.needs.energy);
  // Passive buffs: still capped at level 3, scaled by condition.
  const effects = publicWorksEffectsFromScenes([{ status: 'active', features: { origin: 'public_works',
    publicWork: { stage: 'built', kind: 'school', level: 9, condition: 100 } } }, { status: 'active', features: { origin: 'public_works',
    publicWork: { stage: 'built', kind: 'library', level: 1, condition: 0 } } }]);
  assert.equal(effects.schools, PASSIVE_LEVEL_CAP + 0.35);
  assert.ok(useCounts('park', 'rest') && useCounts('park', 'socialize') && !useCounts('park', 'work'));
  assert.ok(useCounts('market_hall', 'work') && !useCounts('road', 'work'));
});

test('use affordances: residents get real reasons to go to the buildings (externals too)', () => {
  const scene = (name, kind, extra = {}) => ({ id: name, name, status: 'active', features: { origin: 'public_works',
    publicWork: { stage: 'built', kind, level: 3, condition: 90, ...extra } } });
  const scenes = [scene('Public Clinic', 'clinic'), scene('Public School', 'school'), scene('Commons Park', 'park'),
    scene('Community Hall', 'public_building'), scene('Market Hall', 'market_hall'), scene('Apartment Block', 'apartment'),
    scene('Workshop District', 'workshop'), { id: 'site', name: 'Site', status: 'inactive', features: { origin: 'public_works',
      publicWork: { stage: 'building', kind: 'library' } } }];
  const tired = publicWorkUseCandidates({ agentId: 'a', energy: 25, food: 60, hygiene: 40, fun: 40, social: 30, knowledge: 20,
    homeStatus: 'building' }, scenes, { founders: new Set(['a']) });
  const byType = Object.fromEntries(tired.map((option) => [option.publicWorkUse, option]));
  for (const type of ['clinic','school','park','public_building','market_hall','apartment','workshop']) assert.ok(byType[type], type);
  assert.equal(byType.clinic.action, 'rest');
  assert.equal(byType.school.action, 'learn');
  assert.equal(byType.public_building.action, 'socialize');
  assert.equal(byType.market_hall.action, 'work');
  assert.ok(!tired.some((option) => option.targetLocation === 'Site'), 'construction sites are not destinations');
  const fresh = publicWorkUseCandidates({ agentId: 'b', energy: 90, food: 80, hygiene: 90, fun: 90, social: 90, knowledge: 95,
    homeStatus: 'built' }, scenes, { founders: new Set() });
  assert.ok(!fresh.some((option) => ['clinic','apartment','market_hall'].includes(option.publicWorkUse)),
    'healthy, housed, no business: no clinic, apartment or market visit');
  // A recent market listing lowers the urge to sell again; the listing gives buyers a bonus.
  const listed = publicWorkUseCandidates({ agentId: 'a', energy: 60, food: 60 }, [scenes[4]], { founders: new Set(['a']),
    listed: new Map([['a', 1000]]), worldMinutes: 500 });
  assert.ok(listed[0].score < byType.market_hall.score);
  setGrowthCache('w', 1, { listingFactor: new Map([['founder', 1.2]]) });
  assert.ok(marketListingBonus('founder') > 0 && marketListingBonus('nobody') === 0);
});

test('use logging: every use is one countable row (agent, work, activity, minute, effect) and wears the building', async () => {
  const calls = [];
  const client = { async query(sql, params = []) {
    const text = String(sql); calls.push({ text, params });
    if (/to_regclass\('public\.world_public_work_uses'\)/.test(text)) return { rows: [{ ready: true }], rowCount: 1 };
    if (/FROM world_public_works work\s+LEFT JOIN world_public_work_conditions/.test(text)) return { rows: [{ id: W(1), condition: 80 }], rowCount: 1 };
    if (/FROM world_external_residents/.test(text)) return { rows: [{ x: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const scene = { id: W(101), name: 'Public School', status: 'active', features: { origin: 'public_works',
    publicWork: { stage: 'built', kind: 'school', level: 3 } } };
  assert.equal(await applyPublicWorkUse(client, { worldId: 'w', agentId: 'ext', scene, activity: 'rest', worldMinutes: 10 }), null,
    'resting at a school is not a school use');
  const use = await applyPublicWorkUse(client, { worldId: 'w', agentId: 'ext', scene, activity: 'learn', worldMinutes: 1234 });
  assert.equal(use.type, 'school');
  assert.equal(use.external, true, 'external residents can use buildings');
  const insert = calls.find((call) => /INSERT INTO world_public_work_uses/.test(call.text));
  assert.deepEqual(insert.params.slice(0, 9), ['w', W(1), W(101), 'ext', 'school', 'learn', 'learn', true, 1234]);
  assert.ok(JSON.parse(insert.params[9]).skills.research > 0);
  const wear = calls.find((call) => /UPDATE world_public_work_conditions SET condition=GREATEST\(0,condition-\$3\),uses_total=uses_total\+1/.test(call.text));
  assert.ok(wear, 'a use wears the building and counts');
  assert.ok(!calls.some((call) => /world_sync_treasury_entries|arc_sync_|world_external_resident_balances/.test(call.text)), 'a use moves no money');
});

test('maintenance: buildings wear (faster with use), repairs are tendered below 70 and priced from value x wear; never deleted', () => {
  assert.equal(initialCondition(0), 100);
  assert.equal(initialCondition(10 * 1440), 80);
  assert.equal(initialCondition(400 * 1440), 30, 'floor');
  assert.equal(wornCondition(100, 24), 98);
  assert.equal(wornCondition(1, 1000), 0);
  const demand = quiet();
  demand.facilities = [facility(1, 'clinic', 6, { condition: 45 }), facility(2, 'park', 2, { condition: 69.9 }),
    facility(3, 'school', 1, { condition: 71 }), facility(4, 'hospital', 3, { condition: 20 })];
  const repairs = repairNeeds({ demand, open: [{ projectKey: 'repair:x', targetWorkId: W(2) }] });
  assert.deepEqual(repairs.map((need) => need.targetWorkId), [W(4), W(1)], 'worst first; one open repair per building; >=70 waits');
  assert.equal(repairs[0].kind, 'expansion', 'a repair is a targeted contract (rollback-safe kind)');
  assert.equal(repairs[0].workType, 'repair');
  assert.match(repairs[1].reason, /condition 45\.0\/100 \(repair below 70\); 18 visits in 72 h \(6 in 24 h\)/);
  assert.equal(BigInt(repairs[1].baseRaw), repairPriceRaw(10, 3, 45));
  assert.ok(repairPriceRaw(10, 3, 20) > repairPriceRaw(10, 3, 60) && repairPriceRaw(10, 1, 99) === 500_000n);
  assert.equal(REPAIR_THRESHOLD, 70);
  const migration = code(read('../migrations/0032_public_works_growth.sql'));
  assert.match(migration, /Public work conditions are never deleted/);
  assert.match(migration, /NEW\.condition>OLD\.condition AND NEW\.repairs<>OLD\.repairs\+1/);
  const works = read('../src/public-works.js');
  assert.match(works, /SET condition=100,repairs=repairs\+1/);
  assert.match(works, /MAINTENANCE_REPAIR/);
  assert.doesNotMatch(code(works), /DELETE FROM world_scenes|DELETE FROM world_public_works/);
});

test('districts unlock only from building and usage thresholds, at most every two world days', () => {
  const base = { districts: 4, facilities: 17, uses24h: 50, residents: 14, saturated: ['care'], lastUnlockMinute: null, worldMinutes: 10_000,
    newestTraffic: 20 };
  assert.equal(districtUnlockDecision(base).unlock, true);
  assert.equal(districtUnlockDecision(base).district, 5);
  assert.match(districtUnlockDecision(base).reason, /17 public buildings \(need 17\), 50 visits in 24 h \(need 42\), saturated: care/);
  assert.equal(districtUnlockDecision({ ...base, saturated: [] }).unlock, false, 'nothing saturated -> no new district');
  assert.equal(districtUnlockDecision({ ...base, uses24h: 41 }).unlock, false);
  assert.equal(districtUnlockDecision({ ...base, facilities: 16 }).unlock, false);
  assert.equal(districtUnlockDecision({ ...base, lastUnlockMinute: 9000 }).unlock, false);
  const position = growthPosition(5, 0);
  assert.equal(position.district, 5);
  assert.ok(Math.hypot(position.x, position.z) > 2.6);
  assert.equal(districtOfPosition({ x: 0.3, z: 0.2 }), 0, 'the original town');
  assert.equal(districtOfPosition({ x: 1.3, z: 0 }), 1);
  assert.equal(districtOfPosition({ x: 0, z: 0, district: 4 }), 4);
});

test('measured demand summary: facility use vs capacity, homeless, low energy far from care, trips per district', () => {
  const scenes = [{ name: 'Public Clinic', sceneType: 'public_clinic', position: { x: 0.8, z: 1.2, district: 1 }, features: { origin: 'public_works' } },
    { name: 'Far Lab', sceneType: 'lab', position: { x: 2.3, z: 0, district: 4 }, features: { skillGroup: 'x' } },
    { name: 'Garden', sceneType: 'garden', position: { x: 0.2, z: 0.1 }, features: {} }];
  const demand = summarizeGrowthDemand({ worldMinutes: 5000, districts: 4, founders: 3,
    facilities: [{ workId: W(1), kind: 'clinic', type: 'clinic', name: 'Public Clinic', sceneId: W(9), position: scenes[0].position,
      level: 3, condition: 55, usesTotal: 40, repairs: 0, uses24h: 9 }],
    residents: [{ energy: 20, location: 'Far Lab', homeStatus: 'built' }, { energy: 20, location: 'Far Lab', homeStatus: null },
      { energy: 30, location: 'Garden', homeStatus: 'building' }, { energy: 80, location: 'Garden', homeStatus: 'built' }],
    actions: [{ action: 'learn', place: 'Far Lab' }, { action: 'rest', place: 'Garden' }, { action: 'rest', place: 'Public Clinic' }],
    scenes });
  assert.equal(demand.facilities[0].capacity, 18);
  assert.equal(demand.facilities[0].utilization, 0.5);
  assert.deepEqual(demand.housing, { homeless: 2, beds: 0 });
  assert.equal(demand.lowEnergy, 3);
  assert.deepEqual(demand.lowEnergyFarByDistrict, { 4: 2 }, 'the town (district 0) is served by the district-1 clinic');
  assert.equal(demand.categories.care.uses24h, 9);
  assert.equal(demand.categories.learn.latent, 1);
  assert.equal(demand.categories.market.latent, 3);
  assert.deepEqual(demand.districtTrips.map((row) => [row.district, row.trips24h]), [[1, 1], [4, 1]]);
  assert.deepEqual(demand.saturated, ['housing'], '2 homeless and no beds: housing is saturated');
  assert.equal(apartmentBeds(1), 4);
});

test('new kinds: each has a real mechanical use, a required skill, a base price and a 3D look; dropped kinds are reported', () => {
  for (const [type, spec] of Object.entries(GROWTH_TYPES)) {
    assert.ok(USE_SPECS[type], `${type} has an on-site use`);
    assert.ok(['engineering','research','social','trading'].includes(spec.skill), `${type}: skill fits the 0030 CHECK`);
    assert.ok(spec.baseSync > 0 && spec.archetype && /^#[0-9a-f]{6}$/i.test(spec.accent));
    assert.ok(['road','park','market_hall','clinic','school','bridge','public_building'].includes(spec.storedKind));
    assert.equal(buildingSpec(type), spec);
  }
  assert.deepEqual(Object.keys(DROPPED_TYPES).sort(), ['power_station','water_works']);
  const places = read('../site/world-places3d.js');
  for (const archetype of ['library','hospital','harbor','apartment']) assert.match(places, new RegExp(`function ${archetype}\\(b, accent, r\\)`));
  assert.match(places, /atelier/);
  const app = read('../site/app.js'), world3d = read('../site/world3d.js');
  assert.match(app, /public_hospital: '✚'/);
  assert.match(world3d, /'Visits \(24 h\)'/);
});

test('money: no new money, externals stay unpaid volunteers, migration additive, kill switches and gates untouched', () => {
  const works = code(read('../src/public-works.js')), growth = code(read('../src/public-works-growth.js'));
  const engine = code(read('../src/world-engine.js'));
  // The only treasury outflow is still kind 'public_works' to the contracted builder, through postTreasuryEntry.
  const posts = [...works.matchAll(/kind: '([a-z_]+)',\s*\n?\s*toAgentId/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(posts)], ['public_works']);
  assert.doesNotMatch(growth, /postTreasuryEntry|INSERT INTO|UPDATE /, 'the pure rules move nothing');
  assert.ok(engine.includes('applyPublicWorkUse('));
  assert.doesNotMatch(works, /INSERT INTO arc_sync_|INSERT INTO world_sync_treasury_entries|arc_sync_resident_reward_entitlements \(/);
  assert.doesNotMatch(works, /MAINNET_WRITE_GATE|SYNC_COMMITTED_PAYOUT_WRITE_GATE|SYNC_RESIDENT_REWARD_COMMIT_ENABLED/);
  // external1b guards intact: externals never bid for a paid contract and never get heuristic bids.
  assert.match(works, /if \(await isExternalResident\(client, worldId, agentId\)\) throw coded\('EXTERNAL_VOLUNTEER_ONLY', 403\)/);
  assert.match(works, /if \(resident\.external \|\| externals\.has\(resident\.agentId\)\) continue;/);
  assert.match(works, /filter\(\(resident\) => !resident\?\.external\)/, 'commission capacity counts internal builders only');
  // Repairs and growth commissions keep the NO_BUILDER_CAPACITY rule.
  assert.match(works, /if \(!capacity\.hasCapacity\) \{\s*summary\.repairSkipped = \{ reason: NO_BUILDER_CAPACITY/);
  assert.match(NOT_CAPACITY_SKIP, /NO_BUILDER_CAPACITY/);
  // Migration 0032: additive only.
  const migration = code(read('../migrations/0032_public_works_growth.sql'));
  assert.doesNotMatch(migration, /\bALTER\b|\bDROP\b|\bTRUNCATE\b|DELETE FROM|UPDATE world_|REVOKE/i);
  assert.equal([...migration.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]).join(','),
    'world_public_work_meta,world_public_work_conditions,world_public_work_uses,world_growth_districts');
  assert.doesNotMatch(migration, /treasury|entitlement|balance|transfer/i, 'no money table');
});

test('conservation: a repair contract pays exactly its contract price from the treasury in milestones (no SYNC created)', async () => {
  const { milestonePayments } = await import('../src/public-works.js');
  const contract = repairPriceRaw(10, 3, 40);
  const payments = milestonePayments({ progress: 100, milestonesPaid: 0, contractPriceRaw: contract, paidRaw: 0n });
  assert.equal(payments.reduce((sum, payment) => sum + payment.amountRaw, 0n), contract);
  // Treasury -> builder only: residents + treasury stays constant per payment.
  let treasury = 4_756_825_895n, builder = 0n;
  for (const payment of payments) { treasury -= payment.amountRaw; builder += payment.amountRaw; }
  assert.equal(treasury + builder, 4_756_825_895n);
});
