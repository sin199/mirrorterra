import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { prepareStartupSchema } from '../src/startup-schema.js';

const url = process.env.RUNTIME_OBSERVABILITY_TEST_DATABASE_URL;
test('startup validates the additive rollup contract and refuses missing cache-write privileges', {
  skip: !url, timeout: 5000
}, async () => {
  const target = new URL(url);
  assert.ok(['127.0.0.1','localhost','::1'].includes(target.hostname));
  assert.notEqual(target.port, '5432');
  assert.ok(target.pathname.endsWith('_test'));
  const pool = new Pool({ connectionString: url, max: 1 });
  const rootDirectory = fileURLToPath(new URL('..', import.meta.url));
  try {
    const valid = await prepareStartupSchema(pool, { rootDirectory, mode: 'validate' });
    assert.equal(valid.validated, true);
    await pool.query('REVOKE DELETE ON world_emergence_hour_rollups FROM synterra_app');
    await assert.rejects(prepareStartupSchema(pool, { rootDirectory, mode: 'validate' }),
      (error) => error.code === 'STARTUP_SCHEMA_INCOMPATIBLE' && /DELETE missing/.test(error.message));
  } finally {
    await pool.query('GRANT DELETE ON world_emergence_hour_rollups TO synterra_app');
    await pool.end();
  }
});
