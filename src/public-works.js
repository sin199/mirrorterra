// council3: public works. The treasury pays ONLY for building the world (user direction
// 2026-10-20 14:23: "要Luna思考，不要直接撒钱给居民。需要居民建设世界来赚钱国库资产").
// MirrorTerra-01 (the governor) commissions a project from what the world lacks; the full price is
// reserved from the treasury's free balance at commissioning (construction waits until revenue
// arrives); residents bid; the lowest credible bid (adjusted for skill) wins; the builder does real
// construction work sessions at the site; the treasury pays per milestone (25/50/75/100%); an
// abandoned contract is reassigned to the next credible bidder; the finished project becomes a real
// place (world_scenes) on the 2D/3D map with a real effect on residents (travel, learning, health,
// leisure, sales). Hard rules: the treasury never goes negative (DB trigger, plus the escrow), no
// issuance (only already-issued, pool-backed SYNC moves), no chain/reserve/gate, no daily caps.
import { gambitsEnabled } from './gambit-flags.js';
import { activeBan, gambitsReady } from './world-gambits.js';
import { createHash } from 'node:crypto';
import { writeWorldHistory } from './world-domain.js';
import { currentResidentDisplayName } from './public-display.js';
import { SYNC_GENESIS_ISSUER_AGENT_ID } from './arc/sync-tokenomics.js';
import { SYNC_RAW_PER_SYNC, postTreasuryEntry, readTreasuryFreeBalance, worldDayOf } from './treasury.js';
import { ALL_BUSY, CATEGORY_TYPES, GROWTH_TYPES, HOMELESS_MIN, LATENT_MIN, LISTING_WINDOW_MINUTES, LOW_ENERGY, LOW_ENERGY_MIN,
  NEAR_CAPACITY, REPAIR_THRESHOLD, TRIP_MIN, USE_SPECS, USE_WEAR, apartmentBeds, builtPublicWork, categoryOf, conditionFactor,
  districtSquarePosition, districtUnlockDecision, expansionPriceRaw, facilityCapacity, growthPosition, initialCondition,
  levelFactor, onSiteEffect, repairPriceRaw, setGrowthCache, useCounts, utilization, walkMinutesToDistrict,
  wornCondition, categoryGrowthDecision, pendingCapacityChanges, choosePlacement, expansionDecision, repairEligible, REACH_MAX_WALK_MINUTES, REPAIR_USE_WINDOW_MINUTES,
  REACH_MIN_TRAFFIC } from './public-works-growth.js';
import { homeLocation, isHomeLocation, placePosition } from './world-environment.js';
import { consumeBuildMaterialsSafely, describeBuilderScore, fairnessFactor, practiceBuildSkillSafely, readBuilderScoreSafely,
  readRecentAwardWinners, skillBuildersEnabled, skillMaterialsEnabled } from './public-works-skills.js';

export const PUBLIC_WORKS_GOVERNOR_ID = SYNC_GENESIS_ISSUER_AGENT_ID;
export const PUBLIC_WORK_KINDS = Object.freeze(['road','park','market_hall','clinic','school','bridge','public_building','expansion']);
export const BIDDING_WINDOW_MINUTES = 120;          // two world hours of sealed bids
// council4: the old rule (12 world hours idle -> reassigned to the next bidder) ping-ponged contracts
// 137 times in a day while builders never got to build (they were busy with project/business
// actions and an 8-hour sleep window alone fills most of 12 world hours). Now: the holder is WARNED
// after 10 idle world hours (and gets construction priority anyway); the contract moves only after 16
// idle world hours (8 h sleep + meals + travel fit inside), at least 4 h after the warning, never
// within the minimum hold, and only to a bidder who really has capacity and who did not already
// hold it without building.
export const ABANDON_AFTER_MINUTES = 960;           // 16 world hours without a work session -> reassignable
export const WARN_AFTER_MINUTES = 600;              // 10 world hours idle -> the holder is warned
export const WARNING_GRACE_MINUTES = 240;           // at least 4 world hours between warning and reassignment
export const MIN_HOLD_MINUTES = 960;                // a new holder keeps the contract at least 16 world hours
export const MAX_ACTIVE_CONTRACTS = 2;              // a resident holds at most 2 contracts at once
export const MILESTONES = 4;                        // 25 / 50 / 75 / 100 %
export const CREDIBLE_MIN_BID_BPS = 4_000n;         // a bid below 40% of the price is not credible
export const CREDIBLE_MIN_SKILL = 3;                // the builder needs some of the required skill
export const PRICE_MIN_FACTOR_BPS = 5_000n;         // the governor may price 0.5x-2x the catalog base
export const PRICE_MAX_FACTOR_BPS = 20_000n;
// growth1: expansions have no level cap any more (cost +35% per level, effect with diminishing returns,
// see public-works-growth.js). The legacy passive town-wide buffs still count at most level 3 each.
export const PASSIVE_LEVEL_CAP = 3;

const SYNC = SYNC_RAW_PER_SYNC;
import { isExternalResident, readExternalMap } from './external-residents.js';
const big = (value) => { try { return BigInt(String(value ?? '0')); } catch { return 0n; } };
const unit = (value) => createHash('sha256').update(String(value)).digest().readUInt32BE(0) / 0xffffffff;
const shortText = (value, max = 240) => String(value || '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
function coded(code, statusCode = 409) { return Object.assign(new Error(code), { code, statusCode }); }
const clampNumber = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));

// Catalog: what each kind costs (base, SYNC), which skill builds it, its 3D/2D look and its effect.
export const PUBLIC_WORK_CATALOG = Object.freeze({
  road: { label: 'Road', baseSync: 8, skill: 'engineering', archetype: 'road', accent: '#8f8a80', icon: '═',
    benefit: { travel: 0.08 }, effect: 'Paved road: every walk in town is 8% faster (stacks to 40%).' },
  bridge: { label: 'Bridge', baseSync: 14, skill: 'engineering', archetype: 'bridge', accent: '#7c6a55', icon: '⌒',
    benefit: { outerTravel: 0.2 }, effect: 'Bridge: walks to and from the outer districts are 20% faster.' },
  park: { label: 'Park', baseSync: 6, skill: 'social', archetype: 'park', accent: '#4f9b45', icon: '♣',
    benefit: { fun: 1, social: 1 }, effect: 'Park: every resident regains +1 fun and +1 social each hour.' },
  market_hall: { label: 'Market Hall', baseSync: 12, skill: 'trading', archetype: 'market', accent: '#f08a3c', icon: '⌂',
    benefit: { sales: 6 }, effect: 'Market hall: residents buy more from residents\' businesses (higher sales).' },
  clinic: { label: 'Public Clinic', baseSync: 10, skill: 'social', archetype: 'clinic', accent: '#e05d6f', icon: '✚',
    benefit: { energy: 2, hygiene: 1 }, effect: 'Clinic: residents below 50 energy recover +2 energy and +1 hygiene each hour.' },
  school: { label: 'Public School', baseSync: 10, skill: 'research', archetype: 'school', accent: '#e0a63c', icon: '✎',
    benefit: { learn: 0.25 }, effect: 'School: every learning session gives 25% more skill (stacks to 50%).' },
  public_building: { label: 'Community Hall', baseSync: 9, skill: 'engineering', archetype: 'hall', accent: '#9fb04a', icon: '⌂',
    benefit: { social: 1 }, effect: 'Community hall: every resident regains +1 social each hour.' },
  expansion: { label: 'Expansion', baseSync: 6, skill: 'engineering', archetype: null, accent: null, icon: '+',
    benefit: { level: 1 }, effect: 'Expansion: the facility grows one level (more capacity, stronger on-site effect with diminishing returns).' }
});
// growth1: every building type (legacy kinds + the new kinds) with its price, skill, look and effect.
export function buildingSpec(type) { return PUBLIC_WORK_CATALOG[type] || GROWTH_TYPES[type] || null; }
export const REPAIR_EFFECT = 'Repair: restores the building to full condition (a neglected building loses effect).';

export function publicWorkPriceBounds(kind, targetBaseSync = null) {
  const spec = PUBLIC_WORK_CATALOG[kind];
  if (!spec) return null;
  const base = BigInt(Math.round((kind === 'expansion' && targetBaseSync ? targetBaseSync * 0.6 : spec.baseSync) * 1000)) * SYNC / 1000n;
  return { baseRaw: base, minRaw: base * PRICE_MIN_FACTOR_BPS / 10_000n, maxRaw: base * PRICE_MAX_FACTOR_BPS / 10_000n };
}

// growth1: the demand gate. A building or expansion is offered ONLY when measured resident demand
// exceeds what the town's buildings can serve; every need's reason states the measured numbers.
// Pure. demand: readGrowthDemand() output (null -> nothing measured -> nothing is offered).
// open: [{ kind, projectKey, workType, buildingType, targetWorkId }] (bidding/building).
// Repairs are offered separately (repairNeeds) by the maintenance step.
export function publicWorksNeeds({ completed = [], open = [], demand = null, districts = 1 } = {}) {
  if (!demand) return [];
  const openKeys = new Set(open.map((work) => baseProjectKey(work.projectKey)));
  const openBuildTypes = new Set(open.filter((work) => (work.workType || 'build') === 'build').map((work) => work.buildingType || work.kind));
  const openTargets = new Set(open.filter((work) => work.targetWorkId).map((work) => work.targetWorkId));
  const facilities = demand.facilities || [];
  // growth3: a build or expansion still open in a category blocks any further build or expansion there.
  const pending = pendingCapacityChanges(open, facilities);
  const needs = [];
  const push = (type, projectKey, name, score, why, extra = {}) => {
    if (openKeys.has(projectKey) || needs.some((need) => need.projectKey === projectKey)) return;
    const workType = extra.workType || 'build';
    if (workType === 'build' && openBuildTypes.has(type)) return;
    const spec = buildingSpec(type);
    if (!spec) return;
    const base = workType === 'expand' ? expansionPriceRaw(spec.baseSync, extra.targetLevel ? extra.targetLevel - 1 : 1)
      : BigInt(Math.round(spec.baseSync * 1000)) * SYNC / 1000n;
    needs.push({ kind: workType === 'build' ? (GROWTH_TYPES[type]?.storedKind || type) : 'expansion', buildingType: type, workType,
      projectKey, name: name.slice(0, 64), score: Math.round(score * 10) / 10, reason: shortText(why, 240),
      baseRaw: base.toString(), minRaw: (base * PRICE_MIN_FACTOR_BPS / 10_000n).toString(),
      maxRaw: (base * PRICE_MAX_FACTOR_BPS / 10_000n).toString(),
      effect: workType === 'expand' ? PUBLIC_WORK_CATALOG.expansion.effect : spec.effect, skill: spec.skill, ...extra });
  };
  const typeCount = (type) => facilities.filter((facility) => facility.type === type).length
    + completed.filter((work) => !facilities.length && (work.buildingType || work.kind) === type).length;
  const newest = Math.max(1, Number(demand.newestDistrict) || 1);
  const categories = demand.categories || {};
  const unplaced = [];
  // 1. Expansion: only a building used near its capacity (and in good enough condition to expand).
  // growth2: on SUSTAINED use (both of the last two world days >= 75% of current capacity) and only
  // after the cooldown since it was built or last expanded (expansionDecision).
  const worldMinutes = Number(demand.worldMinutes) || 0;
  for (const facility of facilities) {
    if (!USE_SPECS[facility.type] || openTargets.has(facility.workId)) continue;
    if (pending[categoryOf(facility.type)]) continue;
    if (facility.utilization < NEAR_CAPACITY || Number(facility.condition) < REPAIR_THRESHOLD) continue;
    const decision = expansionDecision(facility, worldMinutes);
    if (!decision.ok) continue;
    const next = (Number(facility.level) || 1) + 1;
    push(facility.type, `expansion:${facility.workId.slice(0, 8)}:${next}`, `${facility.name} Expansion`.slice(0, 64),
      40 + facility.utilization * 30,
      `${facility.name}: ${facility.uses24h} visits in 24 h and ${facility.usesPrev24h} the day before vs capacity ${facility.capacity} (${Math.round(decision.today * 100)}%/${Math.round(decision.prev * 100)}%), ${Math.round(decision.sinceRenewMinutes / 60)} h since last built/expanded; level ${next} adds capacity.`,
      { workType: 'expand', targetWorkId: facility.workId, targetName: facility.name, targetKind: facility.storedKind || facility.type,
        targetType: facility.type, targetLevel: next, targetBaseSync: buildingSpec(facility.type).baseSync,
        demand: { uses24h: facility.uses24h, usesPrev24h: facility.usesPrev24h, capacity: facility.capacity,
          utilization: facility.utilization, level: facility.level, hoursSinceRenew: Math.round(decision.sinceRenewMinutes / 60) } });
  }
  // 2. A new building of a use category: every existing one busy (>= 60%) and the category as a whole
  // near capacity; or, with none built, enough latent demand measured elsewhere in town.
  const latentText = { care: 'residents with energy below 35 right now', learn: 'study sessions elsewhere in 24 h',
    leisure: 'leisure/rest sessions elsewhere in 24 h', social: 'social visits elsewhere in 24 h',
    market: 'residents running an active business', craft: 'work shifts at workshops in 24 h' };
  for (const [category, types] of Object.entries(CATEGORY_TYPES)) {
    if (category === 'housing') continue;
    if (pending[category]) { unplaced.push({ category, reason: 'pending capacity change' }); continue; }
    const row = categories[category] || { uses24h: 0, capacity: 0, buildings: 0, minUtilization: 0, latent: 0 };
    let reason = null, score = 0;
    if (row.buildings > 0) {
      const share = utilization(row.uses24h, row.capacity);
      const growth = categoryGrowthDecision(row, worldMinutes);
      if (growth.ok) {
        reason = `${row.buildings} ${category} building(s) served ${row.uses24h} visits in 24 h and ${row.usesPrev24h} the day before vs capacity ${row.capacity} (${Math.round(share * 100)}%/${Math.round(growth.prev * 100)}%); the least used is at ${Math.round(row.minUtilization * 100)}%/${Math.round(row.minUtilizationPrev * 100)}%.`;
        score = 50 + share * 20;
      }
    } else if ((Number(row.latent) || 0) >= (LATENT_MIN[category] || 99)) {
      reason = `No ${category} building yet; measured ${row.latent} ${latentText[category]} (threshold ${LATENT_MIN[category]}).`;
      score = 45 + Math.min(20, row.latent);
    }
    if (!reason) continue;
    // growth2: only where residents actually go (measured traffic, within walking reach of homes and
    // workplaces); a latent-demand building also needs that demand measured within reach of its slot.
    const placement = choosePlacement({ category, reach: demand.reach, newestDistrict: newest,
      latentMin: row.buildings > 0 ? 0 : (LATENT_MIN[category] || 99) });
    if (!placement.ok) { unplaced.push({ category, reason: placement.reason }); continue; }
    // The larger type of the category once the smaller ones exist (hospital, library, harbor).
    const type = types.length > 1 && typeCount(types[0]) >= 2 ? types[1] : types[0];
    const ordinal = typeCount(type) + 1;
    const spec = buildingSpec(type);
    const label = GROWTH_TYPES[type] ? spec.label : `Public ${spec.label}`;
    push(type, `${type}:${ordinal}`, ordinal > 1 ? `${label} ${ordinal} (District ${placement.district})` : label,
      score, `${reason} ${row.buildings > 0 ? '' : `${placement.demandNear} of them within reach; `}${placement.text}`,
      { district: placement.district, position: placement.position, demand: { category, uses24h: row.uses24h, capacity: row.capacity,
        buildings: row.buildings, minUtilization: row.minUtilization, latent: row.latent, placement: placementDemand(placement) } });
  }
  // 3. Care where residents are: low-energy residents in a district with no care building.
  for (const [district, count] of Object.entries(demand.lowEnergyFarByDistrict || {})) {
    if (count < LOW_ENERGY_MIN) continue;
    if (pending.care) { unplaced.push({ category: 'care', district: Number(district), reason: 'pending capacity change' }); continue; }
    const placement = choosePlacement({ category: 'care', reach: demand.reach, district: Math.max(1, Number(district)), newestDistrict: newest });
    if (!placement.ok) { unplaced.push({ category: 'care', district: Number(district), reason: placement.reason }); continue; }
    const ordinal = typeCount('clinic') + 1;
    push('clinic', `clinic:${ordinal}`, `District ${placement.district} Clinic`, 55 + count * 2,
      `${count} residents with energy below ${LOW_ENERGY} are in District ${district}, which has no clinic or hospital; ${placement.text}`,
      { district: placement.district, position: placement.position,
        demand: { lowEnergyFar: count, district: Number(district), placement: placementDemand(placement) } });
  }
  // 4. Housing: residents without a finished home beyond the free apartment beds.
  const housing = demand.housing || { homeless: 0, beds: 0 };
  const unhoused = Math.max(0, (Number(housing.homeless) || 0) - (Number(housing.beds) || 0));
  if (unhoused >= HOMELESS_MIN && pending.housing) unplaced.push({ category: 'housing', reason: 'pending capacity change' });
  else if (unhoused >= HOMELESS_MIN) {
    const apartments = facilities.filter((facility) => facility.type === 'apartment' && !openTargets.has(facility.workId)
      && Number(facility.condition) >= REPAIR_THRESHOLD);
    // growth2: a block is expanded only when it is really used (sustained >= 75% on both of the last two
    // world days) and after the cooldown; while one exists but is not ready, no second block is built.
    const allApartments = facilities.filter((facility) => facility.type === 'apartment');
    const ready = apartments.filter((facility) => expansionDecision(facility, worldMinutes).ok);
    if (allApartments.length && !ready.length) unplaced.push({ category: 'housing', reason: 'apartment block not yet sustainedly used / in cooldown' });
    else if (ready.length) {
      const target = ready.sort((a, b) => (a.level - b.level) || a.workId.localeCompare(b.workId))[0];
      const next = (Number(target.level) || 1) + 1;
      push('apartment', `expansion:${target.workId.slice(0, 8)}:${next}`, `${target.name} Expansion`.slice(0, 64), 60 + unhoused * 3,
        `${housing.homeless} residents have no finished home and the apartments have ${housing.beds} beds; level ${next} adds beds.`,
        { workType: 'expand', targetWorkId: target.workId, targetName: target.name, targetKind: target.storedKind, targetType: 'apartment',
          targetLevel: next, targetBaseSync: GROWTH_TYPES.apartment.baseSync, demand: { homeless: housing.homeless, beds: housing.beds } });
    } else {
      const placement = choosePlacement({ category: 'housing', reach: demand.reach, newestDistrict: newest });
      if (!placement.ok) unplaced.push({ category: 'housing', reason: placement.reason });
      else {
        const ordinal = typeCount('apartment') + 1;
        push('apartment', `apartment:${ordinal}`, ordinal > 1 ? `District ${placement.district} Apartments` : 'Apartment Block', 60 + unhoused * 3,
          `${housing.homeless} residents have no finished home and the town has ${housing.beds} apartment beds; ${placement.text}`,
          { district: placement.district, position: placement.position,
            demand: { homeless: housing.homeless, beds: housing.beds, placement: placementDemand(placement) } });
      }
    }
  }
  // 5. Roads and bridges: many trips into a district that has no road / bridge yet (long walks).
  const roads = typeCount('road');
  for (const trip of demand.districtTrips || []) {
    if (trip.trips24h < TRIP_MIN) continue;
    if (!trip.hasRoad) {
      push('road', `road:${roads + 1}`, `Road to District ${trip.district}`, 50 + Math.min(30, trip.trips24h / 2),
        `${trip.trips24h} trips into District ${trip.district} in 24 h on rough tracks (about ${trip.walkMinutes} walking minutes each, no road).`,
        { district: trip.district, demand: { trips24h: trip.trips24h, walkMinutes: trip.walkMinutes, district: trip.district } });
    } else if (trip.district >= 2 && !trip.hasBridge) {
      push('bridge', `bridge:${trip.district}`, `Bridge to District ${trip.district}`, 48 + Math.min(30, trip.trips24h / 2),
        `${trip.trips24h} trips into District ${trip.district} in 24 h across the creek (about ${trip.walkMinutes} walking minutes each, no bridge).`,
        { district: trip.district, demand: { trips24h: trip.trips24h, walkMinutes: trip.walkMinutes, district: trip.district } });
    }
  }
  if (demand && typeof demand === 'object') demand.unplaced = unplaced;
  return needs.sort((left, right) => right.score - left.score || left.projectKey.localeCompare(right.projectKey));
}
const placementDemand = (placement) => ({ district: placement.district, districtVisits: placement.districtVisits,
  residentsWithin: placement.residentsWithin, residents: placement.residents, demandNear: placement.demandNear,
  meanWalkMinutes: placement.meanWalkMinutes, maxWalkMinutes: REACH_MAX_WALK_MINUTES });

// growth1: repair contracts for worn buildings (condition below REPAIR_THRESHOLD), worst first. The
// price is the building's replacement value x wear x 1.5; the treasury pays it to the resident builder
// per milestone through the normal tender. One open repair per building.
export function repairNeeds({ demand = null, open = [] } = {}) {
  if (!demand) return [];
  const openTargets = new Set(open.filter((work) => work.targetWorkId).map((work) => work.targetWorkId));
  const needs = [];
  for (const facility of demand.facilities || []) {
    const condition = Number(facility.condition);
    if (!(condition < REPAIR_THRESHOLD) || openTargets.has(facility.workId)) continue;
    // growth2: no repair for a building nobody visited in the last 3 world days (roads/bridges exempt).
    const eligibility = repairEligible(facility);
    if (!eligibility.eligible) continue;
    const spec = buildingSpec(facility.type);
    if (!spec) continue;
    const base = repairPriceRaw(spec.baseSync, facility.level, condition);
    const repairs = Number(facility.repairs) || 0;
    needs.push({ kind: 'expansion', buildingType: facility.type, workType: 'repair',
      projectKey: `repair:${facility.workId.slice(0, 8)}:${repairs + 1}`, name: `${facility.name} Repair`.slice(0, 64),
      score: Math.round((100 - condition) * 10) / 10,
      reason: shortText(`${facility.name} is at condition ${condition.toFixed(1)}/100 (repair below ${REPAIR_THRESHOLD}); `
        + (eligibility.exempt ? `a ${facility.type} serves travel (repaired without visit count). `
          : `${facility.uses72h} visits in 72 h (${facility.uses24h} in 24 h), ${facility.usesTotal} in total. `)
        + `Below ${60} it loses effect.`, 240),
      baseRaw: base.toString(), minRaw: (base * PRICE_MIN_FACTOR_BPS / 10_000n).toString(), maxRaw: (base * PRICE_MAX_FACTOR_BPS / 10_000n).toString(),
      effect: REPAIR_EFFECT, skill: spec.skill, targetWorkId: facility.workId, targetName: facility.name,
      targetKind: facility.storedKind || facility.type, targetType: facility.type, targetLevel: facility.level,
      demand: { condition, uses24h: facility.uses24h, uses72h: facility.uses72h ?? null, usesTotal: facility.usesTotal,
        level: facility.level, exempt: eligibility.exempt } });
  }
  return needs.sort((left, right) => right.score - left.score || left.projectKey.localeCompare(right.projectKey));
}

// council4: a cancelled tender (no credible bid) used to block its project key forever (UNIQUE
// world_id+project_key, rows are never deleted): PUBLIC_WORK_ALREADY_COMMISSIONED 24 times for the
// Community Hall expansion. A re-commission gets the key '<key>.r<n>'; needs compare base keys.
export function baseProjectKey(key) { return String(key || '').replace(/\.r\d+$/, ''); }
export function recommissionKey(key, takenKeys = []) {
  const base = baseProjectKey(key);
  const taken = new Set(takenKeys);
  if (!taken.has(base)) return base;
  for (let n = 1; n < 1000; n += 1) if (!taken.has(`${base}.r${n}`)) return `${base}.r${n}`;
  return null;
}

// Pure: the deterministic commission fallback: the most needed project the free balance can pay in full.
export function fallbackCommission({ needs = [], freeRaw = 0n }) {
  const free = big(freeRaw);
  const affordable = needs.filter((need) => big(need.baseRaw) <= free);
  if (!affordable.length) return null;
  const pick = affordable[0];
  return { projectKey: pick.projectKey, priceRaw: pick.baseRaw,
    reason: `The town lacks it most among what the treasury can pay in full: ${pick.reason}` };
}

// Pure: validate a commission choice (Luna's or the fallback's). Returns the need and a bounded price.
export function validateCommission({ needs = [], freeRaw = 0n, projectKey, priceRaw }) {
  const need = needs.find((item) => item.projectKey === projectKey);
  if (!need) throw coded('PUBLIC_WORK_UNKNOWN_PROJECT', 400);
  let price = big(priceRaw);
  if (price <= 0n) price = big(need.baseRaw);
  if (price < big(need.minRaw)) price = big(need.minRaw);
  if (price > big(need.maxRaw)) price = big(need.maxRaw);
  price = price / 10_000n * 10_000n;
  if (price <= 0n) throw coded('PUBLIC_WORK_PRICE_INVALID', 400);
  if (price > big(freeRaw)) throw coded('PUBLIC_WORK_UNFUNDED');
  return { need, priceRaw: price };
}

// Pure: heuristic sealed bid (used when a resident's Luna bid call fails or for residents that never got
// one). A more skilled resident bids lower (works faster); a poorer one bids lower (needs the work).
export function heuristicBid({ agentId, priceRaw, skillValue = 0, balanceRaw = 0n, medianBalanceRaw = 0n, workKey = '' }) {
  const price = big(priceRaw);
  const median = big(medianBalanceRaw);
  const wealth = median > 0n ? Math.min(1, Number(big(balanceRaw) * 1000n / (median * 2n)) / 1000) : 0.5;
  const skill = clampNumber(skillValue, 0, 100) / 100;
  const factor = 0.62 + 0.18 * wealth + 0.12 * (1 - skill) + 0.08 * unit(`${agentId}:${workKey}:bid`);
  const bid = price * BigInt(Math.round(Math.min(1, factor) * 10_000)) / 10_000n / 10_000n * 10_000n;
  return bid > 0n ? bid : 10_000n;
}

export function bidCredible({ bidRaw, priceRaw, skillValue = 0, busy = false, agentId }) {
  const bid = big(bidRaw), price = big(priceRaw);
  return agentId !== PUBLIC_WORKS_GOVERNOR_ID && !busy && bid > 0n && bid <= price
    && bid * 10_000n >= price * CREDIBLE_MIN_BID_BPS && Number(skillValue) >= CREDIBLE_MIN_SKILL;
}

// ---- contract holding (council4) -----------------------------------------------------------------
// Hold bookkeeping lives in position.hold (position is an updatable column; map code ignores 'hold'):
// { holder, since, sessionsAtStart, warnedAt, idleHolders[] }. idleHolders are residents who held
// this contract and never built on it; they never get it back.
export function holdOf(work) {
  const hold = work?.position?.hold;
  return hold && typeof hold === 'object' && !Array.isArray(hold) ? hold : null;
}
export function holdSince(work) {
  const hold = holdOf(work);
  return Number(hold?.since ?? work?.last_work_world_minute ?? work?.awarded_world_minute ?? 0) || 0;
}
export function holdSessions(work) {
  const hold = holdOf(work);
  return Math.max(0, (Number(work?.sessions) || 0) - (Number(hold?.sessionsAtStart ?? work?.sessions) || 0));
}
export function idleMinutes(work, minute) {
  return Math.max(0, Math.trunc(Number(minute) || 0) - Math.max(holdSince(work), Number(work?.last_work_world_minute ?? 0) || 0));
}
// Pure: does a resident really have capacity for (another) contract? At most MAX_ACTIVE_CONTRACTS;
// none of the held contracts may be idle past the warning; a second contract only once the first one
// is actually being built during the current hold.
export function builderCapacity(agentId, building = [], minute = 0) {
  const held = building.filter((work) => work.status === 'building' && work.builder_agent_id === agentId);
  const idle = held.filter((work) => idleMinutes(work, minute) >= WARN_AFTER_MINUTES).length;
  const unproven = held.filter((work) => holdSessions(work) === 0).length;
  return { active: held.length, idle, unproven,
    hasCapacity: held.length < MAX_ACTIVE_CONTRACTS && idle === 0 && (held.length === 0 || unproven === 0) };
}
// council4: can anyone take a new contract right now? Eligible builders are all residents except the
// governor (who never bids). If none has capacity, a tender would only collect non-credible bids, be
// cancelled and churn '<key>.r<n>' keys, so both commission paths skip instead (NO_BUILDER_CAPACITY).
export const NO_BUILDER_CAPACITY = 'NO_BUILDER_CAPACITY';
export function commissionCapacity(residents = [], building = [], minute = 0) {
  const eligible = [...new Set((residents || []).filter((resident) => !resident?.external).map((resident) => resident?.agentId)
    .filter((id) => id && id !== PUBLIC_WORKS_GOVERNOR_ID))];
  const withCapacity = eligible.filter((id) => builderCapacity(id, building, minute).hasCapacity);
  return { eligible: eligible.length, withCapacity: withCapacity.length, hasCapacity: withCapacity.length > 0 };
}
// Pure: what to do with a building contract this hour: keep, warn the holder, or reassign it.
export function reassignmentDecision(work, minute) {
  if (work?.status !== 'building' || Number(work?.progress) >= 100) return 'keep';
  const now = Math.trunc(Number(minute) || 0);
  const idle = idleMinutes(work, now);
  if (idle < WARN_AFTER_MINUTES) return 'keep';
  const hold = holdOf(work) || {};
  const lastActivity = now - idle;
  const warnedAt = hold.warnedAt === null || hold.warnedAt === undefined ? null : Number(hold.warnedAt);
  if (warnedAt === null || warnedAt < lastActivity) return 'warn';
  if (idle >= ABANDON_AFTER_MINUTES && now - holdSince(work) >= MIN_HOLD_MINUTES
    && now - warnedAt >= WARNING_GRACE_MINUTES) return 'reassign';
  return 'keep';
}
const withoutHold = (position) => { const { hold, ...rest } = position || {}; return rest; };

// Pure: award rule. Among credible bids the lowest effective cost wins: bid x (1.25 - 0.5 x skill/60,
// floored at 0.75), so a skilled builder can beat a slightly cheaper unskilled one; ties go to the
// lower bid, then the earlier bid.
// skillwork: an optional fairness factor (>= 1, MIRRORTERRA_SKILL_BUILDERS) multiplies the effective cost.
export function effectiveBidCost(bid) {
  const skill = Math.min(1, clampNumber(bid.skillValue, 0, 100) / 60);
  const fairness = Number(bid.fairness);
  return Number(big(bid.bidRaw)) * Math.max(0.75, 1.25 - 0.5 * skill) * (Number.isFinite(fairness) && fairness > 0 ? fairness : 1);
}
export function chooseWinningBid(bids = [], exclude = new Set()) {
  return bids.filter((bid) => bid.credible && !exclude.has(bid.agentId))
    .sort((left, right) => effectiveBidCost(left) - effectiveBidCost(right)
      || (big(left.bidRaw) < big(right.bidRaw) ? -1 : big(left.bidRaw) > big(right.bidRaw) ? 1 : 0)
      || Number(left.id || 0) - Number(right.id || 0) || String(left.agentId).localeCompare(String(right.agentId)))[0] || null;
}

// Pure: construction progress of one work session (skill-based, deterministic jitter).
export function constructionGain({ agentId, workKey, sessions = 0, skillValue = 0 }) {
  return 10 + Math.floor(clampNumber(skillValue, 0, 100) / 10) + Math.floor(unit(`${agentId}:${workKey}:${sessions}`) * 5);
}

// Pure: milestones now due and what each pays. Remaining contract SYNC is split evenly over the
// milestones still unpaid; the last milestone pays the exact remainder, so the total equals the
// contract price and is never exceeded.
export function milestonePayments({ progress, milestonesPaid = 0, contractPriceRaw, paidRaw = 0n }) {
  const reached = Math.min(MILESTONES, Math.floor(clampNumber(progress, 0, 100) / (100 / MILESTONES)));
  const payments = [];
  let paid = big(paidRaw);
  const contract = big(contractPriceRaw);
  for (let milestone = Number(milestonesPaid) + 1; milestone <= reached; milestone += 1) {
    const left = MILESTONES - milestone + 1;
    const amount = milestone === MILESTONES ? contract - paid : (contract - paid) / BigInt(left);
    if (amount < 0n) break;
    payments.push({ milestone, amountRaw: amount });
    paid += amount;
  }
  return payments;
}

// Pure: public works positions sit between the district rings (1.475, 1.825, ... normalised), offset
// from the skill-place slots; a bridge sits at the edge of its district.
export function publicWorkPosition(index, { kind = null, district = null } = {}) {
  if (kind === 'bridge' && district) {
    const angle = 0.6 + district * 1.7;
    const radius = 1.3 + (district - 1) * 0.35 + 0.17;
    return { x: Math.round(Math.cos(angle) * radius * 1000) / 1000, z: Math.round(Math.sin(angle) * radius * 1000) / 1000,
      district, civic: true };
  }
  const ring = Math.floor(index / 12), slot = index % 12;
  const angle = (slot / 12) * Math.PI * 2 + 0.47 + ring * 0.26;
  const radius = 1.475 + ring * 0.35;
  return { x: Math.round(Math.cos(angle) * radius * 1000) / 1000, z: Math.round(Math.sin(angle) * radius * 1000) / 1000,
    district: ring + 1, civic: true };
}

// ---- effects ------------------------------------------------------------------------------------
// Effects come from ACTIVE public-works places (world_scenes.features.origin='public_works'), summed
// by kind and level. The engine reads them once per world hour (and right after a completion).
export function emptyPublicWorksEffects() {
  return { roads: 0, bridges: 0, parks: 0, marketHalls: 0, clinics: 0, schools: 0, halls: 0 };
}
export function publicWorksEffectsFromScenes(scenes = []) {
  const effects = emptyPublicWorksEffects();
  // growth1: the larger new kinds give the passive buff of their category; a neglected building's
  // contribution shrinks with its condition (it is never removed).
  const key = { road: 'roads', bridge: 'bridges', park: 'parks', market_hall: 'marketHalls', clinic: 'clinics',
    school: 'schools', public_building: 'halls', hospital: 'clinics', library: 'schools', harbor: 'marketHalls' };
  for (const scene of scenes) {
    const work = scene?.features?.publicWork;
    if (scene?.status !== 'active' || scene?.features?.origin !== 'public_works' || !work || work.stage !== 'built') continue;
    if (key[work.kind]) effects[key[work.kind]] += Math.round(Math.max(1, Math.min(PASSIVE_LEVEL_CAP, Number(work.level) || 1))
      * conditionFactor(work.condition ?? 100) * 1000) / 1000;
  }
  return effects;
}
const radiusOf = (position) => Math.hypot(Number(position?.x) || 0, Number(position?.z) || 0);
export function publicWorksTravelFactor(effects, fromPosition = null, toPosition = null) {
  const e = effects || emptyPublicWorksEffects();
  let factor = Math.max(0.6, 1 - 0.08 * (Number(e.roads) || 0));
  if ((Number(e.bridges) || 0) > 0 && (radiusOf(fromPosition) > 1.45 || radiusOf(toPosition) > 1.45)) {
    factor *= Math.max(0.6, 1 - 0.2 * Number(e.bridges));
  }
  return Math.round(factor * 1000) / 1000;
}
export function publicWorksLearnMultiplier(effects) {
  return 1 + Math.min(0.5, 0.25 * (Number(effects?.schools) || 0));
}
export function publicWorksSalesBonus(effects) {
  return Math.min(12, 6 * (Number(effects?.marketHalls) || 0));
}
// Pure: hourly need bonus for one resident (applied after the normal hourly need update).
export function publicWorksNeedBonus(resident, effects, hours = 1) {
  const e = effects || emptyPublicWorksEffects();
  const h = Math.max(0, Math.min(24, Math.trunc(Number(hours) || 0)));
  const bonus = { energy: 0, hygiene: 0, fun: 0, social: 0 };
  if (!h) return bonus;
  if ((Number(resident?.energy) || 0) < 50) {
    bonus.energy += 2 * Math.min(3, Number(e.clinics) || 0) * h;
    bonus.hygiene += Math.min(3, Number(e.clinics) || 0) * h;
  }
  bonus.fun += Math.min(3, Number(e.parks) || 0) * h;
  bonus.social += (Math.min(3, Number(e.parks) || 0) + Math.min(2, Number(e.halls) || 0)) * h;
  return bonus;
}
export function applyPublicWorksNeedBonus(update, effects, hours = 1) {
  const bonus = publicWorksNeedBonus(update, effects, hours);
  const cap = (value) => Math.max(0, Math.min(100, Math.round(value)));
  return { ...update, energy: cap(update.energy + bonus.energy), hygiene: cap((update.hygiene ?? 80) + bonus.hygiene),
    fun: cap((update.fun ?? 70) + bonus.fun), social: cap(update.social + bonus.social) };
}

let effectsCache = { worldId: null, effects: emptyPublicWorksEffects(), hour: null };
export function currentPublicWorksEffects() { return effectsCache.effects; }
export function setPublicWorksEffects(worldId, effects, hour = null) { effectsCache = { worldId, effects, hour }; }
export async function refreshPublicWorksEffects(client, { worldId, worldMinutes = 0, force = false }) {
  const hour = Math.floor((Number(worldMinutes) || 0) / 60);
  if (!force && effectsCache.worldId === worldId && effectsCache.hour === hour) return effectsCache.effects;
  try {
    const rows = await client.query(`SELECT status,features FROM world_scenes WHERE world_id=$1
      AND features->>'origin'='public_works' AND status='active'`, [worldId]);
    setPublicWorksEffects(worldId, publicWorksEffectsFromScenes(rows.rows), hour);
  } catch { /* keep the previous effects */ }
  return effectsCache.effects;
}

// ---- reads ----------------------------------------------------------------------------------------
export async function publicWorksReady(client) {
  const result = await client.query(`SELECT to_regclass('public.world_public_works') IS NOT NULL
    AND to_regclass('public.world_public_work_bids') IS NOT NULL
    AND to_regclass('public.world_council_deliberations') IS NOT NULL AS ready`);
  return result.rows?.[0]?.ready === true;
}

export async function readPublicWorks(client, { worldId, statuses = ['bidding','building'] }) {
  const rows = await client.query(`SELECT work.id::text AS id,work.project_key,work.kind,work.name,work.reason,work.benefit,
      work.price_raw::text AS price_raw,work.required_skill,work.target_work_id::text AS target_work_id,work.status,
      work.builder_agent_id::text AS builder_agent_id,builder.name AS builder_name,
      work.contract_price_raw::text AS contract_price_raw,work.progress,work.sessions,work.milestones_paid,
      work.paid_raw::text AS paid_raw,work.commissioned_world_minute::text AS commissioned_world_minute,
      work.bidding_closes_world_minute::text AS bidding_closes_world_minute,
      work.awarded_world_minute::text AS awarded_world_minute,work.last_work_world_minute::text AS last_work_world_minute,
      work.reassignments,work.scene_id::text AS scene_id,scene.name AS scene_name,work.position,work.commissioned_by,
      work.completed_world_minute::text AS completed_world_minute,
      (SELECT count(*)::int FROM world_public_work_bids bid WHERE bid.work_id=work.id) AS bid_count,
      COALESCE(meta.building_type,CASE WHEN work.kind='expansion' THEN NULL ELSE work.kind END) AS building_type,
      COALESCE(meta.work_type,CASE WHEN work.kind='expansion' THEN 'expand' ELSE 'build' END) AS work_type,
      meta.target_level,meta.district AS meta_district
    FROM world_public_works work LEFT JOIN agents builder ON builder.id=work.builder_agent_id
    LEFT JOIN world_scenes scene ON scene.id=work.scene_id
    LEFT JOIN world_public_work_meta meta ON meta.work_id=work.id
    WHERE work.world_id=$1 AND work.status=ANY($2::text[]) ORDER BY work.commissioned_world_minute,work.id`, [worldId, statuses]);
  return rows.rows;
}

export async function readCompletedPublicWorks(client, { worldId }) {
  const rows = await client.query(`SELECT work.id::text AS work_id,work.kind,work.name,scene.name AS scene_name,
      COALESCE((scene.features->'publicWork'->>'level')::int,1) AS level,(work.position->>'district')::int AS district,
      COALESCE(meta.building_type,work.kind) AS building_type,
      (SELECT count(*)::int FROM world_public_work_uses used WHERE used.world_id=work.world_id AND used.work_id=work.id) AS uses
    FROM world_public_works work LEFT JOIN world_scenes scene ON scene.id=work.scene_id
    LEFT JOIN world_public_work_meta meta ON meta.work_id=work.id
    WHERE work.world_id=$1 AND work.status='completed' AND work.kind<>'expansion' ORDER BY work.completed_world_minute`, [worldId]);
  return rows.rows.map((row) => ({ workId: row.work_id, kind: row.kind, buildingType: row.building_type, name: row.name,
    sceneName: row.scene_name, level: Number(row.level) || 1, district: row.district === null ? null : Number(row.district),
    uses: Number(row.uses) || 0 }));
}

export async function readOuterDistricts(client, { worldId }) {
  const row = await client.query(`SELECT COALESCE(max((position->>'district')::int),1) AS districts FROM world_scenes
    WHERE world_id=$1 AND position ? 'district' AND NOT (position ? 'civic')`, [worldId]);
  return Math.max(1, Number(row.rows[0]?.districts) || 1);
}


const openForNeeds = (open) => open.map((work) => ({ kind: work.kind, projectKey: work.project_key, workType: work.work_type,
  buildingType: work.building_type, targetWorkId: work.target_work_id,
  commissionedMinute: work.commissioned_world_minute === null || work.commissioned_world_minute === undefined ? null : Number(work.commissioned_world_minute) }));
// growth1: needs come only from measured demand (readGrowthDemand). includeRepairs adds the repair
// needs (used to validate a repair commission; Luna and the build fallback see builds/expansions only).
export async function readPublicWorksNeeds(client, { worldId, stats, worldMinutes = null, demand = null, includeRepairs = false }) {
  const [completed, open, districts] = [await readCompletedPublicWorks(client, { worldId }),
    await readPublicWorks(client, { worldId }), await readOuterDistricts(client, { worldId })];
  const measured = demand || await readGrowthDemand(client, { worldId, worldMinutes, stats });
  const needs = publicWorksNeeds({ completed, open: openForNeeds(open), demand: measured, districts });
  return includeRepairs ? [...needs, ...repairNeeds({ demand: measured, open: openForNeeds(open) })] : needs;
}

async function residentSkill(client, { worldId, agentId, skill }) {
  const row = await client.query(`SELECT COALESCE((SELECT skill_value::float8 FROM world_agent_skills
    WHERE world_id=$1 AND agent_id=$2 AND skill_name=$3),0) AS value`, [worldId, agentId, skill]);
  return Number(row.rows[0]?.value) || 0;
}

// skillwork (fix 2): the skill a bid is judged on. With MIRRORTERRA_SKILL_BUILDERS (default on) it is the
// resident's O*NET skill-library score for this job (construction / repair work activities, 0-100);
// with it off, or if the library read fails, the legacy world_agent_skills value as before.
export async function bidSkill(client, { worldId, agentId, work, env = process.env, inTransaction = true }) {
  if (skillBuildersEnabled(env)) {
    const scored = await readBuilderScoreSafely(client, { worldId, agentId, workType: work?.work_type || 'build',
      requiredSkill: work?.required_skill || 'engineering' }, { inTransaction });
    if (scored) return { skillValue: scored.score, scored, source: 'library' };
  }
  return { skillValue: await residentSkill(client, { worldId, agentId, skill: work?.required_skill }), scored: null, source: 'legacy' };
}

// skillwork (fix 2): bids as the award rule sees them. Capacity as before; with MIRRORTERRA_SKILL_BUILDERS
// each bid is re-scored from the library at award time (LLM and heuristic bids alike) and carries the
// fairness factor (recent wins in this category, active contracts).
async function rankableBids(client, { worldId, work, bids, building, minute, env = process.env }) {
  const hasCapacity = (agentId) => builderCapacity(agentId, building, minute).hasCapacity;
  if (!skillBuildersEnabled(env)) return bids.map((bid) => ({ ...bid, credible: bid.credible && hasCapacity(bid.agentId) }));
  const recentWinners = await readRecentAwardWinners(client, { worldId, workType: work.work_type || 'build', excludeWorkId: work.id });
  const ranked = [];
  for (const bid of bids) {
    const { skillValue, scored, source } = await bidSkill(client, { worldId, agentId: bid.agentId, work, env });
    const active = building.filter((item) => item.status === 'building' && item.builder_agent_id === bid.agentId).length;
    const fairness = fairnessFactor({ agentId: bid.agentId, recentWinners, active });
    ranked.push({ ...bid, legacySkillValue: bid.skillValue, skillValue, skillSource: source,
      skillTop: (scored?.top || []).slice(0, 3).map((skill) => `${skill.name || skill.skillId} L${skill.level}`),
      recentWins: recentWinners.filter((id) => id === bid.agentId).length, active, fairness,
      credible: bid.credible && hasCapacity(bid.agentId) && fairness !== null && Number(skillValue) >= CREDIBLE_MIN_SKILL });
  }
  return ranked;
}

async function recordEvent(client, { worldId, actorId, type, actionId, data }) {
  await client.query(`INSERT INTO world_events(world_id,actor_id,event_type,data,action_id)
    VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(world_id,actor_id,action_id) DO NOTHING`,
  [worldId, actorId, type, JSON.stringify(data), String(actionId).slice(0, 180)]);
}

export async function recordDeliberation(client, { worldId, worldMinutes, phase, agentId, source, latencyMs = null,
  failureCode = null, proposalId = null, workId = null, decision = {}, reason = null }) {
  await client.query(`INSERT INTO world_council_deliberations(world_id,world_day,world_minute,phase,agent_id,source,latency_ms,
      failure_code,proposal_id,work_id,decision,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`,
  [worldId, worldDayOf(worldMinutes), Math.trunc(Number(worldMinutes) || 0), phase, agentId, source,
    latencyMs === null ? null : Math.max(0, Math.round(latencyMs)), failureCode ? String(failureCode).slice(0, 80) : null,
    proposalId, workId, JSON.stringify(decision || {}), reason ? shortText(reason, 240) : null]);
}

// Record a NO_BUILDER_CAPACITY skip as a commission deliberation, at most once per world hour (shared by
// the Luna worker and the tick fallback; serialised by the public-works lock). These rows do not count as
// a commission decision for the cooldowns, so commissioning resumes as soon as a builder is free again.
export async function recordNoCapacitySkip(client, { worldId, worldMinutes, agentId = PUBLIC_WORKS_GOVERNOR_ID, capacity = {},
  projectKey = null, origin = 'tick' }) {
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const hourStart = minute - (((minute % 60) + 60) % 60);
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('mirrorterra_public_works:' || $1::text))`, [worldId]);
  const seen = await client.query(`SELECT 1 FROM world_council_deliberations WHERE world_id=$1 AND world_day=$2
    AND phase='commission' AND failure_code=$3 AND world_minute >= $4 AND world_minute < $5 LIMIT 1`,
  [worldId, worldDayOf(hourStart), NO_BUILDER_CAPACITY, hourStart, hourStart + 60]);
  if (seen.rowCount) return false;
  const eligible = Number(capacity.eligible) || 0;
  await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'commission', agentId, source: 'fallback',
    failureCode: NO_BUILDER_CAPACITY, decision: { commission: false, skipped: NO_BUILDER_CAPACITY, projectKey, origin,
      eligibleBuilders: eligible, buildersWithCapacity: Number(capacity.withCapacity) || 0 },
    reason: `Commission skipped: none of the ${eligible} eligible builders has capacity for another contract.` });
  return true;
}
// growth1: maintenance (repair) commissions do not count as a build commission for the cooldowns either.
export const NOT_CAPACITY_SKIP = `failure_code IS DISTINCT FROM '${NO_BUILDER_CAPACITY}' AND failure_code IS DISTINCT FROM 'MAINTENANCE_REPAIR'`;

// ---- commission -----------------------------------------------------------------------------------
// Commission one project. The FULL price must be covered by the treasury's free balance; it is then
// reserved (escrow) until paid out per milestone, so construction waits until revenue arrives.
export async function commissionPublicWork(client, { worldId, worldMinutes, projectKey, priceRaw, reason, source, stats, demand = null }) {
  if (!['governor_llm','governor_fallback'].includes(source)) throw coded('PUBLIC_WORK_SOURCE_INVALID', 400);
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('mirrorterra_public_works:' || $1::text))`, [worldId]);
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const free = await readTreasuryFreeBalance(client, worldId);
  // growth1: needs come only from measured demand; repairs are valid commission targets too.
  const needs = await readPublicWorksNeeds(client, { worldId, stats, worldMinutes: minute, demand, includeRepairs: true });
  const { need, priceRaw: price } = validateCommission({ needs, freeRaw: free, projectKey, priceRaw });
  // One open tender per class: a repair tender may run next to a build/expansion tender.
  const repair = need.workType === 'repair';
  const bidding = await client.query(`SELECT 1 FROM world_public_works work LEFT JOIN world_public_work_meta meta ON meta.work_id=work.id
    WHERE work.world_id=$1 AND work.status='bidding' AND (COALESCE(meta.work_type,'build')='repair') = $2 LIMIT 1`, [worldId, repair]);
  if (bidding.rowCount) throw coded('PUBLIC_WORK_BIDDING_OPEN');
  let position = {};
  if (need.workType === 'build' && need.position) {
    // growth2: the reachable slot chosen from measured resident traffic (choosePlacement).
    position = { x: Number(need.position.x), z: Number(need.position.z), district: Number(need.position.district) || need.district || 1, civic: true };
  } else if (need.workType === 'build') {
    if (need.buildingType === 'bridge' && need.district) position = publicWorkPosition(0, { kind: 'bridge', district: need.district });
    else {
      const district = Math.max(1, Number(need.district) || 1);
      const inDistrict = await client.query(`SELECT count(*)::int AS n FROM world_public_works WHERE world_id=$1 AND kind<>'expansion'
        AND status<>'cancelled' AND (position->>'district')::int=$2`, [worldId, district]);
      position = growthPosition(district, Number(inDistrict.rows[0]?.n) || 0);
    }
  }
  // A key whose earlier tenders were all cancelled can be commissioned again under '<key>.r<n>'.
  const sameKey = await client.query(`SELECT project_key,status FROM world_public_works WHERE world_id=$1
    AND (project_key=$2 OR project_key LIKE $2 || '.r%')`, [worldId, need.projectKey]);
  if (sameKey.rows.some((row) => row.status !== 'cancelled' && baseProjectKey(row.project_key) === need.projectKey)) {
    throw coded('PUBLIC_WORK_ALREADY_COMMISSIONED');
  }
  const storedKey = recommissionKey(need.projectKey, sameKey.rows.map((row) => row.project_key));
  if (!storedKey) throw coded('PUBLIC_WORK_ALREADY_COMMISSIONED');
  // Every commission's reason starts with the measured demand; a council note (Luna) may follow.
  const note = shortText(reason, 240);
  const finalReason = shortText(note && !note.includes(need.reason) ? `${need.reason} Note: ${note}` : (note || need.reason), 300);
  const spec = buildingSpec(need.buildingType) || {};
  const inserted = await client.query(`INSERT INTO world_public_works(world_id,project_key,kind,name,reason,benefit,price_raw,
      required_skill,target_work_id,commissioned_by,commissioned_world_minute,bidding_closes_world_minute,position)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::numeric,$8,$9,$10,$11,$12,$13::jsonb)
    ON CONFLICT(world_id,project_key) DO NOTHING RETURNING id::text AS id`,
  [worldId, storedKey, need.kind, need.name, finalReason,
    JSON.stringify({ ...(need.workType === 'build' ? spec.benefit || {} : need.workType === 'repair' ? { repair: 1 } : { level: 1 }),
      effect: need.effect, buildingType: need.buildingType, workType: need.workType,
      ...(need.targetKind ? { targetKind: need.targetKind } : {}) }), price.toString(),
    need.skill, need.targetWorkId || null, source, minute, minute + BIDDING_WINDOW_MINUTES, JSON.stringify(position)]);
  if (!inserted.rowCount) throw coded('PUBLIC_WORK_ALREADY_COMMISSIONED');
  const id = inserted.rows[0].id;
  await client.query(`INSERT INTO world_public_work_meta(work_id,world_id,building_type,work_type,target_level,district,demand,
      created_world_minute) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
  [id, worldId, need.buildingType, need.workType, need.targetLevel || null, need.district || position.district || null,
    JSON.stringify(need.demand || {}), minute]);
  await recordEvent(client, { worldId, actorId: PUBLIC_WORKS_GOVERNOR_ID, type: 'world.public_work_commissioned',
    actionId: `public-work:${id}:commissioned`, data: { name: need.name, kind: need.kind, buildingType: need.buildingType,
      workType: need.workType, priceRaw: price.toString(), source, reason: shortText(finalReason, 240), demand: need.demand || {},
      place: 'MirrorTerra Central Bank', worldMinutes: minute } });
  return { workId: id, projectKey: storedKey, recommissioned: storedKey !== need.projectKey, kind: need.kind, name: need.name,
    buildingType: need.buildingType, workType: need.workType, reason: finalReason,
    priceRaw: price.toString(), biddingClosesWorldMinute: minute + BIDDING_WINDOW_MINUTES };
}

// ---- bids -----------------------------------------------------------------------------------------
export async function placePublicWorkBid(client, { worldId, workId, agentId, bidRaw, reason, source, worldMinutes, env = process.env }) {
  if (!['llm','heuristic'].includes(source)) throw coded('PUBLIC_WORK_BID_SOURCE_INVALID', 400);
  if (agentId === PUBLIC_WORKS_GOVERNOR_ID) throw coded('PUBLIC_WORK_GOVERNOR_CANNOT_BID', 403);
  // external1: external residents never hold a paid contract (no treasury SYNC); they volunteer instead.
  if (await isExternalResident(client, worldId, agentId)) throw coded('EXTERNAL_VOLUNTEER_ONLY', 403);
  // gambit1 P2: a tender ban the residents voted (a recorded fact) keeps the banned resident out until it ends.
  if (gambitsEnabled(env) && await gambitsReady(client) && await activeBan(client, { worldId, agentId, worldMinutes })) {
    throw coded('PUBLIC_WORK_BIDDER_BANNED', 403);
  }
  const work = (await client.query(`SELECT work.id,work.kind,work.price_raw::text AS price_raw,work.required_skill,work.status,
      work.bidding_closes_world_minute::text AS closes,
      COALESCE(meta.work_type,CASE WHEN work.kind='expansion' THEN 'expand' ELSE 'build' END) AS work_type
    FROM world_public_works work LEFT JOIN world_public_work_meta meta ON meta.work_id=work.id
    WHERE work.world_id=$1 AND work.id=$2`, [worldId, workId])).rows[0];
  if (!work || work.status !== 'bidding') throw coded('PUBLIC_WORK_NOT_BIDDING');
  let bid = big(bidRaw) / 10_000n * 10_000n;
  if (bid <= 0n) throw coded('PUBLIC_WORK_BID_INVALID', 400);
  if (bid > big(work.price_raw)) bid = big(work.price_raw);
  const { skillValue } = await bidSkill(client, { worldId, agentId, work, env });
  const building = await readPublicWorks(client, { worldId, statuses: ['building'] });
  const busy = !builderCapacity(agentId, building, worldMinutes).hasCapacity;
  const credible = bidCredible({ bidRaw: bid, priceRaw: work.price_raw, skillValue, busy, agentId });
  const text = shortText(reason, 240);
  const inserted = await client.query(`INSERT INTO world_public_work_bids(world_id,work_id,agent_id,bid_raw,skill_value,credible,source,reason,world_minute)
    VALUES($1,$2,$3,$4::numeric,$5,$6,$7,$8,$9) ON CONFLICT(work_id,agent_id) DO NOTHING RETURNING id`,
  [worldId, workId, agentId, bid.toString(), Math.round(skillValue * 100) / 100, credible, source,
    text.length >= 3 ? text : 'My sealed bid.', Math.trunc(Number(worldMinutes) || 0)]);
  return { workId, agentId, bidRaw: bid.toString(), credible, skillValue, duplicate: !inserted.rowCount };
}

async function readBids(client, { worldId, workId }) {
  const rows = await client.query(`SELECT bid.id,bid.agent_id::text AS agent_id,agent.name,bid.bid_raw::text AS bid_raw,
      bid.skill_value::float8 AS skill_value,bid.credible,bid.source,bid.reason
    FROM world_public_work_bids bid JOIN agents agent ON agent.id=bid.agent_id
    WHERE bid.world_id=$1 AND bid.work_id=$2 ORDER BY bid.bid_raw,bid.id`, [worldId, workId]);
  return rows.rows.map((row) => ({ id: Number(row.id), agentId: row.agent_id, name: row.name, bidRaw: row.bid_raw,
    skillValue: Number(row.skill_value) || 0, credible: row.credible, source: row.source, reason: row.reason }));
}

// Heuristic bids for residents who neither bid nor declined (through Luna) before the window closed.
export async function fillHeuristicBids(client, { worldId, work, worldMinutes, stats, env = process.env }) {
  const declined = await client.query(`SELECT DISTINCT agent_id::text AS agent_id FROM world_council_deliberations
    WHERE world_id=$1 AND phase='bid' AND work_id=$2`, [worldId, work.id]);
  const done = new Set(declined.rows.map((row) => row.agent_id));
  const existing = await client.query(`SELECT agent_id::text AS agent_id FROM world_public_work_bids WHERE work_id=$1`, [work.id]);
  for (const row of existing.rows) done.add(row.agent_id);
  const placed = [];
  const externals = await readExternalMap(client, worldId);
  for (const resident of stats?.residents || []) {
    if (resident.agentId === PUBLIC_WORKS_GOVERNOR_ID || done.has(resident.agentId)) continue;
    if (resident.external || externals.has(resident.agentId)) continue;
    const { skillValue, scored } = await bidSkill(client, { worldId, agentId: resident.agentId, work, env });
    const bid = heuristicBid({ agentId: resident.agentId, priceRaw: work.price_raw, skillValue, balanceRaw: resident.balanceRaw,
      medianBalanceRaw: stats.medianBalanceRaw, workKey: work.project_key });
    const heuristic = await placePublicWorkBid(client, { worldId, workId: work.id, agentId: resident.agentId, bidRaw: bid,
      reason: scored ? `Heuristic bid: ${describeBuilderScore(scored, 2)}.`.slice(0, 240)
        : `Heuristic bid: skill ${Math.round(skillValue)} in ${work.required_skill}.`, source: 'heuristic', worldMinutes, env })
      .catch((error) => { if (error?.code === 'PUBLIC_WORK_BIDDER_BANNED') return null; throw error; });
    if (heuristic) placed.push(heuristic);
  }
  return placed;
}

async function ensureSiteScene(client, { worldId, work, builderId, worldMinutes }) {
  if (work.kind === 'expansion') {
    const target = await client.query(`SELECT scene_id::text AS scene_id FROM world_public_works WHERE world_id=$1 AND id=$2`,
      [worldId, work.target_work_id]);
    return target.rows[0]?.scene_id || null;
  }
  if (work.scene_id) return work.scene_id;
  const type = work.building_type || work.kind;
  const spec = buildingSpec(type) || PUBLIC_WORK_CATALOG[work.kind];
  let name = work.name;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt ? `${work.name} ${attempt + 1}`.slice(0, 64) : work.name;
    const taken = await client.query('SELECT 1 FROM world_scenes WHERE world_id=$1 AND lower(name)=lower($2)', [worldId, candidate]);
    if (!taken.rowCount) { name = candidate; break; }
  }
  const sceneType = `public_${type}`.slice(0, 40);
  const inserted = await client.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description,status,
      purpose,capacity,features,position,created_world_minutes)
    VALUES($1,$2,$3,$4,$5,'inactive',$6,12,$7::jsonb,$8::jsonb,$9)
    ON CONFLICT(world_id,name) DO NOTHING RETURNING id::text AS id`,
  [worldId, builderId, name, sceneType, shortText(`Construction site: ${work.name}, a public work paid by the treasury.`, 240),
    shortText(spec.effect, 400), JSON.stringify({ origin: 'public_works', archetype: spec.archetype, kind: type,
      accent: spec.accent, action: ['school','library'].includes(type) ? 'learn'
        : ['park','public_building','clinic','hospital','market_hall','apartment'].includes(type) ? 'socialize' : 'work',
      openingHours: { weekday: [[0, 24]], weekend: [[0, 24]] },
      publicWork: { stage: 'building', progress: 0, kind: type, level: 1, effect: spec.effect,
        capacityPerDay: facilityCapacity(type, 1) || null } }),
    JSON.stringify(withoutHold(work.position)), Math.trunc(Number(worldMinutes) || 0)]);
  return inserted.rows[0]?.id || null;
}

// Award at bidding close: heuristic bids fill in, the best credible bid wins, the site appears.
export async function awardPublicWork(client, { worldId, work, worldMinutes, stats, env = process.env }) {
  await fillHeuristicBids(client, { worldId, work, worldMinutes, stats, env });
  await client.query('SAVEPOINT public_work_volunteer_fallback');
  try {
    await fillExternalVolunteerFallback(client, { worldId, work, worldMinutes });
    await client.query('RELEASE SAVEPOINT public_work_volunteer_fallback');
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT public_work_volunteer_fallback');
    await client.query('RELEASE SAVEPOINT public_work_volunteer_fallback');
  }
  const bids = await readBids(client, { worldId, workId: work.id });
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const building = await readPublicWorks(client, { worldId, statuses: ['building'] });
  const ranked = await rankableBids(client, { worldId, work, bids, building, minute, env });
  const winner = chooseWinningBid(ranked);
  if (!winner) {
    await client.query(`UPDATE world_public_works SET status='cancelled' WHERE world_id=$1 AND id=$2 AND status='bidding'`,
      [worldId, work.id]);
    await recordEvent(client, { worldId, actorId: PUBLIC_WORKS_GOVERNOR_ID, type: 'world.public_work_cancelled',
      actionId: `public-work:${work.id}:cancelled`, data: { name: work.name, reason: 'No credible bid', bids: bids.length, worldMinutes: minute } });
    return { workId: work.id, status: 'cancelled', bids: bids.length };
  }
  const sceneId = await ensureSiteScene(client, { worldId, work, builderId: winner.agentId, worldMinutes: minute });
  const hold = { holder: winner.agentId, since: minute, sessionsAtStart: 0, warnedAt: null, idleHolders: [] };
  await client.query(`UPDATE world_public_works SET status='building',builder_agent_id=$3,contract_price_raw=$4::numeric,
      awarded_world_minute=$5,last_work_world_minute=$5,scene_id=$6,position=$7::jsonb
    WHERE world_id=$1 AND id=$2 AND status='bidding'`,
  [worldId, work.id, winner.agentId, winner.bidRaw, minute, sceneId,
    JSON.stringify({ ...withoutHold(work.position), hold })]);
  await recordEvent(client, { worldId, actorId: winner.agentId, type: 'world.public_work_awarded',
    actionId: `public-work:${work.id}:awarded`, data: { name: work.name, kind: work.kind, contractPriceRaw: winner.bidRaw,
      priceRaw: work.price_raw, bids: bids.length, credible: bids.filter((bid) => bid.credible).length,
      bidSource: winner.source, worldMinutes: minute,
      ...(winner.skillSource ? { workType: work.work_type || null, skillSource: winner.skillSource, skillValue: winner.skillValue,
        skillTop: winner.skillTop, fairness: winner.fairness, recentWins: winner.recentWins,
        candidates: ranked.filter((bid) => bid.credible).sort((a, b) => effectiveBidCost(a) - effectiveBidCost(b)).slice(0, 5)
          .map((bid) => ({ agentId: bid.agentId, name: bid.name, bidRaw: bid.bidRaw, skillValue: bid.skillValue,
            fairness: bid.fairness, source: bid.source })) } : {}) } });
  return { workId: work.id, status: 'building', builder: winner.agentId, builderName: winner.name, contractPriceRaw: winner.bidRaw,
    bids: bids.length, ...(winner.skillSource ? { skillValue: winner.skillValue, fairness: winner.fairness } : {}) };
}

// ---- construction ---------------------------------------------------------------------------------
async function payMilestones(client, { worldId, work, worldMinutes, progress }) {
  const due = milestonePayments({ progress, milestonesPaid: work.milestones_paid, contractPriceRaw: work.contract_price_raw,
    paidRaw: work.paid_raw });
  let milestonesPaid = Number(work.milestones_paid), paid = big(work.paid_raw);
  const payments = [];
  for (const payment of due) {
    if (payment.amountRaw > 0n) {
      const posted = await postTreasuryEntry(client, { worldId,
        entryKey: `public_work:${work.id}:${work.reassignments || 0}:m${payment.milestone}`, kind: 'public_works',
        toAgentId: work.builder_agent_id, amountRaw: payment.amountRaw,
        reason: `Public works: ${work.name} milestone ${payment.milestone}/${MILESTONES} (${payment.milestone * 25}% built)`,
        actor: 'council', sourceRef: `public_work:${work.id}`, worldMinute: worldMinutes });
      if (!posted.created && !posted.duplicate) break; // the treasury refused: retried on the next hour
    }
    milestonesPaid = payment.milestone;
    paid += payment.amountRaw;
    payments.push({ milestone: payment.milestone, amountRaw: payment.amountRaw.toString() });
  }
  return { milestonesPaid, paidRaw: paid, payments };
}

async function completeIfDone(client, { worldId, work, worldMinutes, progress, milestonesPaid }) {
  if (progress < 100 || milestonesPaid < MILESTONES) return false;
  const minute = Math.trunc(Number(worldMinutes) || 0);
  await client.query(`UPDATE world_public_works SET status='completed',completed_world_minute=$3 WHERE world_id=$1 AND id=$2
    AND status='building'`, [worldId, work.id, minute]);
  const workType = work.work_type || (work.kind === 'expansion' ? 'expand' : 'build');
  const type = work.building_type || (work.kind === 'expansion' ? null : work.kind);
  const spec = buildingSpec(type) || PUBLIC_WORK_CATALOG[work.kind] || {};
  let sceneName = work.scene_name || work.name;
  if (workType === 'repair') {
    // growth1: a finished repair restores the building to full condition (repairs + 1).
    if (work.target_work_id) await client.query(`UPDATE world_public_work_conditions SET condition=100,repairs=repairs+1,
        last_repair_world_minute=$3,wear_world_minute=GREATEST(wear_world_minute,$3) WHERE world_id=$1 AND work_id=$2`,
    [worldId, work.target_work_id, minute]);
    if (work.scene_id) await client.query(`UPDATE world_scenes SET features=jsonb_set(features,'{publicWork}',
        COALESCE(features->'publicWork','{}'::jsonb) || '{"condition":100}'::jsonb,true) WHERE world_id=$1 AND id=$2`, [worldId, work.scene_id]);
  } else if (work.kind === 'expansion') {
    // growth1: no level cap; the effect grows with diminishing returns (levelFactor) and cost +35%/level.
    const updated = await client.query(`UPDATE world_scenes SET features=jsonb_set(features,'{publicWork,level}',
        to_jsonb(COALESCE((features->'publicWork'->>'level')::int,1)+1))
      WHERE world_id=$1 AND id=$2 RETURNING name`, [worldId, work.scene_id]);
    sceneName = updated.rows[0]?.name || sceneName;
  } else if (work.scene_id) {
    const updated = await client.query(`UPDATE world_scenes SET status='active',
        description=$3,features=jsonb_set(jsonb_set(features,'{publicWork,stage}','"built"'),'{publicWork,progress}','100')
      WHERE world_id=$1 AND id=$2 RETURNING name`, [worldId, work.scene_id,
      shortText(`${work.name}: a public work built by ${currentResidentDisplayName(work.builder_name || 'a resident')} and paid by the treasury.`, 240)]);
    sceneName = updated.rows[0]?.name || sceneName;
    await client.query(`INSERT INTO world_public_work_conditions(work_id,world_id,condition,initial_condition,wear_world_minute)
      VALUES($1,$2,100,100,$3) ON CONFLICT(work_id) DO NOTHING`, [work.id, worldId, minute]).catch(() => null);
  }
  const verb = workType === 'repair' ? 'repaired' : work.kind === 'expansion' ? 'finished' : 'opened';
  const effectText = workType === 'repair' ? REPAIR_EFFECT : work.kind === 'expansion' ? PUBLIC_WORK_CATALOG.expansion.effect : spec.effect;
  await writeWorldHistory(client, { worldId, eventKey: `public_work:${work.id}:completed`, eventType: 'place_created',
    actorAgentId: work.builder_agent_id, entityType: 'place', entityId: work.kind === 'expansion' ? null : work.scene_id,
    worldTime: minute, title: `${work.name} ${verb}`,
    detail: shortText(`${effectText || ''} Built by ${currentResidentDisplayName(work.builder_name || 'a resident')}.`, 600),
    metadata: { publicWork: true, kind: work.kind, buildingType: type, workType } });
  await recordEvent(client, { worldId, actorId: work.builder_agent_id, type: 'world.public_work_completed',
    actionId: `public-work:${work.id}:completed`, data: { name: work.name, kind: work.kind, buildingType: type, workType, place: sceneName,
      contractPriceRaw: work.contract_price_raw, worldMinutes: minute } });
  return true;
}

// One construction work session by the builder at the site. Returns the new state, or null when the
// resident has no public work at this place.
export async function advancePublicWork(client, { worldId, agentId, place, worldMinutes, env = process.env }) {
  const row = (await client.query(`SELECT work.id::text AS id,work.kind,work.name,work.project_key,work.required_skill,work.position,
      work.progress,work.sessions,work.milestones_paid,work.paid_raw::text AS paid_raw,
      work.contract_price_raw::text AS contract_price_raw,work.builder_agent_id::text AS builder_agent_id,
      work.reassignments,work.scene_id::text AS scene_id,scene.name AS scene_name,builder.name AS builder_name,
      work.target_work_id::text AS target_work_id,meta.building_type,meta.work_type
    FROM world_public_works work JOIN world_scenes scene ON scene.id=work.scene_id
    JOIN agents builder ON builder.id=work.builder_agent_id
    LEFT JOIN world_public_work_meta meta ON meta.work_id=work.id
    WHERE work.world_id=$1 AND work.status='building' AND work.builder_agent_id=$2 AND scene.name=$3
    ORDER BY work.awarded_world_minute LIMIT 1 FOR UPDATE OF work`, [worldId, agentId, place])).rows[0];
  if (!row) return null;
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const skillValue = await residentSkill(client, { worldId, agentId, skill: row.required_skill });
  // growth1: a repair is lighter work than new construction (twice the progress per session).
  const baseGain = constructionGain({ agentId, workKey: row.project_key, sessions: row.sessions, skillValue }) * (row.work_type === 'repair' ? 2 : 1);
  let progress = Math.min(100, Number(row.progress) + baseGain);
  // skillwork (fix 1): other residents' skill outputs become building materials (bounded extra progress).
  const materials = skillMaterialsEnabled(env) && progress < 100
    ? await consumeBuildMaterialsSafely(client, { worldId, work: row, builderId: agentId, remaining: 100 - progress,
      worldMinutes: minute, env }) : { consumed: [], bonus: 0 };
  progress = Math.min(100, progress + materials.bonus);
  const gain = progress - Number(row.progress);
  const paid = await payMilestones(client, { worldId, work: row, worldMinutes: minute, progress });
  const materialsTotal = materials.consumed.length ? { count: (Number(row.position?.materials?.count) || 0) + materials.consumed.length,
    bonus: (Number(row.position?.materials?.bonus) || 0) + materials.bonus } : null;
  await client.query(`UPDATE world_public_works SET progress=$3,sessions=sessions+1,milestones_paid=$4,paid_raw=$5::numeric,
      last_work_world_minute=$6,position=CASE WHEN $7::jsonb IS NULL THEN position ELSE jsonb_set(position,'{materials}',$7::jsonb,true) END
    WHERE world_id=$1 AND id=$2`, [worldId, row.id, progress, paid.milestonesPaid,
    paid.paidRaw.toString(), minute, materialsTotal ? JSON.stringify(materialsTotal) : null]);
  if (row.kind !== 'expansion' && row.scene_id) await client.query(`UPDATE world_scenes SET
      features=jsonb_set(features,'{publicWork,progress}',to_jsonb($3::int)) WHERE world_id=$1 AND id=$2
      AND features->'publicWork'->>'stage'='building'`, [worldId, row.scene_id, progress]);
  // skillwork (fix 2): the session practises the builder's most relevant library skill (XP only).
  const practiced = await practiceBuildSkillSafely(client, { worldId, agentId, workType: row.work_type || (row.kind === 'expansion' ? 'expand' : 'build'),
    requiredSkill: row.required_skill, place, env });
  await recordEvent(client, { worldId, actorId: agentId, type: 'world.public_work_progress',
    actionId: `public-work:${row.id}:session:${Number(row.sessions) + 1}`, data: { name: row.name, place, progress, gain,
      milestonesPaid: paid.milestonesPaid, paidRaw: paid.paidRaw.toString(), worldMinutes: minute,
      ...(materials.consumed.length ? { baseGain, materials: { used: materials.consumed.length, bonus: materials.bonus,
        outputIds: materials.consumed.map((item) => item.outputId) } } : {}),
      ...(practiced ? { practiced: { skillId: practiced.skillId, name: practiced.name, level: practiced.level,
        xp: practiced.xp, levelUp: Boolean(practiced.levelUp) } } : {}) } });
  const completed = await completeIfDone(client, { worldId, work: row, worldMinutes: minute, progress,
    milestonesPaid: paid.milestonesPaid });
  return { workId: row.id, name: row.name, kind: row.kind, progress, gain, payments: paid.payments,
    milestonesPaid: paid.milestonesPaid, paidRaw: paid.paidRaw.toString(), completed,
    ...(materials.consumed.length ? { materials } : {}),
    ...(practiced ? { practiced: { skillId: practiced.skillId, name: practiced.name, level: practiced.level, levelUp: practiced.levelUp } } : {}) };
}

// council4: idle contracts. The holder is warned first (event + priority); only after 16 idle world
// hours, the minimum hold and the warning grace does the contract move, and only to the best credible
// bidder who really has capacity, is not the holder, and never held it without building (no
// ping-pong back to idle residents). With no such bidder the holder keeps it. The new contract covers
// what was paid plus the new bidder's bid for the unbuilt share (never above price).
async function legacyIdleHolders(client, { worldId, work }) {
  // Works awarded before council4 have no hold record: residents who were awarded or reassigned this
  // work and never logged a construction session on it count as idle holders.
  const rows = await client.query(`SELECT DISTINCT held.actor_id::text AS agent_id FROM world_events held
    WHERE held.world_id=$1 AND held.event_type IN ('world.public_work_awarded','world.public_work_reassigned')
      AND held.action_id LIKE $2
      AND NOT EXISTS (SELECT 1 FROM world_events built WHERE built.world_id=held.world_id
        AND built.actor_id=held.actor_id AND built.event_type='world.public_work_progress' AND built.action_id LIKE $2)`,
  [worldId, `public-work:${work.id}:%`]);
  return rows.rows.map((row) => row.agent_id).filter((id) => id !== work.builder_agent_id);
}

async function writeHold(client, { worldId, work, hold }) {
  await client.query(`UPDATE world_public_works SET position=jsonb_set(position,'{hold}',$3::jsonb,true)
    WHERE world_id=$1 AND id=$2 AND status='building'`, [worldId, work.id, JSON.stringify(hold)]);
  work.position = { ...(work.position || {}), hold };
}

export async function reassignAbandonedWorks(client, { worldId, worldMinutes, env = process.env }) {
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const building = await readPublicWorks(client, { worldId, statuses: ['building'] });
  const results = [];
  for (const work of building) {
    if (!holdOf(work)) {
      await writeHold(client, { worldId, work, hold: { holder: work.builder_agent_id, since: holdSince(work),
        sessionsAtStart: Number(work.sessions) || 0, warnedAt: null, idleHolders: await legacyIdleHolders(client, { worldId, work }) } });
    }
    const decision = reassignmentDecision(work, minute);
    if (decision === 'keep') continue;
    const hold = holdOf(work);
    if (decision === 'warn') {
      await writeHold(client, { worldId, work, hold: { ...hold, warnedAt: minute } });
      await recordEvent(client, { worldId, actorId: work.builder_agent_id, type: 'world.public_work_warning',
        actionId: `public-work:${work.id}:warning:${Number(work.reassignments) || 0}:${minute}`, data: { name: work.name,
          progress: Number(work.progress), idleWorldHours: Math.floor(idleMinutes(work, minute) / 60),
          reassignAfterWorldMinute: Math.max(minute + WARNING_GRACE_MINUTES, minute - idleMinutes(work, minute) + ABANDON_AFTER_MINUTES,
            holdSince(work) + MIN_HOLD_MINUTES), worldMinutes: minute } });
      results.push({ workId: work.id, warned: true, holder: work.builder_agent_id });
      continue;
    }
    const builtThisHold = holdSessions(work) > 0;
    const idleHolders = new Set([...(Array.isArray(hold?.idleHolders) ? hold.idleHolders : []),
      ...(builtThisHold ? [] : [work.builder_agent_id])]);
    const bids = await readBids(client, { worldId, workId: work.id });
    const next = chooseWinningBid(await rankableBids(client, { worldId, work, bids, building, minute, env }),
      new Set([work.builder_agent_id, ...idleHolders]));
    if (!next) { results.push({ workId: work.id, reassigned: false, reason: 'no_capable_bidder' }); continue; }
    const paid = big(work.paid_raw), price = big(work.price_raw);
    const share = big(next.bidRaw) * BigInt(100 - Number(work.progress)) / 100n;
    let contract = paid + (share < price - paid ? share : price - paid);
    if (contract <= paid) contract = paid + 10_000n > price ? price : paid + 10_000n;
    const newHold = { holder: next.agentId, since: minute, sessionsAtStart: Number(work.sessions) || 0, warnedAt: null,
      idleHolders: [...idleHolders].slice(-12) };
    await client.query(`UPDATE world_public_works SET builder_agent_id=$3,contract_price_raw=$4::numeric,reassignments=reassignments+1,
        last_work_world_minute=$5,position=jsonb_set(position,'{hold}',$6::jsonb,true) WHERE world_id=$1 AND id=$2 AND status='building'`,
    [worldId, work.id, next.agentId, contract.toString(), minute, JSON.stringify(newHold)]);
    await recordEvent(client, { worldId, actorId: next.agentId, type: 'world.public_work_reassigned',
      actionId: `public-work:${work.id}:reassigned:${Number(work.reassignments) + 1}`, data: { name: work.name,
        progress: Number(work.progress), contractPriceRaw: contract.toString(), fromBuiltSessions: holdSessions(work),
        worldMinutes: minute } });
    // The building list is reused for later capacity checks this hour.
    work.builder_agent_id = next.agentId;
    work.position = { ...(work.position || {}), hold: newHold };
    work.last_work_world_minute = String(minute);
    results.push({ workId: work.id, reassigned: true, to: next.agentId, contractPriceRaw: contract.toString() });
  }
  return results;
}

// Milestones whose payment the treasury refused earlier are retried, and finished works complete.
async function settleDueMilestones(client, { worldId, worldMinutes }) {
  const works = await client.query(`SELECT work.id::text AS id,work.kind,work.name,work.progress,work.milestones_paid,
      work.paid_raw::text AS paid_raw,work.contract_price_raw::text AS contract_price_raw,
      work.builder_agent_id::text AS builder_agent_id,work.reassignments,work.scene_id::text AS scene_id,
      scene.name AS scene_name,builder.name AS builder_name,work.target_work_id::text AS target_work_id,
      (SELECT meta.building_type FROM world_public_work_meta meta WHERE meta.work_id=work.id) AS building_type,
      (SELECT meta.work_type FROM world_public_work_meta meta WHERE meta.work_id=work.id) AS work_type
    FROM world_public_works work LEFT JOIN world_scenes scene ON scene.id=work.scene_id
    JOIN agents builder ON builder.id=work.builder_agent_id
    WHERE work.world_id=$1 AND work.status='building' AND work.milestones_paid < LEAST(4, work.progress/25)
    FOR UPDATE OF work`, [worldId]);
  const done = [];
  for (const work of works.rows) {
    const paid = await payMilestones(client, { worldId, work, worldMinutes, progress: Number(work.progress) });
    await client.query(`UPDATE world_public_works SET milestones_paid=$3,paid_raw=$4::numeric WHERE world_id=$1 AND id=$2`,
      [worldId, work.id, paid.milestonesPaid, paid.paidRaw.toString()]);
    if (await completeIfDone(client, { worldId, work, worldMinutes, progress: Number(work.progress), milestonesPaid: paid.milestonesPaid })) {
      done.push(work.id);
    }
  }
  return done;
}

// Hourly (inside the council hour): award works whose bidding closed, reassign abandoned ones, retry
// refused milestones, and the deterministic commission fallback when Luna has not acted.
export const COMMISSION_FALLBACK_AFTER_MINUTES = 180;
export async function runPublicWorksHour(client, { worldId, worldMinutes, stats, env = process.env }) {
  if (!await publicWorksReady(client)) return { skipped: 'not_migrated' };
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const summary = { awarded: [], reassigned: [], completed: [] };
  for (const work of await readPublicWorks(client, { worldId, statuses: ['bidding'] })) {
    if (Number(work.bidding_closes_world_minute) <= minute) summary.awarded.push(await awardPublicWork(client, { worldId, work, worldMinutes: minute, stats, env }));
  }
  summary.reassigned = await reassignAbandonedWorks(client, { worldId, worldMinutes: minute, env });
  summary.completed = await settleDueMilestones(client, { worldId, worldMinutes: minute });
  // growth1: wear, map cards, district unlock and the maintenance (repair) tender.
  await client.query('SAVEPOINT public_works_growth_hour');
  try {
    summary.growth = await runGrowthHour(client, { worldId, worldMinutes: minute, stats, env });
    await client.query('RELEASE SAVEPOINT public_works_growth_hour');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT public_works_growth_hour');
    await client.query('RELEASE SAVEPOINT public_works_growth_hour');
    summary.growth = { error: error.code || error.message };
  }
  const demand = summary.growth?.demand || null;
  // Commission fallback: only when no Luna commission decision was recorded recently (worker absent or
  // its calls failing), there is no open bidding, and the free balance can pay a needed project in full.
  if (String(env?.MIRRORTERRA_PUBLIC_WORKS ?? 'on').toLowerCase() !== 'off') {
    const recent = await client.query(`SELECT 1 FROM world_council_deliberations WHERE world_id=$1 AND phase='commission'
      AND world_minute > $2 AND ${NOT_CAPACITY_SKIP} LIMIT 1`, [worldId, minute - COMMISSION_FALLBACK_AFTER_MINUTES]);
    // growth1: a repair tender does not block a demand-gated build/expansion tender.
    const bidding = await client.query(`SELECT 1 FROM world_public_works work LEFT JOIN world_public_work_meta meta ON meta.work_id=work.id
      WHERE work.world_id=$1 AND work.status='bidding' AND COALESCE(meta.work_type,'build')<>'repair' LIMIT 1`, [worldId]);
    if (!recent.rowCount && !bidding.rowCount) {
      const free = await readTreasuryFreeBalance(client, worldId);
      const needs = await readPublicWorksNeeds(client, { worldId, stats, worldMinutes: minute, demand });
      const pick = fallbackCommission({ needs, freeRaw: free });
      const capacity = pick ? commissionCapacity(stats?.residents || [],
        await readPublicWorks(client, { worldId, statuses: ['building'] }), minute) : null;
      if (pick && !capacity.hasCapacity) {
        const recorded = await recordNoCapacitySkip(client, { worldId, worldMinutes: minute, capacity, projectKey: pick.projectKey,
          origin: 'tick' });
        summary.skipped = { reason: NO_BUILDER_CAPACITY, recorded, eligible: capacity.eligible, projectKey: pick.projectKey };
      } else if (pick) {
        summary.commissioned = await commissionPublicWork(client, { worldId, worldMinutes: minute, projectKey: pick.projectKey,
          priceRaw: pick.priceRaw, reason: pick.reason, source: 'governor_fallback', stats, demand })
          .catch((error) => ({ error: error.code || error.message }));
        await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'commission', agentId: PUBLIC_WORKS_GOVERNOR_ID,
          source: 'fallback', failureCode: 'NO_RECENT_LUNA_COMMISSION', workId: summary.commissioned?.workId || null,
          decision: { commission: Boolean(summary.commissioned?.workId), projectKey: pick.projectKey }, reason: pick.reason });
      } else summary.waiting = { freeRaw: free.toString(), cheapestRaw: needs.map((need) => need.baseRaw)
        .sort((a, b) => (big(a) < big(b) ? -1 : 1))[0] || null };
    }
  }
  if (summary.growth?.demand) {
    const d = summary.growth.demand;
    summary.growth = { ...summary.growth, demand: { uses24h: d.uses24h, residents: d.residents, homeless: d.housing?.homeless,
      saturated: d.saturated, facilities: d.facilities.length } };
  }
  return summary;
}

// Construction affordance for a builder (utility candidate; also offered to open cognition).
export function publicWorkCandidates(agent, works = [], { calendar = null, distance = () => 0 } = {}) {
  const options = [];
  for (const work of works) {
    if (work.builder_agent_id !== agent.agentId || work.status !== 'building' || !work.scene_name) continue;
    if ((Number(agent.energy) || 0) < 25 || (Number(agent.food) || 0) < 15) continue;
    const progress = Number(work.progress) || 0;
    const left = big(work.contract_price_raw) - big(work.paid_raw);
    options.push({ id: `work:public:${work.id}`, action: 'work', targetLocation: work.scene_name,
      goal: `Build ${work.name} (${progress}% done) - the treasury pays per milestone.`,
      description: `Public works contract: ${(Number(left) / 1e6).toFixed(2)} SYNC still to earn by building.`,
      score: 66 + progress * 0.12 + (calendar?.isWorkHours ? 8 : 0) - distance(agent.location, work.scene_name) * 3
        + (holdOf(work)?.warnedAt !== null && holdOf(work)?.warnedAt !== undefined ? 12 : 0),
      plannedPaidMeal: false, side: null, asset: null, quoteUnits: null, socialPartnerId: null, socialPartnerName: null,
      publicWorkId: work.id, contractPriority: true });
  }
  return options;
}

// council4: a resident holding an active contract builds before project/business/plan actions, but
// critical needs come first: below 25 food or 30 energy they eat/rest, and inside their sleep window
// (unless still fresh, energy >= 70) they sleep. Pure; the engine calls it after the survival check.
export const CONTRACT_PRIORITY_MIN_FOOD = 25;
export const CONTRACT_PRIORITY_MIN_ENERGY = 30;
export function contractPriorityChoice(agent, candidates = [], { sleep = null } = {}) {
  const choice = candidates.filter((candidate) => candidate?.contractPriority && candidate.publicWorkId)
    .sort((left, right) => Number(right.score) - Number(left.score))[0];
  if (!choice) return null;
  if ((Number(agent?.food) || 0) < CONTRACT_PRIORITY_MIN_FOOD || (Number(agent?.energy) || 0) < CONTRACT_PRIORITY_MIN_ENERGY) return null;
  if (sleep?.inWindow && (Number(agent?.energy) || 0) < 70) return null;
  return choice;
}

// ---- external1: volunteers ---------------------------------------------------------------------------
// External residents help build public works for reputation and council eligibility only: they never hold
// the contract, the treasury never pays them, and the contracted (internal) builder is still paid per
// milestone. A volunteer session adds half a normal construction gain, at most VOLUNTEER_MAX_PROGRESS points
// per volunteer per work, and does not count as the builder's own session (idle/abandon rules unchanged).
export const VOLUNTEER_MAX_PROGRESS = 50;
export const EXTERNAL_SILENT_VOLUNTEER = 'EXTERNAL_SILENT_VOLUNTEER_FALLBACK';
export async function volunteersReady(client) {
  try { return Boolean((await client.query(`SELECT to_regclass('public.world_public_work_volunteers') IS NOT NULL AS ready`)).rows[0]?.ready); }
  catch { return false; }
}
export async function pledgePublicWorkVolunteer(client, { worldId, workId, agentId, reason, source = 'external_api', worldMinutes,
  maxActive = 2 }) {
  if (!['external_api','fallback'].includes(source)) throw coded('PUBLIC_WORK_VOLUNTEER_SOURCE_INVALID', 400);
  if (!await isExternalResident(client, worldId, agentId)) throw coded('EXTERNAL_RESIDENT_REQUIRED', 403);
  const work = (await client.query(`SELECT id,status,name FROM world_public_works WHERE world_id=$1 AND id=$2`, [worldId, workId])).rows[0];
  if (!work || !['bidding','building'].includes(work.status)) throw coded('PUBLIC_WORK_NOT_OPEN');
  const existing = await client.query(`SELECT id FROM world_public_work_volunteers WHERE work_id=$1 AND agent_id=$2`, [workId, agentId]);
  if (existing.rowCount) return { workId, name: work.name, volunteer: true, paid: false, duplicate: true };
  const active = await client.query(`SELECT count(*)::int AS n FROM world_public_work_volunteers v JOIN world_public_works w ON w.id=v.work_id
    WHERE v.world_id=$1 AND v.agent_id=$2 AND w.status IN ('bidding','building')`, [worldId, agentId]);
  if (Number(active.rows[0]?.n) >= maxActive) throw coded('PUBLIC_WORK_VOLUNTEER_LIMIT');
  const text = shortText(reason, 240);
  await client.query(`INSERT INTO world_public_work_volunteers(world_id,work_id,agent_id,source,reason,pledged_world_minute)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(work_id,agent_id) DO NOTHING`,
  [worldId, workId, agentId, source, text.length >= 3 ? text : 'I will help build this.', Math.trunc(Number(worldMinutes) || 0)]);
  await recordEvent(client, { worldId, actorId: agentId, type: 'world.public_work_volunteer',
    actionId: `public-work:${workId}:volunteer`, data: { name: work.name, source, paid: false, worldMinutes: Math.trunc(Number(worldMinutes) || 0) } });
  return { workId, name: work.name, volunteer: true, paid: false, duplicate: false };
}
// Pure: the deterministic pledge of a silent external resident.
export function volunteerFallbackDecision({ agentId, workKey = '', skillValue = 0, activeVolunteering = 0, maxActive = 2 }) {
  return Number(skillValue) >= CREDIBLE_MIN_SKILL && Number(activeVolunteering) < maxActive
    && unit(`${agentId}:${workKey}:volunteer`) < 0.5;
}
export async function fillExternalVolunteerFallback(client, { worldId, work, worldMinutes }) {
  if (!await volunteersReady(client)) return [];
  const externals = await readExternalMap(client, worldId);
  const pledged = [];
  for (const agentId of externals.keys()) {
    const decided = await client.query(`SELECT 1 FROM world_public_work_volunteers WHERE work_id=$1 AND agent_id=$2
      UNION ALL SELECT 1 FROM world_council_deliberations WHERE world_id=$3 AND phase='bid' AND work_id=$1 AND agent_id=$2`,
    [work.id, agentId, worldId]);
    if (decided.rowCount) continue;
    const skillValue = await residentSkill(client, { worldId, agentId, skill: work.required_skill });
    const active = await client.query(`SELECT count(*)::int AS n FROM world_public_work_volunteers v JOIN world_public_works w ON w.id=v.work_id
      WHERE v.world_id=$1 AND v.agent_id=$2 AND w.status IN ('bidding','building')`, [worldId, agentId]);
    const volunteer = volunteerFallbackDecision({ agentId, workKey: work.project_key, skillValue, activeVolunteering: active.rows[0]?.n });
    if (volunteer) pledged.push(await pledgePublicWorkVolunteer(client, { worldId, workId: work.id, agentId, source: 'fallback',
      reason: `Silent resident: deterministic volunteer pledge (skill ${Math.round(skillValue)} in ${work.required_skill}).`, worldMinutes }));
    await recordDeliberation(client, { worldId, worldMinutes, phase: 'bid', agentId, source: 'fallback',
      failureCode: EXTERNAL_SILENT_VOLUNTEER, workId: work.id, decision: { volunteer, external: true, paid: false },
      reason: volunteer ? 'Volunteers (unpaid).' : 'Does not volunteer.' });
  }
  return pledged;
}
export async function readVolunteerWorkIds(client, { worldId }) {
  if (!await volunteersReady(client)) return new Map();
  const rows = await client.query(`SELECT v.agent_id::text AS agent_id,v.work_id::text AS work_id,v.progress_added
    FROM world_public_work_volunteers v JOIN world_public_works w ON w.id=v.work_id
    WHERE v.world_id=$1 AND w.status='building'`, [worldId]);
  const map = new Map();
  for (const row of rows.rows) {
    if (Number(row.progress_added) >= VOLUNTEER_MAX_PROGRESS) continue;
    if (!map.has(row.agent_id)) map.set(row.agent_id, new Set());
    map.get(row.agent_id).add(row.work_id);
  }
  return map;
}
export function volunteerCandidates(agent, works = [], workIds = new Set(), { calendar = null, distance = () => 0 } = {}) {
  const options = [];
  for (const work of works) {
    if (!workIds.has(String(work.id)) || work.status !== 'building' || !work.scene_name) continue;
    if ((Number(agent.energy) || 0) < 25 || (Number(agent.food) || 0) < 15) continue;
    const progress = Number(work.progress) || 0;
    options.push({ id: `work:volunteer:${work.id}`, action: 'work', targetLocation: work.scene_name,
      goal: `Help build ${work.name} (${progress}% done) as an unpaid volunteer.`,
      description: 'Volunteer construction: no pay, counts as a contribution to the town.',
      score: 44 + progress * 0.08 + (calendar?.isWorkHours ? 6 : 0) - distance(agent.location, work.scene_name) * 3,
      plannedPaidMeal: false, side: null, asset: null, quoteUnits: null, socialPartnerId: null, socialPartnerName: null,
      publicWorkId: work.id, volunteer: true, contractPriority: false });
  }
  return options;
}
export async function advanceVolunteerSession(client, { worldId, agentId, place, worldMinutes }) {
  if (!await volunteersReady(client)) return null;
  const row = (await client.query(`SELECT work.id::text AS id,work.kind,work.name,work.project_key,work.required_skill,
      work.progress,work.sessions,work.milestones_paid,work.paid_raw::text AS paid_raw,
      work.contract_price_raw::text AS contract_price_raw,work.builder_agent_id::text AS builder_agent_id,
      work.reassignments,work.scene_id::text AS scene_id,scene.name AS scene_name,builder.name AS builder_name,
      volunteer.id AS volunteer_id,volunteer.sessions AS volunteer_sessions,volunteer.progress_added,
      work.target_work_id::text AS target_work_id,
      (SELECT meta.building_type FROM world_public_work_meta meta WHERE meta.work_id=work.id) AS building_type,
      (SELECT meta.work_type FROM world_public_work_meta meta WHERE meta.work_id=work.id) AS work_type
    FROM world_public_work_volunteers volunteer JOIN world_public_works work ON work.id=volunteer.work_id
    JOIN world_scenes scene ON scene.id=work.scene_id JOIN agents builder ON builder.id=work.builder_agent_id
    WHERE volunteer.world_id=$1 AND volunteer.agent_id=$2 AND work.status='building' AND scene.name=$3
    ORDER BY work.awarded_world_minute LIMIT 1 FOR UPDATE OF work,volunteer`, [worldId, agentId, place])).rows[0];
  if (!row) return null;
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const skillValue = await residentSkill(client, { worldId, agentId, skill: row.required_skill });
  const full = constructionGain({ agentId, workKey: `${row.project_key}:volunteer`, sessions: row.volunteer_sessions, skillValue });
  const gain = Math.max(0, Math.min(VOLUNTEER_MAX_PROGRESS - Number(row.progress_added), Math.ceil(full / 2), 100 - Number(row.progress)));
  const progress = Math.min(100, Number(row.progress) + gain);
  const paid = await payMilestones(client, { worldId, work: row, worldMinutes: minute, progress });
  await client.query(`UPDATE world_public_works SET progress=$3,milestones_paid=$4,paid_raw=$5::numeric WHERE world_id=$1 AND id=$2`,
    [worldId, row.id, progress, paid.milestonesPaid, paid.paidRaw.toString()]);
  await client.query(`UPDATE world_public_work_volunteers SET sessions=sessions+1,progress_added=progress_added+$2,
      last_session_world_minute=$3 WHERE id=$1`, [row.volunteer_id, gain, minute]);
  if (row.kind !== 'expansion' && row.scene_id) await client.query(`UPDATE world_scenes SET
      features=jsonb_set(features,'{publicWork,progress}',to_jsonb($3::int)) WHERE world_id=$1 AND id=$2
      AND features->'publicWork'->>'stage'='building'`, [worldId, row.scene_id, progress]);
  await recordEvent(client, { worldId, actorId: agentId, type: 'world.public_work_volunteer_session',
    actionId: `public-work:${row.id}:volunteer:${Number(row.volunteer_sessions) + 1}`,
    data: { name: row.name, place, progress, gain, paid: false, worldMinutes: minute } });
  const completed = await completeIfDone(client, { worldId, work: row, worldMinutes: minute, progress, milestonesPaid: paid.milestonesPaid });
  return { workId: row.id, name: row.name, kind: row.kind, progress, gain, volunteer: true, payments: [], completed };
}


// ---- growth1: measured demand, use, wear, repairs and districts (database) --------------------------
export const DEMAND_WINDOW_MINUTES = 1440;
export const MAINTENANCE_REPAIR = 'MAINTENANCE_REPAIR';
const ACTION_SAMPLE_LIMIT = 6000;
export async function growthReady(client) {
  try {
    return Boolean((await client.query(`SELECT to_regclass('public.world_public_work_uses') IS NOT NULL
      AND to_regclass('public.world_public_work_conditions') IS NOT NULL AND to_regclass('public.world_public_work_meta') IS NOT NULL
      AND to_regclass('public.world_growth_districts') IS NOT NULL AS ready`)).rows[0]?.ready);
  } catch { return false; }
}
const positionRadius = (position) => Math.hypot(Number(position?.x) || 0, Number(position?.z) || 0);
// District numbering as on the map: 0 = the original town (homes, plaza places), 1 = the first outer
// ring (radius 1.3), k = ring k (radius 1.3 + 0.35(k-1)).
export function districtOfPosition(position) {
  if (position && position.district !== undefined && position.district !== null) return Math.max(0, Number(position.district) || 0);
  const radius = positionRadius(position);
  return radius > 1.05 ? Math.max(1, 1 + Math.round((radius - 1.3) / 0.35)) : 0;
}
const roadDistrict = (facility) => {
  if (facility.metaDistrict) return Number(facility.metaDistrict);
  const match = /District (\d+)/.exec(facility.name || '');
  return match ? Number(match[1]) : 0;
};
async function currentWorldMinute(client, worldId) {
  return Number((await client.query('SELECT world_minutes FROM world_runtime_state WHERE world_id=$1', [worldId])).rows[0]?.world_minutes) || 0;
}

// Pure: the demand summary from measured rows (facilities with their 24 h use, residents, the recent
// action sample, places). Exported for the unit tests.
export function summarizeGrowthDemand({ worldMinutes = 0, facilities = [], residents = [], actions = [], scenes = [],
  founders = 0, districts = 1, takenPositions = null }) {
  const sceneByName = new Map(scenes.map((scene) => [scene.name, scene]));
  const facilityRows = facilities.map((row) => {
    const type = row.type;
    const level = Math.max(1, Number(row.level) || 1);
    const capacity = facilityCapacity(type, level);
    const uses24h = Number(row.uses24h) || 0;
    return { workId: row.workId, type, storedKind: row.kind, name: row.name, sceneId: row.sceneId, sceneName: row.sceneName,
      level, district: Number(row.metaDistrict) || districtOfPosition(row.position), metaDistrict: row.metaDistrict || null,
      condition: row.condition === null || row.condition === undefined ? 100 : Math.round(Number(row.condition) * 100) / 100,
      uses24h, usesTotal: Number(row.usesTotal) || 0, repairs: Number(row.repairs) || 0, capacity,
      // growth2: measured use over 3 world days (repairs), the day before (sustained expansion) and when
      // the building was built or last expanded (expansion cooldown). Unknown stays unknown (null).
      uses72h: row.uses72h === undefined || row.uses72h === null ? null : Number(row.uses72h),
      usesPrev24h: row.usesPrev24h === undefined || row.usesPrev24h === null ? null : Number(row.usesPrev24h),
      renewedMinute: row.renewedMinute === undefined || row.renewedMinute === null ? null : Number(row.renewedMinute),
      utilization: USE_SPECS[type] ? utilization(uses24h, capacity) : 0 };
  });
  // A care building serves its own district and the neighbouring rings (|d - district| <= 1).
  const careDistricts = facilityRows.filter((row) => categoryOf(row.type) === 'care').map((row) => row.district);
  const careNear = (district) => careDistricts.some((value) => Math.abs(value - district) <= 1);
  const lowEnergyFarByDistrict = {};
  let lowEnergy = 0, homeless = 0;
  for (const resident of residents) {
    if (resident.homeStatus !== 'built') homeless += 1;
    if ((Number(resident.energy) || 0) >= LOW_ENERGY) continue;
    lowEnergy += 1;
    const scene = sceneByName.get(resident.location);
    if (!scene) continue;
    const district = districtOfPosition(scene.position);
    if (!careNear(district)) lowEnergyFarByDistrict[district] = (lowEnergyFarByDistrict[district] || 0) + 1;
  }
  const latent = { care: lowEnergy, learn: 0, leisure: 0, social: 0, market: Number(founders) || 0, craft: 0 };
  const trips = {};
  for (const action of actions) {
    const scene = sceneByName.get(action.place);
    if (!scene) continue;
    const isPublic = scene.features?.origin === 'public_works';
    if (!isPublic) {
      if (action.action === 'learn') latent.learn += 1;
      else if (action.action === 'rest' && ['garden','beach','commons'].includes(scene.sceneType)) latent.leisure += 1;
      else if (action.action === 'socialize') latent.social += 1;
      else if ((action.action === 'work' || action.action === 'cooperate')
        && (['workshop','studio','data_center'].includes(scene.sceneType) || scene.features?.skillGroup)) latent.craft += 1;
    }
    const district = districtOfPosition(scene.position);
    if (district >= 1) trips[district] = (trips[district] || 0) + 1;
  }
  const categories = {};
  for (const [category, types] of Object.entries(CATEGORY_TYPES)) {
    const rows = facilityRows.filter((row) => types.includes(row.type));
    categories[category] = { buildings: rows.length, uses24h: rows.reduce((sum, row) => sum + row.uses24h, 0),
      capacity: rows.reduce((sum, row) => sum + row.capacity, 0),
      minUtilization: rows.length ? Math.min(...rows.map((row) => row.utilization)) : 0, latent: latent[category] ?? 0,
      // growth2: the day before and the last capacity change (sustained-growth rule for a new building).
      usesPrev24h: rows.length && rows.every((row) => row.usesPrev24h !== null) ? rows.reduce((sum, row) => sum + row.usesPrev24h, 0) : null,
      minUtilizationPrev: rows.length && rows.every((row) => row.usesPrev24h !== null)
        ? Math.min(...rows.map((row) => utilization(row.usesPrev24h, row.capacity))) : null,
      lastChangeMinute: rows.length && rows.every((row) => row.renewedMinute !== null) ? Math.max(...rows.map((row) => row.renewedMinute)) : null };
  }
  const beds = facilityRows.filter((row) => row.type === 'apartment').reduce((sum, row) => sum + apartmentBeds(row.level), 0);
  const reach = summarizeReach({ residents, actions, scenes, facilities: facilityRows, takenPositions });
  const roads = facilityRows.filter((row) => row.type === 'road').map(roadDistrict);
  const bridges = new Set(facilityRows.filter((row) => row.type === 'bridge').map((row) => row.district));
  const districtTrips = Object.entries(trips).map(([district, count]) => ({ district: Number(district), trips24h: count,
    walkMinutes: walkMinutesToDistrict(Number(district)), hasRoad: roads.includes(Number(district)), hasBridge: bridges.has(Number(district)) }))
    .sort((a, b) => a.district - b.district);
  const saturated = Object.entries(categories).filter(([category, row]) => category !== 'housing' && row.buildings > 0
    && utilization(row.uses24h, row.capacity) >= NEAR_CAPACITY).map(([category]) => category);
  if (homeless - beds >= HOMELESS_MIN) saturated.push('housing');
  return { worldMinutes, windowMinutes: DEMAND_WINDOW_MINUTES, residents: residents.length, lowEnergy, lowEnergyFarByDistrict,
    housing: { homeless, beds }, facilities: facilityRows, categories, districtTrips, newestDistrict: Math.max(1, Number(districts) || 1),
    uses24h: facilityRows.reduce((sum, row) => sum + row.uses24h, 0), actionsSampled: actions.length, saturated, reach };
}

// growth2: where residents actually go. Pure. From the action sample of the demand window (who did what
// where): visits and distinct residents per district, each resident's home and most frequent workplace
// (anchors for the walking bound), and the positions where each category's demand was measured.
const xz = (position) => ({ x: Math.round(Number(position.x) * 1000) / 1000, z: Math.round(Number(position.z) * 1000) / 1000 });
export function summarizeReach({ residents = [], actions = [], scenes = [], facilities = [], takenPositions = null } = {}) {
  const sceneByName = new Map(scenes.map((scene) => [scene.name, scene]));
  const positionOf = (place) => {
    const scene = sceneByName.get(place);
    if (scene) return placePosition(scene);
    return place && isHomeLocation(place) ? placePosition(place) : null;
  };
  const districtTraffic = {};
  const visitors = {};
  const points = { care: [], learn: [], leisure: [], social: [], market: [], craft: [], housing: [], all: [] };
  const workCounts = new Map();
  const careNames = new Set(facilities.filter((row) => categoryOf(row.type) === 'care').map((row) => row.sceneName || row.name));
  for (const action of actions) {
    const position = positionOf(action.place);
    if (!position) continue;
    const scene = sceneByName.get(action.place);
    const district = scene ? districtOfPosition(scene.position || position) : districtOfPosition(position);
    const row = districtTraffic[district] || (districtTraffic[district] = { visits: 0, residents: 0 });
    row.visits += 1;
    if (action.agentId) (visitors[district] || (visitors[district] = new Set())).add(action.agentId);
    const point = xz(position);
    points.all.push(point);
    const type = scene?.sceneType || '';
    const publicKind = scene?.features?.origin === 'public_works' ? scene.features?.publicWork?.kind || scene.features?.kind : null;
    if (action.action === 'learn') points.learn.push(point);
    else if (action.action === 'socialize') points.social.push(point);
    else if (action.action === 'rest' && (careNames.has(action.place) || ['clinic','hospital'].includes(publicKind))) points.care.push(point);
    else if (action.action === 'rest' && (['garden','beach','commons'].includes(type) || publicKind === 'park')) points.leisure.push(point);
    if ((action.action === 'work' || action.action === 'cooperate') && !isHomeLocation(action.place)) {
      if (['workshop','studio','data_center'].includes(type) || scene?.features?.skillGroup || publicKind === 'workshop') points.craft.push(point);
      if (['market_hall','harbor'].includes(publicKind) || type === 'exchange') points.market.push(point);
      if (action.agentId) {
        const key = `${action.agentId}\u0000${action.place}`;
        workCounts.set(key, (workCounts.get(key) || 0) + 1);
      }
    }
  }
  for (const [district, set] of Object.entries(visitors)) districtTraffic[district].residents = set.size;
  const bestWork = new Map();
  for (const [key, count] of workCounts) {
    const [agentId, place] = key.split('\u0000');
    if (!bestWork.has(agentId) || bestWork.get(agentId).count < count) bestWork.set(agentId, { place, count });
  }
  const anchors = [];
  for (const resident of residents) {
    if (!resident.agentId) continue;
    const home = xz(placePosition(homeLocation(resident.agentId)));
    const workPlace = bestWork.get(resident.agentId)?.place;
    const work = workPlace ? positionOf(workPlace) : null;
    anchors.push({ agentId: resident.agentId, home, work: work ? xz(work) : null });
    if ((Number(resident.energy) || 0) < LOW_ENERGY) {
      const here = positionOf(resident.location);
      if (here) points.care.push(xz(here));
    }
    if (resident.homeStatus !== 'built') points.housing.push(home);
  }
  const taken = (takenPositions || scenes.map((scene) => scene.position))
    .filter((position) => position && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.z))).map(xz);
  return { windowMinutes: DEMAND_WINDOW_MINUTES, districtTraffic, anchors, points, taken };
}

export async function readGrowthDemand(client, { worldId, worldMinutes = null, stats = null } = {}) {
  if (!await growthReady(client)) return null;
  const minute = worldMinutes === null || worldMinutes === undefined ? await currentWorldMinute(client, worldId) : Math.trunc(Number(worldMinutes));
  const since = minute - DEMAND_WINDOW_MINUTES;
  const facilities = await client.query(`SELECT work.id::text AS work_id,work.kind,COALESCE(meta.building_type,work.kind) AS type,
      work.name,scene.id::text AS scene_id,scene.name AS scene_name,scene.position,
      COALESCE((scene.features->'publicWork'->>'level')::int,1) AS level,meta.district AS meta_district,
      cond.condition::float8 AS condition,COALESCE(cond.uses_total,0)::bigint AS uses_total,COALESCE(cond.repairs,0)::int AS repairs,
      (SELECT count(*)::int FROM world_public_work_uses used WHERE used.world_id=work.world_id AND used.work_id=work.id
        AND used.world_minute>=$2) AS uses24h,
      (SELECT count(*)::int FROM world_public_work_uses used WHERE used.world_id=work.world_id AND used.work_id=work.id
        AND used.world_minute>=$3) AS uses72h,
      (SELECT count(*)::int FROM world_public_work_uses used WHERE used.world_id=work.world_id AND used.work_id=work.id
        AND used.world_minute>=$2-${DEMAND_WINDOW_MINUTES} AND used.world_minute<$2) AS uses_prev24h,
      GREATEST(work.completed_world_minute,COALESCE((SELECT max(exp.completed_world_minute) FROM world_public_works exp
        LEFT JOIN world_public_work_meta exp_meta ON exp_meta.work_id=exp.id
        WHERE exp.world_id=work.world_id AND exp.target_work_id=work.id AND exp.status='completed'
          AND COALESCE(exp_meta.work_type,'expand')='expand'),0))::bigint AS renewed_minute
    FROM world_public_works work JOIN world_scenes scene ON scene.id=work.scene_id
    LEFT JOIN world_public_work_meta meta ON meta.work_id=work.id
    LEFT JOIN world_public_work_conditions cond ON cond.work_id=work.id
    WHERE work.world_id=$1 AND work.status='completed' AND work.kind<>'expansion' AND scene.status='active'
    ORDER BY work.completed_world_minute,work.id`, [worldId, since, minute - REPAIR_USE_WINDOW_MINUTES]);
  const residents = await client.query(`SELECT member.agent_id::text AS agent_id,member.energy,member.location,home.status AS home_status
    FROM world_members member LEFT JOIN world_resident_homes home ON home.world_id=member.world_id AND home.agent_id=member.agent_id
    WHERE member.world_id=$1 AND member.agent_id<>$2`, [worldId, PUBLIC_WORKS_GOVERNOR_ID]);
  const actions = await client.query(`SELECT recent.data->>'action' AS action,recent.data->>'place' AS place,
      recent.actor_id::text AS "agentId" FROM (
      SELECT data,actor_id FROM world_events WHERE world_id=$1 AND event_type='world.action_completed' ORDER BY id DESC LIMIT ${ACTION_SAMPLE_LIMIT}) recent
    WHERE COALESCE((recent.data->>'worldMinutes')::numeric,0) >= $2`, [worldId, since]);
  const scenes = await client.query(`SELECT name,scene_type AS "sceneType",position,features FROM world_scenes WHERE world_id=$1`, [worldId]);
  const founders = await client.query(`SELECT count(DISTINCT founder_agent_id)::int AS n FROM world_businesses
    WHERE world_id=$1 AND status='active'`, [worldId]).catch(() => ({ rows: [{ n: 0 }] }));
  const districts = await readOuterDistricts(client, { worldId });
  const taken = await client.query(`SELECT position FROM world_scenes WHERE world_id=$1 AND status IN ('active','inactive')
    UNION ALL SELECT position FROM world_public_works WHERE world_id=$1 AND status<>'cancelled' AND kind<>'expansion'`, [worldId])
    .catch(() => ({ rows: [] }));
  return summarizeGrowthDemand({ worldMinutes: minute, takenPositions: taken.rows.map((row) => row.position),
    facilities: facilities.rows.map((row) => ({ workId: row.work_id, kind: row.kind, type: row.type, name: row.name,
      sceneId: row.scene_id, sceneName: row.scene_name, position: row.position, level: row.level, metaDistrict: row.meta_district,
      condition: row.condition, usesTotal: Number(row.uses_total), repairs: row.repairs, uses24h: row.uses24h,
      uses72h: row.uses72h, usesPrev24h: row.uses_prev24h, renewedMinute: row.renewed_minute === null ? null : Number(row.renewed_minute) })),
    residents: residents.rows.map((row) => ({ agentId: row.agent_id, energy: row.energy, location: row.location,
      homeStatus: row.home_status || null })),
    actions: actions.rows, scenes: scenes.rows, founders: Number(founders.rows[0]?.n) || 0, districts });
}

// Condition rows for built facilities that have none yet. A facility that stood before growth1 starts
// at the condition its age without any maintenance gives (2 points per world day since it was built or
// last expanded, floor 30).
export async function ensureConditionRows(client, { worldId, worldMinutes }) {
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const rows = await client.query(`SELECT work.id::text AS id,GREATEST(work.completed_world_minute,
      COALESCE((SELECT max(exp.completed_world_minute) FROM world_public_works exp WHERE exp.target_work_id=work.id
        AND exp.status='completed'),0)) AS renewed
    FROM world_public_works work WHERE work.world_id=$1 AND work.status='completed' AND work.kind<>'expansion'
      AND NOT EXISTS (SELECT 1 FROM world_public_work_conditions cond WHERE cond.work_id=work.id)`, [worldId]);
  for (const row of rows.rows) {
    const condition = initialCondition(minute - Number(row.renewed || minute));
    await client.query(`INSERT INTO world_public_work_conditions(work_id,world_id,condition,initial_condition,wear_world_minute)
      VALUES($1,$2,$3,$3,$4) ON CONFLICT(work_id) DO NOTHING`, [row.id, worldId, condition, minute]);
  }
  return rows.rowCount;
}
// Standing wear: BASE_WEAR_PER_HOUR for every whole world hour since the last wear step.
export async function applyStandingWear(client, { worldId, worldMinutes }) {
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const rows = await client.query(`SELECT work_id::text AS work_id,condition::float8 AS condition,wear_world_minute::bigint AS wear
    FROM world_public_work_conditions WHERE world_id=$1 AND wear_world_minute <= $2 - 60 FOR UPDATE`, [worldId, minute]);
  for (const row of rows.rows) {
    const hours = Math.floor((minute - Number(row.wear)) / 60);
    if (hours < 1) continue;
    await client.query(`UPDATE world_public_work_conditions SET condition=LEAST(condition,$3),wear_world_minute=$4
      WHERE world_id=$1 AND work_id=$2`, [worldId, row.work_id, wornCondition(row.condition, hours), Number(row.wear) + hours * 60]);
  }
  return rows.rowCount;
}
// Show level, condition and recent use on each building's map card (scene features).
async function syncFacilityFeatures(client, { worldId, demand }) {
  for (const facility of demand?.facilities || []) {
    if (!facility.sceneId) continue;
    const patch = { condition: Math.round(facility.condition), uses24h: facility.uses24h, usesTotal: facility.usesTotal,
      capacityPerDay: facility.capacity, repairs: facility.repairs,
      effectFactor: Math.round(levelFactor(facility.level) * conditionFactor(facility.condition) * 100) / 100 };
    await client.query(`UPDATE world_scenes SET features=jsonb_set(features,'{publicWork}',
        COALESCE(features->'publicWork','{}'::jsonb) || $3::jsonb,true) WHERE world_id=$1 AND id=$2`,
    [worldId, facility.sceneId, JSON.stringify(patch)]);
  }
}

// One real use of a public building (called by the engine when an activity completes on site).
// Returns the on-site effect, or null when this activity is not a use of this building.
export async function applyPublicWorkUse(client, { worldId, agentId, scene, activity, worldMinutes }) {
  const work = builtPublicWork(scene);
  if (!work || !useCounts(work.kind, activity) || !scene?.id) return null;
  if (!await growthReady(client)) return null;
  const type = work.kind, spec = USE_SPECS[type];
  const row = (await client.query(`SELECT work.id::text AS id,cond.condition::float8 AS condition FROM world_public_works work
      LEFT JOIN world_public_work_conditions cond ON cond.work_id=work.id
    WHERE work.world_id=$1 AND work.scene_id=$2 AND work.kind<>'expansion' AND work.status='completed'
    ORDER BY work.completed_world_minute LIMIT 1`, [worldId, scene.id])).rows[0];
  if (!row) return null;
  if (spec.business) {
    const owns = await client.query(`SELECT 1 FROM world_businesses WHERE world_id=$1 AND founder_agent_id=$2 AND status='active' LIMIT 1`,
      [worldId, agentId]);
    if (!owns.rowCount) return null;
  }
  if (spec.homeless) {
    const home = await client.query(`SELECT status FROM world_resident_homes WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId]);
    if (home.rows[0]?.status === 'built') return null;
  }
  const condition = row.condition === null || row.condition === undefined ? 100 : Number(row.condition);
  const effect = onSiteEffect(type, { level: work.level, condition });
  for (const [skill, gain] of Object.entries(effect.skills)) {
    if (!(gain > 0)) continue;
    await client.query(`INSERT INTO world_agent_skills(world_id,agent_id,skill_name,skill_value,actions_completed)
      VALUES($1,$2,$3,$4,1) ON CONFLICT(world_id,agent_id,skill_name) DO UPDATE SET
        skill_value=LEAST(100,world_agent_skills.skill_value+$4),updated_at=now()`, [worldId, agentId, skill, gain]);
  }
  const external = (await client.query(`SELECT 1 FROM world_external_residents WHERE world_id=$1 AND agent_id=$2`, [worldId, agentId])
    .catch(() => ({ rowCount: 0 }))).rowCount > 0;
  const minute = Math.trunc(Number(worldMinutes) || 0);
  await client.query(`INSERT INTO world_public_work_uses(world_id,work_id,scene_id,agent_id,building_type,activity,use_kind,external,
      world_minute,effect) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
  [worldId, row.id, scene.id, agentId, type, activity, effect.useKind, external, minute,
    JSON.stringify({ needs: effect.needs, skills: effect.skills, listing: effect.listing, factor: effect.factor,
      level: Number(work.level) || 1, condition: Math.round(condition) })]);
  await client.query(`UPDATE world_public_work_conditions SET condition=GREATEST(0,condition-$3),uses_total=uses_total+1
    WHERE world_id=$1 AND work_id=$2`, [worldId, row.id, USE_WEAR]);
  if (effect.listing > 0) {
    const cache = growthCacheFor(worldId);
    cache.listed.set(agentId, minute + LISTING_WINDOW_MINUTES);
    cache.listingFactor.set(agentId, Math.max(Number(cache.listingFactor.get(agentId)) || 0, effect.listing));
  }
  return { workId: row.id, place: scene.name, type, useKind: effect.useKind, needs: effect.needs, skills: effect.skills,
    listing: effect.listing, factor: effect.factor, condition: Math.round(condition), external };
}
let growthState = { worldId: null, hour: null, founders: new Set(), listed: new Map(), listingFactor: new Map() };
function growthCacheFor(worldId) {
  if (growthState.worldId !== worldId) growthState = { worldId, hour: null, founders: new Set(), listed: new Map(), listingFactor: new Map() };
  return growthState;
}
export function currentGrowthContext() { return growthState; }
// Hourly: active business founders (who can sell at a market hall/harbor) and current listings.
export async function refreshGrowthCache(client, { worldId, worldMinutes = 0, force = false }) {
  const hour = Math.floor((Number(worldMinutes) || 0) / 60);
  const cache = growthCacheFor(worldId);
  if (!force && cache.hour === hour) return cache;
  try {
    if (!await growthReady(client)) return cache;
    const founders = await client.query(`SELECT DISTINCT founder_agent_id::text AS id FROM world_businesses WHERE world_id=$1 AND status='active'`, [worldId]);
    const listings = await client.query(`SELECT agent_id::text AS id,max(world_minute)::bigint AS last,
        max(COALESCE((effect->>'listing')::float8,0)) AS factor FROM world_public_work_uses
      WHERE world_id=$1 AND use_kind IN ('market','trade') AND world_minute >= $2 GROUP BY 1`, [worldId, Number(worldMinutes) - LISTING_WINDOW_MINUTES]);
    growthState = { worldId, hour, founders: new Set(founders.rows.map((row) => row.id)),
      listed: new Map(listings.rows.map((row) => [row.id, Number(row.last) + LISTING_WINDOW_MINUTES])),
      listingFactor: new Map(listings.rows.map((row) => [row.id, Number(row.factor) || 0])) };
    setGrowthCache(worldId, hour, growthState);
  } catch { /* keep the previous cache */ }
  return growthState;
}

async function unlockDistrict(client, { worldId, worldMinutes, decision, demand }) {
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const district = decision.district;
  const exists = await client.query(`SELECT 1 FROM world_growth_districts WHERE world_id=$1 AND district=$2`, [worldId, district]);
  if (exists.rowCount) return null;
  let name = `District ${district} Square`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = attempt ? `District ${district} Square ${attempt + 1}` : name;
    if (!(await client.query('SELECT 1 FROM world_scenes WHERE world_id=$1 AND lower(name)=lower($2)', [worldId, candidate])).rowCount) { name = candidate; break; }
  }
  const scene = await client.query(`INSERT INTO world_scenes(world_id,created_by,name,scene_type,description,status,purpose,capacity,
      features,position,created_world_minutes) VALUES($1,$2,$3,'district_square',$4,'active',$5,12,$6::jsonb,$7::jsonb,$8)
    ON CONFLICT(world_id,name) DO NOTHING RETURNING id::text AS id`,
  [worldId, PUBLIC_WORKS_GOVERNOR_ID, name, shortText(`The square of District ${district}, opened because the town outgrew its districts.`, 240),
    'A new outer district: its roads, bridge and services are built as residents start to use it.',
    JSON.stringify({ origin: 'growth_district', archetype: 'stage', kind: 'district_square', accent: '#c9a14a', action: 'socialize',
      district, openingHours: { weekday: [[0, 24]], weekend: [[0, 24]] } }),
    JSON.stringify(districtSquarePosition(district)), minute]);
  const sceneId = scene.rows[0]?.id || null;
  const reason = shortText(decision.reason, 300);
  await client.query(`INSERT INTO world_growth_districts(world_id,district,unlocked_world_minute,scene_id,reason,demand)
    VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`, [worldId, district, minute, sceneId, reason,
    JSON.stringify({ facilities: decision.facilities, uses24h: decision.uses24h, saturated: decision.saturated,
      minFacilities: decision.minFacilities, minUses: decision.minUses, residents: demand?.residents ?? null })]);
  await recordEvent(client, { worldId, actorId: PUBLIC_WORKS_GOVERNOR_ID, type: 'world.district_unlocked',
    actionId: `growth:district:${district}`, data: { district, name, reason, worldMinutes: minute } });
  await writeWorldHistory(client, { worldId, eventKey: `growth:district:${district}`, eventType: 'place_created',
    actorAgentId: PUBLIC_WORKS_GOVERNOR_ID, entityType: 'place', entityId: sceneId, worldTime: minute,
    title: `District ${district} opened`, detail: reason, metadata: { growthDistrict: district } });
  return { district, sceneId, name, reason };
}

// Hourly growth step (inside the public-works hour): condition rows, standing wear, map cards, district
// unlock and the maintenance tender (repairs, worst building first, paid to a resident builder).
export async function runGrowthHour(client, { worldId, worldMinutes, stats, env = process.env }) {
  if (!await growthReady(client)) return { skipped: 'not_migrated' };
  const minute = Math.trunc(Number(worldMinutes) || 0);
  const summary = { conditionRows: await ensureConditionRows(client, { worldId, worldMinutes: minute }) };
  summary.wear = await applyStandingWear(client, { worldId, worldMinutes: minute });
  const demand = await readGrowthDemand(client, { worldId, worldMinutes: minute, stats });
  summary.demand = demand;
  await syncFacilityFeatures(client, { worldId, demand });
  await refreshGrowthCache(client, { worldId, worldMinutes: minute, force: true });
  const last = await client.query(`SELECT max(unlocked_world_minute)::bigint AS last FROM world_growth_districts WHERE world_id=$1`, [worldId]);
  const decision = districtUnlockDecision({ districts: demand.newestDistrict, facilities: demand.facilities.length,
    uses24h: demand.uses24h, residents: demand.residents, saturated: demand.saturated,
    lastUnlockMinute: last.rows[0]?.last === null || last.rows[0]?.last === undefined ? null : Number(last.rows[0].last), worldMinutes: minute,
    newestTraffic: Number(demand.reach?.districtTraffic?.[demand.newestDistrict]?.visits) || 0 });
  summary.district = decision.unlock ? await unlockDistrict(client, { worldId, worldMinutes: minute, decision, demand }) : null;
  if (String(env?.MIRRORTERRA_PUBLIC_WORKS ?? 'on').toLowerCase() === 'off') return summary;
  const repairOpen = await client.query(`SELECT 1 FROM world_public_works work JOIN world_public_work_meta meta ON meta.work_id=work.id
    WHERE work.world_id=$1 AND work.status='bidding' AND meta.work_type='repair' LIMIT 1`, [worldId]);
  if (repairOpen.rowCount) return summary;
  const open = await readPublicWorks(client, { worldId });
  const repairs = repairNeeds({ demand, open: openForNeeds(open) });
  if (!repairs.length) return summary;
  const free = await readTreasuryFreeBalance(client, worldId);
  const pick = repairs.find((need) => big(need.baseRaw) <= free);
  if (!pick) { summary.repairWaiting = { freeRaw: free.toString(), due: repairs.length }; return summary; }
  const capacity = commissionCapacity(stats?.residents || [], open.filter((work) => work.status === 'building'), minute);
  if (!capacity.hasCapacity) {
    summary.repairSkipped = { reason: NO_BUILDER_CAPACITY, recorded: await recordNoCapacitySkip(client, { worldId, worldMinutes: minute,
      capacity, projectKey: pick.projectKey, origin: 'maintenance' }) };
    return summary;
  }
  summary.repair = await commissionPublicWork(client, { worldId, worldMinutes: minute, projectKey: pick.projectKey,
    priceRaw: pick.baseRaw, reason: pick.reason, source: 'governor_fallback', stats, demand })
    .catch((error) => ({ error: error.code || error.message }));
  await recordDeliberation(client, { worldId, worldMinutes: minute, phase: 'commission', agentId: PUBLIC_WORKS_GOVERNOR_ID,
    source: 'fallback', failureCode: MAINTENANCE_REPAIR, workId: summary.repair?.workId || null,
    decision: { commission: Boolean(summary.repair?.workId), projectKey: pick.projectKey, workType: 'repair' }, reason: pick.reason });
  return summary;
}

// ---- panel summary (names and amounts only, no ids) ---------------------------------------------
export async function readPublicWorksSummary(pool, { worldId }) {
  const ready = await pool.query(`SELECT to_regclass('public.world_public_works') IS NOT NULL AS ready`);
  if (!ready.rows[0]?.ready) return null;
  const [open, completed, bids, deliberation] = await Promise.all([
    pool.query(`SELECT work.id,work.kind,work.name,work.status,work.price_raw::text AS price_raw,
        work.contract_price_raw::text AS contract_price_raw,work.paid_raw::text AS paid_raw,work.progress,work.milestones_paid,
        builder.name AS builder,work.commissioned_by,work.bidding_closes_world_minute::text AS closes,
        (SELECT count(*)::int FROM world_public_work_bids bid WHERE bid.work_id=work.id) AS bids,
        (SELECT count(*)::int FROM world_public_work_bids bid WHERE bid.work_id=work.id AND bid.source='llm') AS llm_bids,
        (SELECT min(bid.bid_raw)::text FROM world_public_work_bids bid WHERE bid.work_id=work.id AND bid.credible) AS low_bid
      FROM world_public_works work LEFT JOIN agents builder ON builder.id=work.builder_agent_id
      WHERE work.world_id=$1 AND work.status IN ('bidding','building') ORDER BY work.commissioned_world_minute LIMIT 6`, [worldId]),
    pool.query(`SELECT work.kind,work.name,builder.name AS builder,work.contract_price_raw::text AS contract_price_raw,
        COALESCE((scene.features->'publicWork'->>'level')::int,1) AS level,work.completed_world_minute::text AS completed
      FROM world_public_works work LEFT JOIN agents builder ON builder.id=work.builder_agent_id
      LEFT JOIN world_scenes scene ON scene.id=work.scene_id
      WHERE work.world_id=$1 AND work.status='completed' ORDER BY work.completed_world_minute DESC LIMIT 8`, [worldId]),
    pool.query(`SELECT count(*)::int AS n,COALESCE(sum(amount_raw),0)::text AS paid FROM world_sync_treasury_entries
      WHERE world_id=$1 AND kind='public_works'`, [worldId]),
    pool.query(`SELECT phase,source,count(*)::int AS n FROM world_council_deliberations WHERE world_id=$1
      AND created_at > now() - interval '1440 seconds' GROUP BY 1,2`, [worldId])
  ]);
  return buildPublicWorksSummary({ open: open.rows, completed: completed.rows, payments: bids.rows[0] || {},
    deliberation: deliberation.rows });
}

export function buildPublicWorksSummary({ open = [], completed = [], payments = {}, deliberation = [] }) {
  const name = (value) => (value ? currentResidentDisplayName(value) : null);
  const counts = { llm: 0, fallback: 0 };
  const byPhase = {};
  for (const row of deliberation) {
    counts[row.source] = (counts[row.source] || 0) + Number(row.n || 0);
    byPhase[row.phase] = byPhase[row.phase] || { llm: 0, fallback: 0 };
    byPhase[row.phase][row.source] = (byPhase[row.phase][row.source] || 0) + Number(row.n || 0);
  }
  return {
    projects: open.map((row) => ({ kind: row.kind, label: PUBLIC_WORK_CATALOG[row.kind]?.label || row.kind, name: row.name,
      status: row.status, priceRaw: big(row.price_raw).toString(),
      contractPriceRaw: row.contract_price_raw ? big(row.contract_price_raw).toString() : null,
      paidRaw: big(row.paid_raw).toString(), progress: Number(row.progress) || 0, milestonesPaid: Number(row.milestones_paid) || 0,
      builder: name(row.builder), bids: Number(row.bids) || 0, llmBids: Number(row.llm_bids) || 0,
      lowestBidRaw: row.low_bid ? big(row.low_bid).toString() : null,
      commissionedBy: row.commissioned_by === 'governor_llm' ? 'llm' : 'fallback' })),
    completed: completed.map((row) => ({ kind: row.kind, label: PUBLIC_WORK_CATALOG[row.kind]?.label || row.kind, name: row.name,
      builder: name(row.builder), contractPriceRaw: big(row.contract_price_raw).toString(), level: Number(row.level) || 1,
      effect: PUBLIC_WORK_CATALOG[row.kind]?.effect || '' })),
    paidCount: Number(payments.n) || 0, paidRaw: big(payments.paid).toString(),
    deliberation: { lastWorldDay: counts, byPhase }
  };
}
