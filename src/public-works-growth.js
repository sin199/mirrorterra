// growth1: the town grows from what residents really use (user decision 2026-10-21: "only build what
// residents really use"). Pure rules only (no database): which buildings exist, what a visit does on
// site, how much a building can serve per world day, how it wears and what its repair costs, when an
// outer district unlocks, and the use affordances offered to residents. src/public-works.js reads the
// measured demand from the database and turns it into commission needs with these rules.
// growth2 (user decision 2026-10-21, "好"): reachability (new buildings only where residents actually go,
// within walking reach of their homes/workplaces), repairs only for used buildings (roads/bridges exempt),
// slower expansion (sustained use over two world days since the last expansion, steeper cost).
// Money: nothing here moves SYNC. Every payment still goes through the existing tender -> contract ->
// milestone path (postTreasuryEntry, pool-backed treasury SYNC only); externals never hold a contract.

// ---- building types --------------------------------------------------------------------------------
// New kinds are stored in world_public_works under the closest legacy kind (the 0030 kind CHECK is not
// changed, schema changes stay additive) and carry their real type in world_public_work_meta
// (migration 0032). The stored kind is what the rollback release (external1b) would see: a hospital
// acts like a clinic, a library like a school, a harbor like a market hall, the rest like a hall.
export const GROWTH_TYPES = Object.freeze({
  library: { label: 'Public Library', baseSync: 16, skill: 'research', archetype: 'library', accent: '#5b7fc4', icon: '▤',
    storedKind: 'school', benefit: { learn: 0.25 },
    effect: 'Library: a study session here gives extra knowledge and research skill; also speeds learning town-wide like a school.' },
  hospital: { label: 'Hospital', baseSync: 30, skill: 'social', archetype: 'hospital', accent: '#d9465b', icon: '✚',
    storedKind: 'clinic', benefit: { energy: 2, hygiene: 1 },
    effect: 'Hospital: a visit restores much more energy and hygiene than a clinic and serves many more residents per day.' },
  workshop: { label: 'Workshop District', baseSync: 20, skill: 'engineering', archetype: 'atelier', accent: '#b9783f', icon: '⚒',
    storedKind: 'public_building', benefit: { craft: 1 },
    effect: 'Workshop district: a work shift here gives extra engineering (crafting) skill.' },
  harbor: { label: 'Harbor', baseSync: 24, skill: 'trading', archetype: 'harbor', accent: '#3f86b5', icon: '⚓',
    storedKind: 'market_hall', benefit: { sales: 6 },
    effect: 'Harbor: a trading shift here lists the resident\'s business for buyers (more sales) and builds trading skill.' },
  apartment: { label: 'Apartment Block', baseSync: 26, skill: 'engineering', archetype: 'apartment', accent: '#a08a6c', icon: '▦',
    storedKind: 'public_building', benefit: { housing: 4 },
    effect: 'Apartment block: residents without a finished home rest here in a real bed (energy and hygiene).' }
});
// Proposed but dropped: nothing in the engine would consume what they produce.
export const DROPPED_TYPES = Object.freeze({
  power_station: 'The engine has no electricity model: no action, place or business consumes power, so a power station would have no mechanical use.',
  water_works: 'Water and hygiene are already served by homes (wash at home) and clinics; no engine mechanic consumes piped water, so water works would be a passive checklist item.'
});
export const BUILDING_TYPES = Object.freeze(['road','bridge','park','market_hall','clinic','school','public_building',
  ...Object.keys(GROWTH_TYPES)]);

// ---- on-site use ------------------------------------------------------------------------------------
// action: the engine activity that counts as a use there; also: other activities that count too.
// capacity: visits one level-1 building in good condition can serve per world day.
// gains: need gains on site (before level/condition factors); skills: skill gains on site.
export const USE_SPECS = Object.freeze({
  clinic: { action: 'rest', also: [], useKind: 'care', capacity: 8, gains: { energy: 14, hygiene: 12, happiness: 2 } },
  hospital: { action: 'rest', also: [], useKind: 'care', capacity: 20, gains: { energy: 22, hygiene: 16, happiness: 3 } },
  school: { action: 'learn', also: [], useKind: 'learn', capacity: 8, gains: { knowledge: 3 }, skills: { research: 0.5 } },
  library: { action: 'learn', also: [], useKind: 'learn', capacity: 10, gains: { knowledge: 5 }, skills: { research: 0.4 } },
  park: { action: 'rest', also: ['socialize'], useKind: 'leisure', capacity: 12, gains: { fun: 14, social: 6, happiness: 4 } },
  public_building: { action: 'socialize', also: ['rest'], useKind: 'social', capacity: 10, gains: { social: 14, fun: 6, happiness: 3 } },
  market_hall: { action: 'work', also: [], useKind: 'market', capacity: 8, gains: { happiness: 2 }, skills: { trading: 0.3 },
    listing: 1, business: true },
  harbor: { action: 'work', also: [], useKind: 'trade', capacity: 14, gains: { happiness: 2 }, skills: { trading: 0.5 },
    listing: 1.4, business: true },
  workshop: { action: 'work', also: [], useKind: 'craft', capacity: 10, gains: { knowledge: 1, happiness: 1 },
    skills: { engineering: 0.6 } },
  apartment: { action: 'rest', also: [], useKind: 'housing', capacity: 8, beds: 4, gains: { energy: 16, hygiene: 14, happiness: 2 },
    homeless: true }
});
export const USE_KINDS = Object.freeze(['care','learn','leisure','social','market','trade','craft','housing']);
// Demand categories: a category's buildings serve the same need; the larger type is built once the
// smaller ones are saturated.
export const CATEGORY_TYPES = Object.freeze({
  care: ['clinic','hospital'], learn: ['school','library'], leisure: ['park'], social: ['public_building'],
  market: ['market_hall','harbor'], craft: ['workshop'], housing: ['apartment']
});
export const categoryOf = (type) => Object.keys(CATEGORY_TYPES).find((key) => CATEGORY_TYPES[key].includes(type)) || null;
export const LISTING_WINDOW_MINUTES = 720;     // a market/harbor shift lists the business for 12 world hours
export const LISTING_SCORE = 10;               // buyer score bonus for a listed business (x level/condition factor)

// ---- diminishing returns ---------------------------------------------------------------------------
// Effect factor of a level: 1, 1.24, 1.41, 1.53, 1.61 ... -> never above 1.8 however far a building is
// expanded. Capacity grows sub-linearly (level^0.75). Expansion cost grows 35% per level.
export const LEVEL_EFFECT_MAX = 1.8;
export function levelFactor(level) {
  const L = Math.max(1, Math.trunc(Number(level) || 1));
  return Math.round((1 + (LEVEL_EFFECT_MAX - 1) * (1 - 0.7 ** (L - 1))) * 1000) / 1000;
}
export function capacityFactor(level) { return Math.round(Math.max(1, Math.trunc(Number(level) || 1)) ** 0.75 * 1000) / 1000; }
// Neglect: full effect from condition 60 up; below that the effect falls linearly to 35% at condition 0.
// A building is never deleted.
export const FULL_EFFECT_CONDITION = 60;
export function conditionFactor(condition) {
  const c = Math.max(0, Math.min(100, Number(condition ?? 100)));
  return c >= FULL_EFFECT_CONDITION ? 1 : Math.round((0.35 + 0.65 * c / FULL_EFFECT_CONDITION) * 1000) / 1000;
}
export function facilityCapacity(type, level = 1) {
  const spec = USE_SPECS[type];
  return spec ? Math.max(1, Math.round(spec.capacity * capacityFactor(level))) : 0;
}
export function apartmentBeds(level = 1) { return Math.max(1, Math.round(USE_SPECS.apartment.beds * capacityFactor(level))); }

// Pure: what one visit does on site (needs, skills, business listing), scaled by level and condition.
export function onSiteEffect(type, { level = 1, condition = 100 } = {}) {
  const spec = USE_SPECS[type];
  if (!spec) return null;
  const factor = levelFactor(level) * conditionFactor(condition);
  const needs = {};
  for (const [key, value] of Object.entries(spec.gains || {})) needs[key] = Math.max(1, Math.round(value * factor));
  const skills = {};
  for (const [key, value] of Object.entries(spec.skills || {})) skills[key] = Math.round(value * factor * 1000) / 1000;
  return { type, useKind: spec.useKind, factor: Math.round(factor * 1000) / 1000, needs, skills,
    listing: spec.listing ? Math.round(spec.listing * factor * 1000) / 1000 : 0 };
}
export function useCounts(type, activity) {
  const spec = USE_SPECS[type];
  return Boolean(spec && (spec.action === activity || spec.also.includes(activity)));
}

// ---- wear and maintenance --------------------------------------------------------------------------
export const BASE_WEAR_PER_HOUR = 2 / 24;     // 2 condition points per world day of standing
export const USE_WEAR = 0.15;                  // plus 0.15 per visit (busy buildings wear faster)
export const INITIAL_WEAR_PER_DAY = 2;         // buildings that stood unmaintained before growth1
export const INITIAL_MIN_CONDITION = 30;
export const REPAIR_THRESHOLD = 70;            // a repair contract is tendered below this condition
export const REPAIR_PRICE_FACTOR = 1.5;
export const REPAIR_MIN_RAW = 500_000n;        // 0.5 SYNC
export function initialCondition(ageMinutes) {
  const days = Math.max(0, Number(ageMinutes) || 0) / 1440;
  return Math.round(Math.max(INITIAL_MIN_CONDITION, Math.min(100, 100 - INITIAL_WEAR_PER_DAY * days)) * 100) / 100;
}
export function wornCondition(condition, hours) {
  const c = Math.max(0, Math.min(100, Number(condition ?? 100)));
  return Math.round(Math.max(0, c - BASE_WEAR_PER_HOUR * Math.max(0, Number(hours) || 0)) * 100) / 100;
}
const RAW = 1_000_000n;
const syncToRaw = (sync) => BigInt(Math.round(Number(sync) * 10_000)) * (RAW / 10_000n);
export function facilityValueSync(baseSync, level = 1) {
  return Math.round(Number(baseSync) * Math.max(1, Math.trunc(Number(level) || 1)) ** 0.8 * 100) / 100;
}
export function repairPriceRaw(baseSync, level, condition) {
  const wear = Math.max(0, Math.min(100, 100 - Number(condition ?? 100))) / 100;
  const raw = syncToRaw(facilityValueSync(baseSync, level) * wear * REPAIR_PRICE_FACTOR) / 10_000n * 10_000n;
  return raw < REPAIR_MIN_RAW ? REPAIR_MIN_RAW : raw;
}
// growth2: steeper than growth1's 1.35/level: 0.6, 0.96, 1.54, 2.46, 3.93 ... x base.
export const EXPANSION_COST_GROWTH = 1.6;
export function expansionPriceRaw(baseSync, level) {
  const L = Math.max(1, Math.trunc(Number(level) || 1));
  return syncToRaw(Number(baseSync) * 0.6 * EXPANSION_COST_GROWTH ** (L - 1)) / 10_000n * 10_000n;
}

// ---- demand gate -----------------------------------------------------------------------------------
export const NEAR_CAPACITY = 0.75;    // a building at >=75% of its daily capacity may be expanded
export const ALL_BUSY = 0.6;          // a new building of a category only when every one is >=60% used
export const LOW_ENERGY = 35;
export const LOW_ENERGY_MIN = 3;      // residents with low energy far from any care building -> clinic there
export const HOMELESS_MIN = 2;        // residents without a home beyond the free apartment beds -> apartment
export const TRIP_MIN = 15;           // trips per world day into a district without road/bridge -> road/bridge
export const LATENT_MIN = { care: 6, learn: 12, leisure: 12, social: 12, market: 3, craft: 15 };
export function utilization(uses, capacity) { return capacity > 0 ? Math.round(Number(uses) / capacity * 1000) / 1000 : 0; }
export function walkMinutesToDistrict(district) {
  const radius = 1.3 + 0.35 * (Math.max(1, Number(district) || 1) - 1);
  return Math.max(3, Math.min(32, Math.round(3 + radius * 10)));
}

// ---- districts -------------------------------------------------------------------------------------
export const DISTRICT_MIN_GAP_MINUTES = 2880;
export function districtUnlockDecision({ districts = 1, facilities = 0, uses24h = 0, residents = 0, saturated = [],
  lastUnlockMinute = null, worldMinutes = 0, newestTraffic = 0 }) {
  const D = Math.max(1, Math.trunc(Number(districts) || 1));
  const minFacilities = 8 + 3 * (D - 1);
  const minUses = Math.max(30, 3 * (Number(residents) || 0));
  const gapOk = lastUnlockMinute === null || Number(worldMinutes) - Number(lastUnlockMinute) >= DISTRICT_MIN_GAP_MINUTES;
  // growth2: a further district opens only when residents actually go to the newest one.
  const trafficOk = (Number(newestTraffic) || 0) >= DISTRICT_MIN_TRAFFIC;
  const unlock = facilities >= minFacilities && uses24h >= minUses && saturated.length > 0 && gapOk && trafficOk;
  return { unlock, district: D + 1, minFacilities, minUses, facilities, uses24h, saturated: [...saturated], gapOk,
    newestTraffic: Number(newestTraffic) || 0, trafficOk,
    reason: `District ${D + 1}: ${facilities} public buildings (need ${minFacilities}), ${uses24h} visits in 24 h (need ${minUses}), `
      + `saturated: ${saturated.length ? saturated.join(', ') : 'none'}; District ${D} had ${Number(newestTraffic) || 0} resident visits in 24 h (need ${DISTRICT_MIN_TRAFFIC}).` };
}
// Public works positions in a district ring, between the skill-place slots of that ring.
export function growthPosition(district, index = 0) {
  const d = Math.max(1, Math.trunc(Number(district) || 1));
  const slots = 10 + 2 * d;
  const angle = ((index % slots) / slots) * Math.PI * 2 + d * 0.53 + 0.31;
  const radius = 1.3 + (d - 1) * 0.35 + 0.09 + Math.floor(index / slots) * 0.04;
  return { x: Math.round(Math.cos(angle) * radius * 1000) / 1000, z: Math.round(Math.sin(angle) * radius * 1000) / 1000,
    district: d, civic: true };
}
export function districtSquarePosition(district) {
  const d = Math.max(2, Math.trunc(Number(district) || 2));
  const angle = d * 1.13 + 0.2, radius = 1.3 + (d - 1) * 0.35;
  return { x: Math.round(Math.cos(angle) * radius * 1000) / 1000, z: Math.round(Math.sin(angle) * radius * 1000) / 1000, district: d };
}

// ---- use affordances (pure; the engine adds them before distance, hours and capacity are applied) ----
const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
export function builtPublicWork(scene) {
  const work = scene?.features?.publicWork;
  return scene?.status === 'active' && scene?.features?.origin === 'public_works' && work && work.stage === 'built' ? work : null;
}
export function publicWorkUseCandidates(agent, scenes = [], { founders = new Set(), listed = new Map(), worldMinutes = 0,
  craftScore = null } = {}) {
  const energy = num(agent?.energy, 60), food = num(agent?.food, 60), social = num(agent?.social, 50);
  const hygiene = num(agent?.hygiene, 80), fun = num(agent?.fun, 70), knowledge = num(agent?.knowledge, 30);
  const goal = String(agent?.goal || '');
  const options = [];
  const push = (scene, type, action, goalText, score) => options.push({ id: `use:${type}:${scene.id || scene.name}`, action,
    targetLocation: scene.name, goal: goalText, description: goalText, score, plannedPaidMeal: false, side: null, asset: null,
    quoteUnits: null, socialPartnerId: null, socialPartnerName: null, publicWorkUse: type });
  for (const scene of scenes) {
    const work = builtPublicWork(scene);
    if (!work || !USE_SPECS[work.kind]) continue;
    const type = work.kind;
    const effect = onSiteEffect(type, { level: work.level, condition: work.condition });
    const boost = 8 * effect.factor;
    if (type === 'clinic' || type === 'hospital') {
      if (energy >= 55 && hygiene >= 50) continue;
      push(scene, type, 'rest', `Get care at ${scene.name}: recover energy and hygiene on site.`,
        30 + Math.max(0, 75 - energy) * 0.9 + Math.max(0, 70 - hygiene) * 0.6 + boost + (type === 'hospital' ? 4 : 0));
    } else if (type === 'school' || type === 'library') {
      if (knowledge >= 90 || energy < 15 || food < 8) continue;
      push(scene, type, 'learn', `Study at ${scene.name}: extra skill on site.`,
        24 + (goal === 'learn' ? 22 : 0) + Math.max(0, 85 - knowledge) * 0.6 + boost);
    } else if (type === 'park') {
      if (energy < 10 || (fun >= 80 && social >= 70)) continue;
      push(scene, type, 'rest', `Relax at ${scene.name}: fun and company on site.`,
        20 + Math.max(0, 78 - fun) * 0.6 + Math.max(0, 60 - social) * 0.3 + boost);
    } else if (type === 'public_building') {
      if (energy < 12 || food < 8 || social >= 85) continue;
      push(scene, type, 'socialize', `Join the community at ${scene.name}.`,
        20 + (goal === 'community' ? 14 : 0) + Math.max(0, 80 - social) * 0.55 + boost);
    } else if (type === 'market_hall' || type === 'harbor') {
      if (!founders.has(agent?.agentId) || energy < 20 || food < 12) continue;
      const until = num(listed.get(agent.agentId), -1);
      push(scene, type, 'work', `Sell my business's goods at ${scene.name}.`,
        30 + (goal === 'wealth' ? 10 : 0) + boost - (until > worldMinutes ? 18 : 0));
    } else if (type === 'workshop') {
      if (energy < 20 || food < 12) continue;
      // growth2: a crafting shift here competes with the resident's best workshop/skill-place shift on the
      // same base score (craftScore, computed by the engine for this resident) plus the on-site bonus, so a
      // resident who would craft anyway prefers the public workshop when it is within reach.
      const base = Math.max(26 + (goal === 'wealth' ? 8 : 0), Number.isFinite(Number(craftScore)) ? Number(craftScore) : -Infinity);
      push(scene, type, 'work', `Craft at ${scene.name}: extra engineering skill on site.`, base + boost);
    } else if (type === 'apartment') {
      if (agent?.homeStatus === 'built') continue;
      push(scene, type, 'rest', `Rest in a bed at ${scene.name} (no finished home yet).`,
        34 + Math.max(0, 85 - energy) * 0.5 + Math.max(0, 70 - hygiene) * 0.5 + boost);
    }
  }
  return options;
}

// ---- buyers prefer businesses listed at a market hall / harbor -------------------------------------
let listingCache = { worldId: null, hour: null, founders: new Set(), listed: new Map(), listingFactor: new Map() };
export function setGrowthCache(worldId, hour, { founders = new Set(), listed = new Map(), listingFactor = new Map() } = {}) {
  listingCache = { worldId, hour, founders, listed, listingFactor };
}
export function growthCache() { return listingCache; }
export function marketListingBonus(founderAgentId) {
  const factor = Number(listingCache.listingFactor.get(founderAgentId)) || 0;
  return factor > 0 ? Math.round(LISTING_SCORE * Math.min(LEVEL_EFFECT_MAX * 1.4, factor) * 10) / 10 : 0;
}

// ---- growth2: repairs only for used buildings ------------------------------------------------------
// A building with no visit in the last REPAIR_USE_WINDOW_MINUTES (3 world days) gets no repair contract;
// it keeps wearing (its effect falls to 35% at condition 0) and is never deleted. Roads and bridges
// serve travel (no visits are logged there) and are always repaired.
export const REPAIR_USE_WINDOW_MINUTES = 4320;
export const REPAIR_EXEMPT_TYPES = Object.freeze(['road', 'bridge']);
export function repairEligible(facility) {
  if (REPAIR_EXEMPT_TYPES.includes(facility?.type)) return { eligible: true, exempt: true };
  const uses = facility?.uses72h === null || facility?.uses72h === undefined ? NaN : Number(facility.uses72h);
  if (!Number.isFinite(uses)) return { eligible: false, exempt: false, reason: 'no_use_measurement' };
  return uses > 0 ? { eligible: true, exempt: false } : { eligible: false, exempt: false, reason: 'unused_72h' };
}

// ---- growth2: slower expansion ----------------------------------------------------------------------
// A building is expanded only after EXPANSION_COOLDOWN_MINUTES since it was built or last expanded, and
// only on SUSTAINED use: each of the last two world days at >= NEAR_CAPACITY of its current capacity,
// both days measured after the last expansion finished (EXPANSION_SUSTAIN_MINUTES). Build time plus
// the 48 h window gives at most ~2 levels per 84 world hours.
export const EXPANSION_COOLDOWN_MINUTES = 1440;
export const EXPANSION_SUSTAIN_MINUTES = 2880;
export function expansionDecision(facility, worldMinutes) {
  const capacity = Number(facility?.capacity) || 0;
  const today = utilization(facility?.uses24h, capacity);
  const prev = utilization(facility?.usesPrev24h, capacity);
  const renewed = facility?.renewedMinute === null || facility?.renewedMinute === undefined ? NaN : Number(facility.renewedMinute);
  const since = Number.isFinite(renewed) ? Number(worldMinutes) - renewed : null;
  const out = { today, prev, sinceRenewMinutes: since, ok: false, reason: null };
  const prevKnown = facility?.usesPrev24h !== null && facility?.usesPrev24h !== undefined && Number.isFinite(Number(facility.usesPrev24h));
  if (since === null || !prevKnown) return { ...out, reason: 'no_measurement' };
  if (since < Math.max(EXPANSION_COOLDOWN_MINUTES, EXPANSION_SUSTAIN_MINUTES)) return { ...out, reason: 'cooldown' };
  if (today < NEAR_CAPACITY || prev < NEAR_CAPACITY) return { ...out, reason: 'not_sustained' };
  return { ...out, ok: true };
}

// growth2: the same rule for a NEW building of a category that already has buildings (otherwise the
// throttled expansion is replaced by building copies): the category at >= NEAR_CAPACITY and every
// building at >= ALL_BUSY on BOTH of the last two world days, measured after the category's last
// capacity change (a building opened or expanded) at least EXPANSION_SUSTAIN_MINUTES ago.
// growth3: a commissioned build or expansion of the category that is still open (bidding/building) is a
// PENDING capacity change. While one is pending nothing more is added to the category, and its commission
// minute counts as a capacity change for the 48 h window (the later completion restarts it again).
export function categoryGrowthDecision(row, worldMinutes) {
  const known = (value) => value !== null && value !== undefined && Number.isFinite(Number(value));
  const changes = [row?.lastChangeMinute, row?.pendingSinceMinute].filter(known).map(Number);
  const out = { today: utilization(row?.uses24h, row?.capacity), prev: utilization(row?.usesPrev24h, row?.capacity),
    sinceChangeMinutes: known(row?.lastChangeMinute) ? Number(worldMinutes) - Math.max(...changes) : null, ok: false, reason: null,
    pending: Number(row?.pendingChanges) || 0 };
  if (out.pending > 0) return { ...out, reason: 'pending_change' };
  if (!known(row?.usesPrev24h) || !known(row?.minUtilizationPrev) || out.sinceChangeMinutes === null) return { ...out, reason: 'no_measurement' };
  if (out.sinceChangeMinutes < EXPANSION_SUSTAIN_MINUTES) return { ...out, reason: 'cooldown' };
  if (out.today < NEAR_CAPACITY || out.prev < NEAR_CAPACITY || Number(row.minUtilization) < ALL_BUSY
    || Number(row.minUtilizationPrev) < ALL_BUSY) return { ...out, reason: 'not_sustained' };
  return { ...out, ok: true };
}

// growth3: open (bidding/building) builds and expansions per demand category. Pure.
// open: [{ workType, buildingType, targetWorkId, commissionedMinute }]; facilities resolve an expansion
// without a stored building type through its target. Repairs are not capacity changes.
export function pendingCapacityChanges(open = [], facilities = []) {
  const typeOfTarget = new Map(facilities.map((facility) => [facility.workId, facility.type]));
  const out = {};
  for (const work of open) {
    const workType = work.workType || 'build';
    if (workType !== 'build' && workType !== 'expand') continue;
    const type = work.buildingType || (work.targetWorkId ? typeOfTarget.get(work.targetWorkId) : null) || work.kind;
    const category = categoryOf(type);
    if (!category) continue;
    const minute = Number(work.commissionedMinute);
    const entry = out[category] || (out[category] = { count: 0, sinceMinute: null, works: [] });
    entry.count += 1;
    if (Number.isFinite(minute)) entry.sinceMinute = entry.sinceMinute === null ? minute : Math.max(entry.sinceMinute, minute);
    entry.works.push({ workType, buildingType: type, targetWorkId: work.targetWorkId || null, commissionedMinute: Number.isFinite(minute) ? minute : null });
  }
  return out;
}

// ---- growth2: reachability --------------------------------------------------------------------------
// New buildings go only where residents actually go: a district needs measured resident traffic
// (visits in the demand window), and the slot must be within REACH_MAX_WALK_MINUTES of the home or
// workplace of at least REACH_RESIDENT_SHARE of the residents. Among reachable slots the one closest
// (mean walk) to where the category's demand was measured wins. No reachable slot -> nothing is built.
export const REACH_MIN_TRAFFIC = 8;            // visits per demand window in the district
export const REACH_MAX_WALK_MINUTES = 18;      // one way, same formula as the engine (3 + 10 x distance)
export const REACH_RESIDENT_SHARE = 0.5;
export const DISTRICT_MIN_TRAFFIC = 10;        // the newest district must be visited before another opens
export const REACH_DEMAND_SHARE = 0.25;        // >= 25% of the category's measured sessions within reach of the slot
export function walkMinutesBetween(a, b) {
  if (!a || !b) return 32;
  return Math.max(3, Math.min(32, Math.round(3 + Math.hypot(Number(a.x) - Number(b.x), Number(a.z) - Number(b.z)) * 10)));
}
const nearTaken = (position, taken) => taken.some((other) => Math.hypot(Number(other.x) - position.x, Number(other.z) - position.z) < 0.12);
// reach: { districtTraffic: {d: {visits, residents}}, anchors: [{home:{x,z}, work:{x,z}|null}],
//          points: {category: [{x,z}], all: [{x,z}]}, taken: [{x,z}] }
export function choosePlacement({ category = 'all', reach = null, district = null, newestDistrict = 1, latentMin = 0,
  demandShare = REACH_DEMAND_SHARE } = {}) {
  if (!reach) return { ok: false, reason: 'no reach measurement' };
  const districts = district ? [Math.max(1, Number(district))]
    : Array.from({ length: Math.max(1, Number(newestDistrict) || 1) }, (_, i) => i + 1);
  const anchors = reach.anchors || [];
  const needResidents = Math.max(1, Math.ceil(anchors.length * REACH_RESIDENT_SHARE));
  const own = Boolean(reach.points?.[category]?.length);
  const points = (own ? reach.points[category] : reach.points?.all) || [];
  const taken = reach.taken || [];
  let best = null; const rejected = [];
  for (const d of districts) {
    const traffic = reach.districtTraffic?.[d] || { visits: 0, residents: 0 };
    if ((Number(traffic.visits) || 0) < REACH_MIN_TRAFFIC) { rejected.push(`District ${d}: ${traffic.visits || 0} visits`); continue; }
    const slots = 10 + 2 * d;
    for (let index = 0; index < slots * 2; index += 1) {
      const position = growthPosition(d, index);
      if (nearTaken(position, taken)) continue;
      const within = anchors.filter((anchor) => Math.min(walkMinutesBetween(anchor.home, position),
        anchor.work ? walkMinutesBetween(anchor.work, position) : 99) <= REACH_MAX_WALK_MINUTES).length;
      if (within < needResidents) continue;
      const near = points.filter((point) => walkMinutesBetween(point, position) <= REACH_MAX_WALK_MINUTES).length;
      if (latentMin > 0 && (!own || near < latentMin)) continue;
      // The slot must also serve where the demand is: a share of the category's measured sessions in reach.
      if (own && demandShare > 0 && near < Math.ceil(points.length * demandShare)) continue;
      const meanWalk = points.length ? points.reduce((sum, point) => sum + walkMinutesBetween(point, position), 0) / points.length
        : anchors.reduce((sum, anchor) => sum + walkMinutesBetween(anchor.home, position), 0) / Math.max(1, anchors.length);
      const score = meanWalk - near * 0.01;
      if (!best || score < best.score - 1e-9) best = { score, district: d, index, position, within, near, meanWalk, traffic };
    }
  }
  if (!best) return { ok: false, reason: `no reachable slot (need ${REACH_MIN_TRAFFIC}+ visits in the district and ${needResidents} of ${anchors.length} residents within ${REACH_MAX_WALK_MINUTES} walking minutes`
    + `${latentMin ? `, ${latentMin}+ ${category} demand nearby` : ''})${rejected.length ? `; ${rejected.join(', ')}` : ''}` };
  return { ok: true, district: best.district, position: { ...best.position }, residentsWithin: best.within, residents: anchors.length,
    demandNear: best.near, meanWalkMinutes: Math.round(best.meanWalk * 10) / 10, districtVisits: Number(best.traffic.visits) || 0,
    text: `placed in District ${best.district}: ${best.traffic.visits} resident visits there in 24 h; ${best.within}/${anchors.length} residents live or work within ${REACH_MAX_WALK_MINUTES} walking min`
      + `${points.length ? `; ${best.near} ${own ? `${category} sessions` : 'resident visits'} measured within reach (mean walk ${Math.round(best.meanWalk)} min)` : ''}.` };
}
