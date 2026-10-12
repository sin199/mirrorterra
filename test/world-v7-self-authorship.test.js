import test from 'node:test';
import assert from 'node:assert/strict';
import { reflectWorldV7Resident } from '../src/world-v7.js';

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
      if (s.includes('FROM world_agent_goals')) {
        if (s.includes("metadata->>'actionId'")) return { rowCount: 0, rows: [] };
        return { rowCount: state.goals.length, rows: state.goals };
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
        const row = { id: 99, category: 'SELF_X', description: params[4], priority: '0.5', status: 'active' };
        state.goals.push({ ...row, goalType: 'secondary', source: 'self_generated' });
        state.createdGoalDescription = params[4];
        return { rowCount: 1, rows: [row] };
      }
      if (s.includes('UPDATE world_agent_self_models SET')) {
        state.updatedIdentity = params[2];
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
