import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { createObservationScope } from '../src/arc/observation-scope.js';

const url = process.env.RUNTIME_OBSERVABILITY_TEST_DATABASE_URL;
test('PostgreSQL cancels timed-out observation SQL on the server and releases the pool', {
  skip: !url, timeout: 5000
}, async () => {
  const target = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(target.hostname));
  assert.notEqual(target.port, '5432');
  assert.ok(target.pathname.endsWith('_test'));
  const pool = new Pool({ connectionString: url, max: 2, application_name: 'arc-observer-timeout-test',
    options: '-c statement_timeout=100 -c idle_in_transaction_session_timeout=1000' });
  const scope = createObservationScope(pool, { timeoutMs: 1000, queryTimeoutMs: 500 });
  try {
    await assert.rejects(scope.pool.query('SELECT pg_sleep(10)'), { code: 'ARC_OBSERVER_QUERY_TIMEOUT' });
    const active = await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name='arc-observer-timeout-test' AND state='active'
        AND query LIKE 'SELECT pg_sleep%'`);
    assert.equal(active.rows[0].n, 0, 'the server is no longer executing the timed-out SQL');
    assert.equal(pool.waitingCount, 0);
    assert.equal((await pool.query('SELECT 1 AS healthy')).rows[0].healthy, 1);
  } finally { scope.close(); await pool.end(); }
});

test('an idle transaction disconnect aborts an owned Arc client without an unhandled error', {
  skip: !url, timeout: 5000
}, async () => {
  const target = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(target.hostname));
  assert.notEqual(target.port, '5432');
  assert.ok(target.pathname.endsWith('_test'));
  const pool = new Pool({ connectionString: url, max: 1,
    options: '-c statement_timeout=1000 -c idle_in_transaction_session_timeout=100' });
  const scope = createObservationScope(pool, { timeoutMs: 2000 });
  try {
    const client = await scope.pool.connect();
    await client.query('BEGIN');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(scope.signal.aborted, true);
    assert.equal(scope.signal.reason.code, '25P03');
    client.release();
    assert.equal((await pool.query('SELECT 1 AS healthy')).rows[0].healthy, 1);
  } finally { scope.close(); await pool.end(); }
});
