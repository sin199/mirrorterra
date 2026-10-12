import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeSelectRequiredTables } from '../src/startup-schema.js';

test('runtime SELECT checks exclude only explicitly operator-only contract tables', () => {
  const tables = ['world_runtime_state', 'arc_turnkey_agent_wallet_provisioning', 'synterra_schema_migrations'];
  const contract = { arc_turnkey_agent_wallet_provisioning: { runtimeSelect: false } };

  assert.deepEqual(runtimeSelectRequiredTables(tables, contract), [
    'world_runtime_state', 'synterra_schema_migrations'
  ]);
});
