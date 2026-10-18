import test from 'node:test';
import assert from 'node:assert/strict';
import { measurePromptSections, safeBaiEnvelopeMetadata } from '../src/agent-runtime/bai-attribution.js';
import { classifyBaiCall, projectBaiAttributionDiagnostics }
  from '../src/agent-runtime/bai-attribution-diagnostics.js';
import { completeBaiCognition } from '../src/agent-runtime/open-cognition/provider.js';

const callId = '6d286a4f-8cda-48aa-a060-cf32f512fe91';
const eventId = 401;
const now = Date.UTC(2026, 9, 18, 8);
const row = (id = callId) => ({ id, created_at: new Date(now - 1000).toISOString(),
  provider_started_at: new Date(now - 900).toISOString(), correlation_id: callId,
  source: 'openCognition', tier: 'sonnet', model: 'claude-sonnet-4.6',
  status: 'succeeded', application_status: 'accepted', request_bytes: 1000,
  input_tokens: 100, output_tokens: 20, cost_source: 'usage_priced',
  effective_cost_nano_usd: '170000000' });

test('prompt metrics persist only sizes and hashes, with absent sections zeroed', () => {
  const secret = 'private-memory-example';
  const body = JSON.stringify({ messages: [{ role: 'user', content: secret }] });
  const metrics = measurePromptSections(body, { memories: secret });
  const memory = metrics.rows.find((item) => item.sectionName === 'memories');
  assert.equal(memory.characters, secret.length);
  assert.match(memory.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(metrics.rows.find((item) => item.sectionName === 'relationships').bytes, 0);
  assert.equal(JSON.stringify(metrics).includes(secret), false);
});

test('provider usage and IDs survive invalid model JSON content', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ id: 'resp-1', model: 'claude-sonnet-4.6',
    usage: { prompt_tokens: 70047, completion_tokens: 3142,
      prompt_tokens_details: { cached_tokens: 1000 } },
    choices: [{ message: { content: '{bad json' } }] }),
  { status: 200, headers: { 'x-request-id': 'req-1' } });
  await assert.rejects(completeBaiCognition({ apiKey: 'fake', model: 'claude-sonnet-4.6',
    messages: [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }], fetchImpl }),
  (error) => {
    assert.equal(error.code, 'BAI_COMPLETION_NOT_JSON');
    assert.equal(error.usage.inputTokens, 70047);
    assert.equal(error.usage.outputTokens, 3142);
    assert.equal(error.providerMetadata.providerRequestId, 'req-1');
    assert.equal(error.providerMetadata.providerResponseId, 'resp-1');
    return true;
  });
});

test('missing provider cache fields remain null', () => {
  const metadata = safeBaiEnvelopeMetadata({ usage: { prompt_tokens: 9, completion_tokens: 2 } });
  assert.equal(metadata.usage.cacheReadTokens, null);
  assert.equal(metadata.usage.cachedInputTokens, null);
  assert.equal(metadata.providerResponseId, null);
});

test('classification upgrades with evidence and historical rows stay unlinked', () => {
  assert.equal(classifyBaiCall(row()).value, 'noEffectYet');
  assert.equal(classifyBaiCall(row(), [{ effect_type: 'plan_updated' }]).value, 'partialValue');
  assert.equal(classifyBaiCall(row(), [{ effect_type: 'world_execution' }]).value, 'highValue');
  assert.deepEqual(classifyBaiCall({ ...row(), correlation_id: null }),
    { value: 'unclassified', reason: 'historical_unlinked' });
});

test('multiple effect edges count one call cost and one World event', () => {
  const otherId = 'e9458b84-7014-408b-8c0f-221e4598ca2d';
  const effects = [
    { model_call_id: callId, effect_type: 'replan_completed', cognition_turn_id: 1 },
    { model_call_id: callId, effect_type: 'grounding_succeeded', plan_id: 'p', step_id: 's' },
    { model_call_id: callId, effect_type: 'world_execution', world_event_id: eventId },
    { model_call_id: callId, effect_type: 'plan_step_completed', world_event_id: eventId,
      plan_id: 'p', step_id: 's' },
    { model_call_id: otherId, effect_type: 'world_execution', world_event_id: eventId }
  ];
  const report = projectBaiAttributionDiagnostics({ ledgerRows: [row(), row(otherId)],
    effectRows: effects, now });
  assert.equal(report.rolling24h.effectiveness.worldExecutionsAttributed, 1);
  assert.equal(report.rolling24h.effectiveness.planStepsCompletedAttributed, 1);
  assert.equal(report.rolling24h.cost.knownCostUsd, 0.34);
  assert.equal(report.rolling24h.cost.costHighValueUsd, 0.34);
  assert.equal(report.rolling24h.efficiency.costPerWorldExecution, 0.34);
});
