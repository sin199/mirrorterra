import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../client.js';

// ctxfix2 kill switch: MIRRORTERRA_CURSOR_FIX=off (env, or the same tickfix-flags.json the budget gateway,
// chainfix and ctxfix1 read; the file wins over the env and is re-read at most every 15 s, no restart)
// restores the ctxfix1 behaviour exactly: no escalation of a step whose grounding keeps getting blocked,
// no typed-snapshot target match in grounding, and the oldest-first context delta (no backlog skip).
export const CURSOR_FIX_KEY = 'MIRRORTERRA_CURSOR_FIX';
const FLAG_OFF = /^(off|0|false|disabled|no)$/i;
const FLAG_RELOAD_MS = 15_000;

export function createCursorFixFlags({ env = process.env, file = null, now = () => Date.now() } = {}) {
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
          && ['string', 'number', 'boolean'].includes(typeof parsed[CURSOR_FIX_KEY])) {
        value = String(parsed[CURSOR_FIX_KEY]);
      }
    } catch { /* missing or unreadable file = no override */ }
    cache = { at: t, value, file: target };
    return value;
  }
  return {
    enabled() {
      let value = fromFile();
      if (value === undefined && env && env[CURSOR_FIX_KEY] !== undefined && env[CURSOR_FIX_KEY] !== '') {
        value = String(env[CURSOR_FIX_KEY]);
      }
      return value === undefined ? true : !FLAG_OFF.test(String(value).trim());
    }
  };
}

const sharedFlags = createCursorFixFlags();
export function cursorFixEnabled() {
  try { return sharedFlags.enabled(); } catch { return true; }
}
