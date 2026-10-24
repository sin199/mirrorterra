import { createDrivefixFlags } from './drivefix-flags.js';

// island1 kill switches (ferry + neighbouring resort island, user decisions 2026-10-24 14:13 CST).
// Same source as the drivefix1 switches: env, or /var/lib/synterra/.synterra/tickfix-flags.json (the file wins
// over env, re-read at most every 15 s, no restart). Each switch is on by default; 'off' disables it.
//   MIRRORTERRA_FERRY_ISLAND          master. off = observer2 behaviour exactly: no island needs, no island
//                                     type overrides, no trips, no pier strolls, no map block, no extra queries.
//   MIRRORTERRA_FERRY_ISLAND_PIER     phase A: commission the main-shore pier from sustained beach use
//   MIRRORTERRA_FERRY_ISLAND_FERRY    phase B: commission the ferry from measured pier use
//   MIRRORTERRA_FERRY_ISLAND_RESORT   phase C: commission island buildings from measured crossings
//   MIRRORTERRA_FERRY_ISLAND_CRUISE   phase D: expand the ferry to a cruise ship after full sailings
//   MIRRORTERRA_FERRY_ISLAND_SAILINGS operation: residents book sailings (fares), cross, visit; pier strolls
// A phase switch only stops NEW commissions/bookings of that phase; buildings already built stay (nothing is
// ever deleted) and trips already booked complete normally.
export const FERRY_ISLAND_KEY = 'MIRRORTERRA_FERRY_ISLAND';
export const FERRY_ISLAND_PHASE_KEYS = Object.freeze({
  pier: 'MIRRORTERRA_FERRY_ISLAND_PIER',
  ferry: 'MIRRORTERRA_FERRY_ISLAND_FERRY',
  resort: 'MIRRORTERRA_FERRY_ISLAND_RESORT',
  cruise: 'MIRRORTERRA_FERRY_ISLAND_CRUISE',
  sailings: 'MIRRORTERRA_FERRY_ISLAND_SAILINGS'
});
export const FERRY_ISLAND_KEYS = Object.freeze([FERRY_ISLAND_KEY, ...Object.values(FERRY_ISLAND_PHASE_KEYS)]);

const shared = createDrivefixFlags();
function enabled(key, env) {
  try {
    if (env && env !== process.env) return createDrivefixFlags({ env }).enabled(key);
    return shared.enabled(key);
  } catch { return false; }
}
export const ferryIslandEnabled = (env = process.env) => enabled(FERRY_ISLAND_KEY, env);
// A phase is on only when the master is on too.
export function ferryIslandPhaseEnabled(phase, env = process.env) {
  const key = FERRY_ISLAND_PHASE_KEYS[phase];
  return Boolean(key) && ferryIslandEnabled(env) && enabled(key, env);
}
// The full switch set at one moment (passed into the pure rules).
export function ferryIslandFlags(env = process.env) {
  const master = ferryIslandEnabled(env);
  const out = { master };
  for (const [phase, key] of Object.entries(FERRY_ISLAND_PHASE_KEYS)) out[phase] = master && enabled(key, env);
  return out;
}
export const FERRY_ISLAND_OFF = Object.freeze({ master: false, pier: false, ferry: false, resort: false, cruise: false, sailings: false });
