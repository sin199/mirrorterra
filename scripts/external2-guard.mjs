// Read-only production guard. A nonzero exit means rollback is required by the release operator.
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const worldId = process.env.EXTERNAL2_GUARD_WORLD_ID;
const release = process.env.EXTERNAL2_GUARD_RELEASE;
if (!/^[0-9a-f-]{36}$/i.test(String(worldId || '')) || !release) {
  throw new Error('EXTERNAL2_GUARD_TARGET_REQUIRED');
}
const durationMinutes = process.argv.includes('--once') ? 0 : 30;
const service = () => {
  const raw = execFileSync('systemctl', ['show','synterra.service','-p','ActiveState','-p','MainPID','-p','NRestarts'],
    { encoding: 'utf8', timeout: 5000 });
  return Object.fromEntries(raw.trim().split('\n').map((line) => line.split('=',2)));
};
const rssBytes = (pid) => {
  const match = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s+(\d+) kB$/m);
  if (!match) throw new Error('EXTERNAL2_GUARD_RSS_UNAVAILABLE');
  return Number(match[1]) * 1024;
};
async function readSample() {
  const health = await fetch('http://127.0.0.1:8788/local/health', { signal: AbortSignal.timeout(5000) });
  if (!health.ok || (await health.json()).worldId !== worldId) throw new Error('EXTERNAL2_GUARD_WORLD_MISMATCH');
  const response = await fetch('http://127.0.0.1:8788/local/external2-guard', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`EXTERNAL2_GUARD_HTTP_${response.status}`);
  const sample = await response.json();
  for (const key of ['worldMinute','tickCount','economyDelta','oldJournalDelta','newJournalDelta','infrastructureDelta']) {
    sample[key] = BigInt(sample[key]);
  }
  for (const key of ['economyDelta','oldJournalDelta','newJournalDelta','infrastructureDelta',
    'negativeResidentBalances','badPayoutSplits','invalidAcceptances','rewardFeaturesEnabled',
    'withdrawalsEnabled','mainnetWriteEnabled','committedPayoutWriteEnabled']) {
    if (BigInt(sample[key]) !== 0n) throw new Error(`EXTERNAL2_GUARD_NONZERO_${key}`);
  }
  return sample;
}
let last = null, baseline = null;
for (let elapsed = 0; elapsed <= durationMinutes; elapsed += 1) {
    if (realpathSync('/opt/synterra/current') !== release) throw new Error('EXTERNAL2_GUARD_RELEASE_CHANGED');
    const process = service();
    if (process.ActiveState !== 'active' || Number(process.MainPID) <= 0) throw new Error('EXTERNAL2_GUARD_SERVICE_DOWN');
    if (baseline && (process.MainPID !== baseline.MainPID || process.NRestarts !== baseline.NRestarts)) {
      throw new Error('EXTERNAL2_GUARD_SERVICE_RESTARTED');
    }
    baseline ||= process;
    const sample = await readSample();
    if (last && (sample.worldMinute <= last.worldMinute || sample.tickCount <= last.tickCount)) {
      throw new Error('EXTERNAL2_GUARD_WORLD_TICK_FROZEN');
    }
    console.log(JSON.stringify({ event: 'external2_guard_sample', elapsedMinutes: elapsed,
      worldMinute: String(sample.worldMinute), tickCount: String(sample.tickCount),
      conservation: [sample.economyDelta,sample.oldJournalDelta,sample.newJournalDelta,sample.infrastructureDelta].map(String),
      negativeResidentBalances: sample.negativeResidentBalances,
      badPayoutSplits: sample.badPayoutSplits, invalidAcceptances: sample.invalidAcceptances,
      rewardFeaturesEnabled: sample.rewardFeaturesEnabled, withdrawalsEnabled: sample.withdrawalsEnabled,
      mainnetWriteEnabled: sample.mainnetWriteEnabled, committedPayoutWriteEnabled: sample.committedPayoutWriteEnabled,
      model: sample.model, servicePid: process.MainPID, serviceRestarts: process.NRestarts,
      rssBytes: rssBytes(process.MainPID) }));
    last = sample;
    if (elapsed < durationMinutes) await delay(60_000);
}
