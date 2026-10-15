import test from 'node:test';
import assert from 'node:assert/strict';
import { completePendingExecutionReplans } from '../src/agent-runtime/open-cognition/grounding.js';
import { cognitionDiagnosticModelCallIds, cognitionPlanForPrompt, isPrivateCognitionDiagnosticsRequest,
  eligibleExecutionReplanFingerprints, isExecutionReplanEligible, markProviderRecoveryAvailable,
  nextGroundingDiagnostics, nextRetryGateDiagnostics, projectCognitionDiagnostics,
  recordExecutionReplanAttempt } from '../src/agent-runtime/open-cognition/diagnostics.js';

const worldId = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const agentId = '57c09d40-df32-4293-af2f-653b85c6244a';
const callId = '6d286a4f-8cda-48aa-a060-cf32f512fe91';
const cacheId = 'e9458b84-7014-408b-8c0f-221e4598ca2d';
const retryFingerprint = 'a'.repeat(64);
const affordanceSignature = 'b'.repeat(64);

test('cognition diagnostics accept only a loopback-bound listener, loopback peer, and local Host', () => {
  const allowed = { bindHost: '127.0.0.1', hostHeader: 'localhost:8788', remoteAddress: '127.0.0.1' };
  assert.equal(isPrivateCognitionDiagnosticsRequest(allowed), true);
  assert.equal(isPrivateCognitionDiagnosticsRequest({ ...allowed, hostHeader: 'mirrorterra.com' }), false);
  assert.equal(isPrivateCognitionDiagnosticsRequest({ ...allowed, remoteAddress: '203.0.113.9' }), false);
  assert.equal(isPrivateCognitionDiagnosticsRequest({ ...allowed, bindHost: '0.0.0.0' }), false);
  assert.equal(isPrivateCognitionDiagnosticsRequest({ ...allowed, hostHeader: '[::1]:8788', remoteAddress: '::1' }), true);
});

test('grounding and retry gate counters remain separate and reset on a changed fingerprint', () => {
  const first = nextGroundingDiagnostics(null, { fingerprint: retryFingerprint, worldMinute: 100 });
  assert.equal(first.groundingChecks, 1);
  assert.equal(first.deterministicGroundingChecks, 1);
  assert.equal(first.retryGateChecks, 0);
  assert.equal(first.lastRelevantStateChangeWorldMinute, null);

  const gated = nextRetryGateDiagnostics(first, { fingerprint: retryFingerprint, worldMinute: 160 });
  assert.equal(gated.groundingChecks, 1);
  assert.equal(gated.retryGateChecks, 1);

  const changed = nextGroundingDiagnostics(gated, { fingerprint: 'c'.repeat(64),
    worldMinute: 220, modelCallId: callId });
  assert.equal(changed.groundingChecks, 1);
  assert.equal(changed.deterministicGroundingChecks, 0);
  assert.equal(changed.modelCallCount, 1);
  assert.deepEqual(changed.modelCallIds, [callId]);
  assert.equal(changed.lastRelevantStateChangeWorldMinute, 220);
});

test('insufficient balance leaves terminal replan pending and records only safe correlation metadata', () => {
  const pending = { id: 'plan-1', status: 'blocked', currentStep: 0,
    executionReplans: [{ fingerprint: retryFingerprint, status: 'pending', modelCallIds: [], modelCallCount: 0 }],
    steps: [{ stepId: 'step-1', groundingBlocked: { reason: 'target_expired',
      retryFingerprint, replanFingerprint: retryFingerprint, replanRequired: true,
      replanTriggered: false, replanCompleted: false } }] };
  const afterFailure = recordExecutionReplanAttempt([pending], { fingerprints: [retryFingerprint],
    modelCallIds: [callId], providerFailureCategory: 'provider_insufficient_balance' })[0];
  assert.equal(afterFailure.executionReplans[0].status, 'pending');
  assert.equal(afterFailure.executionReplans[0].replanTriggered, true);
  assert.equal(afterFailure.executionReplans[0].replanCompleted, false);
  assert.equal(afterFailure.executionReplans[0].providerFailureCategory, 'provider_insufficient_balance');
  assert.equal(afterFailure.executionReplans[0].providerRetryEligible, false);
  assert.equal(isExecutionReplanEligible(afterFailure.executionReplans[0]), false);
  assert.equal(afterFailure.steps[0].groundingBlocked.replanRequired, true);
  assert.equal(afterFailure.steps[0].groundingBlocked.replanCompleted, false);

  const afterSuccess = completePendingExecutionReplans([afterFailure], { trigger: 'execution_replan_required',
    turnId: 'turn-1', worldMinute: 300, fingerprints: [retryFingerprint], modelCallIds: [callId] })[0];
  assert.equal(afterSuccess.executionReplans[0].status, 'completed');
  assert.equal(afterSuccess.executionReplans[0].replanCompleted, true);
  assert.equal(afterSuccess.steps[0].groundingBlocked.replanRequired, false);
  assert.equal(afterSuccess.steps[0].groundingBlocked.replanTriggered, true);
});

test('a pending failed terminal replan wakes only after a successful Sonnet recovery signal', () => {
  const pending = { id: 'plan-1', status: 'blocked', currentStep: 0,
    executionReplans: [{ fingerprint: retryFingerprint, status: 'pending', replanTriggered: true,
      replanCompleted: false, providerFailureCategory: 'provider_request_failed',
      providerRetryEligible: false, modelCallCount: 2, modelCallIds: [callId] }],
    steps: [{ stepId: 'step-1', groundingBlocked: { reason: 'target_expired',
      retryFingerprint, replanFingerprint: retryFingerprint, replanRequired: true,
      replanTriggered: true, replanCompleted: false } }] };
  assert.equal(isExecutionReplanEligible(pending.executionReplans[0]), false);
  assert.deepEqual(eligibleExecutionReplanFingerprints([pending]), []);
  const legacyEntry = { ...pending.executionReplans[0] };
  delete legacyEntry.providerRetryEligible;
  assert.equal(isExecutionReplanEligible(legacyEntry), false);

  const awakened = markProviderRecoveryAvailable([pending], { worldMinute: 440 })[0];
  assert.equal(awakened.executionReplans[0].status, 'pending');
  assert.equal(awakened.executionReplans[0].replanCompleted, false);
  assert.equal(awakened.executionReplans[0].providerFailureCategory, 'provider_request_failed');
  assert.equal(awakened.executionReplans[0].providerRetryEligible, true);
  assert.equal(awakened.executionReplans[0].providerRecoveryWorldMinute, 440);
  assert.equal(isExecutionReplanEligible(awakened.executionReplans[0]), true);
  assert.deepEqual(eligibleExecutionReplanFingerprints([awakened]), [retryFingerprint]);
  assert.equal(awakened.steps[0].groundingBlocked.replanRequired, true);
  assert.equal(awakened.steps[0].groundingBlocked.replanCompleted, false);

  const retried = recordExecutionReplanAttempt([awakened], { fingerprints: [retryFingerprint],
    modelCallIds: [cacheId], providerFailureCategory: 'provider_insufficient_balance' })[0];
  assert.equal(retried.executionReplans[0].status, 'pending');
  assert.equal(retried.executionReplans[0].providerRetryEligible, false);
  assert.equal(isExecutionReplanEligible(retried.executionReplans[0]), false);
  assert.deepEqual(eligibleExecutionReplanFingerprints([retried]), []);

  const unchanged = markProviderRecoveryAvailable([awakened], { worldMinute: 500 });
  assert.strictEqual(unchanged[0], awakened);
});

test('diagnostics expose one current plan per agent with bounded safe fields and linked model cost', () => {
  const state = {
    agent_id: agentId,
    goals: [{ id: 'goal-1', title: 'sensitive goal text must not be returned' }],
    plans: [
      { id: 'completed-plan', goalId: 'goal-old', status: 'completed', currentStep: 1,
        steps: [{ stepId: 'old-step' }] },
      { id: 'plan-share-trading-info', goalId: 'goal-1', status: 'blocked', currentStep: 0,
        executionReplans: [{ fingerprint: retryFingerprint, status: 'pending', replanTriggered: true,
          replanCompleted: false, modelCallCount: 2, modelCallIds: [callId, cacheId],
          providerFailureCategory: 'provider_insufficient_balance' }],
        summary: 'do not expose prompt-like text',
        steps: [{ stepId: 'step-1', targetBindingMode: 'exact', targetId: 'opportunity:123',
          targetType: 'opportunity', description: 'private plan wording',
          groundingTelemetry: { grounding_attempted: true, grounding_succeeded: false,
            grounding_status: 'blocked' },
          groundingDiagnostics: { retryFingerprintHash: retryFingerprint, groundingChecks: 2,
            deterministicGroundingChecks: 1, retryGateChecks: 3, modelCallCount: 2,
            modelCallIds: [callId, cacheId], lastGroundingWorldMinute: 240,
            lastRelevantStateChangeWorldMinute: 220 },
          groundingBlocked: { reason: 'target_expired', targetId: 'target-123',
            targetType: 'opportunity', targetStateVersion: 7, affordanceSignature,
            retryFingerprint: retryFingerprint, replanFingerprint: retryFingerprint,
            retryCondition: { type: 'target_expired', fingerprint: retryFingerprint,
              targetStateVersion: 7, affordanceSignature,
              observed: { target: { status: 'expired', secret: 'must not leave projection' } } },
            replanRequired: true, replanTriggered: true, replanCompleted: false,
            replanFailureCode: 'provider_insufficient_balance' } }] }
    ]
  };
  const calls = [{ id: callId, tier: 'sonnet', status: 'failed', input_tokens: null,
    output_tokens: null, total_tokens: null, cache_hit: false,
    failure_code: 'provider_insufficient_balance', trigger: 'execution_replan_required',
    prompt: 'never return prompt', response: 'never return response' }];
  calls.push({ id: cacheId, tier: 'haiku', status: 'cached', input_tokens: null,
    output_tokens: null, total_tokens: null, cache_hit: true, trigger: 'memory_selection' });
  assert.deepEqual(cognitionDiagnosticModelCallIds([state]), [callId, cacheId]);
  const result = projectCognitionDiagnostics([state], calls, { worldId, worldMinute: 241 });
  assert.equal(result.agentCount, 1);
  assert.equal(result.agentsWithActivePlan, 1);
  assert.equal(result.agents[0].planId, 'plan-share-trading-info');
  assert.equal(result.agents[0].blockedReason, 'target_expired');
  assert.equal(result.agents[0].targetLifecycleStatus, 'expired');
  assert.equal(result.agents[0].groundingSucceeded, false);
  assert.equal(result.agents[0].replanRequired, true);
  assert.equal(result.agents[0].replanCompleted, false);
  assert.equal(result.agents[0].providerFailureCategory, 'provider_insufficient_balance');
  assert.equal(result.agents[0].providerRetryEligible, false);
  assert.equal(result.agents[0].fingerprintMetrics.deterministicGroundingChecks, 1);
  assert.equal(result.agents[0].fingerprintMetrics.unchangedRetryGateChecks, 3);
  assert.equal(result.agents[0].fingerprintMetrics.modelCalls.byTier.sonnet.calls, 1);
  assert.equal(result.agents[0].fingerprintMetrics.modelCalls.byTier.haiku.calls, 0);
  assert.equal(result.agents[0].fingerprintMetrics.modelCalls.byTier.haiku.cachedSelections, 1);
  assert.equal(result.agents[0].fingerprintMetrics.modelCalls.totalCalls, 1);
  assert.equal(result.agents[0].fingerprintMetrics.modelCalls.cacheHits, 1);
  assert.equal(result.agents[0].fingerprintMetrics.modelCalls.totalTokens, null);
  assert.equal(result.agents[0].fingerprintMetrics.modelCalls.tokenUsageCoverage, 'unavailable');
  assert.equal(result.agents[0].fingerprintMetrics.modelCalls.failedCalls, 1);
  const json = JSON.stringify(result);
  for (const hidden of ['sensitive goal text', 'prompt-like text', 'private plan wording',
    'must not leave projection', 'never return prompt', 'never return response']) {
    assert.equal(json.includes(hidden), false);
  }
});

test('unattributed legacy records are marked unknown instead of reported as zero', () => {
  const state = { agent_id: agentId, plans: [{ id: 'plan-2', goalId: 'goal-2', status: 'blocked',
    currentStep: 0, steps: [{ stepId: 'step-2', groundingBlocked: { reason: 'target_affordance_missing' } }] }] };
  const result = projectCognitionDiagnostics([state], [], { worldId, worldMinute: 999 });
  assert.equal(result.agents[0].diagnosticCoverage, 'not_instrumented');
  assert.equal(result.agents[0].fingerprintMetrics.groundingAttempts, null);
  assert.equal(result.agents[0].fingerprintMetrics.deterministicGroundingChecks, null);
  assert.equal(result.agents[0].fingerprintMetrics.modelCalls.coverage, 'not_attributable');
  assert.equal(result.agents[0].fingerprintMetrics.modelCalls.totalCalls, null);
  assert.equal(result.agents[0].groundingAttempted, null);
});

test('diagnostic-only state is kept out of cognition model context', () => {
  const plan = { id: 'plan-1', status: 'blocked', currentStep: 0,
    executionReplans: [{ fingerprint: retryFingerprint, status: 'pending', modelCallIds: [callId],
      modelCallCount: 1, providerFailureCategory: 'provider_insufficient_balance',
      replanTriggered: true, replanCompleted: false, providerRetryEligible: false,
      providerRecoveryWorldMinute: 220 }],
    steps: [{ stepId: 'step-1', groundingDiagnostics: { retryFingerprintHash: retryFingerprint },
      groundingTelemetry: { grounding_attempted: true, model_call_id: callId },
      groundingBlocked: { reason: 'target_expired', replanCompleted: false,
        replanFailureCode: 'provider_insufficient_balance' } }] };
  const promptPlan = cognitionPlanForPrompt(plan);
  const json = JSON.stringify(promptPlan);
  for (const internalField of ['groundingDiagnostics', 'modelCallIds', 'modelCallCount',
    'model_call_id', 'replanFailureCode', 'replanCompleted', 'providerFailureCategory',
    'providerRetryEligible', 'providerRecoveryWorldMinute']) {
    assert.equal(json.includes(internalField), false);
  }
  assert.equal(promptPlan.steps[0].groundingBlocked.reason, 'target_expired');
});
