import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../client.js';

// ctxfix1 kill switch: MIRRORTERRA_CONTEXT_READ_FIX=off (env, or the same tickfix-flags.json the budget
// gateway and chainfix read; the file wins over the env and is re-read at most every 15 s, no restart)
// restores the old readCognitionContext exactly (8 s statement timeout, world-events delta with a
// count(*) OVER() over every unseen event) and the old long provider_retry postponement on a timeout.
export const CONTEXT_READ_FIX_KEY = 'MIRRORTERRA_CONTEXT_READ_FIX';
const FLAG_OFF = /^(off|0|false|disabled|no)$/i;
const FLAG_RELOAD_MS = 15_000;

export function createContextReadFixFlags({ env = process.env, file = null, now = () => Date.now() } = {}) {
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
          && ['string', 'number', 'boolean'].includes(typeof parsed[CONTEXT_READ_FIX_KEY])) {
        value = String(parsed[CONTEXT_READ_FIX_KEY]);
      }
    } catch { /* missing or unreadable file = no override */ }
    cache = { at: t, value, file: target };
    return value;
  }
  return {
    enabled() {
      let value = fromFile();
      if (value === undefined && env && env[CONTEXT_READ_FIX_KEY] !== undefined && env[CONTEXT_READ_FIX_KEY] !== '') {
        value = String(env[CONTEXT_READ_FIX_KEY]);
      }
      return value === undefined ? true : !FLAG_OFF.test(String(value).trim());
    }
  };
}

const sharedFlags = createContextReadFixFlags();
export function contextReadFixEnabled() {
  try { return sharedFlags.enabled(); } catch { return true; }
}
