// gambit1: switches for the Qianmen resident-gambit phases.
//   P0 MIRRORTERRA_CAPABILITY_HONESTY  (default on)  honest labels on the capability-proposal page
//   P1 MIRRORTERRA_QIANMEN_COUNCIL     (default off) personal stakes + Qianmen tools + claims in council calls
//   P2 MIRRORTERRA_GAMBITS             (default off) resident gambit engine (worker outside the tick)
//   P3 MIRRORTERRA_CAPABILITY_COUNCIL  (default off) capability proposals/votes + proposer royalty
//   P4 MIRRORTERRA_GAMBIT_COGNITION    (default off) gambit summary in open-cognition context
// Values come from the process env, and can be overridden WITHOUT a restart by a JSON file
// (MIRRORTERRA_GAMBIT_FLAGS_FILE, default <state dir>/gambit-flags.json), e.g. {"MIRRORTERRA_GAMBITS":"on"}.
// The file is re-read at most every 15 s; a missing or invalid file means env only.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './agent-runtime/client.js';

export const FLAG_DEFAULTS = Object.freeze({
  MIRRORTERRA_CAPABILITY_HONESTY: 'on',
  MIRRORTERRA_QIANMEN_COUNCIL: 'off',
  MIRRORTERRA_GAMBITS: 'off',
  MIRRORTERRA_CAPABILITY_COUNCIL: 'off',
  MIRRORTERRA_GAMBIT_COGNITION: 'off'
});
export const TUNABLE_DEFAULTS = Object.freeze({
  MIRRORTERRA_GAMBIT_INTERVAL_MS: 20_000,             // worker pacing (compute), not a world rule
  MIRRORTERRA_GAMBIT_PROMPT_EVERY_WORLD_MINUTES: 1_440, // how often each resident is asked "start a gambit?"
  MIRRORTERRA_GAMBIT_VERIFY_DELAY_MINUTES: 30,        // a check takes world time
  MIRRORTERRA_GAMBIT_VERIFY_FEE_RAW: 10_000,          // 0.01 SYNC, verifier -> speaker, only when the claim was true
  MIRRORTERRA_GAMBIT_RESPONSE_TTL_MINUTES: 360,       // an unanswered gambit lapses (void) after this
  MIRRORTERRA_CAPABILITY_ROYALTY_RAW: 2_000,          // 0.002 SYNC per use, user -> proposer
  MIRRORTERRA_CAPABILITY_PROPOSE_EVERY_WORLD_MINUTES: 1_440
});
const OFF = /^(off|0|false|disabled|no)$/i;
const ON = /^(on|1|true|enabled|yes)$/i;
const RELOAD_MS = 15_000;

export function defaultFlagFile(env = process.env) {
  if (env?.MIRRORTERRA_GAMBIT_FLAGS_FILE) return env.MIRRORTERRA_GAMBIT_FLAGS_FILE;
  return path.join(STATE_DIR, 'gambit-flags.json');
}

export function createFlagReader({ file = null, now = () => Date.now() } = {}) {
  let cache = { at: -Infinity, mtime: null, values: {} , file: null };
  function overrides(env) {
    const target = file || defaultFlagFile(env);
    const t = now();
    if (cache.file === target && t - cache.at < RELOAD_MS) return cache.values;
    let values = {}, mtime = null;
    try {
      const stat = statSync(target);
      mtime = `${stat.mtimeMs}:${stat.size}`;
      if (cache.file === target && cache.mtime === mtime) values = cache.values;
      else {
        const parsed = JSON.parse(readFileSync(target, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if ((key in FLAG_DEFAULTS || key in TUNABLE_DEFAULTS) && ['string', 'number', 'boolean'].includes(typeof value)) {
              values[key] = String(value);
            }
          }
        }
      }
    } catch { values = {}; mtime = null; }
    cache = { at: t, mtime, values, file: target };
    return values;
  }
  function raw(key, env = process.env) {
    const file = overrides(env);
    if (Object.hasOwn(file, key)) return file[key];
    if (env && env[key] !== undefined && env[key] !== '') return String(env[key]);
    return key in FLAG_DEFAULTS ? FLAG_DEFAULTS[key] : key in TUNABLE_DEFAULTS ? String(TUNABLE_DEFAULTS[key]) : undefined;
  }
  function enabled(key, env = process.env) {
    const value = String(raw(key, env) ?? '').trim();
    if (OFF.test(value)) return false;
    if (ON.test(value)) return true;
    return !OFF.test(FLAG_DEFAULTS[key] || 'off');
  }
  function number(key, env = process.env) {
    const value = Number(raw(key, env));
    return Number.isFinite(value) && value >= 0 ? value : TUNABLE_DEFAULTS[key];
  }
  function snapshot(env = process.env) {
    return { ...Object.fromEntries(Object.keys(FLAG_DEFAULTS).map((key) => [key, enabled(key, env)])),
      overrideFile: Object.keys(overrides(env)).length > 0 };
  }
  return { raw, enabled, number, snapshot, reset: () => { cache = { at: -Infinity, mtime: null, values: {}, file: null }; } };
}

const shared = createFlagReader();
export const gambitFlag = (key, env = process.env) => shared.enabled(key, env);
export const gambitNumber = (key, env = process.env) => shared.number(key, env);
export const gambitFlagSnapshot = (env = process.env) => shared.snapshot(env);
export const capabilityHonestyEnabled = (env = process.env) => shared.enabled('MIRRORTERRA_CAPABILITY_HONESTY', env);
export const qianmenCouncilEnabled = (env = process.env) => shared.enabled('MIRRORTERRA_QIANMEN_COUNCIL', env);
export const gambitsEnabled = (env = process.env) => shared.enabled('MIRRORTERRA_GAMBITS', env);
export const capabilityCouncilEnabled = (env = process.env) => shared.enabled('MIRRORTERRA_CAPABILITY_COUNCIL', env);
export const gambitCognitionEnabled = (env = process.env) => shared.enabled('MIRRORTERRA_GAMBIT_COGNITION', env);
