// growth2: reachability, repairs only for used buildings, slower expansion (unit tests, no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DISTRICT_MIN_TRAFFIC, EXPANSION_COST_GROWTH, EXPANSION_SUSTAIN_MINUTES, GROWTH_TYPES, REACH_MAX_WALK_MINUTES,
  REACH_MIN_TRAFFIC, categoryGrowthDecision, choosePlacement, districtUnlockDecision, expansionDecision, expansionPriceRaw, facilityCapacity,
  growthPosition, publicWorkUseCandidates, repairEligible, walkMinutesBetween } from '../src/public-works-growth.js';
import { publicWorksNeeds, repairNeeds, summarizeReach } from '../src/public-works.js';
import { driveProfileFor } from '../src/world-drive-choice.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const W = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const category = (over = {}) => ({ buildings: 0, uses24h: 0, capacity: 0, minUtilization: 0, latent: 0, ...over });
const near = growthPosition(1, 0);
const far = growthPosition(5, 7);
const at = (p, n) => Array.from({ length: n }, () => ({ x: p.x, z: p.z }));
const traffic = (map) => Object.fromEntries(Object.entries(map).map(([d, visits]) => [d, { visits, residents: 5 }]));
const anchorsAt = (p, n = 10) => Array.from({ length: n }, (_, i) => ({ agentId: `r${i}`, home: { x: p.x, z: p.z }, work: null }));
const demandWith = (reach, over = {}) => ({ worldMinutes: 100_000, residents: 10, lowEnergy: 0, lowEnergyFarByDistrict: {},
  housing: { homeless: 0, beds: 0 }, facilities: [], districtTrips: [], newestDistrict: 5, uses24h: 0, saturated: [], reach,
  categories: Object.fromEntries(['care','learn','leisure','social','market','craft','housing'].map((key) => [key, category()])), ...over });
const facility = (n, type, { uses24h = 0, usesPrev24h = uses24h, uses72h = uses24h * 3, level = 1, condition = 90,
  renewedMinute = 0 } = {}) => {
  const capacity = facilityCapacity(type, level);
  return { workId: W(n), type, storedKind: GROWTH_TYPES[type]?.storedKind || type, name: `${type} ${n}`, sceneId: W(100 + n),
    level, district: 1, condition, uses24h, usesPrev24h, uses72h, usesTotal: uses72h, repairs: 0, capacity, renewedMinute,
    utilization: Math.round(uses24h / capacity * 1000) / 1000 };
};

test('reachability: a new building goes only to a district residents visit, within walking reach of homes/workplaces', () => {
  // Residents live and work near district 1; district 5 (the newest) has no measured traffic.
  const reach = { districtTraffic: traffic({ 1: 60, 2: 3, 5: 0 }), anchors: anchorsAt(near), points: { all: at(near, 30) }, taken: [] };
  const placed = choosePlacement({ category: 'learn', reach, newestDistrict: 5 });
  assert.equal(placed.ok, true);
  assert.equal(placed.district, 1, 'not the empty newest ring');
  assert.ok(walkMinutesBetween(placed.position, near) <= REACH_MAX_WALK_MINUTES);
  assert.match(placed.text, /placed in District 1: 60 resident visits there in 24 h; 10\/10 residents live or work within 18 walking min/);
  // An outer district with no traffic is never chosen, even when it is the only candidate.
  assert.equal(choosePlacement({ category: 'learn', reach, district: 5 }).ok, false);
  assert.equal(choosePlacement({ category: 'learn', reach, district: 2 }).ok, false, `${REACH_MIN_TRAFFIC}+ visits needed`);
  // Traffic but nobody lives or works within reach -> no slot.
  const remote = { ...reach, districtTraffic: traffic({ 5: 40 }), anchors: anchorsAt({ x: 0, z: 0 }) };
  assert.equal(choosePlacement({ category: 'learn', reach: remote, district: 5 }).ok, false);
  // Occupied slots are skipped.
  const taken = { ...reach, taken: [{ x: placed.position.x, z: placed.position.z }] };
  const second = choosePlacement({ category: 'learn', reach: taken, newestDistrict: 5 });
  assert.ok(second.ok && (second.position.x !== placed.position.x || second.position.z !== placed.position.z));
  assert.equal(choosePlacement({ category: 'learn', reach: null }).ok, false, 'no measurement -> nothing placed');
});

test('reachability: workshop district only where crafting demand is measured within reach; never on far latent demand', () => {
  // growth1 failure: 111 workshop shifts measured anywhere -> workshop placed in the newest outer ring, 0 visits.
  const farDemand = { districtTraffic: traffic({ 1: 80, 5: 0 }), anchors: anchorsAt(near),
    points: { craft: at(far, 40), all: at(near, 40) }, taken: [] };
  const demand = demandWith(farDemand);
  demand.categories.craft = category({ latent: 111 });
  assert.equal(publicWorksNeeds({ demand }).filter((need) => need.buildingType === 'workshop').length, 0,
    'craft demand far from any visited, reachable slot builds nothing');
  assert.ok(demand.unplaced.some((row) => row.category === 'craft'), 'the skipped need is recorded');
  // The same demand measured where residents work -> a workshop there, with the placement in the reason.
  const nearDemand = { ...farDemand, points: { craft: at(near, 40), all: at(near, 40) } };
  const demand2 = demandWith(nearDemand);
  demand2.categories.craft = category({ latent: 111 });
  const workshop = publicWorksNeeds({ demand: demand2 }).find((need) => need.buildingType === 'workshop');
  assert.ok(workshop, 'reachable craft demand -> workshop');
  assert.equal(workshop.district, 1);
  assert.ok(workshop.position && Number.isFinite(workshop.position.x));
  assert.match(workshop.reason, /measured 111 work shifts.*40 of them within reach; placed in District 1/);
  assert.equal(workshop.demand.placement.district, 1);
  // Below the latent threshold within reach (only 10 nearby shifts) -> no workshop.
  const thin = demandWith({ ...nearDemand, points: { craft: [...at(near, 10), ...at(far, 60)], all: at(near, 40) } });
  thin.categories.craft = category({ latent: 70 });
  assert.equal(publicWorksNeeds({ demand: thin }).filter((need) => need.buildingType === 'workshop').length, 0);
  // Commission uses the chosen slot.
  assert.match(read('../src/public-works.js'), /if \(need\.workType === 'build' && need\.position\) \{/);
});

test('reachability: apartments and district clinics follow the residents; districts open only after the newest is visited', () => {
  const reach = { districtTraffic: traffic({ 1: 50, 3: 30 }), anchors: anchorsAt(near), points: { all: at(near, 20) }, taken: [] };
  const needs = publicWorksNeeds({ demand: demandWith(reach, { housing: { homeless: 4, beds: 0 }, lowEnergyFarByDistrict: { 3: 4, 5: 6 } }) });
  const apartment = needs.find((need) => need.buildingType === 'apartment');
  assert.equal(apartment.district, 1);
  assert.match(apartment.reason, /placed in District 1/);
  assert.ok(needs.some((need) => need.buildingType === 'clinic' && need.district === 3), 'district 3 is visited and in reach');
  assert.ok(!needs.some((need) => need.buildingType === 'clinic' && need.district === 5), 'district 5 has no measured traffic');
  const base = { districts: 4, facilities: 17, uses24h: 50, residents: 14, saturated: ['care'], lastUnlockMinute: null, worldMinutes: 10_000 };
  assert.equal(districtUnlockDecision({ ...base, newestTraffic: DISTRICT_MIN_TRAFFIC - 1 }).unlock, false, 'nobody goes to district 4');
  assert.equal(districtUnlockDecision({ ...base, newestTraffic: DISTRICT_MIN_TRAFFIC }).unlock, true);
  assert.match(districtUnlockDecision({ ...base, newestTraffic: 3 }).reason, /District 4 had 3 resident visits in 24 h \(need 10\)/);
});

test('reach summary: visits per district, homes and most frequent workplace as anchors, category demand points', () => {
  const scenes = [{ name: 'Old Workshop', sceneType: 'workshop', position: { x: 0.5, z: 0.1 }, features: {} },
    { name: 'Far Lab', sceneType: 'lab', position: { x: 2.3, z: 0, district: 4 }, features: { skillGroup: 'x' } },
    { name: 'Garden', sceneType: 'garden', position: { x: 0.2, z: 0.1 }, features: {} }];
  const reach = summarizeReach({ scenes, residents: [{ agentId: 'a', energy: 80, homeStatus: 'built' },
    { agentId: 'b', energy: 20, location: 'Garden', homeStatus: null }],
  actions: [{ agentId: 'a', action: 'work', place: 'Old Workshop' }, { agentId: 'a', action: 'work', place: 'Old Workshop' },
    { agentId: 'a', action: 'work', place: 'Far Lab' }, { agentId: 'b', action: 'rest', place: 'Garden' },
    { agentId: 'b', action: 'rest', place: 'home:b' }] });
  assert.equal(reach.districtTraffic[0].visits, 3);
  assert.equal(reach.districtTraffic[4].visits, 1);
  assert.equal(reach.districtTraffic[1].visits, 1, 'homes sit on the inner edge of district 1');
  assert.deepEqual(reach.anchors.find((row) => row.agentId === 'a').work, { x: 0.5, z: 0.1 }, 'most frequent workplace');
  assert.equal(reach.anchors.find((row) => row.agentId === 'b').work, null);
  assert.equal(reach.points.craft.length, 3);
  assert.equal(reach.points.leisure.length, 1);
  assert.equal(reach.points.care.length, 1, 'low-energy resident location');
  assert.equal(reach.points.housing.length, 1);
  assert.equal(reach.taken.length, 3);
});

test('workshop choice: the public workshop competes with the resident\'s best crafting shift, plus its on-site bonus', () => {
  const scene = { id: 'ws', name: 'Workshop District', status: 'active', features: { origin: 'public_works', kind: 'workshop',
    publicWork: { stage: 'built', kind: 'workshop', level: 1, condition: 100 } } };
  const agent = { agentId: 'a', energy: 70, food: 60 };
  const [low] = publicWorkUseCandidates(agent, [scene], {});
  const [matched] = publicWorkUseCandidates(agent, [scene], { craftScore: 71 });
  assert.equal(low.score, 26 + 8, 'growth1 base (26) + boost when no crafting shift is on offer');
  assert.equal(matched.score, 71 + 8, 'best crafting shift (71) + on-site boost: preferred at equal distance');
  assert.ok(matched.score > 71);
  const profile = driveProfileFor({ action: 'work', targetLocation: 'Workshop District' }, { sceneType: 'public_workshop', features: scene.features });
  assert.equal(profile.creation, 0.6, 'a making place for the creation/mastery drives, like a workshop');
  const engine = read('../src/world-engine.js');
  assert.match(engine, /craftScore: Number\.isFinite\(craftScore\) \? craftScore : null/);
});

test('repairs only for used buildings: no visit in 3 world days -> no repair; roads and bridges exempt; never deleted', () => {
  const demand = demandWith(null);
  demand.facilities = [facility(1, 'market_hall', { uses24h: 0, uses72h: 0, condition: 50 }),
    facility(2, 'clinic', { uses24h: 0, uses72h: 2, condition: 60 }),
    { ...facility(3, 'road', { condition: 55 }), uses72h: 0 }, { ...facility(4, 'bridge', { condition: 65 }), uses72h: 0 },
    { ...facility(5, 'park', { condition: 40 }), uses72h: null }];
  const repairs = repairNeeds({ demand });
  const targets = repairs.map((need) => need.targetWorkId);
  assert.ok(!targets.includes(W(1)), 'unused market hall: no repair');
  assert.ok(!targets.includes(W(5)), 'no use measurement: no repair');
  assert.ok(targets.includes(W(2)), 'clinic used 2 times in 72 h (none today) is repaired');
  assert.ok(targets.includes(W(3)) && targets.includes(W(4)), 'road and bridge are repaired without visits');
  assert.match(repairs.find((need) => need.targetWorkId === W(2)).reason, /2 visits in 72 h \(0 in 24 h\)/);
  assert.match(repairs.find((need) => need.targetWorkId === W(3)).reason, /serves travel/);
  assert.deepEqual(repairEligible({ type: 'school', uses72h: 0 }), { eligible: false, exempt: false, reason: 'unused_72h' });
  assert.doesNotMatch(read('../src/public-works.js').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n'),
    /DELETE FROM world_scenes|DELETE FROM world_public_works/);
});

test('slower expansion: cooldown and two sustained days; steeper cost; at most ~2 levels per 84 world hours', () => {
  const now = 100_000;
  const busy = (over) => facility(1, 'clinic', { uses24h: 10, usesPrev24h: 10, level: 1, renewedMinute: now - 3000, ...over });
  assert.equal(expansionDecision(busy({}), now).ok, true);
  assert.equal(expansionDecision(busy({ renewedMinute: now - 600 }), now).reason, 'cooldown');
  assert.equal(expansionDecision(busy({ renewedMinute: now - 2000 }), now).reason, 'cooldown', '2 sustained days after the last expansion');
  assert.equal(expansionDecision(busy({ usesPrev24h: 3 }), now).reason, 'not_sustained', 'one busy snapshot is not enough');
  assert.equal(expansionDecision(busy({ usesPrev24h: null }), now).reason, 'no_measurement');
  const demand = demandWith(null);
  demand.worldMinutes = now;
  demand.facilities = [busy({ renewedMinute: now - 600 })];
  assert.equal(publicWorksNeeds({ demand }).length, 0, 'in cooldown: no expansion');
  demand.facilities = [busy({})];
  assert.equal(publicWorksNeeds({ demand })[0].workType, 'expand');
  // Cost: 1.6x per level (growth1 was 1.35x).
  assert.equal(EXPANSION_COST_GROWTH, 1.6);
  for (let level = 1; level < 6; level += 1) {
    const ratio = Number(expansionPriceRaw(10, level + 1)) / Number(expansionPriceRaw(10, level));
    assert.ok(Math.abs(ratio - 1.6) < 0.01, `level ${level} -> ${level + 1}: x${ratio}`);
  }
  assert.ok(Number(expansionPriceRaw(10, 5)) > 10 * 0.6 * 1.35 ** 4 * 1e6 * 1.9, 'about twice growth1 at level 5');
  // Worst case: always 150% used, every expansion built in 4 world hours, checked every world hour; a
  // fresh building (renewed at 0) and one last expanded long ago with two busy days already measured.
  for (const start of [0, -1_000_000]) {
    let level = 1, renewed = start, building = null, gained = 0;
    for (let minute = 0; minute <= 84 * 60; minute += 60) {
      if (building !== null && minute >= building) { level += 1; renewed = minute; building = null; gained += 1; }
      const cap = facilityCapacity('clinic', level);
      const row = { capacity: cap, uses24h: Math.ceil(cap * 1.5), usesPrev24h: Math.ceil(cap * 1.5), renewedMinute: renewed };
      if (building === null && expansionDecision(row, minute).ok) building = minute + 240;
    }
    assert.ok(gained <= 2, `levels gained in 84 world hours (renewed ${start}): ${gained}`);
  }
  assert.equal(EXPANSION_SUSTAIN_MINUTES, 2880);
});

test('slower growth: a new building of an existing category needs two sustained days after the last capacity change', () => {
  const now = 100_000;
  const row = (over) => ({ buildings: 2, uses24h: 30, usesPrev24h: 30, capacity: 20, minUtilization: 0.8, minUtilizationPrev: 0.8,
    lastChangeMinute: now - 3000, latent: 0, ...over });
  assert.equal(categoryGrowthDecision(row({}), now).ok, true);
  assert.equal(categoryGrowthDecision(row({ lastChangeMinute: now - 1500 }), now).reason, 'cooldown',
    'a building opened or expanded in the last two days: wait for two measured days at the new capacity');
  assert.equal(categoryGrowthDecision(row({ usesPrev24h: 8 }), now).reason, 'not_sustained');
  assert.equal(categoryGrowthDecision(row({ minUtilizationPrev: 0.3 }), now).reason, 'not_sustained');
  assert.equal(categoryGrowthDecision(row({ usesPrev24h: null }), now).reason, 'no_measurement');
  const reach = { districtTraffic: traffic({ 1: 60 }), anchors: anchorsAt(near), points: { all: at(near, 30), craft: at(near, 30) }, taken: [] };
  const busy = demandWith(reach);
  busy.worldMinutes = now;
  busy.categories.craft = row({ lastChangeMinute: now - 600 });
  assert.equal(publicWorksNeeds({ demand: busy }).filter((need) => need.buildingType === 'workshop').length, 0,
    'first growth2 sim: 3 more workshops within ~1.5 world days on snapshots; now it waits');
  busy.categories.craft = row({});
  const next = publicWorksNeeds({ demand: busy }).find((need) => need.buildingType === 'workshop');
  assert.match(next.reason, /30 visits in 24 h and 30 the day before vs capacity 20/);
  assert.equal(next.name, 'Workshop District');
});

test('reachability: a slot that residents can reach but that is far from where the demand is measured is not used', () => {
  const opposite = growthPosition(1, 6);
  const reach = { districtTraffic: traffic({ 1: 60 }), anchors: anchorsAt(near, 12),
    points: { care: at(opposite, 20), all: at(near, 40) }, taken: [] };
  assert.equal(choosePlacement({ category: 'care', reach, newestDistrict: 1, demandShare: 0 }).ok, true, 'without the demand-share rule');
  const placed = choosePlacement({ category: 'care', reach, newestDistrict: 1 });
  assert.equal(placed.ok, false, 'reachable for residents, but none of the measured care demand is within walking reach');
  const mixed = { ...reach, points: { care: [...at(opposite, 15), ...at(near, 5)] } };
  assert.equal(choosePlacement({ category: 'care', reach: mixed, newestDistrict: 1 }).ok, true, '5 of 20 (25%) near residents is enough');
});
