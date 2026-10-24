// drivefix1 survival (MIRRORTERRA_SURVIVAL_EARLY, default on; off = ctxfix2-perf1 behaviour exactly).
//
// Before: a resident ate only when food < 8 (else rested when energy < 12), and only at a NEW decision; a
// walk or an action already under way ran to its end. Prod 24 h (Codex audit): low reading -> walking to
// eat median 34 s / max 59 s, -> food recovered median 109 s / max 147 s; one Food=0 (MirrorTerra-04 woke
// from sleep at 0: sleep costs ~1 food per world hour plus 2 on waking, so going to bed under ~10 food
// wakes at 0).
//
// Now, small and only around the existing lines:
//   1. Emergency lines unchanged (food < 8 eat; energy < 12 rest). Exception: energy < 12 with food under
//      the early line eats first (one 8 s meal, +45 food) so nobody goes to bed hungry.
//   2. Early line (FOOD_EARLY 20 / ENERGY_EARLY 20): at a new decision, eat (resp. rest) first. A meal
//      gives +45 food, so this is one extra-early meal, not more meals (food falls 2 per waking world
//      hour; a resident still eats about once per world day). An eat/rest at the current place wins
//      ("on the way"), else the best-scored one.
//   3. Pre-emption at the next interruptible point: a resident asleep whose food drops under the
//      emergency line wakes (sleep ends now, normal completion), and a resident ARRIVING for a routine
//      action (work / learn / socialize / cooperate / rest, no cognition plan, no initiative target) while
//      under an emergency line it does not address skips that action and decides again at once.
//   4. Waking with food under the early line: rule 2 makes eating the first thing.
export const FOOD_EMERGENCY = 8;
export const ENERGY_EMERGENCY = 12;
export const FOOD_EARLY = 20;
export const ENERGY_EARLY = 20;
export const PREEMPTIBLE_ON_ARRIVAL = Object.freeze(['work', 'learn', 'socialize', 'cooperate', 'rest']);

const finite = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

function pick(candidates, action, location) {
  const list = (candidates || []).filter((candidate) => candidate?.action === action);
  if (!list.length) return null;
  const here = list.filter((candidate) => !candidate.targetLocation || candidate.targetLocation === location);
  const pool = here.length ? here : list;
  return [...pool].sort((a, b) => finite(b.score) - finite(a.score))[0];
}

// Pure. Returns { candidate, layer, reason } or null. enabled=false reproduces the old expression exactly.
export function chooseSurvivalAction(agent, candidates = [], { enabled = true } = {}) {
  const food = finite(agent?.food, 100), energy = finite(agent?.energy, 100);
  if (!enabled) {
    const candidate = food < FOOD_EMERGENCY
      ? candidates.find((item) => item.action === 'eat')
      : energy < ENERGY_EMERGENCY ? candidates.find((item) => item.action === 'rest') : null;
    return candidate ? { candidate, layer: 'survival_interruption', reason: food < FOOD_EMERGENCY ? 'food_emergency' : 'energy_emergency' } : null;
  }
  if (food < FOOD_EMERGENCY) {
    const candidate = candidates.find((item) => item.action === 'eat');
    if (candidate) return { candidate, layer: 'survival_interruption', reason: 'food_emergency' };
  }
  if (energy < ENERGY_EMERGENCY) {
    if (food < FOOD_EARLY) {
      const meal = pick(candidates, 'eat', agent?.location);
      if (meal) return { candidate: meal, layer: 'survival_interruption', reason: 'meal_before_rest' };
    }
    const candidate = candidates.find((item) => item.action === 'rest');
    if (candidate) return { candidate, layer: 'survival_interruption', reason: 'energy_emergency' };
  }
  if (food < FOOD_EARLY) {
    const candidate = pick(candidates, 'eat', agent?.location);
    if (candidate) return { candidate, layer: 'survival_early', reason: 'food_early' };
  }
  if (energy < ENERGY_EARLY) {
    const candidate = pick(candidates, 'rest', agent?.location);
    if (candidate) return { candidate, layer: 'survival_early', reason: 'energy_early' };
  }
  return null;
}

// Pure: should a resident arriving for `plannedAction` skip it to address an emergency first?
export function arrivalPreemption({ food, energy, plannedAction, plannedContext = {} }) {
  const action = String(plannedAction || '');
  if (!PREEMPTIBLE_ON_ARRIVAL.includes(action)) return null;
  const context = plannedContext && typeof plannedContext === 'object' ? plannedContext : {};
  if (Object.keys(context).length) return null; // a plan step or an initiative target: never dropped here
  if (finite(food, 100) < FOOD_EMERGENCY) return { reason: 'food_emergency' };
  if (finite(energy, 100) < ENERGY_EMERGENCY && action !== 'rest') return { reason: 'energy_emergency' };
  return null;
}
