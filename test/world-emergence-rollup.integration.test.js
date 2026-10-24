import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { refreshEmergenceRollup, readEmergenceAggregates, readEmergenceRollup }
  from '../src/world-emergence-rollup.js';

const url = process.env.RUNTIME_OBSERVABILITY_TEST_DATABASE_URL;
test('closed-hour rollups match raw counts through partial backfill, rollback and concurrent ticks', {
  skip: !url, timeout: 15_000
}, async (t) => {
  const target = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(target.hostname));
  assert.notEqual(target.port, '5432');
  assert.ok(target.pathname.endsWith('_test'));
  const pool = new Pool({ connectionString: url, max: 5,
    options: '-c search_path=emergence_rollup_test,public' });
  const worldId = randomUUID();
  async function assertExact(from = 407, to = 1001) {
    const actual = await readEmergenceAggregates(pool, { worldId, fromWorldMinute: from, toWorldMinute: to });
    const counts = (await pool.query(`SELECT system,stage,action,count(*)::int AS count
      FROM world_emergence_events WHERE world_id=$1 AND world_minutes >= $2
      GROUP BY system,stage,action ORDER BY system,stage,action`, [worldId, from])).rows;
    const reasons = (await pool.query(`SELECT system,reason_code,count(*)::int AS count
      FROM world_emergence_events WHERE world_id=$1 AND world_minutes >= $2
      AND stage='blocked' AND reason_code<>'NONE' GROUP BY system,reason_code
      ORDER BY count DESC,system,reason_code LIMIT 30`, [worldId, from])).rows;
    assert.deepEqual(actual.counts, counts);
    assert.deepEqual(actual.blockedReasons, reasons);
    return actual;
  }
  try {
    await pool.query('CREATE SCHEMA emergence_rollup_test');
    await pool.query(`CREATE TABLE worlds(id uuid PRIMARY KEY);
      CREATE TABLE world_runtime_state(world_id uuid PRIMARY KEY REFERENCES worlds(id),world_minutes bigint);
      CREATE TABLE world_emergence_events(id bigserial PRIMARY KEY,world_id uuid,world_minutes bigint,
        system text,stage text,action text,reason_code text);
      CREATE INDEX ON world_emergence_events(world_id,world_minutes DESC,id DESC)`);
    await pool.query(await readFile(new URL('../migrations/0035_emergence_rollups.sql', import.meta.url), 'utf8'));
    await pool.query('INSERT INTO worlds VALUES($1)', [worldId]);
    await pool.query('INSERT INTO world_runtime_state VALUES($1,1001)', [worldId]);
    await pool.query(`INSERT INTO world_emergence_events(world_id,world_minutes,system,stage,action,reason_code)
      SELECT $1,n,CASE WHEN n%2=0 THEN 'project' ELSE 'place' END,
        CASE WHEN n%3=0 THEN 'blocked' ELSE 'chosen' END,
        CASE WHEN n%5=0 THEN NULL WHEN n%5=1 THEN '' ELSE 'work' END,
        CASE WHEN n%7=0 THEN 'NONE' ELSE 'CLOSED' END
      FROM generate_series(0,1001) n`, [worldId]);

    await t.test('partial batches never truncate the live window or double-count boundaries', async () => {
      assert.equal((await assertExact()).coverage, null);
      for (let n = 0; n < 12; n += 1) {
        const result = await refreshEmergenceRollup(pool, { worldId, maxHours: 1, windowMinutes: 600 });
        await assertExact();
        if (result.caughtUp) break;
      }
      assert.ok((await assertExact()).coverage);
      await assertExact(0);
      await assertExact(420);
      await assertExact(961);
      const first = await refreshEmergenceRollup(pool, { worldId, windowMinutes: 600 });
      const again = await refreshEmergenceRollup(pool, { worldId, windowMinutes: 600 });
      assert.equal(first.cursor, again.cursor);
      assert.equal(again.rowsProcessed, 0);
      await assertExact();
    });

    await t.test('an uncommitted tick is not mistaken for a complete hour', async () => {
      const writer = await pool.connect();
      try {
        await writer.query('BEGIN');
        await writer.query('UPDATE world_runtime_state SET world_minutes=1100 WHERE world_id=$1', [worldId]);
        await writer.query(`INSERT INTO world_emergence_events(world_id,world_minutes,system,stage,action,reason_code)
          VALUES($1,1050,'project','blocked','late','CLOSED')`, [worldId]);
        const before = await refreshEmergenceRollup(pool, { worldId });
        assert.equal(before.cursor, 960);
        await assertExact();
        await writer.query('COMMIT');
        assert.equal((await refreshEmergenceRollup(pool, { worldId })).cursor, 1080);
        await assertExact(407, 1100);
      } finally { await writer.query('ROLLBACK'); writer.release(); }
    });

    await t.test('a second rollup writer skips without waiting on World/member locks', async () => {
      const owner = await pool.connect();
      try {
        await owner.query('BEGIN');
        await owner.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`emergence-rollup:${worldId}`]);
        const result = await refreshEmergenceRollup(pool, { worldId });
        assert.equal(result.reason, 'another_rollup_writer');
        assert.equal(result.skipped, true);
      } finally { await owner.query('ROLLBACK'); owner.release(); }
    });

    await t.test('a failure after copying rows rolls back both counts and coverage', async () => {
      await pool.query(`UPDATE world_runtime_state SET world_minutes=1201 WHERE world_id=$1`, [worldId]);
      await pool.query(`INSERT INTO world_emergence_events(world_id,world_minutes,system,stage,action,reason_code)
        VALUES($1,1150,'project','chosen','new','NONE')`, [worldId]);
      await pool.query(`CREATE FUNCTION fail_rollup_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated interrupt' USING ERRCODE='57014'; END $$;
        CREATE TRIGGER fail_cursor BEFORE UPDATE ON world_emergence_rollup_state
        FOR EACH ROW EXECUTE FUNCTION fail_rollup_cursor()`);
      await assert.rejects(refreshEmergenceRollup(pool, { worldId }), { code: '57014' });
      const saved = await pool.query('SELECT through_world_minute FROM world_emergence_rollup_state WHERE world_id=$1', [worldId]);
      assert.equal(Number(saved.rows[0].through_world_minute), 1080);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM world_emergence_hour_rollups WHERE bucket_world_minute>=1080')).rows[0].n, 0);
      await pool.query('DROP TRIGGER fail_cursor ON world_emergence_rollup_state');
      await refreshEmergenceRollup(pool, { worldId });
      await assertExact(407, 1201);
      assert.equal(await readEmergenceRollup(pool, { worldId, fromWorldMinute: 407, toWorldMinute: 1001 }), null,
        'an apparently ahead-of-clock cache falls back to raw data');
    });

    await t.test('moving the cache window prunes only derived buckets and preserves historical reports', async () => {
      const before = (await pool.query('SELECT count(*)::int AS n FROM world_emergence_events')).rows[0].n;
      await pool.query('UPDATE world_runtime_state SET world_minutes=2500 WHERE world_id=$1', [worldId]);
      const result = await refreshEmergenceRollup(pool, { worldId, windowMinutes: 600 });
      assert.equal(result.startWorldMinute, 1860);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM world_emergence_hour_rollups WHERE bucket_world_minute<1860')).rows[0].n, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM world_emergence_events')).rows[0].n, before);
      await assertExact(0, 2500);
    });
  } finally {
    await pool.query('DROP SCHEMA IF EXISTS emergence_rollup_test CASCADE');
    await pool.end();
  }
});
