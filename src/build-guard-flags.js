import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './agent-runtime/client.js';

// ctxfix2 kill switch: MIRRORTERRA_BUILD_GUARD_FIX=off (env, or /var/lib/synterra/.synterra/tickfix-flags.json;
// the file wins over the env and is re-read at most every 15 s, no restart) removes the town-growth guard
// on project-built places (world-projects.js) and restores the old "congestion alone decides" behaviour.
export const BUILD_GUARD_FIX_KEY = 'MIRRORTERRA_BUILD_GUARD_FIX';
const FLAG_OFF = /^(off|0|false|disabled|no)$/i;
const FLAG_RELOAD_MS = 15_000;

export function createBuildGuardFixFlags({ env = process.env, file = null, now = () => Date.now() } = {}) {
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
          && ['string', 'number', 'boolean'].includes(typeof parsed[BUILD_GUARD_FIX_KEY])) {
        value = String(parsed[BUILD_GUARD_FIX_KEY]);
      }
    } catch { /* missing or unreadable file = no override */ }
    cache = { at: t, value, file: target };
    return value;
  }
  return {
    enabled() {
      let value = fromFile();
      if (value === undefined && env && env[BUILD_GUARD_FIX_KEY] !== undefined && env[BUILD_GUARD_FIX_KEY] !== '') {
        value = String(env[BUILD_GUARD_FIX_KEY]);
      }
      return value === undefined ? true : !FLAG_OFF.test(String(value).trim());
    }
  };
}

const sharedFlags = createBuildGuardFixFlags();
export function buildGuardFixEnabled() {
  try { return sharedFlags.enabled(); } catch { return true; }
}
