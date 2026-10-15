import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { completeBaiCognition, createCognitionModelRouter, discoverBaiClaudeModels, routeCognition }
  from '../src/agent-runtime/open-cognition/provider.js';
import { validateCognitionIntent } from '../src/agent-runtime/open-cognition/intent.js';
import { choosePlannedAffordance, completePlannedAction, routineFallbackCandidates }
  from '../src/agent-runtime/open-cognition/selection.js';
import { groundPlanStep, shouldRetryBlockedGrounding }
  from '../src/agent-runtime/open-cognition/grounding.js';
import { runOpenCognition, selectRelevantMemories } from '../src/agent-runtime/open-cognition/prompt.js';
import { clearMemorySelectionCacheForTests, prefilterMemoryCandidates }
  from '../src/agent-runtime/open-cognition/memory-retrieval.js';
import { affordanceFingerprint } from '../src/agent-runtime/open-cognition/grounding.js';
import { readPublicGitHub } from '../src/agent-runtime/open-cognition/github-public-read.js';

const catalog = { haiku: 'claude-haiku-5.5', sonnet: 'claude-sonnet-5.5', opus: 'claude-opus-5.5' };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const emptyIntent = () => ({ selfModelUpdate: null, goalUpdates: [], planUpdates: [],
  beliefUpdates: [], valueUpdates: [], policyExperimentUpdates: [], questionUpdates: [], memoryUpdates: [], nextAction: null,
  toolRequests: [], capabilityDecisions: [],
  reviewAfterWorldMinutes: 1800, requestModel: null, reasonSummary: 'Continue observing the world.',
  uncertainty: 'The next opportunity is unknown.' });

test('catalog uses only actual OpenAI-compatible Claude model IDs', async () => {
  const models = await discoverBaiClaudeModels({ apiKey: 'test', fetchImpl: async () => response({ data: [
    ...Object.values(catalog).map((id) => ({ id, supported_endpoint_types: ['openai','anthropic'] })),
    { id: 'claude-opus-5.6', supported_endpoint_types: ['openai'] },
    { id: 'claude-fake', supported_endpoint_types: ['anthropic'] }
  ] }) });
  assert.equal(models.opus, 'claude-opus-5.6');
  assert.equal(models.sonnet, catalog.sonnet);
  assert.equal(models.availableClaudeIds.includes('claude-fake'), false);
  await assert.rejects(discoverBaiClaudeModels({ apiKey: 'test', fetchImpl: async () => response({ data: [
    { id: catalog.haiku, supported_endpoint_types: ['openai'] }
  ] }) }), { code: 'BAI_REQUIRED_CLAUDE_MODELS_UNAVAILABLE' });
});

test('routing gives initial strategy Opus and everyday execution Sonnet', () => {
  assert.equal(routeCognition({ trigger: 'initial' }, catalog).tier, 'opus');
  assert.equal(routeCognition({ trigger: 'routine' }, catalog).tier, 'sonnet');
  assert.equal(routeCognition({ trigger: 'routine_environment' }, catalog).tier, 'haiku');
  assert.equal(routeCognition({ trigger: 'routine', agentRequest: 'opus' }, catalog).tier, 'opus');
});

test('an explicit resident request for strategic reconsideration is routed to Opus', async () => {
  const tiers = [];
  const requestModel = async ({ tier }) => {
    tiers.push(tier);
    return { tier: tier === 'strategic' ? 'opus' : 'sonnet',
      model: tier === 'strategic' ? catalog.opus : catalog.sonnet,
      callId: `10000000-0000-4000-8000-00000000004${tiers.length}`,
      usage: { inputTokens: 20, outputTokens: 4 },
      output: tiers.length === 1 ? { ...emptyIntent(), requestModel: 'opus' } : emptyIntent() };
  };
  const result = await runOpenCognition({ requestModel, catalog, trigger: 'routine',
    context: { resident: { id: 'agent-1' }, prior: { goals: [], plans: [], beliefs: [], values: [],
      policyExperiments: [], openQuestions: [] }, evidenceRefs: [] } });
  assert.deepEqual(tiers, ['sonnet','strategic']);
  assert.equal(result.tier, 'opus');
  assert.equal(result.model, catalog.opus);
  assert.equal(result.escalated, true);
});

test('an unchanged blocked plan does not escalate routine cognition to Opus', async () => {
  const tiers = [];
  const prior = { goals: [{ id: 'goal-a', status: 'active', title: 'Learn', why: 'Curiosity', priority: 50 }],
    plans: [{ id: 'plan-a', goalId: 'goal-a', status: 'blocked', currentStep: 0,
      steps: [{ stepId: 'step-a', intentId: 'intent-a', description: 'Wait for a new research affordance.' }] }],
    beliefs: [], values: [], policyExperiments: [], openQuestions: [] };
  await runOpenCognition({ requestModel: async ({ tier }) => {
    tiers.push(tier);
    return { tier: 'sonnet', model: catalog.sonnet,
      callId: '10000000-0000-4000-8000-000000000049', usage: { inputTokens: 10, outputTokens: 5 },
      output: emptyIntent() };
  }, catalog, trigger: 'tool_result', priorState: prior,
  context: { resident: { id: 'agent-a' }, prior, evidenceRefs: [] } });
  assert.deepEqual(tiers, ['sonnet']);
});

test('advisory model-analysis tool requests cannot use the strategic Opus tier', () => {
  const output = emptyIntent();
  output.toolRequests = [{ id: 'analysis-request', capability: 'model_analysis', tier: 'opus',
    question: 'What evidence is most relevant?', objective: 'Support the current plan.' }];
  assert.throws(() => validateCognitionIntent(output), /MODEL_SUBTASK_INVALID/u);
});

test('the semantic execution tier reaches the Sonnet provider model', async () => {
  let request;
  const router = createCognitionModelRouter({ apiKey: 'test', catalog, fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return response({ model: catalog.sonnet,
      choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
      usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } });
  } });
  const result = await router({ tier: 'execution', trigger: 'plan_grounding',
    messages: [{ role: 'system', content: 'ground' }, { role: 'user', content: 'intent' }] });
  assert.equal(request.model, catalog.sonnet);
  assert.equal(result.tier, 'sonnet');
  assert.equal(result.model, catalog.sonnet);
  assert.equal(result.usage.totalTokens, 16);
});

test('Claude completion is parsed fail-closed and omits deprecated temperature', async () => {
  let request;
  const fetchImpl = async (_url, options) => {
    request = JSON.parse(options.body);
    return response({ model: catalog.sonnet,
      choices: [{ message: { content: JSON.stringify(emptyIntent()) } }],
      usage: { prompt_tokens: 10, completion_tokens: 15, total_tokens: 25 } });
  };
  const result = await completeBaiCognition({ apiKey: 'test', model: catalog.sonnet,
    messages: [{ role: 'system', content: 'test' }, { role: 'user', content: 'test' }], fetchImpl });
  assert.equal(result.output.reasonSummary, 'Continue observing the world.');
  assert.equal(Object.hasOwn(request, 'temperature'), false);
  assert.equal(result.usage.totalTokens, 25);
  await assert.rejects(completeBaiCognition({ apiKey: 'test', model: catalog.sonnet,
    messages: [{ role: 'system', content: 'test' }, { role: 'user', content: 'test' }],
    fetchImpl: async () => response({ choices: [{ message: { content: 'not JSON' } }] }) }),
  { code: 'BAI_COMPLETION_NOT_JSON' });
});

test('provider insufficient balance is classified separately from plan blocking', async () => {
  await assert.rejects(completeBaiCognition({ apiKey: 'test', model: catalog.sonnet,
    messages: [{ role: 'system', content: 'test' }, { role: 'user', content: 'test' }],
    fetchImpl: async () => response({ error: { code: 'insufficient_balance' } }, 402) }),
  { code: 'provider_insufficient_balance' });
});

test('cognition deltas preserve old goals and plans instead of rewriting history', () => {
  const prior = { selfModel: { summary: 'Prior' },
    goals: [{ id: 'old', title: 'Explore', why: 'Curiosity', status: 'active', priority: 50 }],
    plans: [{ id: 'old-plan', goalId: 'old', summary: 'Visit places', status: 'active',
      steps: [{ description: 'Go to the library', actionType: 'learn' }], currentStep: 0 }] };
  const output = emptyIntent();
  output.goalUpdates.push({ id: 'new', title: 'Study weather', why: 'A recent storm raised a question.',
    status: 'active', priority: 70 });
  const intent = validateCognitionIntent(output, prior);
  assert.deepEqual(intent.goals.map((goal) => goal.id), ['old','new']);
  assert.equal(intent.plans[0].id, 'old-plan');
  assert.equal(intent.selfModel.summary, 'Prior');
});

test('generic world_action waits for Sonnet grounding and never enters the action matcher', () => {
  const state = { pending_action: {}, plans: [{ id: 'plan', goalId: 'goal', status: 'active', currentStep: 0,
    steps: [{ stepId: 'step', intentId: 'intent', description: 'Research changing storm patterns',
      actionType: 'world_action' }] }] };
  const selected = choosePlannedAffordance(state, [
    { id: 'rest:1', action: 'rest', score: 99 },
    { id: 'learn:2', action: 'learn', score: 10 },
    { id: 'generic', action: 'world_action' }
  ]);
  assert.equal(selected.candidate, null);
  assert.equal(selected.needsGrounding, true);
  assert.equal(selected.planId, 'plan');
  assert.equal(selected.step.intent, 'Research changing storm patterns');
  assert.equal(choosePlannedAffordance({ pending_action: { actionType: 'world_action' }, plans: [] },
    [{ id: 'generic', action: 'world_action' }]).candidate, null);
});

test('grounded selection binds one exact live candidate and preserves Work Order target', () => {
  const state = { pending_action: { goalId: 'goal', planId: 'plan', stepId: 'step', intentId: 'intent',
    executableAction: 'work', targetId: 'order-1', candidateId: 'world-work-order:order-1',
    executionCorrelationId: '10000000-0000-4000-8000-000000000021', expectedOutcome: 'Target cleared.',
    affordanceFingerprint: 'fp', modelCallId: '10000000-0000-4000-8000-000000000022' },
  plans: [{ id: 'plan', goalId: 'goal', status: 'active', currentStep: 0,
    steps: [{ stepId: 'step', intentId: 'intent', description: 'Complete the accepted cleanup work order.' }] }] };
  const selected = choosePlannedAffordance(state, [
    { id: 'work:workshop', action: 'work' },
    { id: 'world-work-order:order-1', action: 'work', workOrderId: 'order-1' }
  ]);
  assert.equal(selected.candidate.id, 'world-work-order:order-1');
  assert.equal(selected.candidate.workOrderId, 'order-1');
  assert.equal(selected.executionCorrelationId, state.pending_action.executionCorrelationId);
  assert.equal(selected.modelCallId, state.pending_action.modelCallId);
  assert.equal(choosePlannedAffordance(state, [{ id: 'work:workshop', action: 'work' }]).blocked,
    'grounded_candidate_unavailable');
});

test('execution grounding uses the execution router and can choose any current affordance', async () => {
  let requestedTier;
  const step = { stepId: 'step', intentId: 'intent', targetId: 'order-1', intent: 'Contribute research at the active workshop.',
    description: 'Advance the question using a currently feasible work order.' };
  const candidate = { id: 'world-work-order:order-1', action: 'work', workOrderId: 'order-1',
    targetLocation: 'Workshop', description: 'Complete the accepted cleanup work order.' };
  const grounded = await groundPlanStep({ requestModel: async (request) => {
    requestedTier = request.tier;
    return { callId: '10000000-0000-4000-8000-000000000023', output: {
      candidateId: candidate.id, executableAction: 'work', arguments: { workOrderId: 'order-1' },
      capabilityId: null, targetId: 'order-1', expectedOutcome: 'The accepted order records verified completion.'
    } };
  }, context: { resident: { id: 'agent', location: 'Workshop', energy: 60, food: 50, social: 50 },
    world: { minute: 10 }, availableAffordances: { candidates: [candidate] }, capabilities: [] },
  goal: { id: 'goal', title: 'Complete the accepted cleanup order' },
  plan: { id: 'plan', summary: 'Finish work already accepted.' }, step,
  correlationId: '10000000-0000-4000-8000-000000000024' });
  assert.equal(requestedTier, 'execution');
  assert.equal(grounded.executableAction, 'work');
  assert.equal(grounded.targetId, 'order-1');
  assert.deepEqual(grounded.arguments, { workOrderId: 'order-1' });
  assert.equal(grounded.candidateId, candidate.id);
});

test('grounding may report a blocked intent instead of choosing an unrelated affordance', async () => {
  const result = await groundPlanStep({ requestModel: async () => ({ callId: '10000000-0000-4000-8000-000000000051',
    output: { candidateId: null, executableAction: null, arguments: {}, capabilityId: null,
      targetId: null, expectedOutcome: null, blockedReason: 'missing_location',
      requiredChange: 'Reach the location where the relevant source is available.' } }),
  context: { resident: { id: 'agent-1', location: 'Home' }, world: { minute: 1 },
    availableAffordances: { candidates: [{ id: 'eat:home', action: 'eat' }] }, capabilities: [] },
  goal: { id: 'goal-1', title: 'Study the archive' }, plan: { id: 'plan-1' },
  step: { stepId: 'step-1', intentId: 'intent-1', intent: 'Read the source at the archive.' } });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'missing_location');
  assert.equal(result.modelCallId, '10000000-0000-4000-8000-000000000051');
});

test('grounding refuses to switch an explicitly targeted plan to another target', async () => {
  let called = false;
  const result = await groundPlanStep({ requestModel: async () => { called = true; },
    context: { resident: { id: 'agent-1', location: 'Workshop' }, world: { minute: 1 },
      availableAffordances: { candidates: [{ id: 'order:new', action: 'work', workOrderId: 'new' }] },
      capabilities: [] },
    goal: { id: 'goal-1', title: 'Complete the accepted order' }, plan: { id: 'plan-1' },
    step: { stepId: 'step-1', intentId: 'intent-1', targetId: 'order:expired', intent: 'Complete this order.' } });
  assert.equal(called, false);
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'target_affordance_unavailable');
});

test('blocked grounding retries only after its relevant affordance fingerprint changes', () => {
  const blocked = { reason: 'no_matching_affordance', affordanceFingerprint: 'same' };
  assert.equal(shouldRetryBlockedGrounding(blocked, 'same'), false);
  assert.equal(shouldRetryBlockedGrounding(blocked, 'changed'), true);
  assert.equal(shouldRetryBlockedGrounding(null, 'same'), true);
  const candidates = [{ id: 'work:job-1', action: 'work', jobId: 'job-1' }];
  assert.equal(affordanceFingerprint(candidates, { location: 'Workshop', energy: 20, food: 10 }),
    affordanceFingerprint(candidates, { location: 'Workshop', energy: 21, food: 11 }));
  assert.notEqual(affordanceFingerprint(candidates, { location: 'Workshop', resourceVersion: 'pool-10' }),
    affordanceFingerprint(candidates, { location: 'Workshop', resourceVersion: 'pool-9' }));
});

test('memory retrieval has no fixed result-count cap when evidence is relevant', () => {
  const context = { world: { minute: 10_000 }, relationships: [], projects: [],
    prior: { goals: [{ status: 'active', title: 'Storm debris cleanup' }],
      plans: [{ status: 'active', summary: 'Inspect storm debris cleanup evidence', currentStep: 0,
        steps: [{ description: 'Compare storm cleanup reports' }] }], openQuestions: [] } };
  const candidates = Array.from({ length: 100 }, (_, index) => ({ id: `memory-${index}`,
    type: index < 35 ? 'research' : 'episodic',
    summary: index < 35 ? `Storm debris cleanup evidence ${index}` : `Unrelated cooking recipe ${index}`,
    worldMinute: 9_900 - index, importance: index < 35 ? 0.9 : 0.2 }));
  const filtered = prefilterMemoryCandidates(candidates, context);
  assert.ok(filtered.length > 24);
  assert.ok(filtered.length < candidates.length);
});

test('tool delta cursor orders UUID-keyed attempts through the migration sequence', async () => {
  const migration = await readFile(new URL('../migrations/0014_open_cognition_runtime.sql', import.meta.url), 'utf8');
  assert.match(migration, /ADD COLUMN cognition_sequence bigserial UNIQUE/u);
  assert.match(migration, /min\(attempt\.cognition_sequence\)[\s\S]*max\(attempt\.cognition_sequence\)/u);
  assert.match(migration, /GRANT USAGE,SELECT ON SEQUENCE world_agent_cognition_tool_attempts_cognition_sequence_seq/u);
  assert.doesNotMatch(migration, /min\(attempt\.id\)[\s\S]{0,100}-1/u);
});

test('memory retrieval filters locally and reuses the semantic selection cache', async () => {
  clearMemorySelectionCacheForTests();
  const context = { resident: { id: 'agent-1', location: 'Workshop', knowledge: 20 },
    world: { minute: 900, environment: { weather: 'storm' } },
    prior: { goals: [{ id: 'goal-1', title: 'Understand storm damage', why: 'Help the community.', status: 'active' }],
      plans: [{ id: 'plan-1', summary: 'Study cleanup evidence', currentStep: 0,
        steps: [{ description: 'Compare debris evidence' }], status: 'active' }], openQuestions: [] },
    relationships: [], projects: [], capabilities: [], availableAffordances: { candidates: [] }, recentEvents: [] };
  const candidates = Array.from({ length: 60 }, (_, index) => ({ id: `memory-${index}`,
    type: index % 2 ? 'episodic' : 'research', summary: index < 18
      ? `Storm debris cleanup evidence ${index}` : `Unrelated cooking memory ${index}`,
    worldMinute: 800 - index, importance: index < 18 ? 0.9 : 0.2 }));
  let calls = 0;
  const requestModel = async ({ tier, messages }) => {
    calls += 1;
    assert.equal(tier, 'memory');
    const payload = JSON.parse(messages[1].content);
    assert.ok(payload.candidates.length < candidates.length);
    return { output: { ids: payload.candidates.slice(0, 3).map((row) => row.id) },
      callId: '10000000-0000-4000-8000-000000000031', usage: { inputTokens: 50, outputTokens: 3 } };
  };
  const first = await selectRelevantMemories({ requestModel, context, candidates, agentId: 'agent-1' });
  const second = await selectRelevantMemories({ requestModel, context, candidates, agentId: 'agent-1' });
  assert.ok(first.prefilteredCount < candidates.length);
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.equal(calls, 1);
});

test('a plan step cannot advance without its matching authoritative World event', async () => {
  const statements = [];
  const client = { query: async (sql) => {
    statements.push(sql.trim().split(/\s+/u).slice(0, 3).join(' '));
    return { rows: [], rowCount: 0 };
  } };
  const result = await completePlannedAction(client, { worldId: 'world', agentId: 'agent',
    context: { cognitionRevision: 4, cognitionPlanId: 'plan', cognitionStepIndex: 0,
      cognitionStepId: 'step', cognitionGoalId: 'goal', cognitionCandidateId: 'candidate',
      cognitionExecutionCorrelationId: '10000000-0000-4000-8000-000000000025' },
    worldMinute: 20, completionEventId: 9, actionType: 'work' });
  assert.equal(result.updated, false);
  assert.equal(result.reason, 'authoritative_execution_evidence_missing');
  assert.equal(statements.some((statement) => statement.startsWith('UPDATE world_agent_cognition_state')), false);
});

test('a plan step advances only after its exact completed World event is persisted', async () => {
  let storedPlans;
  const executionCorrelationId = '10000000-0000-4000-8000-000000000041';
  const plan = { id: 'plan', goalId: 'goal', summary: 'Clear the accepted target', status: 'active',
    currentStep: 0, steps: [{ stepId: 'step', intentId: 'intent', description: 'Clear target.' }] };
  const client = { query: async (sql, params = []) => {
    if (sql.includes('FROM world_events event')) return { rowCount: 1, rows: [{ id: 9,
      event_type: 'world.action_completed', data: { status: 'completed',
        cognitionExecution: { goalId: 'goal', planId: 'plan', stepId: 'step', intentId: 'intent',
          candidateId: 'candidate', correlationId: executionCorrelationId, action: 'work', targetId: 'target' } } }] };
    if (sql.includes('SELECT revision,plans,pending_action')) return { rowCount: 1, rows: [{ revision: 4,
      plans: [plan], pending_action: { executionCorrelationId }, next_review_world_minute: 100 }] };
    if (sql.includes('UPDATE world_agent_cognition_state')) { storedPlans = JSON.parse(params[2]); return { rowCount: 1, rows: [] }; }
    return { rowCount: 1, rows: [] };
  } };
  const result = await completePlannedAction(client, { worldId: 'world', agentId: 'agent',
    context: { cognitionRevision: 4, cognitionGoalId: 'goal', cognitionPlanId: 'plan',
      cognitionStepIndex: 0, cognitionStepId: 'step', cognitionIntentId: 'intent',
      cognitionCandidateId: 'candidate', cognitionTargetId: 'target',
      cognitionExecutableAction: 'work',
      cognitionExecutionCorrelationId: executionCorrelationId, cognitionModelCallId: null },
    worldMinute: 20, completionEventId: 9, actionType: 'work' });
  assert.equal(result.updated, true);
  assert.equal(result.advanced, true);
  assert.equal(result.completed, true);
  assert.equal(storedPlans[0].currentStep, 1);
  assert.equal(storedPlans[0].status, 'completed');
  assert.equal(storedPlans[0].steps[0].executionEvidence.eventId, 9);
});

test('Fruitfly fallback cannot take strategic, monetary or Work Order actions', () => {
  const candidates = [{ action: 'business_invest' }, { action: 'project_propose' },
    { action: 'opportunity' }, { action: 'work', workOrderId: 'formal-order' },
    { action: 'rest' }, { action: 'learn' }];
  assert.deepEqual(routineFallbackCandidates(candidates).map((row) => row.action), ['rest','learn']);
});

test('resident REA question replaces only a currently feasible granted research candidate', () => {
  const intent = emptyIntent();
  intent.nextAction = { intent: 'Investigate a source about storm prediction.', targetId: 'research:cap:artifact:goal:12',
    researchIntent: { researchQuestion: 'What does the source reveal about storm prediction?',
      objective: 'Improve the active weather research project.', desiredInvestigation: 'Inspect relevant source paths.',
      expectedResult: 'Evidence with unresolved uncertainty.' } };
  const validated = validateCognitionIntent(intent);
  assert.equal(validated.nextAction.actionType, 'world_action');
  const candidate = { id: intent.nextAction.targetId, action: 'capability_use',
    capabilityContext: { researchIntent: { artifactId: 'artifact', targetType: 'source_code',
      relationType: 'goal', relationId: '12', researchQuestion: 'Template question' } } };
  const selected = choosePlannedAffordance({ pending_action: { goalId: 'goal', planId: 'plan',
    stepId: 'step', intentId: 'intent', executableAction: 'capability_use',
    candidateId: candidate.id, targetId: candidate.id,
    executionCorrelationId: '10000000-0000-4000-8000-000000000026',
    researchIntent: validated.nextAction.researchIntent },
  plans: [{ id: 'plan', goalId: 'goal', status: 'active', currentStep: 0,
    steps: [{ stepId: 'step', intentId: 'intent' }] }] }, [candidate]);
  assert.equal(selected.candidate.capabilityContext.researchIntent.researchQuestion,
    intent.nextAction.researchIntent.researchQuestion);
  assert.equal(selected.candidate.capabilityContext.researchIntent.artifactId, 'artifact');
  assert.equal(choosePlannedAffordance({ pending_action: { ...selected, candidateId: candidate.id }, plans: [] },
    [{ id: candidate.id, action: 'capability_use' }]).blocked, 'grounded_plan_stale');
});

test('resident-authored project description replaces template proposal but keeps World validation', () => {
  const intent = emptyIntent();
  intent.nextAction = { intent: 'Propose a research project about storm archives.', targetId: null,
    projectProposal: { projectType: 'RESEARCH', title: 'Storm archive',
      goal: 'Understand changing storm patterns',
      description: 'Collect historical observations and compare them with current weather events.' } };
  const validated = validateCognitionIntent(intent);
  const selected = choosePlannedAffordance({ pending_action: { goalId: 'goal', planId: 'plan',
    stepId: 'step', intentId: 'intent', executableAction: 'project_propose',
    candidateId: 'candidate', targetId: 'candidate',
    executionCorrelationId: '10000000-0000-4000-8000-000000000027',
    projectProposal: validated.nextAction.projectProposal },
  plans: [{ id: 'plan', goalId: 'goal', status: 'active', currentStep: 0,
    steps: [{ stepId: 'step', intentId: 'intent' }] }] },
    [{ id: 'candidate', action: 'project_propose', projectProposal: { title: 'Template' } }]);
  assert.equal(selected.candidate.projectProposal.title, 'Storm archive');
  assert.equal(selected.candidate.goal, 'Understand changing storm patterns');
});

test('GitHub public read requests are bounded to fixed API endpoints and return untrusted evidence', async () => {
  const intent = emptyIntent();
  intent.toolRequests = [{ id: 'read-source', capability: 'github_public_read',
    operation: 'contents', owner: 'example', repo: 'project', path: 'README.md' }];
  const request = validateCognitionIntent(intent).toolRequests[0];
  let requestedUrl;
  const result = await readPublicGitHub(request, { fetchImpl: async (url, options) => {
    requestedUrl = url;
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.authorization, undefined);
    return response({ type: 'file', path: 'README.md', sha: 'abc', size: 5,
      encoding: 'base64', content: Buffer.from('hello').toString('base64') });
  } });
  assert.equal(requestedUrl, 'https://api.github.com/repos/example/project/contents/README.md');
  assert.equal(result.data.contentExcerpt, 'hello');
  intent.toolRequests[0].path = '../secret';
  assert.throws(() => validateCognitionIntent(intent), /TOOL_REQUEST_INVALID/);
});

test('existing long plan steps survive a concise status update', () => {
  const output = emptyIntent();
  output.planUpdates = [{ id: 'plan-a', goalId: 'goal-a', summary: 'Keep investigating',
    status: 'active', currentStep: 2, steps: [] }];
  const prior = { goals: [{ id: 'goal-a', title: 'Learn', why: 'Curiosity', status: 'active', priority: 50 }],
    plans: [{ id: 'plan-a', goalId: 'goal-a', summary: 'Long plan', status: 'active', currentStep: 1,
      steps: [{ description: 'one' }, { description: 'two' }, { description: 'three' }] }] };
  const validated = validateCognitionIntent(output, prior);
  assert.equal(validated.plans[0].steps.length, 3);
  assert.equal(validated.plans[0].currentStep, 1);
});

test('an active plan at its step length cannot masquerade as completed execution', () => {
  const output = emptyIntent();
  output.planUpdates = [{ id: 'plan-finished-index', goalId: 'goal-a', summary: 'A completed-index plan',
    status: 'active', currentStep: 2, steps: [] }];
  const prior = { goals: [{ id: 'goal-a', title: 'Learn', why: 'Curiosity', status: 'active', priority: 50 }],
    plans: [{ id: 'plan-finished-index', goalId: 'goal-a', summary: 'A completed-index plan',
      status: 'active', currentStep: 1, steps: [{ stepId: 's1', description: 'Observed step' },
        { stepId: 's2', description: 'Unexecuted step' }] }] };
  const validated = validateCognitionIntent(output, prior);
  assert.equal(validated.plans[0].currentStep, 1);
  assert.equal(validated.plans[0].status, 'active');

  prior.plans[0].currentStep = 2;
  const exhausted = validateCognitionIntent(output, prior);
  assert.equal(exhausted.plans[0].currentStep, 2);
  assert.equal(exhausted.plans[0].status, 'blocked');
});

test('resident capability decisions require observed targets and bound evidence', () => {
  const gapId = '10000000-0000-4000-8000-000000000011';
  const proposalId = '10000000-0000-4000-8000-000000000012';
  const experimentId = '10000000-0000-4000-8000-000000000013';
  const parentId = '10000000-0000-4000-8000-000000000014';
  const output = emptyIntent();
  output.capabilityDecisions = [
    { type: 'propose', gapId, evidenceRefs: [`capability_gap:${gapId}`],
      proposal: { name: 'Weather observations', category: 'world.research',
        problemStatement: 'Residents cannot compare repeated weather observations.',
        expectedBenefit: 'A reusable observation practice.', expectedCost: {},
        requiredResources: {}, affectedSystems: [],
        specification: { schemaVersion: 1, kind: 'composition',
          composition: [{ capabilityId: parentId, parameters: {} }], requirements: {} } } },
    { type: 'review_proposal', proposalId, decision: 'support',
      rationale: 'The proposal addresses the observed gap.', evidenceRefs: [`capability_proposal:${proposalId}`] },
    { type: 'review_experiment', proposalId, experimentId, useId: '123', decision: 'oppose',
      rationale: 'The observed use failed.', evidenceRefs: ['capability_use:123'] }
  ];
  const options = { allowedEvidenceRefs: new Set([
    `capability_gap:${gapId}`, `capability_proposal:${proposalId}`, 'capability_use:123']),
  availableCapabilityContext: { gaps: new Set([gapId]), proposals: new Set([proposalId]),
    experiences: new Map([[`experiment:${experimentId}:123`, proposalId]]) } };
  const validated = validateCognitionIntent(output, {}, options);
  assert.equal(validated.capabilityDecisions[2].useId, '123');
  assert.equal(validated.changes.capabilityDecisions.length, 3);
  assert.throws(() => validateCognitionIntent({ ...output,
    capabilityDecisions: [{ ...output.capabilityDecisions[1], proposalId: gapId }] }, {}, options),
  /CAPABILITY_PROPOSAL_NOT_VISIBLE/);
  assert.throws(() => validateCognitionIntent({ ...output,
    capabilityDecisions: [{ ...output.capabilityDecisions[2], proposalId: gapId }] }, {}, options),
  /CAPABILITY_EXPERIENCE_NOT_VISIBLE/);
  assert.throws(() => validateCognitionIntent({ ...output,
    capabilityDecisions: [{ ...output.capabilityDecisions[0], evidenceRefs: ['invented'] }] }, {}, options),
  /EVIDENCE_REFERENCE_INVALID/);
});
