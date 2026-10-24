// modelab1: per-resident model A/B (claude-haiku-5.5 vs gpt-6-luna): cohort split, kill switch,
// challenger fallback, model attribution, Claude response parsing, and the additive migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLAUDE_CASING_HINT, createCognitionModelRouter, configuredCognitionCatalog, isShoutedObject,
  normalizeShoutedObject, parseCompletionObject } from '../src/agent-runtime/open-cognition/provider.js';
import { MODEL_AB_COHORTS, MODEL_AB_CHALLENGER, MODEL_AB_CONTROL, MODEL_AB_DEFAULT_MAX_PROMPT_BYTES, MODEL_AB_MIN_OUTPUT_TOKENS,
  challengerFallbackReason, createModelAbRouting, modelAbEnabled, modelAbMaxPromptBytes, modelAbStatus,
  resolveCohortModel } from '../src/agent-runtime/open-cognition/model-ab.js';
import { createQuotaBackoff } from '../src/agent-runtime/open-cognition/quota-backoff.js';
import { callLuna, createCouncilModelRouter, modelTag } from '../src/council-deliberation.js';
import { COUNCIL_GOVERNOR_ID } from '../src/council.js';
import { createBaiBudgetGateway } from '../src/agent-runtime/bai-budget.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const idOf = (name) => Object.entries(MODEL_AB_COHORTS).find(([, entry]) => entry.name === name)[0];
const GOV = idOf('MirrorTerra-01');
const R02 = idOf('MirrorTerra-02');
const R08 = idOf('MirrorTerra-08');
const MESSAGES = [{ role: 'system', content: 'Return one JSON object.' }, { role: 'user', content: 'json please' }];

function envelope(model, content, status = 200) {
  const body = status === 200
    ? { model, choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }
    : { error: { code: status === 429 ? 'rate_limit_exceeded' : 'insufficient_user_quota', message: 'x' } };
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function harness({ env = {}, reply = null } = {}) {
  const sent = [];
  const gateway = [];
  let clock = 1_000;
  const luna = createQuotaBackoff({ now: () => clock, log: () => {}, env: {} });
  const haiku = createQuotaBackoff({ now: () => clock, log: () => {}, env: {} });
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    sent.push(body);
    if (reply) return reply(body, sent.length);
    return envelope(body.model, '{"ok":true}');
  };
  const budgetGateway = { runRequest: async (input, send) => { gateway.push(input); return send(); } };
  const router = createCognitionModelRouter({ apiKey: 'fixture', catalog: configuredCognitionCatalog('gpt-6-luna'),
    fetchImpl, budgetGateway, worldId: 'w', quotaBackoff: luna,
    modelAb: createModelAbRouting({ env, backoff: haiku }) });
  return { router, sent, gateway, luna, haiku, tick: (ms) => { clock += ms; } };
}
const call = (router, agentId, extra = {}) => router({ tier: 'routine', messages: MESSAGES, trigger: 'council_deliberation',
  callContext: { agentId }, ...extra });

test('cohort split: 10 residents, 5 haiku / 5 luna, governor and the two busiest builders not in one group', () => {
  const entries = Object.values(MODEL_AB_COHORTS);
  assert.equal(entries.length, 10);
  assert.equal(new Set(entries.map((entry) => entry.name)).size, 10);
  const haiku = entries.filter((entry) => entry.model === MODEL_AB_CHALLENGER).map((entry) => entry.name).sort();
  const luna = entries.filter((entry) => entry.model === MODEL_AB_CONTROL).map((entry) => entry.name).sort();
  assert.deepEqual(haiku, ['MirrorTerra-01', 'MirrorTerra-03', 'MirrorTerra-05', 'MirrorTerra-07', 'MirrorTerra-08']);
  assert.deepEqual(luna, ['MirrorTerra-02', 'MirrorTerra-04', 'MirrorTerra-06', 'MirrorTerra-09', 'MirrorTerra-10']);
  assert.equal(GOV, COUNCIL_GOVERNOR_ID, 'the governor id in the split is the council governor');
  assert.notEqual(MODEL_AB_COHORTS[R08].model, MODEL_AB_COHORTS[idOf('MirrorTerra-09')].model);
  const builders = entries.filter((entry) => entry.role === 'builder');
  assert.equal(builders.filter((entry) => entry.model === MODEL_AB_CHALLENGER).length, 2);
  assert.equal(builders.filter((entry) => entry.model === MODEL_AB_CONTROL).length, 2);
  // Stable: the same agent always gets the same model, for every kind of call.
  for (let index = 0; index < 3; index += 1) {
    assert.deepEqual(resolveCohortModel(GOV, { env: {} }), { model: MODEL_AB_CHALLENGER, cohort: 'haiku' });
    assert.deepEqual(resolveCohortModel(R02, { env: {} }), { model: MODEL_AB_CONTROL, cohort: 'luna' });
  }
  assert.deepEqual(resolveCohortModel(GOV.toUpperCase(), { env: {} }), { model: MODEL_AB_CHALLENGER, cohort: 'haiku' });
  assert.deepEqual(resolveCohortModel('c0c95ab1-e08c-4e06-bc99-f188730089e5', { env: {} }), { model: 'gpt-6-luna', cohort: null },
    'external / unknown residents keep the configured model');
  assert.deepEqual(resolveCohortModel(null, { env: {} }), { model: 'gpt-6-luna', cohort: null });
  assert.deepEqual(resolveCohortModel(GOV, { env: {}, baseModel: 'claude-sonnet-5.5' }), { model: 'claude-sonnet-5.5', cohort: null },
    'an explicit OPEN_COGNITION_MODEL=claude-* is not overridden');
});

test('kill switch MIRRORTERRA_MODEL_AB: default on; off|0|false|disabled -> everyone on Luna', async () => {
  assert.equal(modelAbEnabled({}), true);
  assert.equal(modelAbEnabled({ MIRRORTERRA_MODEL_AB: 'on' }), true);
  for (const value of ['off', 'OFF', '0', 'false', 'disabled', ' off ']) {
    assert.equal(modelAbEnabled({ MIRRORTERRA_MODEL_AB: value }), false, value);
    assert.deepEqual(resolveCohortModel(GOV, { env: { MIRRORTERRA_MODEL_AB: value } }), { model: 'gpt-6-luna', cohort: null });
  }
  const off = harness({ env: { MIRRORTERRA_MODEL_AB: 'off' } });
  const result = await call(off.router, GOV);
  assert.equal(off.sent[0].model, 'gpt-6-luna');
  assert.deepEqual(off.sent[0].response_format, { type: 'json_object' });
  assert.equal(result.abCohort, null);
  assert.equal(off.gateway[0].abCohort, null);
  assert.equal(modelAbStatus({ MIRRORTERRA_MODEL_AB: 'off' }).cohorts['MirrorTerra-01'], 'luna');
  assert.equal(modelAbStatus({}).cohorts['MirrorTerra-01'], 'haiku');
});

test('attribution: each call carries its model and cohort to the budget ledger and the result', async () => {
  const h = harness();
  const haiku = await call(h.router, GOV);
  const luna = await call(h.router, R02);
  assert.equal(h.sent[0].model, MODEL_AB_CHALLENGER);
  assert.equal(h.sent[0].response_format, undefined, 'Claude gets no json_object response_format');
  assert.equal(h.sent[1].model, 'gpt-6-luna');
  assert.deepEqual(h.sent[1].response_format, { type: 'json_object' });
  assert.deepEqual(h.gateway.map((input) => [input.model, input.abCohort, input.fallbackFromModel, input.fallbackReason]),
    [[MODEL_AB_CHALLENGER, 'haiku', null, null], ['gpt-6-luna', 'luna', null, null]]);
  assert.equal(haiku.requestedModel, MODEL_AB_CHALLENGER);
  assert.equal(haiku.abCohort, 'haiku');
  assert.equal(haiku.fallbackFrom, null);
  assert.equal(luna.requestedModel, 'gpt-6-luna');
  assert.equal(luna.abCohort, 'luna');
  // Claude gets the casing hint and at least MODEL_AB_MIN_OUTPUT_TOKENS; the Luna request is unchanged.
  assert.equal(h.sent[0].messages.at(-1).content, CLAUDE_CASING_HINT);
  assert.equal(h.sent[0].max_tokens, 3_000, 'a larger budget is kept');
  assert.deepEqual(h.sent[1].messages, MESSAGES);
  assert.equal(h.sent[1].max_tokens, 3_000);
  const small = harness();
  await call(small.router, GOV, { maxTokens: 700 });
  await call(small.router, R02, { maxTokens: 700 });
  assert.deepEqual(small.sent.map((body) => body.max_tokens), [MODEL_AB_MIN_OUTPUT_TOKENS, 700]);
  assert.deepEqual(small.gateway.map((input) => input.maxTokens), [MODEL_AB_MIN_OUTPUT_TOKENS, 700],
    'the ledger reserves the real output budget');
  // Memory selection (tier memory) and planning (tier sonnet) use the same per-resident model.
  await h.router({ tier: 'memory', messages: MESSAGES, trigger: 'memory_selection', callContext: { agentId: GOV } });
  await h.router({ tier: 'planning', messages: MESSAGES, trigger: 'scheduled', callContext: { agentId: GOV } });
  assert.deepEqual(h.sent.slice(2).map((body) => body.model), [MODEL_AB_CHALLENGER, MODEL_AB_CHALLENGER]);
});

test('fallback: a haiku 429 falls back to Luna once, is recorded, and pauses only the haiku breaker', async () => {
  const h = harness({ reply: (body) => (body.model === MODEL_AB_CHALLENGER ? envelope(body.model, '', 429)
    : envelope(body.model, '{"ok":true}')) });
  const result = await call(h.router, GOV);
  assert.deepEqual(result.output, { ok: true });
  assert.deepEqual(h.sent.map((body) => body.model), [MODEL_AB_CHALLENGER, 'gpt-6-luna']);
  assert.equal(result.requestedModel, 'gpt-6-luna');
  assert.equal(result.fallbackFrom, MODEL_AB_CHALLENGER);
  assert.equal(result.fallbackReason, 'challenger_429');
  assert.equal(result.abCohort, 'haiku', 'the fallback call stays attributed to the haiku cohort');
  assert.deepEqual(h.gateway.map((input) => [input.model, input.abCohort, input.fallbackFromModel, input.fallbackReason]),
    [[MODEL_AB_CHALLENGER, 'haiku', null, null], ['gpt-6-luna', 'haiku', MODEL_AB_CHALLENGER, 'challenger_429']]);
  assert.equal(h.haiku.status().paused, true);
  assert.equal(h.luna.status().paused, false, 'a haiku 429 never pauses the Luna cohort');
  // While the haiku breaker is paused, haiku-cohort calls go straight to Luna: no haiku request at all.
  const paused = await call(h.router, GOV);
  assert.deepEqual(h.sent.slice(2).map((body) => body.model), ['gpt-6-luna']);
  assert.equal(paused.fallbackReason, 'challenger_backoff');
  // The Luna cohort is unaffected.
  await call(h.router, R02);
  assert.equal(h.sent.at(-1).model, 'gpt-6-luna');
});

test('fallback: quota / network / HTTP 5xx; no fallback for budget gates or parse failures', async () => {
  assert.equal(challengerFallbackReason({ status: 400, providerErrorCode: 'insufficient_user_quota', code: 'provider_request_failed' },
    { providerStarted: true }), 'challenger_quota');
  assert.equal(challengerFallbackReason({ status: null, code: 'BAI_COMPLETION_UNAVAILABLE' }, { providerStarted: true }), 'challenger_unavailable');
  assert.equal(challengerFallbackReason({ status: 503, code: 'provider_request_failed' }, { providerStarted: true }), 'challenger_http_503');
  assert.equal(challengerFallbackReason({ code: 'provider_model_unsupported', status: 404 }, { providerStarted: true }), 'challenger_unavailable');
  assert.equal(challengerFallbackReason({ code: 'BAI_COMPLETION_CONTENT_INVALID', status: 200 }, { providerStarted: true }), 'challenger_content_invalid');
  assert.equal(challengerFallbackReason({ code: 'MODEL_HOURLY_RATE_LIMITED' }, { providerStarted: false }), null);
  assert.equal(challengerFallbackReason({ code: 'BAI_COMPLETION_NOT_JSON', status: 200 }, { providerStarted: true }), null);
  assert.equal(challengerFallbackReason({ code: 'BAI_BUDGET_LEASE_LOST' }, { providerStarted: true }), null);

  let first = true;
  const network = harness({ reply: (body) => {
    if (body.model === MODEL_AB_CHALLENGER && first) { first = false; throw new TypeError('fetch failed'); }
    return envelope(body.model, '{"ok":1}');
  } });
  const result = await call(network.router, GOV);
  assert.equal(result.fallbackReason, 'challenger_unavailable');
  assert.equal(network.haiku.status().paused, false, 'a network error is not a quota error: no pause');

  // A budget/rate gate before the provider is not a model failure: no fallback, the caller sees the gate.
  const gated = harness();
  const blocked = createCognitionModelRouter({ apiKey: 'fixture', catalog: configuredCognitionCatalog('gpt-6-luna'),
    fetchImpl: async () => { throw new Error('must not fetch'); },
    budgetGateway: { runRequest: async () => { throw Object.assign(new Error('MODEL_HOURLY_RATE_LIMITED'), { code: 'MODEL_HOURLY_RATE_LIMITED' }); } },
    quotaBackoff: gated.luna, modelAb: createModelAbRouting({ env: {}, backoff: gated.haiku }) });
  await assert.rejects(call(blocked, GOV), (error) => error.code === 'MODEL_HOURLY_RATE_LIMITED');
});

test('Claude formats: fenced / prefixed JSON parses; unparseable output is repaired on the SAME model', async () => {
  assert.deepEqual(parseCompletionObject('```json\n{"propose":true,"lever":"tax.trade"}\n```'), { propose: true, lever: 'tax.trade' });
  assert.deepEqual(parseCompletionObject('Here is my decision:\n{"bid":false,"reason":"busy {sic}"}\nThanks.'), { bid: false, reason: 'busy {sic}' });
  assert.deepEqual(parseCompletionObject('```\n{"votes":[{"id":"P1","stance":"yes"}]}\n```'), { votes: [{ id: 'P1', stance: 'yes' }] });
  const fenced = harness({ reply: (body) => envelope(body.model, '```json\n{"ok":true}\n```') });
  assert.deepEqual((await call(fenced.router, GOV)).output, { ok: true });
  const repaired = harness({ reply: (body, n) => envelope(body.model, n === 1 ? 'I think yes.' : '{"ok":"fixed"}') });
  const result = await call(repaired.router, GOV);
  assert.deepEqual(result.output, { ok: 'fixed' });
  assert.deepEqual(repaired.sent.map((body) => body.model), [MODEL_AB_CHALLENGER, MODEL_AB_CHALLENGER],
    'a parse failure is the model\'s own result: repaired on haiku, not hidden by a Luna fallback');
  assert.equal(result.fallbackFrom, null);
});

test('Claude upper-cased answers are mapped back to the prompt\'s keys; Luna and normal answers untouched', async () => {
  const prompt = [{ role: 'system', content: 'Return only JSON: {"ids":["candidate-id"]} or {"selfModelUpdate":null,"planUpdates":[{"id":"x","status":"active|blocked","summary":"...","targetBindingMode":"exact|semantic","targetType":"project","steps":[]}],"goalUpdates":[{"category":"MASTER_RESEARCH"}]}' },
    { role: 'user', content: JSON.stringify({ answerJsonSchema: { votes: [{ id: 'P1', stance: 'yes|no' }] } }) }];
  assert.deepEqual(normalizeShoutedObject({ IDS: ['cognition:456', 'legacy:9'] }, prompt), { ids: ['cognition:456', 'legacy:9'] });
  assert.deepEqual(normalizeShoutedObject({ SELFMODELUPDATE: null, GOALUPDATES: [{ CATEGORY: 'MASTER_RESEARCH' }],
    PLANUPDATES: [{ ID: 'p-1', STATUS: 'ACTIVE', SUMMARY: 'Make One Contribution', TARGETBINDINGMODE: 'SEMANTIC', TARGETTYPE: 'PROJECT', STEPS: [] }] }, prompt),
  { selfModelUpdate: null, goalUpdates: [{ category: 'MASTER_RESEARCH' }],
    planUpdates: [{ id: 'p-1', status: 'active', summary: 'Make One Contribution', targetBindingMode: 'semantic', targetType: 'project', steps: [] }] });
  assert.deepEqual(normalizeShoutedObject({ VOTES: [{ ID: 'P1', STANCE: 'YES' }] }, prompt), { votes: [{ id: 'P1', stance: 'yes' }] });
  const normal = { ids: ['a'], status: 'ACTIVE' };
  assert.equal(normalizeShoutedObject(normal, prompt), normal, 'a normal answer is returned as is');
  assert.equal(isShoutedObject({ OK: true }, prompt), false, 'unknown upper-case keys are not guessed');
  assert.equal(isShoutedObject({ ID: 'P1' }, [{ role: 'system', content: '{"ID":1}' }]), false, 'the prompt itself uses ID');
  // End to end: a shouted haiku answer reaches the caller in the schema's casing; Luna output is never rewritten.
  const h = harness({ reply: (body) => envelope(body.model, '{"IDS":["m1"]}') });
  const sys = [{ role: 'system', content: 'Return only JSON: {"ids":["candidate-id"]}' }, { role: 'user', content: '{}' }];
  assert.deepEqual((await h.router({ tier: 'memory', messages: sys, trigger: 'memory_selection', callContext: { agentId: GOV } })).output, { ids: ['m1'] });
  assert.deepEqual((await h.router({ tier: 'memory', messages: sys, trigger: 'memory_selection', callContext: { agentId: R02 } })).output, { IDS: ['m1'] });
});

test('long-prompt guard: a haiku prompt above the byte cap goes to Luna (100k-token 5x tier)', async () => {
  assert.equal(modelAbMaxPromptBytes({}), MODEL_AB_DEFAULT_MAX_PROMPT_BYTES);
  assert.equal(MODEL_AB_DEFAULT_MAX_PROMPT_BYTES, 240_000, '~92k haiku tokens at the measured 2.6 bytes/token');
  assert.equal(modelAbMaxPromptBytes({ MIRRORTERRA_MODEL_AB_MAX_PROMPT_BYTES: '5' }), 20_000);
  assert.equal(modelAbMaxPromptBytes({ MIRRORTERRA_MODEL_AB_MAX_PROMPT_BYTES: '50000' }), 50_000);
  const h = harness({ env: { MIRRORTERRA_MODEL_AB_MAX_PROMPT_BYTES: '20000' } });
  const big = [{ role: 'system', content: 'json' }, { role: 'user', content: 'x'.repeat(25_000) }];
  const result = await h.router({ tier: 'planning', messages: big, trigger: 'scheduled', callContext: { agentId: GOV } });
  assert.deepEqual(h.sent.map((body) => body.model), ['gpt-6-luna']);
  assert.equal(result.fallbackReason, 'prompt_over_100k_guard');
  await h.router({ tier: 'planning', messages: MESSAGES, trigger: 'scheduled', callContext: { agentId: GOV } });
  assert.equal(h.sent.at(-1).model, MODEL_AB_CHALLENGER);
});

test('Luna quota backoff behaviour is unchanged for the Luna cohort and for routers without the test', async () => {
  const h = harness({ reply: (body) => envelope(body.model, '', 400) });
  await assert.rejects(call(h.router, R02));
  assert.equal(h.luna.status().paused, true);
  await assert.rejects(call(h.router, R02), (error) => error.code === 'LUNA_QUOTA_BACKOFF');
  assert.equal(h.sent.length, 1);
  // A haiku-cohort call still reaches haiku while Luna is paused (separate quota breaker).
  const ok = harness({ reply: (body) => (body.model === 'gpt-6-luna' ? envelope(body.model, '', 400) : envelope(body.model, '{"a":1}')) });
  await assert.rejects(call(ok.router, R02));
  assert.deepEqual((await call(ok.router, GOV)).output, { a: 1 });
  // No modelAb: exactly the old router (Luna for everyone, no cohort).
  const sent = [];
  const plain = createCognitionModelRouter({ apiKey: 'fixture', catalog: configuredCognitionCatalog('gpt-6-luna'),
    fetchImpl: async (url, options) => { sent.push(JSON.parse(options.body)); return envelope('gpt-6-luna', '{"ok":true}'); },
    quotaBackoff: createQuotaBackoff({ log: () => {}, env: {} }) });
  const result = await call(plain, GOV);
  assert.equal(sent[0].model, 'gpt-6-luna');
  assert.equal(result.abCohort, null);
});

test('council: callLuna and the decision jsonb carry the model; the council router uses the cohort', async () => {
  const sent = [];
  const fetchImpl = async (url, options) => { const body = JSON.parse(options.body); sent.push(body);
    return envelope(body.model, '{"propose":false,"reason":"No change."}'); };
  const gateway = { runRequest: async (input, send) => send() };
  const router = createCouncilModelRouter({ apiKey: 'fixture', budgetGateway: gateway, worldId: 'w', fetchImpl,
    model: 'gpt-6-luna', modelAb: createModelAbRouting({ env: {}, backoff: createQuotaBackoff({ log: () => {}, env: {} }) }) });
  const gov = await callLuna(router, { messages: MESSAGES, agentId: GOV, phase: 'propose' });
  const other = await callLuna(router, { messages: MESSAGES, agentId: R02, phase: 'vote' });
  assert.deepEqual(sent.map((body) => body.model), [MODEL_AB_CHALLENGER, 'gpt-6-luna']);
  assert.deepEqual(modelTag(gov), { model: MODEL_AB_CHALLENGER, abCohort: 'haiku' });
  assert.deepEqual(modelTag(other), { model: 'gpt-6-luna', abCohort: 'luna' });
  assert.deepEqual(modelTag({ ok: false }), {});
  assert.deepEqual(modelTag({ ok: true, model: 'gpt-6-luna', abCohort: 'haiku', fallbackFrom: MODEL_AB_CHALLENGER }),
    { model: 'gpt-6-luna', abCohort: 'haiku', modelFallbackFrom: MODEL_AB_CHALLENGER });
  assert.deepEqual(modelTag({ ok: true, model: 'gpt-6-luna', abCohort: null }), {}, 'no tag without the test: old decision shape');
  const source = read('../src/council-deliberation.js');
  assert.equal((source.match(/\.\.\.modelTag\(call\)/g) || []).length, 5, 'propose llm + fallback, vote, bid, commission');
  assert.match(read('../src/agent-runtime/open-cognition/worker.js'), /modelAb: createModelAbRouting\(\)/);
});

test('budget ledger: admit writes ab_cohort / fallback_from_model / fallback_reason as the last 3 values', async () => {
  const statements = [];
  const client = { query: async (sql, values = []) => {
    statements.push({ sql, values });
    if (sql.includes('SELECT active_call_id FROM')) return { rows: [{ active_call_id: statements.find((s) => s.sql.includes('INSERT INTO bai_model_budget_calls')).values[0] }] };
    if (sql.includes('FROM bai_model_budget_guard')) return { rowCount: 1, rows: [{ active_call_id: null, active_until: null }] };
    if (sql.includes('committed')) return { rows: [{ committed: '0', unknown_calls: 0, unknown_latest_at: null }] };
    if (sql.includes('SELECT created_at,agent_id')) return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT reserved_cost_nano_usd')) return { rowCount: 1, rows: [{ reserved_cost_nano_usd: '1' }] };
    return { rowCount: 1, rows: [] };
  }, release() {} };
  const pool = { connect: async () => client, query: client.query };
  const gateway = createBaiBudgetGateway(pool);
  await gateway.runRequest({ worldId: 'w', agentId: GOV, source: 'openCognition', tier: 'haiku', model: 'gpt-6-luna',
    body: '{"x":1}', maxTokens: 10, timeoutMs: 1000, abCohort: 'haiku', fallbackFromModel: MODEL_AB_CHALLENGER,
    fallbackReason: 'challenger_429' }, async () => ({ usage: { inputTokens: 1, outputTokens: 1 } }));
  const insert = statements.find(({ sql }) => sql.includes('INSERT INTO bai_model_budget_calls'));
  assert.match(insert.sql, /ab_cohort,fallback_from_model,fallback_reason\)/);
  assert.equal(insert.values.length, 25);
  assert.deepEqual(insert.values.slice(22), ['haiku', MODEL_AB_CHALLENGER, 'challenger_429']);
  assert.equal(insert.values[5], 'gpt-6-luna', 'the model column records the model actually called');
});

test('migration 0033 is additive only (nullable ADD COLUMN, no rewrite, no grants/drops/updates)', () => {
  const sql = read('../migrations/0033_model_ab_attribution.sql');
  const code = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  assert.match(code, /ALTER TABLE bai_model_budget_calls/);
  assert.equal((code.match(/ADD COLUMN/g) || []).length, 3);
  assert.doesNotMatch(code, /\b(DROP|DELETE|UPDATE|TRUNCATE|GRANT|REVOKE|RENAME|DEFAULT|NOT NULL|CHECK|ALTER COLUMN|TYPE)\b/i);
  assert.match(code, /SET LOCAL lock_timeout/);
});
