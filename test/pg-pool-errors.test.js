// skillwork2: an idle pooled client error must be logged, never crash the process (14:26 CST 2026-10-22:
// PostgreSQL restarted, an idle client got 57P01 and pg-pool re-emitted it on a Pool with no listener).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { PG_POOL_ERROR_EVENT, attachPoolErrorLogger } from '../src/pg-pool-errors.js';

class FakeClient extends EventEmitter {
  constructor() { super(); this.ended = false; this._queryable = true; this._ending = false; }
  connect(callback) { setImmediate(() => callback?.(null)); return callback ? undefined : Promise.resolve(); }
  query() { return Promise.resolve({ rows: [], rowCount: 0 }); }
  end(callback) { this.ended = true; this._ending = true; this._queryable = false; if (callback) setImmediate(callback); return Promise.resolve(); }
}

function adminTermination() {
  return Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01', severity: 'FATAL' });
}

test('without a listener an idle client error is thrown (the 14:26 crash)', async () => {
  const pool = new pg.Pool({ Client: FakeClient, max: 1 });
  const client = await pool.connect();
  client.release();
  assert.throws(() => client.emit('error', adminTermination()), /administrator command/);
  await pool.end();
});

test('with attachPoolErrorLogger an idle client error is logged once, the client is dropped and the pool keeps working', async () => {
  const logged = [];
  const pool = new pg.Pool({ Client: FakeClient, max: 2 });
  const guard = attachPoolErrorLogger(pool, 'public_read', { log: (record) => logged.push(record),
    now: () => new Date('2026-10-22T06:26:30Z') });
  const client = await pool.connect();
  client.release();
  assert.equal(pool.idleCount, 1);
  assert.doesNotThrow(() => client.emit('error', adminTermination()));
  assert.equal(guard.count, 1);
  assert.equal(guard.lastCode, '57P01');
  assert.deepEqual(logged, [{ event: PG_POOL_ERROR_EVENT, pool: 'public_read', code: '57P01', severity: 'FATAL',
    message: 'terminating connection due to administrator command', count: 1, at: '2026-10-22T06:26:30.000Z' }]);
  assert.equal(pool.idleCount, 0, 'pg-pool removes the broken client');
  assert.ok(client.ended);
  const next = await pool.connect();
  assert.notEqual(next, client, 'a fresh client replaces it');
  next.release();
  await pool.end();
});

test('a logger that throws still does not crash', () => {
  const pool = new EventEmitter();
  attachPoolErrorLogger(pool, 'main', { log: () => { throw new Error('log sink down'); } });
  assert.doesNotThrow(() => pool.emit('error', adminTermination()));
});

test('server.js attaches the logger to every pg Pool it creates', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const pools = [...source.matchAll(/const (\w+) = new Pool\(/g)].map((match) => match[1]);
  assert.deepEqual(pools.sort(), ['mapBuildPool', 'observerReadPool', 'pool', 'publicReadPool', 'readinessPool']);
  for (const name of pools) assert.match(source, new RegExp(`attachPoolErrorLogger\\(${name}, '`));
});
