import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../client.js';

// chainfix1 kill switch: MIRRORTERRA_CHAIN_FIX=off (env, or the same tickfix-flags.json the budget gateway
// reads; the file wins over the env and is re-read at most every 15 s, no restart) restores the old
// tick/worker candidate matching and the old budget-deferral scheduling exactly.
export const CHAIN_FIX_KEY = 'MIRRORTERRA_CHAIN_FIX';
const FLAG_OFF = /^(off|0|false|disabled|no)$/i;
const FLAG_RELOAD_MS = 15_000;

export function createChainFixFlags({ env = process.env, file = null, now = () => Date.now() } = {}) {
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
          && ['string', 'number', 'boolean'].includes(typeof parsed[CHAIN_FIX_KEY])) value = String(parsed[CHAIN_FIX_KEY]);
    } catch { /* missing or unreadable file = no override */ }
    cache = { at: t, value, file: target };
    return value;
  }
  return {
    enabled() {
      let value = fromFile();
      if (value === undefined && env && env[CHAIN_FIX_KEY] !== undefined && env[CHAIN_FIX_KEY] !== '') value = String(env[CHAIN_FIX_KEY]);
      return value === undefined ? true : !FLAG_OFF.test(String(value).trim());
    }
  };
}

const sharedFlags = createChainFixFlags();
export function chainFixEnabled() {
  try { return sharedFlags.enabled(); } catch { return true; }
}
