// Read-only production guard. A nonzero exit means rollback is required by the release operator.
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { readExternal2GuardSample } from '../src/external2-guard.js';

const worldId = process.env.EXTERNAL2_GUARD_WORLD_ID;
const release = process.env.EXTERNAL2_GUARD_RELEASE;
const connectionString = process.env.SYNTERRA_GUARD_DATABASE_URL;
if (!/^[0-9a-f-]{36}$/i.test(String(worldId || '')) || !release || !connectionString) {
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
const db = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 });
let last = null, baseline = null;
try {
  for (let elapsed = 0; elapsed <= durationMinutes; elapsed += 1) {
    if (realpathSync('/opt/synterra/current') !== release) throw new Error('EXTERNAL2_GUARD_RELEASE_CHANGED');
    const process = service();
    if (process.ActiveState !== 'active' || Number(process.MainPID) <= 0) throw new Error('EXTERNAL2_GUARD_SERVICE_DOWN');
    if (baseline && (process.MainPID !== baseline.MainPID || process.NRestarts !== baseline.NRestarts)) {
      throw new Error('EXTERNAL2_GUARD_SERVICE_RESTARTED');
    }
    baseline ||= process;
    const sample = await readExternal2GuardSample(db, worldId);
    if (last && (sample.worldMinute <= last.worldMinute || sample.tickCount <= last.tickCount)) {
      throw new Error('EXTERNAL2_GUARD_WORLD_TICK_FROZEN');
    }
    console.log(JSON.stringify({ event: 'external2_guard_sample', elapsedMinutes: elapsed,
      worldMinute: String(sample.worldMinute), tickCount: String(sample.tickCount),
      conservation: [sample.economyDelta,sample.oldJournalDelta,sample.newJournalDelta,sample.infrastructureDelta].map(String),
      negativeResidentBalances: sample.negativeResidentBalances,
      badPayoutSplits: sample.badPayoutSplits, invalidAcceptances: sample.invalidAcceptances,
      model: sample.model, servicePid: process.MainPID, serviceRestarts: process.NRestarts,
      rssBytes: rssBytes(process.MainPID) }));
    last = sample;
    if (elapsed < durationMinutes) await delay(60_000);
  }
} finally { await db.end(); }
