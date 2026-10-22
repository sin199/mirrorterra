import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Interface } from 'ethers';
import { arcNetworkConfig } from '../src/arc/config.js';
import { Arc8004ReadOnlyVerifier } from '../src/arc/identity-verifier.js';

const config = arcNetworkConfig({ MAINNET_WRITE_GATE: 'false' });
const walletA = '0x1111111111111111111111111111111111111111';
const walletB = '0x2222222222222222222222222222222222222222';
const iface = new Interface(['function ownerOf(uint256 tokenId) view returns (address)']);

function rpcFixture({ owners = {}, pause = async () => {}, onCall = () => {} } = {}) {
  return async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    onCall(method);
    if (method === 'eth_call') await pause();
    const result = method === 'eth_chainId' ? '0x13b2'
      : method === 'eth_getCode' ? '0x6000'
        : iface.encodeFunctionResult('ownerOf', [owners[iface.decodeFunctionData('ownerOf', params[0].data)[0].toString()] || walletB]);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', result }) };
  };
}

function verifier({ rows, fetchImpl, clock = Date.now, enabled = true, disableFile,
  timeoutMs = 5000, cacheMs = 600000, retryMs = 60000, concurrency = 2, onQuery = () => {} }) {
  const pool = { async query(sql, params) {
    onQuery(sql, params);
    return { rows };
  } };
  const instance = new Arc8004ReadOnlyVerifier({ pool, config, fetchImpl, clock, enabled,
    disableFile, timeoutMs, cacheMs, retryMs, concurrency });
  instance.start({ worldId: 'world-one' });
  return instance;
}

test('read-only worker publishes aggregate owner checks and caches a successful result', async () => {
  let queries = 0;
  const methods = [];
  const worker = verifier({ rows: [
    { address: walletA, external_identity_id: '1' },
    { address: walletB, external_identity_id: '2' },
    { address: walletB, external_identity_id: null }
  ], fetchImpl: rpcFixture({ owners: { 1: walletA, 2: walletA }, onCall: (method) => methods.push(method) }),
  onQuery: (sql, params) => {
    queries++;
    assert.match(sql, /SELECT address,external_identity_id/);
    assert.deepEqual(params, ['world-one', 5042]);
  } });
  try {
    const first = await worker.refresh();
    assert.equal(first.state, 'ready');
    assert.deepEqual([first.total, first.verified, first.noIdentityId, first.ownerMismatch, first.unverifiable],
      [3, 1, 1, 1, 0]);
    assert.ok(Date.parse(first.expiresAt) - Date.parse(first.checkedAt) >= 600000);
    assert.ok(Date.parse(first.expiresAt) - Date.parse(first.checkedAt) < 600100);
    assert.doesNotMatch(JSON.stringify(first), /0x1111|0x2222|identityId|address/);
    await worker.refresh();
    assert.equal(queries, 1);
    assert.deepEqual(methods, ['eth_chainId', 'eth_getCode', 'eth_call', 'eth_call']);
  } finally { await worker.stop(); }
});

test('RPC failure is unavailable, and a hanging RPC reaches the shared deadline', async () => {
  const worker = verifier({ rows: [{ address: walletA, external_identity_id: '1' }], timeoutMs: 25,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) });
  try {
    const start = Date.now();
    const status = await worker.refresh();
    assert.equal(status.state, 'unavailable');
    assert.equal(status.unverifiable, 1);
    assert.ok(Date.now() - start < 500, 'deadline is independent of the caller');
  } finally { await worker.stop(); }
});

test('identity RPC calls obey the concurrency cap', async () => {
  let active = 0;
  let peak = 0;
  const rows = Array.from({ length: 7 }, (_, index) => ({ address: walletA,
    external_identity_id: String(index + 1) }));
  const worker = verifier({ rows, fetchImpl: rpcFixture({ owners: Object.fromEntries(rows.map((row) => [row.external_identity_id, walletA])),
    pause: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    } }) });
  try {
    assert.equal((await worker.refresh()).verified, 7);
    assert.equal(peak, 2);
  } finally { await worker.stop(); }
});

test('disabled switch and emergency marker suppress all reads and public status', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'arc8004-test-'));
  const disableFile = path.join(dir, 'disabled');
  let queries = 0;
  const worker = verifier({ rows: [], fetchImpl: rpcFixture(), enabled: false, disableFile,
    onQuery: () => { queries++; } });
  try {
    assert.equal((await worker.refresh()).state, 'disabled');
    assert.equal(queries, 0);
  } finally { await worker.stop(); }
  const enabled = verifier({ rows: [], fetchImpl: rpcFixture(), disableFile,
    onQuery: () => { queries++; } });
  try {
    assert.equal((await enabled.refresh()).state, 'ready');
    await writeFile(disableFile, 'disabled\n');
    assert.deepEqual(enabled.getStatus(), { enabled: false, state: 'disabled', total: 0,
      verified: 0, noIdentityId: 0, ownerMismatch: 0, unverifiable: 0,
      checkedAt: null, expiresAt: null });
    await enabled.refresh();
    assert.equal(queries, 1);
  } finally {
    await enabled.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
