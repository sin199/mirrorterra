import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import pg from 'pg';
import { registerExternal2GuardRoute, external2GuardEnabled } from '../src/external2-guard-route.js';
import { readExternal2GuardSample } from '../src/external2-guard.js';
const path = '/local/external2-guard';
const request = { url: path, remoteAddress: '127.0.0.1', headers: { host: '127.0.0.1:8788' } };
const sample = { worldMinute: 1n, tickCount: 2n, economyDelta: 0n, oldJournalDelta: 0n,
  newJournalDelta: 0n, infrastructureDelta: 0n, negativeResidentBalances: 0, badPayoutSplits: 0,
  invalidAcceptances: 0, rewardFeaturesEnabled: 0, withdrawalsEnabled: 0,
  residentTotalRaw: 0n, treasuryTotalRaw: 0n, pendingEntitlementTotalRaw: 0n, purchasedTotalRaw: 0n,
  convertedGrossTotalRaw: 0n, withdrawalCount: 0, outboxPayoutCount: 0, infrastructureBalanceRaw: 0n,
  infrastructureFeesRaw: 0n, wallet: 'must-not-leak', model: { eligible: 0, succeeded: 0, failed: 0, quotaExhausted: 9, successRate: null } };

test('guard endpoint: switch off and all non-127/direct requests return 404 without querying DB', async () => {
  assert.equal(external2GuardEnabled({ MIRRORTERRA_EXTERNAL2_GUARD_ENDPOINT: 'off' }), false);
  for (const variant of [{ enabled: () => false }, { bindHost: '0.0.0.0' },
    { remoteAddress: '::1' }, { remoteAddress: '10.0.0.1' },
    { headers: { host: 'mirrorterra.com' } }, { headers: { host: 'www.mirrorterra.com' } },
    { headers: { host: '127.0.0.1:8788', 'x-forwarded-for': '1.2.3.4' } }]) {
    let connects = 0;
    const app = Fastify();
    registerExternal2GuardRoute(app, { pool: { connect() { connects++; throw new Error('forbidden'); } },
      bindHost: variant.bindHost || '127.0.0.1', worldIdFor: () => 'test', enabled: variant.enabled || (() => true) });
    const response = await app.inject({ ...request, ...variant });
    assert.equal(response.statusCode, 404);
    assert.equal(connects, 0);
    await app.close();
  }
});

test('guard snapshot is read-only, aggregate-only, coalesced and cached for 30 seconds', async () => {
  let now = 0, reads = 0, releases = 0;
  const sql = [];
  const app = Fastify();
  registerExternal2GuardRoute(app, { bindHost: '127.0.0.1', worldIdFor: () => 'world', enabled: () => true,
    now: () => now, pool: { async connect() { return { async query(text) { sql.push(text); }, release() { releases++; } }; } },
    readSample: async () => { reads++; await new Promise(resolve => setTimeout(resolve, 10)); return sample; } });
  const responses = await Promise.all([app.inject(request), app.inject(request)]);
  for (const response of responses) {
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().economyDelta, '0');
    assert.equal(response.json().model.quotaExhausted, 9);
    assert.equal(response.body.includes('must-not-leak'), false);
    for (const [key, value] of Object.entries(response.json())) {
      if (key !== 'model') assert.match(String(value), /^-?[0-9]+$/);
    }
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(reads, 1);
  assert.deepEqual(sql, ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', "SET LOCAL statement_timeout='4000ms'", 'COMMIT']);
  now = 29_999;
  await app.inject(request);
  assert.equal(reads, 1);
  now = 30_000;
  await app.inject(request);
  assert.equal(reads, 2);
  assert.equal(releases, 2);
  await app.close();
});

test('guard timeout destroys the read connection and returns 503 within the deadline', async () => {
  let destroyed = false;
  const app = Fastify();
  registerExternal2GuardRoute(app, { bindHost: '127.0.0.1', worldIdFor: () => 'world', enabled: () => true,
    timeoutMs: 30, pool: { async connect() { return { async query() {}, release(value) { destroyed = value; } }; } },
    readSample: () => new Promise(() => {}) });
  const started = Date.now();
  assert.equal((await app.inject(request)).statusCode, 503);
  assert.ok(Date.now() - started < 500);
  assert.equal(destroyed, true);
  await app.close();
});

test('guard route reads full clone in a PostgreSQL read-only snapshot and refuses writes',
  { skip: !process.env.EXTERNAL2_TEST_DATABASE_URL }, async () => {
    const pool = new pg.Pool({ connectionString: process.env.EXTERNAL2_TEST_DATABASE_URL, max: 1 });
    const worldId = (await pool.query('SELECT world_id FROM arc_sync_tokenomics_deployments LIMIT 1')).rows[0].world_id;
    const app = Fastify();
    registerExternal2GuardRoute(app, { pool, bindHost: '127.0.0.1', worldIdFor: () => worldId, enabled: () => true,
      readSample: async (db, id) => {
        assert.equal((await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
        assert.equal((await db.query('SHOW statement_timeout')).rows[0].statement_timeout, '4s');
        return readExternal2GuardSample(db, id);
      } });
    assert.equal((await app.inject(request)).statusCode, 200);
    await app.close();
    const writeApp = Fastify();
    registerExternal2GuardRoute(writeApp, { pool, bindHost: '127.0.0.1', worldIdFor: () => worldId, enabled: () => true,
      readSample: async (db) => {
        await assert.rejects(db.query('UPDATE world_external2_policy SET singleton=singleton WHERE false'), { code: '25006' });
        throw new Error('write correctly refused');
      } });
    assert.equal((await writeApp.inject(request)).statusCode, 503);
    await writeApp.close();
    await pool.end();
  });
