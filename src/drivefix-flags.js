import { readFileSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './agent-runtime/client.js';

// drivefix1 kill switches (user decision 2026-10-24 10:06 CST). Each is on by default; 'off' (env, or
// /var/lib/synterra/.synterra/tickfix-flags.json, the file wins over env and is re-read at most every 15 s,
// no restart) restores the ctxfix2-perf1 behaviour of that part:
//   MIRRORTERRA_DRIVE_DEMAND_OUTPUT  skill outputs pick their drive by what other residents currently want
//   MIRRORTERRA_SURVIVAL_EARLY       early food/energy line, pre-sleep meal, emergency pre-emption
//   MIRRORTERRA_STALE_TARGET_FIX     no project_join / project_contribute on projects that in-flight actions close
export const DRIVE_DEMAND_OUTPUT_KEY = 'MIRRORTERRA_DRIVE_DEMAND_OUTPUT';
export const SURVIVAL_EARLY_KEY = 'MIRRORTERRA_SURVIVAL_EARLY';
export const STALE_TARGET_FIX_KEY = 'MIRRORTERRA_STALE_TARGET_FIX';
export const DRIVEFIX_KEYS = Object.freeze([DRIVE_DEMAND_OUTPUT_KEY, SURVIVAL_EARLY_KEY, STALE_TARGET_FIX_KEY]);
const FLAG_OFF = /^(off|0|false|disabled|no)$/i;
const FLAG_RELOAD_MS = 15_000;

export function createDrivefixFlags({ env = process.env, file = null, now = () => Date.now() } = {}) {
  let cache = { at: -Infinity, parsed: null, file: null };
  function fileFlags() {
    const target = file || env?.MIRRORTERRA_TICKFIX_FLAGS_FILE || path.join(STATE_DIR, 'tickfix-flags.json');
    const t = now();
    if (cache.file === target && t - cache.at < FLAG_RELOAD_MS) return cache.parsed;
    let parsed = null;
    try {
      const value = JSON.parse(readFileSync(target, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value;
    } catch { /* missing or unreadable file = no override */ }
    cache = { at: t, parsed, file: target };
    return parsed;
  }
  return {
    enabled(key) {
      let value;
      const parsed = fileFlags();
      if (parsed && ['string', 'number', 'boolean'].includes(typeof parsed[key])) value = String(parsed[key]);
      if (value === undefined && env && env[key] !== undefined && env[key] !== '') value = String(env[key]);
      return value === undefined ? true : !FLAG_OFF.test(String(value).trim());
    }
  };
}

const shared = createDrivefixFlags();
function enabled(key, env) {
  try {
    if (env && env !== process.env) return createDrivefixFlags({ env }).enabled(key);
    return shared.enabled(key);
  } catch { return true; }
}
export const driveDemandOutputEnabled = (env = process.env) => enabled(DRIVE_DEMAND_OUTPUT_KEY, env);
export const survivalEarlyEnabled = (env = process.env) => enabled(SURVIVAL_EARLY_KEY, env);
export const staleTargetFixEnabled = (env = process.env) => enabled(STALE_TARGET_FIX_KEY, env);
