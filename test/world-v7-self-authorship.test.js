import test from 'node:test';
import assert from 'node:assert/strict';
import { reflectWorldV7Resident, WORLD_V7_REFLECTION_INTERVAL_MINUTES } from '../src/world-v7.js';
import { sanitizeWorldV7ReflectionOptions } from '../src/agent-runtime/typesafe.js';

const DEFAULT_IDENTITY = 'I am still forming my understanding of myself.';

function makeMemories() {
  const rows = [];
  for (let i = 0; i < 60; i++) {
    rows.push({ id: `m-work-${i}`, memoryType: 'work', summary: 'worked', worldMinute: 1000 + i * 70,
      metadata: { outcome: 0.2 } });
  }
  for (let i = 0; i < 20; i++) {
    rows.push({ id: `m-eat-${i}`, memoryType: 'eat', summary: 'ate', worldMinute: 1100 + i * 200,
      metadata: { outcome: 0.1 } });
  }
  return rows;
}

function makeState() {
  return {
    selfModel: {
      current_identity_summary: DEFAULT_IDENTITY,
      last_reflected_world_minute: '0',
      preferred_cognition_mode: 'substrate',
      metadata: {},
      recent_changes: [],
      self_beliefs: {},
      preferred_modes_of_action: [],
      important_capabilities: [],
      important_relationships: [],
      long_term_patterns: [],
    },
    memories: makeMemories(),
    skills: [
      { name: 'engineering', value: '85', actions: 40 },
      { name: 'social', value: '60', actions: 20 },
    ],
    relationships: [
      { id: 'r2', name: 'MirrorTerra-02', familiarity: '70', trust: '60', interactionCount: 30 },
    ],
    goals: [],
    capabilities: [],
    updatedIdentity: null,
    createdGoalDescription: null,
    nextGoalId: 99,
  };
}

function makeClient(state) {
  return {
    async query(sql, params = []) {
      const s = String(sql).replace(/\s+/g, ' ');
      if (s.includes('FROM world_agent_self_models WHERE world_id=$1 AND agent_id=$2 FOR UPDATE')) {
        return { rowCount: 1, rows: [state.selfModel] };
      }
      if (s.includes('FROM agent_memories')) return { rowCount: state.memories.length, rows: state.memories };
      if (s.includes('FROM world_agent_skills')) return { rowCount: state.skills.length, rows: state.skills };
      if (s.includes('FROM world_relationships')) return { rowCount: state.relationships.length, rows: state.relationships };
      if (s.includes('FROM world_capability_uses')) return { rowCount: 0, rows: [] };
      if (s.includes('FROM world_capabilities')) return { rowCount: state.capabilities.length, rows: state.capabilities };
      if (s.includes('FROM world_agent_questions')) return { rowCount: 0, rows: [] };
      if (s.includes('count(*)')) {
        return { rowCount: 1, rows: [{ count: state.goals.filter((g) => g.status === 'active').length }] };
      }
      if (s.includes("metadata->>'experienceSignature'") && s.includes('id=ANY($3::bigint[])')) {
        const ids = new Set((params[2] || []).map(String));
        const rows = state.goals.filter((goal) => ids.has(String(goal.id)))
          .map((goal) => ({ id: String(goal.id), status: goal.status, description: goal.description,
            updatedWorldMinutes: goal.updatedWorldMinutes, experienceSignature: goal.metadata?.experienceSignature }));
        return { rowCount: rows.length, rows };
      }
      if (s.includes('FROM world_agent_goals')) {
        if (s.includes("metadata->>'actionId'")) return { rowCount: 0, rows: [] };
        const rows = state.goals.filter((goal) => goal.status === 'active');
        return { rowCount: rows.length, rows };
      }
      if (s.includes('FROM world_agent_decision_policies')) return { rowCount: 0, rows: [] };
      if (s.includes('FROM world_agent_policy_experiments')) return { rowCount: 0, rows: [] };
      if (s.includes('FROM world_goal_primitives')) {
        const all = [
          { key: 'understand', status: 'active', creatorAgentId: null },
          { key: 'preserve', status: 'active', creatorAgentId: null },
          { key: 'connect', status: 'active', creatorAgentId: null },
          { key: 'explore', status: 'active', creatorAgentId: null },
          { key: 'increase_autonomy', status: 'active', creatorAgentId: null },
        ];
        const wanted = Array.isArray(params[1]) ? params[1] : all.map((p) => p.key);
        const rows = all.filter((p) => wanted.includes(p.key));
        return { rowCount: rows.length, rows };
      }
      if (s.includes('FROM world_members')) return { rowCount: 1, rows: [{}] };
      if (s.includes('INSERT INTO world_agent_goals')) {
        const row = { id: state.nextGoalId++, category: 'SELF_X', description: params[4], priority: '0.5', status: 'active' };
        state.goals.push({ ...row, goalType: 'secondary', source: 'self_generated',
          metadata: JSON.parse(params[8]), updatedWorldMinutes: Number(params[7]) });
        state.createdGoalDescription = params[4];
        return { rowCount: 1, rows: [row] };
      }
      if (s.includes('UPDATE world_agent_self_models SET')) {
        state.updatedIdentity = params[2];
        state.selfModel.current_identity_summary = params[2];
        state.selfModel.last_reflected_world_minute = String(params[11]);
        try {
          const meta = JSON.parse(params[12]);
          state.selfModel.metadata = { ...(state.selfModel.metadata || {}), ...meta };
        } catch { /* ignore */ }
        return { rowCount: 1, rows: [] };
      }
      if (s.includes('INSERT INTO world_agent_self_model_history')) return { rowCount: 1, rows: [] };
      if (s.includes('INSERT INTO world_history')) return { rowCount: 1, rows: [] };
      if (s.includes('INSERT INTO world_v7_events')) return { rowCount: 0, rows: [] };
      if (s.includes('UPDATE world_goal_primitives')) return { rowCount: 0, rows: [] };
      throw new Error(`Unexpected SQL: ${s.slice(0, 140)}`);
    },
  };
}

const agent = { agentId: 'agent-1', curiosity: 0.8, ambition: 0.3, personalityModifiers: {} };

function setInterpretedIdentity(state, { relationId = 'r2', relationName = 'MirrorTerra-02', skill = 'engineering' } = {}) {
  const relationshipText = relationId ? ` ${relationName} is the resident I know best.` : '';
  state.selfModel.current_identity_summary = `I keep returning to work (60 recent times). My strongest skill is ${skill}.${relationshipText} I am still testing whether this pattern reflects a lasting preference.`;
  state.selfModel.metadata.identityBasis = { dominantAction: 'work', evidenceCount: 60, worldMinute: 20000,
    strongestSkill: skill, topRelationId: relationId };
}

function makeAllExperienceEvidenceState() {
  const state = makeState();
  state.memories = [];
  for (let i = 0; i < 60; i++) state.memories.push({ id: `m-work-${i}`, memoryType: 'work', summary: 'worked',
    worldMinute: 1000 + i * 70, metadata: { outcome: 0.2 } });
  for (let i = 0; i < 12; i++) state.memories.push({ id: `m-trade-${i}`, memoryType: 'trade', summary: 'traded',
    worldMinute: 1200 + i * 180, metadata: { outcome: i % 6 === 5 ? -0.5 : 0.5 } });
  state.capabilities = [{ id: 'cap-new-1', name: 'New alloy', category: 'material' }];
  return state;
}

test('no-LLM fallback selects reinterpret_identity and differentiates the identity', async () => {
  const state = makeState();
  const client = makeClient(state);
  const result = await reflectWorldV7Resident(client, { worldId: 'w1', agent, worldMinute: 20000 });

  assert.equal(result.reflectionAction, 'reinterpret_identity');
  assert.equal(result.identityChanged, true);
  assert.notEqual(state.updatedIdentity, DEFAULT_IDENTITY);
  assert.match(state.updatedIdentity, /work/);
  assert.match(state.updatedIdentity, /engineering/);
  assert.match(state.updatedIdentity, /MirrorTerra-02/);
  // The evidence basis is persisted for inertia.
  assert.equal(state.selfModel.metadata.identityBasis.dominantAction, 'work');
  assert.equal(state.selfModel.metadata.identityBasis.evidenceCount, 60);
  assert.equal(state.selfModel.metadata.identityBasis.strongestSkill, 'engineering');
  assert.equal(state.selfModel.metadata.identityBasis.topRelationId, 'r2');
});

test('identity has inertia: no churn without fresh evidence', async () => {
  const state = makeState();
  const client = makeClient(state);
  const first = await reflectWorldV7Resident(client, { worldId: 'w1', agent, worldMinute: 20000 });
  assert.equal(first.reflectionAction, 'reinterpret_identity');
  state.selfModel.current_identity_summary = state.updatedIdentity;

  // Same evidence as last time: the dominant pattern did not shift, deepen 1.5x,
  // or change relationship — so identity stays put (no churn)...
  const second = await reflectWorldV7Resident(client, { worldId: 'w1', agent, worldMinute: 40000 });
  assert.notEqual(second.reflectionAction, 'reinterpret_identity');
  assert.equal(second.identityChanged, false);
  // ...and the reflection moves on to experience-driven growth instead.
  assert.equal(second.reflectionAction, 'experience_goal');
});

test('a shifted dominant pattern reopens identity reinterpretation (success moves identity too)', async () => {
  const state = makeState();
  const client = makeClient(state);
  await reflectWorldV7Resident(client, { worldId: 'w1', agent, worldMinute: 20000 });
  state.selfModel.current_identity_summary = state.updatedIdentity;

  // The resident's life changed: socializing is now dominant, with positive outcomes.
  state.memories = [];
  for (let i = 0; i < 40; i++) {
    state.memories.push({ id: `m-soc-${i}`, memoryType: 'social', summary: 'socialized',
      worldMinute: 20000 + i * 100, metadata: { outcome: 0.3 } });
  }
  const third = await reflectWorldV7Resident(client, { worldId: 'w1', agent, worldMinute: 60000 });
  assert.equal(third.reflectionAction, 'reinterpret_identity');
  assert.equal(third.identityChanged, true);
  assert.match(state.updatedIdentity, /socialize/);
});

test('success (not only failure) unlocks a self-generated goal', async () => {
  const state = makeState();
  const client = makeClient(state);
  await reflectWorldV7Resident(client, { worldId: 'w1', agent, worldMinute: 20000 });
  state.selfModel.current_identity_summary = state.updatedIdentity;

  const second = await reflectWorldV7Resident(client, { worldId: 'w1', agent, worldMinute: 40000 });
  assert.equal(second.reflectionAction, 'experience_goal');
  assert.ok(second.goal);
  assert.match(state.createdGoalDescription, /^Get even better at work/);
});

test('contradiction (mixed outcomes) unlocks an understand goal', async () => {
  const state = makeState();
  // Trade outcomes are mostly good but occasionally bad: high variance, yet too few
  // outright failures to trip the failure pathways — a pure contradiction signal.
  state.memories = [];
  for (let i = 0; i < 12; i++) {
    state.memories.push({ id: `m-tr-${i}`, memoryType: 'trade', summary: 'traded',
      worldMinute: 1000 + i * 270, metadata: { outcome: i % 6 === 5 ? -0.5 : 0.5 } });
  }
  const client = makeClient(state);
  const result = await reflectWorldV7Resident(client, { worldId: 'w1', agent, worldMinute: 20000 });
  // Identity goes first (basis stale), then contradiction should surface as a goal.
  assert.equal(result.reflectionAction, 'reinterpret_identity');
  state.selfModel.current_identity_summary = state.updatedIdentity;
  const second = await reflectWorldV7Resident(client, { worldId: 'w1', agent, worldMinute: 40000 });
  assert.equal(second.reflectionAction, 'experience_goal');
  assert.match(state.createdGoalDescription, /^Understand why my trade results vary/);
});

test('low-curiosity residents still get growth channels (no curiosity caste)', async () => {
  const state = makeState();
  const client = makeClient(state);
  const lowCuriosity = { agentId: 'agent-1', curiosity: 0.2, ambition: 0.1, personalityModifiers: {} };
  const first = await reflectWorldV7Resident(client, { worldId: 'w1', agent: lowCuriosity, worldMinute: 20000 });
  // Identity: evidence-driven, no curiosity gate.
  assert.equal(first.reflectionAction, 'reinterpret_identity');
  state.selfModel.current_identity_summary = state.updatedIdentity;
  const second = await reflectWorldV7Resident(client, { worldId: 'w1', agent: lowCuriosity, worldMinute: 40000 });
  // Success-driven goal fires for low-curiosity residents too.
  assert.equal(second.reflectionAction, 'experience_goal');
  assert.match(state.createdGoalDescription, /^Get even better at work/);
});

test('the cognitive chooser receives every supported experience option and can select a non-first option', async () => {
  const state = makeAllExperienceEvidenceState();
  setInterpretedIdentity(state);
  const client = makeClient(state);
  const expectedSources = ['contradiction', 'success', 'relationship', 'opportunity', 'stagnation', 'ambition', 'curiosity'];
  let chooserOptions = null;
  const result = await reflectWorldV7Resident(client, { worldId: 'w1', agent: { ...agent, ambition: 0.8 }, worldMinute: 40000,
    chooseReflection: async ({ options }) => {
      chooserOptions = options;
      return { decision: { id: 'experience_goal_opportunity' } };
    } });

  const offeredSources = chooserOptions.map((option) => option.id)
    .filter((id) => id.startsWith('experience_goal_')).map((id) => id.slice('experience_goal_'.length));
  assert.deepEqual(offeredSources, expectedSources);
  assert.equal(result.reflectionAction, 'experience_goal');
  assert.equal(result.experienceSource, 'opportunity');
  assert.match(state.createdGoalDescription, /^See what New alloy can do/);
});

test('TypeSafe reflection option sanitizing retains all seven experience choices at the 16-option limit', () => {
  const otherOptions = Array.from({ length: 9 }, (_, index) => ({ id: `other_option_${index}`, description: 'Another bounded choice.' }));
  const experienceOptions = ['contradiction', 'success', 'relationship', 'opportunity', 'stagnation', 'ambition', 'curiosity']
    .map((source) => ({ id: `experience_goal_${source}`, description: `Choose the ${source} evidence-backed goal.` }));
  const retained = sanitizeWorldV7ReflectionOptions([...otherOptions, ...experienceOptions]);

  assert.equal(retained.length, 16);
  assert.deepEqual(retained.slice(-7).map((option) => option.id), experienceOptions.map((option) => option.id));
});

test('no-LLM experience fallback uses the fixed evidence-source order', async () => {
  const state = makeAllExperienceEvidenceState();
  setInterpretedIdentity(state);
  const result = await reflectWorldV7Resident(makeClient(state), { worldId: 'w1', agent: { ...agent, ambition: 0.8 }, worldMinute: 40000 });

  assert.equal(result.reflectionAction, 'experience_goal');
  assert.equal(result.experienceSource, 'contradiction');
  assert.match(state.createdGoalDescription, /^Understand why my trade results vary/);
});

test('a new strongest skill reopens identity reinterpretation', async () => {
  const state = makeState();
  setInterpretedIdentity(state);
  state.skills = [
    { name: 'engineering', value: '60', actions: 40 },
    { name: 'social', value: '95', actions: 20 },
  ];
  const result = await reflectWorldV7Resident(makeClient(state), { worldId: 'w1', agent, worldMinute: 40000 });

  assert.equal(result.reflectionAction, 'reinterpret_identity');
  assert.equal(result.identityChanged, true);
  assert.match(state.updatedIdentity, /strongest skill is social/);
  assert.equal(state.selfModel.metadata.identityBasis.strongestSkill, 'social');
});

test('relationship evidence changes reopen identity interpretation across null and agent identities', async () => {
  const cases = [
    { name: 'null to agent', basis: { relationId: null, relationName: '' }, current: [{ id: 'r2', name: 'MirrorTerra-02', familiarity: '70', trust: '60', interactionCount: 30 }] },
    { name: 'agent to null', basis: { relationId: 'r2', relationName: 'MirrorTerra-02' }, current: [] },
    { name: 'agent A to agent B', basis: { relationId: 'rA', relationName: 'Agent A' }, current: [{ id: 'rB', name: 'Agent B', familiarity: '65', trust: '55', interactionCount: 20 }] },
  ];
  for (const scenario of cases) {
    const state = makeState();
    setInterpretedIdentity(state, scenario.basis);
    state.relationships = scenario.current;
    const result = await reflectWorldV7Resident(makeClient(state), { worldId: 'w1', agent, worldMinute: 40000 });
    assert.equal(result.reflectionAction, 'reinterpret_identity', scenario.name);
    assert.equal(result.identityChanged, true, scenario.name);
  }
});

test('completed experience goals cool down for three reflection intervals, then can recur', async () => {
  const state = makeState();
  state.relationships = [];
  const client = makeClient(state);
  const lowCuriosity = { agentId: 'agent-1', curiosity: 0.2, ambition: 0.1, personalityModifiers: {} };
  await reflectWorldV7Resident(client, { worldId: 'w1', agent: lowCuriosity, worldMinute: 20000 });
  const created = await reflectWorldV7Resident(client, { worldId: 'w1', agent: lowCuriosity, worldMinute: 40000 });
  assert.equal(created.reflectionAction, 'experience_goal');
  assert.match(state.goals[0].metadata.experienceSignature, /^experience-goal\.success\./);
  const signature = state.goals[0].metadata.experienceSignature;
  assert.deepEqual(state.selfModel.metadata.experienceGoalHistory, [{ goalId: '99', signature }]);
  state.goals[0].status = 'completed';
  state.goals[0].updatedWorldMinutes = 40000;

  const duringCooldown = await reflectWorldV7Resident(client, { worldId: 'w1', agent: lowCuriosity, worldMinute: 60000 });
  assert.equal(duringCooldown.reflectionAction, 'no_change');
  assert.equal(state.goals.length, 1);

  const afterCooldown = await reflectWorldV7Resident(client, { worldId: 'w1', agent: lowCuriosity,
    worldMinute: 40000 + 4 * WORLD_V7_REFLECTION_INTERVAL_MINUTES });
  assert.equal(afterCooldown.reflectionAction, 'experience_goal');
  assert.equal(state.goals.length, 2);
  assert.equal(state.goals[1].metadata.experienceSignature, signature);
  assert.deepEqual(state.selfModel.metadata.experienceGoalHistory, [{ goalId: '100', signature }]);
});

test('recent completed experience goals from before signatures are deduplicated by their recorded goal ID', async () => {
  const state = makeState();
  state.relationships = [];
  setInterpretedIdentity(state, { relationId: null });
  state.selfModel.recent_changes = [{ kind: 'self_generated_meta_goal', worldMinute: 40000, goalId: 77 }];
  state.goals.push({ id: 77, goalType: 'secondary', source: 'self_generated', status: 'completed',
    description: 'Get even better at work — it keeps working for me and I want to understand why.',
    metadata: { goalGrammar: [{ primitive: 'understand', target: 'work' }] }, updatedWorldMinutes: 40000 });

  const result = await reflectWorldV7Resident(makeClient(state), { worldId: 'w1',
    agent: { agentId: 'agent-1', curiosity: 0.2, ambition: 0.1, personalityModifiers: {} }, worldMinute: 60000 });

  assert.equal(result.reflectionAction, 'no_change');
  assert.equal(state.goals.length, 1);
});
