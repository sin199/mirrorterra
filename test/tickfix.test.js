// tickfix1: one lock order for the tick and the writers outside it, bounded fast retry, kill switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createTickLockFlagReader, nextTickRetryDelayMs, isDeadlockError, lockMembersFirst, preLockTickResidents,
  MAX_FAST_DEADLOCK_RETRIES, DEFAULT_MEMBER_LOCK_WAIT_MS, TICK_MEMBER_PRELOCK_SQL, MEMBER_KEY_SHARE_ALL_SQL
} from '../src/tick-lock-order.js';

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const hasGambit = existsSync(new URL('../src/gambit-deliberation.js', import.meta.url)); // modelab1 base has no gambit worker
const WORLD = '00000000-0000-4000-8000-000000000001';
const recorder = () => { const calls = []; return { calls, async query(sql, values) { calls.push({ sql, values }); return { rows: [], rowCount: 0 }; } }; };

test('flag reader: on by default, off via env or file, file wins, bad file falls back to env', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tickfix-'));
  const file = path.join(dir, 'tickfix-flags.json');
  let t = 0;
  const reader = createTickLockFlagReader({ file, now: () => t });
  assert.equal(reader.enabled({}), true);
  assert.equal(reader.enabled({ MIRRORTERRA_TICK_LOCK_ORDER: 'off' }), false);
  assert.equal(reader.enabled({ MIRRORTERRA_TICK_LOCK_ORDER: 'on' }), true);
  writeFileSync(file, JSON.stringify({ MIRRORTERRA_TICK_LOCK_ORDER: 'off' }));
  t += 16_000;
  assert.equal(reader.enabled({ MIRRORTERRA_TICK_LOCK_ORDER: 'on' }), false, 'file overrides env');
  writeFileSync(file, '{not json');
  t += 16_000;
  assert.equal(reader.enabled({ MIRRORTERRA_TICK_LOCK_ORDER: 'on' }), true);
  assert.equal(reader.enabled({}), true);
  assert.equal(reader.memberLockWaitMs({}), DEFAULT_MEMBER_LOCK_WAIT_MS);
  assert.equal(reader.memberLockWaitMs({ MIRRORTERRA_TICKFIX_MEMBER_LOCK_WAIT_MS: '5' }), 1_000);
  assert.equal(reader.memberLockWaitMs({ MIRRORTERRA_TICKFIX_MEMBER_LOCK_WAIT_MS: '99999999' }), 600_000);
  assert.equal(reader.memberLockWaitMs({ MIRRORTERRA_TICKFIX_MEMBER_LOCK_WAIT_MS: 'x' }), DEFAULT_MEMBER_LOCK_WAIT_MS);
});

test('retry: a deadlocked tick is retried at the next beat at most 3 times in a row, then normal backoff', () => {
  const deadlock = Object.assign(new Error('deadlock detected'), { code: '40P01' });
  const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  assert.equal(isDeadlockError(deadlock), true);
  assert.equal(isDeadlockError(timeout), false);
  for (let n = 1; n <= MAX_FAST_DEADLOCK_RETRIES; n += 1) {
    assert.equal(nextTickRetryDelayMs({ error: deadlock, consecutiveDeadlocks: n, errorCount: n, enabled: true }), 0);
  }
  assert.equal(nextTickRetryDelayMs({ error: deadlock, consecutiveDeadlocks: 4, errorCount: 4, enabled: true }), 16_000);
  assert.equal(nextTickRetryDelayMs({ error: deadlock, consecutiveDeadlocks: 1, errorCount: 1, enabled: false }), 2_000,
    'kill switch off = the old backoff');
  assert.equal(nextTickRetryDelayMs({ error: timeout, consecutiveDeadlocks: 0, errorCount: 1, enabled: true }), 2_000);
  assert.equal(nextTickRetryDelayMs({ error: timeout, consecutiveDeadlocks: 0, errorCount: 9, enabled: true }), 30_000);
});

test('lockMembersFirst: bounded wait, sorted unique rows, FOR KEY SHARE, caller timeouts restored; off = no query', async () => {
  const db = recorder();
  const env = { MIRRORTERRA_TICKFIX_FLAGS_FILE: '/nonexistent/tickfix.json' };
  assert.equal(await lockMembersFirst(db, WORLD, { agentIds: ['b', 'a', 'b', null], env }), true);
  assert.deepEqual(db.calls.map((call) => call.sql.replace(/\s+/g, ' ').trim()), [
    `SET LOCAL lock_timeout = '${DEFAULT_MEMBER_LOCK_WAIT_MS}ms'`,
    'SELECT agent_id FROM world_members WHERE world_id=$1 AND agent_id=ANY($2::uuid[]) ORDER BY agent_id FOR KEY SHARE',
    "SET LOCAL lock_timeout = '0'"]);
  assert.deepEqual(db.calls[1].values, [WORLD, ['a', 'b']]);
  const all = recorder();
  await lockMembersFirst(all, WORLD, { env, restoreLockTimeout: '3s', restoreStatementTimeout: '15s' });
  assert.deepEqual(all.calls.map((call) => call.sql.replace(/\s+/g, ' ').trim()), [
    `SET LOCAL lock_timeout = '${DEFAULT_MEMBER_LOCK_WAIT_MS}ms'`,
    `SET LOCAL statement_timeout = '${DEFAULT_MEMBER_LOCK_WAIT_MS + 5_000}ms'`,
    MEMBER_KEY_SHARE_ALL_SQL.replace(/\s+/g, ' ').trim(),
    "SET LOCAL lock_timeout = '3s'", "SET LOCAL statement_timeout = '15s'"]);
  const off = recorder();
  assert.equal(await lockMembersFirst(off, WORLD, { env: { ...env, MIRRORTERRA_TICK_LOCK_ORDER: 'off' } }), false);
  assert.equal(await preLockTickResidents(off, WORLD, { env: { ...env, MIRRORTERRA_TICK_LOCK_ORDER: 'off' } }), false);
  assert.equal(off.calls.length, 0);
  const empty = recorder();
  assert.equal(await lockMembersFirst(empty, WORLD, { agentIds: [], env }), false);
  assert.equal(empty.calls.length, 0);
  const tick = recorder();
  assert.equal(await preLockTickResidents(tick, WORLD, { env }), true);
  assert.equal(tick.calls[0].sql, TICK_MEMBER_PRELOCK_SQL);
  assert.match(TICK_MEMBER_PRELOCK_SQL, /ORDER BY m\.agent_id FOR UPDATE OF m,s/);
});

test('tick wiring: residents pre-locked right after the clock row, before any other member lock; fast retry; health', () => {
  const engine = read('../src/world-engine.js');
  const tickStart = engine.indexOf('async function tick()');
  const clock = engine.indexOf('FROM world_runtime_state WHERE world_id=$1 FOR UPDATE`, [worldId]);', tickStart);
  const preLock = engine.indexOf('await preLockTickResidents(client, worldId)', tickStart);
  const firstMemberLock = engine.indexOf('FOR UPDATE OF m,s', tickStart);
  assert.ok(clock > tickStart && preLock > clock && preLock < firstMemberLock, 'pre-lock between clock lock and member reads');
  assert.match(engine, /nextRetryAt = readNowMs\(\) \+ retryDelayMs;/);
  assert.doesNotMatch(engine, /nextRetryAt = readNowMs\(\) \+ Math\.min\(30_000/);
  assert.match(engine, /tickLockOrder: \{ \.\.\.diagnostics\.tickLockOrder \}/);
  assert.match(read('../src/world-engine-diagnostics.js'), /engine\?\.tickLockOrder \? \{ tickLockOrder: engine\.tickLockOrder \}/);
});

test('open-cognition worker: member row locked before the cognition-state row in every state-locking transaction', () => {
  const worker = read('../src/agent-runtime/open-cognition/worker.js');
  const claim = worker.slice(worker.indexOf('async function claimDueTurn'), worker.indexOf('async function recordGateDecision'));
  const pick = claim.indexOf("client.query(dueTurnSql('', '')");
  const lock = claim.indexOf('await lockMembersFirst(client, worldId, { agentIds: [lockedAgent] })');
  const due = claim.indexOf("'FOR UPDATE OF state SKIP LOCKED'");
  const gate = claim.indexOf('INSERT INTO world_agent_cognition_gate_decisions');
  assert.ok(pick > 0 && lock > pick && due > lock && gate > due, 'pick -> member lock -> state lock -> FK insert');
  assert.match(claim, /AND state\.agent_id=\$2/);
  assert.match(claim, /if \(String\(error\?\.code \|\| ''\) === '55P03'\) return null;/);
  // Every transaction that locks a cognition-state row FOR UPDATE takes the member lock right after BEGIN.
  const stateLocks = [...worker.matchAll(/await client\.query\('BEGIN'\);\n(.*)\n\s+const current = await client\.query\(`SELECT revision,lease_token,/g)];
  assert.equal(stateLocks.length, 4);
  for (const match of stateLocks) assert.match(match[1], /await lockMembersFirst\(client, worldId, \{ agentIds: \[claim\.agentId\] \}\)/);
  assert.match(worker, /async function commitToolAttempt[\s\S]{0,200}await lockMembersFirst\(client, worldId, \{ agentIds: \[attempt\.agent_id\] \}\)/);
  assert.equal((worker.match(/NOT EXISTS \(SELECT 1 FROM world_external_residents e/g) || []).length, 3);
});

test('sync reward worker and gambit worker: members first, then advisory lock / gambit writes', () => {
  const rewards = read('../src/arc/sync-resident-rewards.js');
  const process = rewards.slice(rewards.indexOf('async #process()'));
  const lock = process.indexOf('await lockMembersFirst(client, this.#worldId);');
  const advisory = process.indexOf("SELECT pg_advisory_xact_lock(hashtextextended($1,0))");
  assert.ok(lock > 0 && advisory > lock);
  if (!hasGambit) return;
  const gambit = read('../src/gambit-deliberation.js');
  assert.match(gambit, /if \(worldId\) await lockMembersFirst\(client, worldId, \{ restoreLockTimeout: '3s', restoreStatementTimeout: '15s' \}\);/);
  const calls = gambit.match(/await inTransaction\(pool, |return inTransaction\(pool, /g).length;
  const withWorld = (gambit.match(/\}\), worldId\)|\}, worldId\)/g) || []).length;
  assert.equal(withWorld, calls, 'every gambit transaction takes the member lock');
});

test('no world, economy, model A/B or gambit-flag rule touched', { skip: !hasGambit && 'no gambit1 code in this base' }, () => {
  const flags = read('../src/gambit-flags.js');
  assert.match(flags, /MIRRORTERRA_QIANMEN_COUNCIL: 'off'/);
  assert.match(flags, /MIRRORTERRA_GAMBITS: 'off'/);
  assert.match(flags, /MIRRORTERRA_CAPABILITY_COUNCIL: 'off'/);
  assert.match(flags, /MIRRORTERRA_GAMBIT_COGNITION: 'off'/);
  assert.doesNotMatch(read('../src/tick-lock-order.js'), /gambit-flags|model-ab/);
});
