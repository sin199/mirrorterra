// skillwork (fix 4): a provider quota error (HTTP 400 insufficient_user_quota, or HTTP 429) pauses ALL Luna
// calls of this process (open cognition, memory selection, council deliberation) with exponential backoff:
// 5 min, 10, 20, 40, then 60 min at most; the first success resets it. A paused call fails fast with
// LUNA_QUOTA_BACKOFF before the budget gateway, so callers take their unchanged fallback path. One log line
// per backoff change (paused / extended / resumed), never one per call.
// Kill switch MIRRORTERRA_LUNA_QUOTA_BACKOFF=off: no pause at all (old behaviour).
export const LUNA_BACKOFF_START_MS = 5 * 60_000;
export const LUNA_BACKOFF_CAP_MS = 60 * 60_000;
export const LUNA_QUOTA_BACKOFF_CODE = 'LUNA_QUOTA_BACKOFF';

export function lunaQuotaBackoffEnabled(env = process.env) {
  return String(env?.MIRRORTERRA_LUNA_QUOTA_BACKOFF ?? 'on').toLowerCase() !== 'off';
}

export function isQuotaError(error) {
  if (!error || typeof error !== 'object') return false;
  const status = Number(error.status);
  if (status === 429) return true;
  const text = `${error.providerErrorCode || ''} ${error.code || ''}`.toLowerCase();
  return status === 400 && /insufficient_user_quota/.test(text);
}

export function nextBackoffMs(previousMs = 0, { startMs = LUNA_BACKOFF_START_MS, capMs = LUNA_BACKOFF_CAP_MS } = {}) {
  const previous = Number(previousMs) || 0;
  return previous > 0 ? Math.min(capMs, previous * 2) : Math.min(capMs, startMs);
}

export function createQuotaBackoff({ now = () => Date.now(), log = null, env = null,
  startMs = LUNA_BACKOFF_START_MS, capMs = LUNA_BACKOFF_CAP_MS } = {}) {
  let delayMs = 0;
  let pausedUntil = 0;
  let pauses = 0;
  let skipped = 0;
  let logger = log;
  const enabled = () => lunaQuotaBackoffEnabled(env || process.env);
  const emit = (record) => {
    try { (logger || ((item) => console.warn(JSON.stringify({ event: 'luna_quota_backoff', ...item }))))(record); }
    catch { /* logging never breaks a model call */ }
  };
  return {
    setLogger(fn) { logger = typeof fn === 'function' ? fn : null; },
    // Throws LUNA_QUOTA_BACKOFF while paused.
    check() {
      if (!enabled()) return;
      const current = now();
      if (current < pausedUntil) {
        skipped += 1;
        throw Object.assign(new Error(LUNA_QUOTA_BACKOFF_CODE), { code: LUNA_QUOTA_BACKOFF_CODE, status: null,
          nextAdmissionPossibleAt: new Date(pausedUntil).toISOString(), retryInMs: pausedUntil - current });
      }
    },
    // Returns true when this failure started or extended a pause.
    onFailure(error) {
      if (!enabled() || !isQuotaError(error)) return false;
      const current = now();
      if (current < pausedUntil) return false; // a call already in flight when the pause began
      const previous = delayMs;
      delayMs = nextBackoffMs(delayMs, { startMs, capMs });
      pausedUntil = current + delayMs;
      pauses += 1;
      emit({ event: previous ? 'extended' : 'paused', pauseMinutes: Math.round(delayMs / 60_000),
        until: new Date(pausedUntil).toISOString(), httpStatus: Number(error.status) || null,
        providerErrorCode: String(error.providerErrorCode || '').slice(0, 64) || null, skippedCalls: skipped });
      return true;
    },
    onSuccess() {
      if (!delayMs) return false;
      emit({ event: 'resumed', previousPauseMinutes: Math.round(delayMs / 60_000), skippedCalls: skipped });
      delayMs = 0; pausedUntil = 0; skipped = 0;
      return true;
    },
    status() {
      const current = now();
      return { enabled: enabled(), paused: current < pausedUntil, pauseMs: delayMs,
        pausedUntil: pausedUntil ? new Date(pausedUntil).toISOString() : null, pauses, skippedCalls: skipped };
    },
    reset() { delayMs = 0; pausedUntil = 0; pauses = 0; skipped = 0; }
  };
}

// One shared breaker per process: every Luna router uses it.
export const lunaQuotaBackoff = createQuotaBackoff();
export function setLunaQuotaBackoffLogger(fn) { lunaQuotaBackoff.setLogger(fn); }
