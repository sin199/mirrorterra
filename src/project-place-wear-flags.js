import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './agent-runtime/client.js';

// placewear1 kill switch: MIRRORTERRA_PROJECT_PLACE_WEAR=off (env, or /var/lib/synterra/.synterra/tickfix-flags.json;
// the file wins over the env and is re-read at most every 15 s, no restart) turns off wear, effect scaling
// and repair tenders for places built by resident projects (src/project-place-wear.js) and restores the
// ctxfix2 behaviour. Repair contracts already awarded before the switch was turned off still finish (their
// price is already escrowed by the treasury).
export const PROJECT_PLACE_WEAR_KEY = 'MIRRORTERRA_PROJECT_PLACE_WEAR';
const FLAG_OFF = /^(off|0|false|disabled|no)$/i;
const FLAG_RELOAD_MS = 15_000;

export function createProjectPlaceWearFlags({ env = process.env, file = null, now = () => Date.now() } = {}) {
  let cache = { at: -Infinity, value: undefined, file: null };
  function fromFile() {
    const target = file || env?.MIRRORTERRA_TICKFIX_FLAGS_FILE || path.join(STATE_DIR, 'tickfix-flags.json');
    const t = now();
    if (cache.file === target && t - cache.at < FLAG_RELOAD_MS) return cache.value;
    let value;
    try {
      statSync(target);
      const parsed = JSON.parse(readFileSync(target, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          && ['string', 'number', 'boolean'].includes(typeof parsed[PROJECT_PLACE_WEAR_KEY])) {
        value = String(parsed[PROJECT_PLACE_WEAR_KEY]);
      }
    } catch { /* missing or unreadable file = no override */ }
    cache = { at: t, value, file: target };
    return value;
  }
  return {
    enabled() {
      let value = fromFile();
      if (value === undefined && env && env[PROJECT_PLACE_WEAR_KEY] !== undefined && env[PROJECT_PLACE_WEAR_KEY] !== '') {
        value = String(env[PROJECT_PLACE_WEAR_KEY]);
      }
      return value === undefined ? true : !FLAG_OFF.test(String(value).trim());
    }
  };
}

const sharedFlags = createProjectPlaceWearFlags();
// env: pass a custom env object (tests, explicit callers); the process env uses the shared cached reader.
export function projectPlaceWearEnabled(env = process.env) {
  try {
    if (env && env !== process.env) return createProjectPlaceWearFlags({ env }).enabled();
    return sharedFlags.enabled();
  } catch { return true; }
}

// drivefix1: read a numeric/text setting (e.g. MIRRORTERRA_PROJECT_PLACE_REPAIR_MIN_USES) the same way as the switch:
// tickfix-flags.json wins over env, re-read at most every 15 s. Returns undefined when unset.
const settingCache = new Map();
export function projectPlaceWearSetting(key, env = process.env, { file = null, now = () => Date.now() } = {}) {
  const target = file || env?.MIRRORTERRA_TICKFIX_FLAGS_FILE || path.join(STATE_DIR, 'tickfix-flags.json');
  const shared = env === process.env && !file;
  const t = now();
  let fileValue;
  const cached = shared ? settingCache.get(key) : null;
  if (cached && cached.file === target && t - cached.at < FLAG_RELOAD_MS) fileValue = cached.value;
  else {
    try {
      const parsed = JSON.parse(readFileSync(target, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          && ['string', 'number', 'boolean'].includes(typeof parsed[key])) fileValue = String(parsed[key]);
    } catch { /* missing or unreadable file = no override */ }
    if (shared) settingCache.set(key, { at: t, value: fileValue, file: target });
  }
  if (fileValue !== undefined) return fileValue;
  if (env && env[key] !== undefined && env[key] !== '') return String(env[key]);
  return undefined;
}
