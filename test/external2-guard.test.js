import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { modelSuccessMetric, readExternal2GuardSample } from '../src/external2-guard.js';

test('quota exhaustion is counted separately; zero eligible calls has N/A success', () => {
  assert.deepEqual(modelSuccessMetric({ succeeded: 0, failed: 0, quotaExhausted: 12 }),
    { eligible: 0, succeeded: 0, failed: 0, quotaExhausted: 12, successRate: null });
  assert.deepEqual(modelSuccessMetric({ succeeded: 3, failed: 1, quotaExhausted: 20 }),
    { eligible: 4, succeeded: 3, failed: 1, quotaExhausted: 20, successRate: 0.75 });
});

test('guard excludes only insufficient_user_quota in the SQL rate and keeps conservation checks', async () => {
  const queries = [];
  const db = { async query(sql) {
    queries.push(sql);
    if (sql.includes('FROM world_runtime_state')) return { rowCount: 1, rows: [{ minute: '9', tick: '8' }] };
    if (sql.includes('AS residents,')) return { rows: [{ residents: '970000', treasury: '0',
      backed: '1000000', purchases: '0', converted: '30000', negative: 0 }] };
    if (sql.includes('AS balance,')) return { rows: [{ balance: '30000', fees: '30000' }] };
    if (sql.includes('FROM world_external2_policy')) return { rows: [{ rewards: 0, withdrawals: 0 }] };
    if (sql.includes('bai_model_budget_calls')) return { rows: [{ succeeded: 0, failed: 0, quotaExhausted: 12 }] };
    if (sql.includes('AS bad')) return { rows: [{ bad: 0, withdrawals: 1, payouts: 2 }] };
    return { rows: [{ total: '0' }] };
  } };
  const sample = await readExternal2GuardSample(db, '11111111-1111-4111-8111-111111111111');
  assert.equal(sample.model.successRate, null);
  assert.equal(sample.model.quotaExhausted, 12);
  assert.equal(sample.economyDelta, 0n);
  const sql = queries.find((query) => query.includes('bai_model_budget_calls'));
  assert.equal((sql.match(/provider_error_code IS DISTINCT FROM 'insufficient_user_quota'/g) || []).length, 2);
});

test('guard verifies full restored World including committed external withdrawals',
  { skip: !process.env.EXTERNAL2_TEST_DATABASE_URL }, async () => {
    const db = new pg.Pool({ connectionString: process.env.EXTERNAL2_TEST_DATABASE_URL, max: 2 });
    try {
      const world = (await db.query('SELECT world_id FROM arc_sync_tokenomics_deployments LIMIT 1')).rows[0];
      const sample = await readExternal2GuardSample(db, world.world_id);
      assert.deepEqual([sample.economyDelta,sample.oldJournalDelta,sample.newJournalDelta,
        sample.infrastructureDelta], [0n,0n,0n,0n]);
      assert.equal(sample.negativeResidentBalances, 0);
    } finally { await db.end(); }
  });
