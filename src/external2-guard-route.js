import { readExternal2GuardSample } from './external2-guard.js';

export const EXTERNAL2_GUARD_PATH = '/local/external2-guard';
export const external2GuardEnabled = (env = process.env) =>
  String(env.MIRRORTERRA_EXTERNAL2_GUARD_ENDPOINT ?? 'on').toLowerCase() === 'on';

export function isExternal2GuardRequest({ bindHost, hostHeader, remoteAddress, headers = {} }) {
  return bindHost === '127.0.0.1'
    && ['127.0.0.1', '::ffff:127.0.0.1'].includes(remoteAddress)
    && /^127\.0\.0\.1(?::[0-9]+)?$/.test(String(hostHeader || ''))
    && !Object.keys(headers).some((key) => /^(?:forwarded|x-forwarded-.*|cf-connecting-ip)$/i.test(key));
}

// This handler is called by HTTP only, never from the World tick. One consistent
// snapshot, at most one in-flight read, and a 30-second cache bound its DB cost.
export function registerExternal2GuardRoute(app, { pool, bindHost, worldIdFor,
  enabled = external2GuardEnabled, readSample = readExternal2GuardSample,
  gatesFor = () => ({ mainnetWriteEnabled: 0, committedPayoutWriteEnabled: 0 }),
  now = Date.now, timeoutMs = 4500 }) {
  if (!(timeoutMs > 0 && timeoutMs <= 5000)) throw new Error('EXTERNAL2_GUARD_TIMEOUT_INVALID');
  let cached = null, flight = null;
  async function snapshot() {
    const deadline = now() + timeoutMs;
    let client, released = false, timer;
    const release = (destroy = false) => {
      if (client && !released) { released = true; client.release(destroy); }
    };
    const operation = (async () => {
      client = await pool.connect();
      if (now() >= deadline) { release(true); throw new Error('EXTERNAL2_GUARD_TIMEOUT'); }
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL statement_timeout='4000ms'");
      const sample = await readSample(client, worldIdFor());
      await client.query('COMMIT');
      // Explicit aggregate allowlist: no world/resident IDs, wallets or signatures.
      const result = Object.fromEntries(['worldMinute','tickCount','economyDelta','oldJournalDelta',
        'newJournalDelta','infrastructureDelta','negativeResidentBalances','badPayoutSplits',
        'invalidAcceptances','rewardFeaturesEnabled','withdrawalsEnabled',
        'residentTotalRaw','treasuryTotalRaw','pendingEntitlementTotalRaw','purchasedTotalRaw',
        'convertedGrossTotalRaw','withdrawalCount','outboxPayoutCount','infrastructureBalanceRaw','infrastructureFeesRaw'].map((key) => [key, String(sample[key])]));
      Object.assign(result, gatesFor());
      result.model = { eligible: sample.model.eligible, succeeded: sample.model.succeeded,
        failed: sample.model.failed, quotaExhausted: sample.model.quotaExhausted,
        successRate: sample.model.successRate };
      cached = { at: now(), value: result };
      return result;
    })();
    try {
      return await Promise.race([operation, new Promise((_, reject) => {
        timer = setTimeout(() => { release(true); reject(new Error('EXTERNAL2_GUARD_TIMEOUT')); }, timeoutMs);
      })]);
    } catch (error) {
      // Destroying the connection also aborts any queued query and rolls back.
      release(true);
      throw error;
    } finally { clearTimeout(timer); release(); }
  }
  app.get(EXTERNAL2_GUARD_PATH, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!enabled() || !isExternal2GuardRequest({ bindHost, hostHeader: request.headers.host,
      remoteAddress: request.raw.socket.remoteAddress, headers: request.headers })) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    try {
      if (cached && now() - cached.at < 30_000) return cached.value;
      flight ||= snapshot().finally(() => { flight = null; });
      return await flight;
    } catch { return reply.code(503).send({ error: 'EXTERNAL2_GUARD_UNAVAILABLE' }); }
  });
}
