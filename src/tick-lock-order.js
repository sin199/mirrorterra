// tickfix1: one lock order for the world tick and every writer outside it.
//
// Root cause (prod 10-22/23, PG log): the tick locks every world_members row FOR UPDATE early in its
// transaction and later updates world_agent_cognition_state / takes the sync-reward advisory lock.
// Writers outside the tick did the opposite: they first locked a cognition-state row (or the advisory
// lock) and only then touched world_members through a foreign-key check (FOR KEY SHARE), so each
// side waited for the other -> "deadlock detected", and PostgreSQL usually aborted the whole tick.
//
// The rule from here on: world_members first, in agent_id order, then everything else.
//   * the tick pre-locks its residents (world_members + world_agent_states) ORDER BY agent_id right
//     after it locks the clock row, so its member locks are always taken in one order;
//   * writers outside the tick take FOR KEY SHARE on the member rows they will reference before they
//     lock anything else (they simply wait for a running tick to commit, holding nothing);
//   * a tick that still loses a deadlock is retried at the next scheduler beat, at most
//     MAX_FAST_DEADLOCK_RETRIES times in a row, before the normal backoff applies (the failed tick
//     was rolled back as a whole, so a retry is idempotent).
//
// Kill switch, no restart needed: MIRRORTERRA_TICK_LOCK_ORDER=off in the JSON file
// (MIRRORTERRA_TICKFIX_FLAGS_FILE, default <state dir>/tickfix-flags.json, re-read at most every 15 s)
// or in the process env. Off = exactly the old behaviour (no pre-locks, no fast retry).
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './agent-runtime/client.js';

export const TICK_LOCK_ORDER_KEY = 'MIRRORTERRA_TICK_LOCK_ORDER';
export const MEMBER_LOCK_WAIT_KEY = 'MIRRORTERRA_TICKFIX_MEMBER_LOCK_WAIT_MS';
export const DEFAULT_MEMBER_LOCK_WAIT_MS = 120_000;
export const MAX_FAST_DEADLOCK_RETRIES = 3;
const OFF = /^(off|0|false|disabled|no)$/i;
const RELOAD_MS = 15_000;

export function defaultTickfixFlagFile(env = process.env) {
  if (env?.MIRRORTERRA_TICKFIX_FLAGS_FILE) return env.MIRRORTERRA_TICKFIX_FLAGS_FILE;
  return path.join(STATE_DIR, 'tickfix-flags.json');
}

export function createTickLockFlagReader({ file = null, now = () => Date.now() } = {}) {
  let cache = { at: -Infinity, mtime: null, values: {}, file: null };
  function overrides(env) {
    const target = file || defaultTickfixFlagFile(env);
    const t = now();
    if (cache.file === target && t - cache.at < RELOAD_MS) return cache.values;
    let values = {};
    let mtime = null;
    try {
      const stat = statSync(target);
      mtime = `${stat.mtimeMs}:${stat.size}`;
      if (cache.file === target && cache.mtime === mtime) values = cache.values;
      else {
        const parsed = JSON.parse(readFileSync(target, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const key of [TICK_LOCK_ORDER_KEY, MEMBER_LOCK_WAIT_KEY]) {
            if (['string', 'number', 'boolean'].includes(typeof parsed[key])) values[key] = String(parsed[key]);
          }
        }
      }
    } catch { values = {}; mtime = null; }
    cache = { at: t, mtime, values, file: target };
    return values;
  }
  function raw(key, env = process.env) {
    const fromFile = overrides(env);
    if (Object.hasOwn(fromFile, key)) return fromFile[key];
    if (env && env[key] !== undefined && env[key] !== '') return String(env[key]);
    return undefined;
  }
  function enabled(env = process.env) {
    const value = raw(TICK_LOCK_ORDER_KEY, env);
    return value === undefined ? true : !OFF.test(String(value).trim());
  }
  function memberLockWaitMs(env = process.env) {
    const value = Number(raw(MEMBER_LOCK_WAIT_KEY, env));
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_MEMBER_LOCK_WAIT_MS;
    return Math.min(600_000, Math.max(1_000, Math.trunc(value)));
  }
  return { enabled, memberLockWaitMs, reset: () => { cache = { at: -Infinity, mtime: null, values: {}, file: null }; } };
}

const shared = createTickLockFlagReader();
export const tickLockOrderEnabled = (env = process.env) => shared.enabled(env);
export const memberLockWaitMs = (env = process.env) => shared.memberLockWaitMs(env);

export function isDeadlockError(error) {
  return String(error?.code || '') === '40P01';
}

// The tick's own member pre-lock (same rows and lock strength as its later FOR UPDATE OF m,s reads,
// but always in agent_id order). Rows already held are re-locked for free later in the tick.
export const TICK_MEMBER_PRELOCK_SQL = `SELECT m.agent_id FROM world_members m
  JOIN world_agent_states s ON s.world_id=m.world_id AND s.agent_id=m.agent_id
  WHERE m.world_id=$1 ORDER BY m.agent_id FOR UPDATE OF m,s`;

export async function preLockTickResidents(client, worldId, { env = process.env } = {}) {
  if (!tickLockOrderEnabled(env)) return false;
  await client.query(TICK_MEMBER_PRELOCK_SQL, [worldId]);
  return true;
}

// For writers outside the tick, inside their own transaction and BEFORE any other row/advisory lock.
// agentIds = null locks every member of the world (in agent_id order); otherwise only those rows.
// The wait is bounded by a local lock_timeout; afterwards the caller's own timeouts are restored.
export const MEMBER_KEY_SHARE_ALL_SQL = `SELECT agent_id FROM world_members WHERE world_id=$1
  ORDER BY agent_id FOR KEY SHARE`;
export const MEMBER_KEY_SHARE_SOME_SQL = `SELECT agent_id FROM world_members WHERE world_id=$1
  AND agent_id=ANY($2::uuid[]) ORDER BY agent_id FOR KEY SHARE`;

export async function lockMembersFirst(client, worldId, { agentIds = null, env = process.env,
  restoreLockTimeout = '0', restoreStatementTimeout = null } = {}) {
  if (!tickLockOrderEnabled(env)) return false;
  const ids = agentIds === null ? null : [...new Set(agentIds.filter(Boolean).map(String))].sort();
  if (ids && !ids.length) return false;
  const waitMs = memberLockWaitMs(env);
  await client.query(`SET LOCAL lock_timeout = '${waitMs}ms'`);
  if (restoreStatementTimeout !== null) await client.query(`SET LOCAL statement_timeout = '${waitMs + 5_000}ms'`);
  if (ids) await client.query(MEMBER_KEY_SHARE_SOME_SQL, [worldId, ids]);
  else await client.query(MEMBER_KEY_SHARE_ALL_SQL, [worldId]);
  await client.query(`SET LOCAL lock_timeout = '${String(restoreLockTimeout).replace(/[^0-9a-z]/gi, '')}'`);
  if (restoreStatementTimeout !== null) {
    await client.query(`SET LOCAL statement_timeout = '${String(restoreStatementTimeout).replace(/[^0-9a-z]/gi, '')}'`);
  }
  return true;
}

// Fast retry bookkeeping for the tick (pure; the engine owns the counter).
export function nextTickRetryDelayMs({ error, consecutiveDeadlocks, errorCount, enabled }) {
  if (enabled && isDeadlockError(error) && consecutiveDeadlocks <= MAX_FAST_DEADLOCK_RETRIES) return 0;
  return Math.min(30_000, 1_000 * 2 ** Math.min(errorCount, 5));
}
