// growth3: a build or expansion still under construction is a pending capacity change of its category
// (unit tests, no database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPANSION_SUSTAIN_MINUTES, GROWTH_TYPES, categoryGrowthDecision, facilityCapacity, growthPosition,
  pendingCapacityChanges } from '../src/public-works-growth.js';
import { publicWorksNeeds } from '../src/public-works.js';

const W = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const near = growthPosition(1, 0);
const at = (p, n) => Array.from({ length: n }, () => ({ x: p.x, z: p.z }));
const anchorsAt = (p, n = 10) => Array.from({ length: n }, (_, i) => ({ agentId: `r${i}`, home: { x: p.x, z: p.z }, work: null }));
const now = 100_000;
const facility = (n, type, { uses24h = 0, usesPrev24h = uses24h, level = 1, renewedMinute = now - 5000 } = {}) => {
  const capacity = facilityCapacity(type, level);
  return { workId: W(n), type, storedKind: GROWTH_TYPES[type]?.storedKind || type, name: `${type} ${n}`, sceneId: W(100 + n),
    level, district: 1, condition: 90, uses24h, usesPrev24h, uses72h: uses24h * 3, usesTotal: uses24h * 3, repairs: 0, capacity,
    renewedMinute, utilization: Math.round(uses24h / capacity * 1000) / 1000 };
};
const emptyCategory = () => ({ buildings: 0, uses24h: 0, capacity: 0, minUtilization: 0, latent: 0 });
// growth2 rerun 2: one Workshop District at 330-370% on both measured days, 48 h after it opened.
const busyCraft = () => {
  const ws = facility(1, 'workshop', { uses24h: 37, usesPrev24h: 33 });
  const reach = { districtTraffic: { 1: { visits: 200, residents: 10 } }, anchors: anchorsAt(near, 12),
    points: { all: at(near, 40), craft: at(near, 40) }, taken: [] };
  const categories = Object.fromEntries(['care','learn','leisure','social','market','craft','housing'].map((key) => [key, emptyCategory()]));
  categories.craft = { buildings: 1, uses24h: 37, usesPrev24h: 33, capacity: ws.capacity, minUtilization: ws.utilization,
    minUtilizationPrev: Math.round(33 / ws.capacity * 1000) / 1000, lastChangeMinute: ws.renewedMinute, latent: 0 };
  return { worldMinutes: now, residents: 12, lowEnergy: 0, lowEnergyFarByDistrict: {}, housing: { homeless: 0, beds: 0 },
    facilities: [ws], districtTrips: [], newestDistrict: 1, uses24h: 37, saturated: ['craft'], reach, categories };
};

test('pending capacity changes: open builds and expansions are grouped by category; repairs are not capacity changes', () => {
  const facilities = [facility(1, 'workshop'), facility(2, 'clinic')];
  const pending = pendingCapacityChanges([
    { workType: 'expand', buildingType: 'workshop', targetWorkId: W(1), commissionedMinute: now - 300 },
    { workType: 'expand', buildingType: null, targetWorkId: W(2), commissionedMinute: now - 100 },
    { workType: 'build', buildingType: 'hospital', commissionedMinute: now - 50 },
    { workType: 'repair', buildingType: 'park', targetWorkId: W(9), commissionedMinute: now - 10 }], facilities);
  assert.deepEqual(Object.keys(pending).sort(), ['care', 'craft']);
  assert.equal(pending.craft.count, 1);
  assert.equal(pending.care.count, 2, 'an expansion without a stored type resolves through its target (clinic) + a hospital build');
  assert.equal(pending.care.sinceMinute, now - 50);
  assert.equal(pending.leisure, undefined, 'a repair does not add capacity');
});

test('wait rule: while a same-category build or expansion is under construction nothing more is added; the 48 h window runs from the commission', () => {
  const row = { buildings: 1, uses24h: 37, usesPrev24h: 33, capacity: 10, minUtilization: 3.7, minUtilizationPrev: 3.3,
    lastChangeMinute: now - 5000, latent: 0 };
  assert.equal(categoryGrowthDecision(row, now).ok, true, 'baseline: sustained demand, last completed change 83 h ago');
  assert.equal(categoryGrowthDecision({ ...row, pendingChanges: 1, pendingSinceMinute: now - 240 }, now).reason, 'pending_change');
  assert.equal(categoryGrowthDecision({ ...row, pendingChanges: 0, pendingSinceMinute: now - 240 }, now).reason, 'cooldown',
    'a commission counts as a capacity change for the 48 h window');
  assert.equal(categoryGrowthDecision({ ...row, pendingSinceMinute: now - EXPANSION_SUSTAIN_MINUTES }, now).ok, true);

  // The growth2 rerun-2 case: Workshop District Expansion ordered at 72.7 h and still building, then a
  // second workshop was ordered at 76.7 h. Now neither a new workshop nor another expansion is offered.
  const demand = busyCraft();
  const free = publicWorksNeeds({ demand });
  assert.ok(free.some((need) => need.buildingType === 'workshop' && need.workType === 'expand'), 'no pending work: expansion offered');
  assert.ok(free.some((need) => need.buildingType === 'workshop' && need.workType === 'build'), 'no pending work: second workshop offered');
  const openExpansion = [{ kind: 'expansion', projectKey: `expansion:${W(1).slice(0, 8)}:2`, workType: 'expand', buildingType: 'workshop',
    targetWorkId: W(1), commissionedMinute: now - 240 }];
  const blocked = publicWorksNeeds({ demand: busyCraft(), open: openExpansion });
  assert.equal(blocked.filter((need) => need.buildingType === 'workshop').length, 0, 'expansion pending: no new workshop, no expansion');
  const d2 = busyCraft();
  d2.facilities.push(facility(2, 'workshop', { uses24h: 37, usesPrev24h: 33 }));
  const openBuild = [{ kind: 'public_building', projectKey: 'workshop:2', workType: 'build', buildingType: 'workshop', commissionedMinute: now - 60 }];
  assert.equal(publicWorksNeeds({ demand: d2, open: openBuild }).filter((need) => need.buildingType === 'workshop').length, 0,
    'a workshop under construction blocks expanding the other workshops of the category');
  const repairOnly = [{ kind: 'expansion', projectKey: 'repair:x', workType: 'repair', buildingType: 'workshop', targetWorkId: W(1),
    commissionedMinute: now - 60 }];
  assert.ok(publicWorksNeeds({ demand: busyCraft(), open: repairOnly }).some((need) => need.buildingType === 'workshop' && need.workType === 'build'),
    'an open repair is not a capacity change');
});

test('wait rule: a pending change in one category does not block another category', () => {
  const demand = busyCraft();
  const care = facility(3, 'clinic', { uses24h: 30, usesPrev24h: 30 });
  demand.facilities.push(care);
  const openCare = [{ kind: 'clinic', projectKey: 'hospital:1', workType: 'build', buildingType: 'hospital', commissionedMinute: now - 60 }];
  const needs = publicWorksNeeds({ demand, open: openCare });
  assert.equal(needs.filter((need) => need.buildingType === 'clinic').length, 0, 'clinic expansion waits for the hospital');
  assert.ok(needs.some((need) => need.buildingType === 'workshop'), 'craft is unaffected');
  assert.ok(demand.unplaced.some((row) => row.category === 'care' && row.reason === 'pending capacity change'));
});
