import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assertArcChainId } from './config.js';
import { parsePositiveIdentityId, verifyArc8004IdentityOwner } from './identity-registry.js';

export const ARC8004_VERIFY_TIMEOUT_MS = 5_000;
export const ARC8004_VERIFY_CACHE_MS = 10 * 60_000;
export const ARC8004_VERIFY_RETRY_MS = 60_000;
export const ARC8004_VERIFY_CONCURRENCY = 2;
export const ARC8004_DISABLE_FILE = path.join(tmpdir(), 'mirrorterra-arc8004-verify.disabled');

const EMPTY_COUNTS = Object.freeze({ total: 0, verified: 0, noIdentityId: 0,
  ownerMismatch: 0, unverifiable: 0 });
const READ_METHODS = new Set(['eth_chainId', 'eth_getCode', 'eth_call']);

function snapshot(state, counts = EMPTY_COUNTS, checkedAt = null, expiresAt = null) {
  return { enabled: state !== 'disabled', state, ...counts, checkedAt, expiresAt };
}

async function mapLimited(items, limit, work, signal) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !signal.aborted) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

function readOnlyRpc({ url, fetchImpl, signal }) {
  let requestId = 0;
  async function request(method, params) {
    if (!READ_METHODS.has(method) || signal.aborted) throw new Error('ARC8004_READ_UNAVAILABLE');
    const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }), signal });
    if (!response.ok) throw new Error('ARC8004_READ_UNAVAILABLE');
    const body = await response.json();
    if (body?.error || !Object.hasOwn(body || {}, 'result')) throw new Error('ARC8004_READ_UNAVAILABLE');
    return body.result;
  }
  return {
    getChainId: () => request('eth_chainId', []),
    getCode: (address, blockTag = 'latest') => request('eth_getCode', [address, blockTag]),
    call: (transaction, blockTag = 'latest') => request('eth_call', [transaction, blockTag])
  };
}

function withinDeadline(work, signal) {
  if (signal.aborted) return Promise.reject(new Error('ARC8004_READ_UNAVAILABLE'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('ARC8004_READ_UNAVAILABLE'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(work).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export class Arc8004ReadOnlyVerifier {
  #pool;
  #config;
  #fetch;
  #clock;
  #disableFile;
  #enabled;
  #killed = false;
  #worldId = null;
  #timer = null;
  #initialTimer = null;
  #inFlight = null;
  #abort = null;
  #nextRunAt = 0;
  #status;
  #timeoutMs;
  #cacheMs;
  #retryMs;
  #concurrency;

  constructor({ pool, config, fetchImpl = globalThis.fetch, clock = Date.now,
    enabled = true, disableFile = ARC8004_DISABLE_FILE, timeoutMs = ARC8004_VERIFY_TIMEOUT_MS,
    cacheMs = ARC8004_VERIFY_CACHE_MS, retryMs = ARC8004_VERIFY_RETRY_MS,
    concurrency = ARC8004_VERIFY_CONCURRENCY }) {
    if (!pool || typeof pool.query !== 'function' || !config?.primaryRpcUrl || !config?.erc8004?.identity
        || typeof fetchImpl !== 'function') throw new TypeError('Read-only Arc identity inputs are required.');
    if (![timeoutMs, cacheMs, retryMs, concurrency].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new RangeError('Arc identity timing and concurrency limits must be positive integers.');
    }
    this.#pool = pool;
    this.#config = config;
    this.#fetch = fetchImpl;
    this.#clock = clock;
    this.#disableFile = disableFile;
    this.#enabled = enabled === true;
    this.#timeoutMs = timeoutMs;
    this.#cacheMs = cacheMs;
    this.#retryMs = retryMs;
    this.#concurrency = concurrency;
    this.#status = snapshot(this.#enabled ? 'checking' : 'disabled');
  }

  #isDisabled() {
    if (!this.#enabled || this.#killed || existsSync(this.#disableFile)) {
      this.#killed = true;
      this.#abort?.abort();
      this.#status = snapshot('disabled');
      return true;
    }
    return false;
  }

  getStatus() {
    if (this.#isDisabled()) return snapshot('disabled');
    if (this.#status.expiresAt && this.#clock() >= Date.parse(this.#status.expiresAt)) {
      return snapshot('unavailable', { ...EMPTY_COUNTS, total: this.#status.total,
        unverifiable: this.#status.total }, this.#status.checkedAt, this.#status.expiresAt);
    }
    return { ...this.#status };
  }

  start({ worldId }) {
    if (this.#isDisabled()) return this;
    if (this.#timer) return this;
    if (typeof worldId !== 'string' || !worldId) throw new TypeError('World ID is required.');
    this.#worldId = worldId;
    // Detached from startup, requests, world ticks, and every database transaction.
    this.#initialTimer = setTimeout(() => { void this.refresh(); }, 0);
    this.#initialTimer.unref?.();
    this.#timer = setInterval(() => { void this.refresh(); }, this.#retryMs);
    this.#timer.unref?.();
    return this;
  }

  async refresh() {
    if (this.#isDisabled() || !this.#worldId || this.#clock() < this.#nextRunAt) return this.getStatus();
    if (this.#inFlight) return this.getStatus();
    this.#inFlight = this.#scan();
    try { await this.#inFlight; }
    finally { this.#inFlight = null; }
    return this.getStatus();
  }

  async #scan() {
    const controller = new AbortController();
    this.#abort = controller;
    const deadline = setTimeout(() => controller.abort(), this.#timeoutMs);
    let total = 0;
    try {
      // observerReadPool is read-only with a statement timeout; this query opens no transaction.
      const rows = (await withinDeadline(this.#pool.query(`SELECT address,external_identity_id FROM arc_agent_wallets
        WHERE world_id=$1 AND chain_id=$2 AND status='active' ORDER BY agent_id LIMIT 101`,
      [this.#worldId, this.#config.chainId]), controller.signal)).rows;
      if (controller.signal.aborted || !Array.isArray(rows) || rows.length > 100) throw new Error('ARC8004_READ_UNAVAILABLE');
      total = rows.length;
      const counts = { ...EMPTY_COUNTS, total };
      const linked = [];
      for (const row of rows) {
        if (row.external_identity_id === null || row.external_identity_id === undefined || row.external_identity_id === '') {
          counts.noIdentityId += 1;
        } else if (parsePositiveIdentityId(row.external_identity_id) === null) {
          counts.unverifiable += 1;
        } else {
          linked.push(row);
        }
      }
      if (linked.length) {
        const rpc = readOnlyRpc({ url: this.#config.primaryRpcUrl, fetchImpl: this.#fetch, signal: controller.signal });
        const chainId = await withinDeadline(rpc.getChainId(), controller.signal);
        assertArcChainId(chainId, this.#config);
        const code = await withinDeadline(rpc.getCode(this.#config.erc8004.identity, 'latest'), controller.signal);
        if (code === '0x' || controller.signal.aborted) throw new Error('ARC8004_READ_UNAVAILABLE');
        const sharedRpc = { getChainId: async () => chainId, getCode: async () => code,
          call: (transaction, blockTag) => rpc.call(transaction, blockTag) };
        const results = await withinDeadline(mapLimited(linked, this.#concurrency, (row) => verifyArc8004IdentityOwner({
          rpc: sharedRpc, config: this.#config, identityId: row.external_identity_id, issuerWallet: row.address
        }), controller.signal), controller.signal);
        for (const result of results) {
          if (result?.ready) counts.verified += 1;
          else if (result?.reason === 'identity_owner_mismatch') counts.ownerMismatch += 1;
          else counts.unverifiable += 1;
        }
      }
      if (controller.signal.aborted || this.#isDisabled()) throw new Error('ARC8004_READ_UNAVAILABLE');
      const checkedAt = new Date(this.#clock()).toISOString();
      const partial = counts.unverifiable > 0;
      const ttl = partial ? this.#retryMs : this.#cacheMs;
      this.#nextRunAt = this.#clock() + ttl;
      this.#status = snapshot(partial ? 'partial' : 'ready', counts, checkedAt,
        new Date(this.#nextRunAt).toISOString());
    } catch {
      if (!this.#isDisabled()) {
        this.#nextRunAt = this.#clock() + this.#retryMs;
        this.#status = snapshot('unavailable', { ...EMPTY_COUNTS, total, unverifiable: total },
          new Date(this.#clock()).toISOString(), new Date(this.#nextRunAt).toISOString());
      }
    } finally {
      clearTimeout(deadline);
      if (this.#abort === controller) this.#abort = null;
    }
  }

  async stop() {
    if (this.#initialTimer) clearTimeout(this.#initialTimer);
    if (this.#timer) clearInterval(this.#timer);
    this.#initialTimer = null;
    this.#timer = null;
    this.#abort?.abort();
    await this.#inFlight;
  }
}
