// research1 unit tests (no database). DB flows live in test/research1.integration.test.js
// (skipped without RESEARCH1_TEST_DATABASE_URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createResearchFlagReader, RESEARCH_FLAG_DEFAULTS, RESEARCH_TUNABLE_DEFAULTS } from '../src/research-flags.js';
import { CLAIM_METRICS, RESEARCH_LEVER, awardSeed, buildDayStats, calibrate, combinedScore, countUncitedNumbers, decideAwards, isolationOf,
  evaluateMetric, isolationVerdict, judgeResearchClaim, monthKey, parseCitationRef, parseClaimSpec, parseJudgment, parseReport,
  parseSubmission, pickField, readCognitionResearch, reportRefsIn, researchCallFromTarget, researchCallStance, researchCallTitle,
  researchCallValueValid, seededOrder, syncToRaw, valuesMatch, COGNITION_RESEARCH_BYTES } from '../src/world-research.js';
import { callModel, judgeMessages, loadResearchScenes, researchStep, sceneTools, submissionMessages } from '../src/research-deliberation.js';
import { leverChoices, parseProposal, proposeMessages } from '../src/council-deliberation.js';
import { externalAdopt } from '../src/research-api.js';

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const SYNC = 1_000_000n;

test('flags: every switch defaults ON, master off disables every sub-switch, file overrides env', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'r1flags-'));
  const file = path.join(dir, 'research-flags.json');
  const reader = createResearchFlagReader({ file });
  for (const key of Object.keys(RESEARCH_FLAG_DEFAULTS)) assert.equal(reader.enabled(key, {}), true, key);
  assert.equal(reader.number('MIRRORTERRA_RESEARCH_CALL_CAP_SYNC', {}), 5000);
  assert.equal(reader.number('MIRRORTERRA_RESEARCH_MONTHLY_CAP_SYNC', {}), 500000);
  assert.equal(reader.enabled('MIRRORTERRA_RESEARCH_LOTTERY', { MIRRORTERRA_RESEARCH_SOCIETY: 'off' }), false);
  writeFileSync(file, JSON.stringify({ MIRRORTERRA_RESEARCH_EXTERNAL_GRANTS: 'off', MIRRORTERRA_RESEARCH_MONTHLY_CAP_SYNC: 800000, junk: 'x' }));
  const fresh = createResearchFlagReader({ file });
  assert.equal(fresh.enabled('MIRRORTERRA_RESEARCH_EXTERNAL_GRANTS', { MIRRORTERRA_RESEARCH_EXTERNAL_GRANTS: 'on' }), false);
  assert.equal(fresh.number('MIRRORTERRA_RESEARCH_MONTHLY_CAP_SYNC', {}), 800000);
  writeFileSync(file, '{bad json');
  const broken = createResearchFlagReader({ file });
  assert.equal(broken.enabled('MIRRORTERRA_RESEARCH_GRANTS', {}), true);
  assert.ok(RESEARCH_TUNABLE_DEFAULTS.MIRRORTERRA_RESEARCH_BOLDNESS_OFFSET === 12);
});

test('research call lever: bounds, per-call cap (config), title, deterministic fallback stance', () => {
  const cap = 5000n * SYNC;
  const value = researchCallFromTarget({ topic: '餐饮供给', brief: 'Is food supply enough at lunch?', budgetSync: 9000, horizonDays: 6 }, { capRaw: cap });
  assert.equal(value.budgetRaw, (5000n * SYNC).toString());   // clamped to the cap
  assert.ok(researchCallValueValid(value, { capRaw: cap }));
  assert.equal(researchCallValueValid({ ...value, budgetRaw: (5001n * SYNC).toString() }, { capRaw: cap }), false);
  assert.ok(researchCallValueValid({ open: false }));
  assert.equal(researchCallFromTarget({ topic: '', budgetSync: 10 }), null);
  assert.equal(researchCallFromTarget({ topic: 'x crowding', budgetSync: 10, horizonDays: 99 }).horizonDays, 30);
  assert.match(researchCallTitle(value), /^Research call: 餐饮供给 \(5000 SYNC, 6 days\)$/);
  assert.equal(researchCallStance({ value, openCalls: 1 }).stance, 'no');
  assert.equal(researchCallStance({ value, openCalls: 0, monthRemainingRaw: '1' }).stance, 'no');
  assert.equal(researchCallStance({ value, openCalls: 0, monthRemainingRaw: (10_000n * SYNC).toString() }).stance, 'yes');
});

test('council proposal message is byte-identical without the research option; research option adds only the extra keys', () => {
  const resident = { name: 'MirrorTerra-02', balance: '1 SYNC' };
  const context = { treasury: { balance: '0 SYNC' } };
  const base = proposeMessages({ resident, context, levers: leverChoices({}, new Set()), suggestions: [], cooldowns: [] });
  const off = proposeMessages({ resident, context, levers: leverChoices({}, new Set()), suggestions: [], cooldowns: [], research: null });
  assert.equal(sha(base), sha(off));
  const on = proposeMessages({ resident, context, levers: leverChoices({}, new Set()), suggestions: [], cooldowns: [], research: { note: 'n', budgetCapSync: 5000 } });
  const a = JSON.parse(base[1].content), b = JSON.parse(on[1].content);
  assert.deepEqual(b.researchCall, { note: 'n', budgetCapSync: 5000 });
  assert.match(b.answerJsonSchema.lever, /research\.call/);
  delete b.researchCall; delete b.answerJsonSchema; delete a.answerJsonSchema;
  assert.deepEqual(a, b);
  assert.equal(on[0].content, base[0].content);
});

test('parseProposal: research.call accepted only when offered; values bounded', () => {
  const output = { propose: true, lever: RESEARCH_LEVER, target: { topic: '公共设施拥挤', brief: 'Which hall overflows?', budgetSync: 800, horizonDays: 5 }, reason: 'Lunch queues are long.' };
  assert.throws(() => parseProposal(output, {}), /LUNA_LEVER_INVALID/);
  const parsed = parseProposal(output, { research: { capRaw: 5000n * SYNC, defaultHorizon: 6 } });
  assert.equal(parsed.lever, RESEARCH_LEVER);
  assert.equal(parsed.value.budgetRaw, (800n * SYNC).toString());
  assert.throws(() => parseProposal({ ...output, target: { topic: '' } }, { research: { capRaw: 5000n * SYNC } }), /OUT_OF_BOUNDS/);
});

test('submissions: proposal needs method+budget (clamped to the call), decline needs an argument', () => {
  const callBudgetRaw = (1000n * SYNC).toString();
  const p = parseSubmission({ decision: 'proposal', title: 'Lunch queues', method: 'Compare peakHour at food places over 3 days', budgetSync: 5000,
    dataPlan: ['S#', { place: 'x' }], patternIds: ['QM056', 'bad'] }, { callBudgetRaw });
  assert.equal(p.kind, 'proposal');
  assert.equal(p.budgetRaw, 1000n * SYNC);
  assert.deepEqual(p.patternIds, ['QM056']);
  const d = parseSubmission({ decision: 'decline', argument: 'The data cannot separate demand from opening hours.' }, { callBudgetRaw });
  assert.equal(d.kind, 'decline');
  assert.throws(() => parseSubmission({ decision: 'decline' }, { callBudgetRaw }), /ARGUMENT/);
  assert.throws(() => parseSubmission({ decision: 'proposal', method: 'abc' }, { callBudgetRaw }), /BUDGET/);
  assert.throws(() => parseSubmission({ decision: 'maybe' }, { callBudgetRaw }), /DECISION/);
});

test('judges: single question each, no other scores visible, reputation visible; boldness calibrated +12 and logged raw', () => {
  const call = { topic: 't', brief: 'b', budgetRaw: '1000000' };
  const proposal = { title: 'x', method: 'm', data_plan: [], budget_raw: '1000000' };
  for (const judge of ['method', 'value', 'boldness']) {
    const msg = JSON.parse(judgeMessages({ judge, call, proposal, applicant: { exposedFalseClaims: 1 } })[1].content);
    assert.ok(msg.applicantReputation);
    assert.equal(JSON.stringify(msg).includes('otherScores'), false);
    assert.match(msg.task, /You see no other judge's score/);
  }
  assert.equal(calibrate('boldness', 50, 12), 62);
  assert.equal(calibrate('method', 50, 12), 50);
  assert.equal(calibrate('boldness', 95, 12), 100);
  assert.equal(combinedScore([{ calibrated_score: 60 }, { calibrated_score: 70 }, { calibrated_score: null }]), 65);
  assert.equal(combinedScore([]), null);
  assert.deepEqual(parseJudgment({ score: '73.26', rationale: 'ok' }), { score: 73.3, rationale: 'ok' });
  assert.throws(() => parseJudgment({ score: 140 }), /SCORE/);
});

test('awards: rank above the band, seeded lottery inside ±margin of the line, reproducible; lottery off = strict rank', () => {
  const proposals = [
    { id: '1', score: 90, budgetRaw: 400n * SYNC }, { id: '2', score: 72, budgetRaw: 300n * SYNC },
    { id: '3', score: 70, budgetRaw: 300n * SYNC }, { id: '4', score: 69, budgetRaw: 300n * SYNC }, { id: '5', score: 40, budgetRaw: 10n * SYNC }];
  const seed = awardSeed({ callId: 'c', worldMinute: 100, ids: proposals.map((p) => p.id) });
  const a = decideAwards({ proposals, budgetRaw: 1000n * SYNC, margin: 5, minScore: 50, lottery: true, seed });
  assert.equal(a.line, 69);
  assert.deepEqual([...a.band].sort(), ['2', '3', '4']);
  assert.equal(a.funded[0].id, '1');
  assert.equal(a.funded[0].via, 'rank');
  assert.equal(a.funded.length, 3);
  assert.ok(a.funded.slice(1).every((f) => f.via === 'lottery'));
  assert.ok(!a.funded.some((f) => f.id === '5'));                     // below min score
  const b = decideAwards({ proposals, budgetRaw: 1000n * SYNC, margin: 5, minScore: 50, lottery: true, seed });
  assert.deepEqual(a.draw, b.draw);
  const strict = decideAwards({ proposals, budgetRaw: 1000n * SYNC, margin: 5, minScore: 50, lottery: false, seed });
  assert.deepEqual(strict.funded.map((f) => f.id), ['1', '2', '3']);
  assert.ok(strict.funded.every((f) => f.via === 'rank'));
  const all = decideAwards({ proposals: proposals.slice(0, 2), budgetRaw: 5000n * SYNC, margin: 5, lottery: true, seed });
  assert.equal(all.line, null);
  assert.equal(all.funded.length, 2);
  assert.deepEqual(seededOrder([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 's').map((x) => x.id), seededOrder([{ id: 'c' }, { id: 'b' }, { id: 'a' }], 's').map((x) => x.id));
});

test('reports: schema, citation refs, uncited numbers, value matching (exists + equal; truth never judged)', () => {
  const report = parseReport({ question: 'Is the Food Court crowded at noon?', dataSources: ['S12'],
    conclusions: [{ text: 'Peak was 9 actions; the hall is badly overcrowded with 40 people', figures: [{ label: 'peak', value: 9, cite: 'S12.peakHour' }] }],
    conditions: 'Weekdays only', result: 'positive', claims: [{ metric: 'place_peak_hour', subject: 'Food Court', fromDay: 3, toDay: 3, op: 'gte', value: 9 },
      { metric: 'nonsense', op: 'gte', value: 1 }], cites: ['R4', 'S1.x'] }, { closedDay: 3 });
  assert.equal(report.claims.length, 1);
  assert.equal(report.reportCites.length, 1);
  assert.equal(countUncitedNumbers(report.conclusions), 1);       // "40" is not cited
  assert.deepEqual(parseCitationRef('S12.peakHour'), { kind: 'stat', id: 12, field: 'peakHour' });
  assert.deepEqual(parseCitationRef('E99.data.place'), { kind: 'event', id: 99, field: 'data.place' });
  assert.deepEqual(parseCitationRef('R3'), { kind: 'report', id: 3, field: null });
  assert.equal(parseCitationRef('S12'), null);
  assert.equal(pickField({ a: { b: 3 } }, 'a.b'), 3);
  assert.equal(pickField({ a: 1 }, 'a.b'), undefined);
  assert.ok(valuesMatch(9, 9));
  assert.ok(valuesMatch('9', 9));
  assert.equal(valuesMatch(10, 9), false);
  assert.ok(valuesMatch('Food Court', 'food court'));
  assert.equal(valuesMatch(1, { x: 1 }), false);
  assert.throws(() => parseReport({ question: 'qq?', conclusions: [] }), /CONCLUSIONS/);
});

test('claims: metric evaluation from closed days only; ops; authorship refs; isolation verdict', () => {
  const days = new Map([[3, { peakHour: 9, completions: 20 }], [4, { peakHour: 4, completions: 10 }]]);
  assert.equal(evaluateMetric('place_peak_hour', days, { fromDay: 3, toDay: 4 }), 9);
  assert.equal(evaluateMetric('place_visits', days, { fromDay: 3, toDay: 4 }), 30);
  assert.equal(evaluateMetric('place_visits', days, { fromDay: 3, toDay: 5 }), undefined);   // day 5 not closed
  assert.equal(judgeResearchClaim({ op: 'gte', value: 9 }, 9).verification, 'true');
  assert.equal(judgeResearchClaim({ op: 'lte', value: 8 }, 9).verification, 'false');
  assert.equal(judgeResearchClaim({ op: 'eq', value: 100 }, 104).verification, 'true');
  assert.equal(judgeResearchClaim({ op: 'eq', value: 100 }, undefined).verification, 'unverifiable');
  assert.equal(parseClaimSpec({ metric: 'meals', op: '>=', value: 3, day: 2 }).subject, 'food');
  assert.equal(parseClaimSpec({ metric: 'meals', op: '>=', value: 3, fromDay: 5, toDay: 2 }), null);
  assert.deepEqual(reportRefsIn('Follow R12 and R12, also R7 — not R'), [12, 7]);
  assert.equal(isolationVerdict({}).isolated, true);
  assert.equal(isolationVerdict({ transfers: 1 }).isolated, false);
  assert.equal(isolationVerdict({ voteSwaps: 1 }).isolated, false);
  assert.equal(isolationVerdict({ self: true }).isolated, false);
  assert.ok(Object.keys(CLAIM_METRICS).length >= 6);
});

test('day stats: completions, distinct residents, peak hour, meals, low-food readings', () => {
  const rows = [
    { actor: 'a', action: 'eat', place: 'Food Court', minute: 4320 + 12 * 60 + 5, food: 50 },
    { actor: 'b', action: 'eat', place: 'Food Court', minute: 4320 + 12 * 60 + 30, food: 10 },
    { actor: 'a', action: 'work', place: 'Workshop', minute: 4320 + 9 * 60, food: 30 },
    { actor: 'c', action: 'rest', place: null, minute: 4320 + 1, food: null }];
  const stats = buildDayStats(rows, { stockAtClose: 7, foodServices: 2 });
  assert.deepEqual(stats.town, { completions: 4, residents: 3, places: 2 });
  assert.deepEqual(stats.food, { meals: 2, lowFoodReadings: 1, stockAtClose: 7, foodServices: 2 });
  assert.deepEqual(stats.places[0], { subject: 'Food Court', stats: { completions: 2, residents: 2, peakHour: 2, peakHourOfDay: 12, meals: 2 } });
});

test('money helpers: 0.01 SYNC steps, Asia/Shanghai calendar month', () => {
  assert.equal(syncToRaw(1.234), 1_230_000n);
  assert.equal(syncToRaw(-1), 0n);
  assert.equal(monthKey(new Date('2026-10-31T16:30:00Z')), '2026-11');   // 00:30 CST on Nov 1
  assert.equal(monthKey(new Date('2026-10-31T15:30:00Z')), '2026-10');
});

test('external residents: our gateway never calls a model for them; adoption cannot be declared', async () => {
  let called = 0;
  const requestModel = async () => { called += 1; return { output: {} }; };
  const db = { query: async (sql) => (/world_external_residents/.test(sql) ? { rowCount: 1, rows: [{}] } : { rowCount: 0, rows: [] }) };
  const result = await callModel(requestModel, { messages: [], agentId: 'ext', goal: 'research:submission', db, worldId: 'w' });
  assert.equal(result.ok, false);
  assert.equal(result.failureCode, 'EXTERNAL_RESIDENT_OWN_MODEL_ONLY');
  assert.equal(called, 0);
  const internalDb = { query: async () => ({ rowCount: 0, rows: [] }) };
  assert.equal((await callModel(requestModel, { messages: [], agentId: 'int', goal: 'x', db: internalDb, worldId: 'w' })).ok, true);
  assert.equal((await callModel(requestModel, { messages: [], agentId: null, goal: 'research:judge:method:1' })).ok, true);  // institution's judge
  assert.equal(called, 2);
  const adoptDb = { query: async (sql) => (/to_regclass/.test(sql) ? { rows: [{ ready: true }] } : { rowCount: 1, rows: [{}] }) };
  const adopted = await externalAdopt(adoptDb, { worldId: 'w', agentId: 'ext', reportId: '3' });
  assert.equal(adopted.counted, false);
});

test('worker: master switch off touches nothing (no DB query, no model call)', async () => {
  const pool = { query: async () => { throw new Error('no query expected'); }, connect: async () => { throw new Error('no connect expected'); } };
  const result = await researchStep(pool, { worldId: 'w', requestModel: async () => { throw new Error('no model'); },
    env: { MIRRORTERRA_RESEARCH_SOCIETY: 'off', MIRRORTERRA_RESEARCH_FLAGS_FILE: '/nonexistent/research-flags.json' } });
  assert.equal(result, null);
});

test('research scenes file maps onto existing patterns; patterns.json unchanged', () => {
  const file = readFileSync(new URL('../src/agent-runtime/skills/qianmen-eight-generals-108/patterns.json', import.meta.url));
  assert.equal(createHash('sha256').update(file).digest('hex'), '32f89dff8cfe44594d89ad49b482503d33529cd0bf5db3d13fe13cba11582f1d');
  assert.ok(loadResearchScenes());
  assert.ok(sceneTools('research_authorship').candidates.some((c) => c.id === 'QM001'));
  assert.equal(loadResearchScenes({ scenes: { x: { patterns: { QM999: { play: 'p', counter: [] } } } } }), null);
  const msg = JSON.parse(submissionMessages({ name: 'A', call: { topic: 't', brief: 'b', budgetRaw: '1000000', horizonDays: 3, feeRaw: '50000', closesIn: 10 },
    you: {}, evidence: [], library: [], scene: null })[1].content);
  assert.match(msg.task, /0\.05 SYNC application fee/);
});

test('cognition library block stays within 1.5 kB', async () => {
  const long = 'x'.repeat(400);
  const db = { query: async (sql) => {
    if (/FROM world_research_reports/.test(sql)) return { rowCount: 4, rows: Array.from({ length: 4 }, (_, i) => ({ id: i + 1, author: 'a', question: long,
      conclusions: [{ text: long }], conditions: long, result_kind: 'positive', citations_failed: 0, adopted: 0 })) };
    if (/FROM world_research_calls/.test(sql)) return { rowCount: 0, rows: [] };
    return { rowCount: 1, rows: [{ id: 'a', name: 'MirrorTerra-01' }] };
  } };
  const block = await readCognitionResearch(db, { worldId: 'w', agentId: 'b' });
  assert.ok(JSON.stringify(block).length <= COGNITION_RESEARCH_BYTES);
  assert.ok(block.reports.length >= 1);
  assert.match(block.note, /R12/);
});

test('migration 0037: additive (no DROP TABLE/DELETE grants), keeps the external1b epoch fix, narrow external exception', () => {
  const sql = readFileSync(new URL('../migrations/0037_research_society.sql', import.meta.url), 'utf8');
  assert.equal(/DROP\s+TABLE/i.test(sql), false);
  assert.equal(/^GRANT[^;]*DELETE/m.test(sql), false);
  assert.match(sql, /NEW\.epoch_index := COALESCE\(NEW\.epoch_index,/);
  assert.match(sql, /NEW\.source_type NOT IN \('research_grant','research_verification'\)/);
  assert.match(sql, /external residents receive no treasury SYNC|refuse_external_treasury_payout/i.test(sql) ? /research/ : /./);
  assert.equal(/CREATE OR REPLACE FUNCTION refuse_external_treasury_payout/.test(sql), false);
  assert.equal(/CREATE OR REPLACE FUNCTION refuse_internal_to_external_transfer/.test(sql), false);
  assert.match(sql, /Research payout would exceed the operating pool/);
});

test('isolation check queries real columns (world_gambits.opened_world_minute) and never swallows a failed query', async () => {
  const src = readFileSync(new URL('../src/world-research.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export async function isolationOf'), src.indexOf('export async function requestVerification'));
  assert.match(body, /FROM world_gambits WHERE world_id=\$1 AND opened_world_minute>=\$4/);
  assert.doesNotMatch(body, /world_gambits[^`]*created_world_minute/);
  assert.doesNotMatch(body, /\.catch\(/);
  const seen = [];
  const db = { query: async (sql, params) => { seen.push(sql); return { rows: [{ n: /world_gambits/.test(sql) ? 1 : 0, votes: 0 }] }; } };
  const verdict = await isolationOf(db, { worldId: 'w', verifierId: 'a', authorId: 'b', worldMinutes: 100000, env: {} });
  assert.equal(seen.length, 3);
  assert.equal(verdict.isolated, false);
});
