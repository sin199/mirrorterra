import assert from 'node:assert/strict';
import test from 'node:test';
import { completeBaiCognition, discoverBaiClaudeModels, routeCognition }
  from '../src/agent-runtime/open-cognition/provider.js';
import { validateCognitionIntent } from '../src/agent-runtime/open-cognition/intent.js';
import { choosePlannedAffordance, routineFallbackCandidates } from '../src/agent-runtime/open-cognition/selection.js';
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

test('plan continuation chooses its feasible action without Fruitfly utility ranking', () => {
  const state = { pending_action: {}, plans: [{ id: 'plan', status: 'active', currentStep: 0,
    steps: [{ description: 'Research', actionType: 'learn' }] }] };
  const selected = choosePlannedAffordance(state, [
    { id: 'rest:1', action: 'rest', score: 99 },
    { id: 'learn:2', action: 'learn', score: 10 }
  ]);
  assert.equal(selected.candidate.id, 'learn:2');
  assert.equal(selected.source, 'plan_continuation');
  assert.equal(selected.planId, 'plan');
  const blocked = choosePlannedAffordance({ pending_action: { actionType: 'opportunity' }, plans: [] },
    [{ id: 'opportunity:1', action: 'opportunity' }]);
  assert.equal(blocked.blocked, 'target_required');
});

test('a resident can target an accepted Work Order without selecting ordinary work', () => {
  const state = { pending_action: { actionType: 'work', targetId: 'order-1' }, plans: [] };
  const selected = choosePlannedAffordance(state, [
    { id: 'work:workshop', action: 'work' },
    { id: 'world-work-order:order-1', action: 'work', workOrderId: 'order-1' }
  ]);
  assert.equal(selected.candidate.workOrderId, 'order-1');
  const continued = choosePlannedAffordance({ pending_action: {}, plans: [{ id: 'plan',
    status: 'active', currentStep: 0, steps: [{ actionType: 'work', targetId: 'order-1',
      description: 'Clear this accepted target' }] }] }, [
    { id: 'work:workshop', action: 'work' },
    { id: 'world-work-order:order-1', action: 'work', workOrderId: 'order-1' }
  ]);
  assert.equal(continued.candidate.workOrderId, 'order-1');
});

test('Fruitfly fallback cannot take strategic, monetary or Work Order actions', () => {
  const candidates = [{ action: 'business_invest' }, { action: 'project_propose' },
    { action: 'opportunity' }, { action: 'work', workOrderId: 'formal-order' },
    { action: 'rest' }, { action: 'learn' }];
  assert.deepEqual(routineFallbackCandidates(candidates).map((row) => row.action), ['rest','learn']);
});

test('resident REA question replaces only a currently feasible granted research candidate', () => {
  const intent = emptyIntent();
  intent.nextAction = { actionType: 'capability_use', targetId: 'research:cap:artifact:goal:12',
    researchIntent: { researchQuestion: 'What does the source reveal about storm prediction?',
      objective: 'Improve the active weather research project.', desiredInvestigation: 'Inspect relevant source paths.',
      expectedResult: 'Evidence with unresolved uncertainty.' } };
  const validated = validateCognitionIntent(intent);
  const candidate = { id: intent.nextAction.targetId, action: 'capability_use',
    capabilityContext: { researchIntent: { artifactId: 'artifact', targetType: 'source_code',
      relationType: 'goal', relationId: '12', researchQuestion: 'Template question' } } };
  const selected = choosePlannedAffordance({ pending_action: validated.nextAction, plans: [] }, [candidate]);
  assert.equal(selected.candidate.capabilityContext.researchIntent.researchQuestion,
    intent.nextAction.researchIntent.researchQuestion);
  assert.equal(selected.candidate.capabilityContext.researchIntent.artifactId, 'artifact');
  assert.equal(choosePlannedAffordance({ pending_action: validated.nextAction, plans: [] },
    [{ id: candidate.id, action: 'capability_use' }]).blocked, 'research_target_mismatch');
});

test('resident-authored project description replaces template proposal but keeps World validation', () => {
  const intent = emptyIntent();
  intent.nextAction = { actionType: 'project_propose', targetId: null,
    projectProposal: { projectType: 'RESEARCH', title: 'Storm archive',
      goal: 'Understand changing storm patterns',
      description: 'Collect historical observations and compare them with current weather events.' } };
  const validated = validateCognitionIntent(intent);
  const selected = choosePlannedAffordance({ pending_action: validated.nextAction, plans: [] },
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
  assert.equal(validated.plans[0].currentStep, 2);
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
