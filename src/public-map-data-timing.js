import { performance } from 'node:perf_hooks';

export function createPublicMapDataTiming(monotonicNow = () => performance.now()) {
  const phases = {};
  return {
    async measure(name, task) {
      const started = monotonicNow();
      try { return await task(); }
      finally { phases[name] = (phases[name] || 0) + monotonicNow() - started; }
    },
    set(name, value) {
      if (Number.isFinite(value)) phases[name] = value;
    },
    snapshot() {
      return Object.fromEntries(Object.entries(phases).map(([name, value]) => [name, Number(value.toFixed(3))]));
    },
    now: monotonicNow
  };
}
