// research1: switches and tunables for the research society (第二关 v1). Every switch defaults ON after deploy;
// switching one off returns the pre-research1 behaviour for that piece. Values come from the process env and can
// be overridden WITHOUT a restart by a JSON file (MIRRORTERRA_RESEARCH_FLAGS_FILE, default
// <state dir>/research-flags.json), e.g. {"MIRRORTERRA_RESEARCH_LOTTERY":"off","MIRRORTERRA_RESEARCH_MONTHLY_CAP_SYNC":800000}.
// The file is re-read at most every 15 s; a missing or invalid file means env only. gambit-flags.json is not used.
//   MIRRORTERRA_RESEARCH_SOCIETY          master: off = no worker steps, no council research lever, no context block,
//                                         no library payload, no external research endpoints (pre-research1 behaviour)
//   MIRRORTERRA_RESEARCH_COUNCIL          the council may propose/vote research calls (research.call lever)
//   MIRRORTERRA_RESEARCH_GRANTS           grant / verification payouts (pool-backed entitlements); off = no new SYNC
//   MIRRORTERRA_RESEARCH_EXTERNAL_GRANTS  external residents may receive research grants and verification rewards
//   MIRRORTERRA_RESEARCH_LOTTERY          seeded lottery band near the funding line; off = strict rank order
//   MIRRORTERRA_RESEARCH_VERIFICATION     skeptic verification of report claims
//   MIRRORTERRA_RESEARCH_ADOPTION         adoption scan (executed plan steps referencing a report)
//   MIRRORTERRA_RESEARCH_PLAGIARISM       authorship claims (plagiarism is allowed; exposure is a heavy penalty)
//   MIRRORTERRA_RESEARCH_COGNITION        published-report block in open-cognition context
//   MIRRORTERRA_RESEARCH_LIBRARY          public library endpoints / site section
//   MIRRORTERRA_RESEARCH_EXTERNAL_API     signed external research endpoints
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './agent-runtime/client.js';

export const RESEARCH_FLAG_DEFAULTS = Object.freeze({
  MIRRORTERRA_RESEARCH_SOCIETY: 'on',
  MIRRORTERRA_RESEARCH_COUNCIL: 'on',
  MIRRORTERRA_RESEARCH_GRANTS: 'on',
  MIRRORTERRA_RESEARCH_EXTERNAL_GRANTS: 'on',
  MIRRORTERRA_RESEARCH_LOTTERY: 'on',
  MIRRORTERRA_RESEARCH_VERIFICATION: 'on',
  MIRRORTERRA_RESEARCH_ADOPTION: 'on',
  MIRRORTERRA_RESEARCH_PLAGIARISM: 'on',
  MIRRORTERRA_RESEARCH_COGNITION: 'on',
  MIRRORTERRA_RESEARCH_LIBRARY: 'on',
  MIRRORTERRA_RESEARCH_EXTERNAL_API: 'on'
});
export const RESEARCH_TUNABLE_DEFAULTS = Object.freeze({
  MIRRORTERRA_RESEARCH_CALL_CAP_SYNC: 5_000,          // max budget of one call (user decision 2026-10-24)
  MIRRORTERRA_RESEARCH_MONTHLY_CAP_SYNC: 500_000,     // max research payouts per calendar month (Asia/Shanghai)
  MIRRORTERRA_RESEARCH_FEE_RAW: 50_000,               // 0.05 SYNC application fee per proposal, paid to the treasury
  MIRRORTERRA_RESEARCH_DEFAULT_HORIZON_DAYS: 6,
  MIRRORTERRA_RESEARCH_MAX_OPEN_CALLS: 1,             // one call at a time (cost + attention)
  MIRRORTERRA_RESEARCH_PROPOSAL_WINDOW_MINUTES: 1_440,// world minutes residents have to propose/decline
  MIRRORTERRA_RESEARCH_LOTTERY_MARGIN: 5,             // score points around the funding line
  MIRRORTERRA_RESEARCH_MIN_SCORE: 50,                 // combined score below this is never funded
  MIRRORTERRA_RESEARCH_BOLDNESS_OFFSET: 12,           // boldness judge calibration (+12, paper: ~12/100 lower)
  MIRRORTERRA_RESEARCH_UPFRONT_PCT: 50,               // share of a grant paid at award; rest on a cited report
  MIRRORTERRA_RESEARCH_REPORT_AFTER_MINUTES: 1_440,   // a grantee writes the report after this much world time
  MIRRORTERRA_RESEARCH_CONFERENCE_EVERY_DAYS: 2,      // 汇报会 every K world days
  MIRRORTERRA_RESEARCH_ISOLATION_DAYS: 3,             // verifier: no alliance/transfer/vote swap/commitment with author
  MIRRORTERRA_RESEARCH_VERIFY_DELAY_MINUTES: 30,      // same time cost as gambit verification
  MIRRORTERRA_RESEARCH_VERIFY_FEE_RAW: 10_000,        // same SYNC cost as gambit verification (to the author if true)
  MIRRORTERRA_RESEARCH_EXPOSURE_REWARD_RAW: 1_000_000,    // 1 SYNC to a verifier who exposes a false claim
  MIRRORTERRA_RESEARCH_REPLICATION_REWARD_RAW: 500_000,   // 0.5 SYNC to the first verifier confirming a claim
  MIRRORTERRA_RESEARCH_MAX_JUDGED_PER_CALL: 12,
  MIRRORTERRA_RESEARCH_INTERVAL_MS: 20_000
});
const OFF = /^(off|0|false|disabled|no)$/i;
const ON = /^(on|1|true|enabled|yes)$/i;
const RELOAD_MS = 15_000;

export function defaultResearchFlagFile(env = process.env) {
  if (env?.MIRRORTERRA_RESEARCH_FLAGS_FILE) return env.MIRRORTERRA_RESEARCH_FLAGS_FILE;
  return path.join(STATE_DIR, 'research-flags.json');
}

export function createResearchFlagReader({ file = null, now = () => Date.now() } = {}) {
  let cache = { at: -Infinity, mtime: null, values: {}, file: null };
  function overrides(env) {
    const target = file || defaultResearchFlagFile(env);
    const t = now();
    if (cache.file === target && t - cache.at < RELOAD_MS) return cache.values;
    let values = {}, mtime = null;
    try {
      const stat = statSync(target);
      mtime = `${stat.mtimeMs}:${stat.size}`;
      if (cache.file === target && cache.mtime === mtime) values = cache.values;
      else {
        const parsed = JSON.parse(readFileSync(target, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed)) {
            if ((key in RESEARCH_FLAG_DEFAULTS || key in RESEARCH_TUNABLE_DEFAULTS)
              && ['string', 'number', 'boolean'].includes(typeof value)) values[key] = String(value);
          }
        }
      }
    } catch { values = {}; mtime = null; }
    cache = { at: t, mtime, values, file: target };
    return values;
  }
  function raw(key, env = process.env) {
    const fileValues = overrides(env);
    if (Object.hasOwn(fileValues, key)) return fileValues[key];
    if (env && env[key] !== undefined && env[key] !== '') return String(env[key]);
    return key in RESEARCH_FLAG_DEFAULTS ? RESEARCH_FLAG_DEFAULTS[key]
      : key in RESEARCH_TUNABLE_DEFAULTS ? String(RESEARCH_TUNABLE_DEFAULTS[key]) : undefined;
  }
  function switchOn(key, env = process.env) {
    const value = String(raw(key, env) ?? '').trim();
    if (OFF.test(value)) return false;
    if (ON.test(value)) return true;
    return !OFF.test(RESEARCH_FLAG_DEFAULTS[key] || 'off');
  }
  // A sub-switch is effective only while the master switch is on.
  function enabled(key, env = process.env) {
    if (key !== 'MIRRORTERRA_RESEARCH_SOCIETY' && !switchOn('MIRRORTERRA_RESEARCH_SOCIETY', env)) return false;
    return switchOn(key, env);
  }
  function number(key, env = process.env) {
    const value = Number(raw(key, env));
    return Number.isFinite(value) && value >= 0 ? value : RESEARCH_TUNABLE_DEFAULTS[key];
  }
  function snapshot(env = process.env) {
    return { ...Object.fromEntries(Object.keys(RESEARCH_FLAG_DEFAULTS).map((key) => [key, enabled(key, env)])),
      callCapSync: number('MIRRORTERRA_RESEARCH_CALL_CAP_SYNC', env),
      monthlyCapSync: number('MIRRORTERRA_RESEARCH_MONTHLY_CAP_SYNC', env),
      overrideFile: Object.keys(overrides(env)).length > 0 };
  }
  return { raw, enabled, number, snapshot, reset: () => { cache = { at: -Infinity, mtime: null, values: {}, file: null }; } };
}

const shared = createResearchFlagReader();
export const researchFlag = (key, env = process.env) => shared.enabled(key, env);
export const researchNumber = (key, env = process.env) => shared.number(key, env);
export const researchFlagSnapshot = (env = process.env) => shared.snapshot(env);
export const researchSocietyEnabled = (env = process.env) => shared.enabled('MIRRORTERRA_RESEARCH_SOCIETY', env);
export const researchCouncilEnabled = (env = process.env) => shared.enabled('MIRRORTERRA_RESEARCH_COUNCIL', env);
export const researchCognitionEnabled = (env = process.env) => shared.enabled('MIRRORTERRA_RESEARCH_COGNITION', env);
export const researchLibraryEnabled = (env = process.env) => shared.enabled('MIRRORTERRA_RESEARCH_LIBRARY', env);
export const researchExternalApiEnabled = (env = process.env) => shared.enabled('MIRRORTERRA_RESEARCH_EXTERNAL_API', env);
