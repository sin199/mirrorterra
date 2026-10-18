import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateAutonomy, aggregateIntelligence, normalizeObservable,
  parseObservabilityPage, projectEventPage } from '../src/observability.js';
import { aggregateAutonomyCounts, readObservableEvents, readWorldFeed } from '../src/observability-data.js';
import { readFollowed, toggleFollow } from '../site/follow-state.js';
import { isAuthExemptRoutePath, isReadinessGatedPublicApiPath } from '../src/request-routing.js';

const worldId = 'b0a7be89-9e2f-4611-9533-2d7a87e97021';
const agentId = '33dfae78-5a6b-433e-88bc-a28736311e97';
const at = (minute) => new Date(Date.UTC(2026, 9, 18, 0, minute)).toISOString();
const history = (id, event_type, minute, agent_id = agentId) => ({ source: 'h', id: String(id),
  created_at: at(minute), agent_id, agent_name: 'Ada', world_minute: minute,
  event_type, title: `Event ${id}`, detail: `Detail ${id}`, entity_type: 'project', entity_id: `entity-${id}` });

test('feed keeps meaningful milestones and filters routine ticks', () => {
  const rows = [history(1, 'project_completed', 1), history(2, 'heartbeat', 2),
    { source: 'e', id: '3', created_at: at(3), agent_id: agentId,
      event_type: 'world.movement_started', data: {} },
    { source: 'e', id: '4', created_at: at(4), agent_id: agentId,
      event_type: 'world.action_completed', data: { action: 'rest', status: 'completed' } }];
  assert.deepEqual(projectEventPage(rows).items.map((item) => item.id), ['h:1']);
});

test('event normalization never exposes raw action payload or internal reasoning', () => {
  const event = normalizeObservable({ source: 'e', id: '9', created_at: at(8), agent_id: agentId,
    event_type: 'world.action_completed', data: { action: 'project_contribute', status: 'completed',
      secret: 'private', cognitionExecution: { modelCallId: 'call-id' } } });
  assert.equal(event.type, 'world_action_completed');
  assert.equal(JSON.stringify(event).includes('private'), false);
});

test('duplicate entity milestone is filtered and keyset pagination is stable', () => {
  const rows = [history(1, 'project_started', 4), history(2, 'project_started', 4),
    history(3, 'project_completed', 3)];
  rows[1].entity_id = rows[0].entity_id;
  const first = projectEventPage(rows, { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].id, 'h:2');
  const next = projectEventPage(rows, { limit: 2, cursor: parseObservabilityPage({ cursor: first.nextCursor }).cursor });
  assert.deepEqual(next.items.map((item) => item.id), ['h:3']);
  assert.throws(() => parseObservabilityPage({ limit: '100' }), /LIMIT_INVALID/);
  assert.throws(() => parseObservabilityPage({ cursor: 'nonsense' }), /CURSOR_INVALID/);
});

test('timeline scopes every source to the requested resident and handles empty history', async () => {
  const queries = [];
  const pool = { async query(sql, values) { queries.push({ sql, values }); return { rows: [], rowCount: 0 }; } };
  const page = await readObservableEvents(pool, { worldId, agentId, limit: 7 });
  assert.deepEqual(page, { items: [], nextCursor: null });
  assert.equal(queries.length, 6);
  assert.ok(queries.every(({ values }) => values[0] === worldId && values[1] === agentId && values[5] >= 100));
  assert.ok(queries.every(({ sql }) => sql.includes('LIMIT $6')));
});

test('mixed source feed is newest first and reads only the current world', async () => {
  const queries = [];
  const pool = { async query(sql, values) {
    queries.push({ sql, values });
    if (sql.includes('FROM worlds world')) return { rows: [{ id: worldId }], rowCount: 1 };
    if (sql.includes('FROM world_history h')) return { rows: [history(1, 'project_completed', 1)], rowCount: 1 };
    if (sql.includes('FROM world_research_jobs j')) return { rows: [{ source: 'j', id: 'job-1',
      created_at: at(2), agent_id: agentId, status: 'completed', research_question: 'Investigate actual evidence' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } };
  const page = await readWorldFeed(pool, { limit: 10 });
  assert.deepEqual(page.items.map((item) => item.id), ['j:job-1', 'h:1']);
  assert.ok(queries.slice(1).every(({ values }) => values[0] === worldId));
});

test('intelligence aggregates actual models, failures, usage and known cost without guessing missing fields', () => {
  const rows = [
    { created_at: at(1), provider_started_at: at(1), model: 'haiku-v1', returned_model: 'haiku-v1',
      tier: 'haiku', status: 'succeeded', input_tokens: 100, output_tokens: 20,
      cost_source: 'usage_priced', effective_cost_nano_usd: '10000000' },
    { created_at: at(2), provider_started_at: at(2), model: 'sonnet-v1', tier: 'sonnet',
      status: 'failed', input_tokens: null, output_tokens: null,
      cost_source: 'reservation', effective_cost_nano_usd: '100000000' }
  ];
  const result = aggregateIntelligence(rows, new Date(at(30)));
  assert.equal(result.calls24h, 2);
  assert.equal(result.failedCalls24h, 1);
  assert.equal(result.byModel['haiku-v1'], 1);
  assert.equal(result.byTier.sonnet, 1);
  assert.equal(result.usage.inputTokens, 100);
  assert.equal(result.cost.knownUsd24h, 0.01);
  assert.equal(result.cost.complete, false);
  assert.equal(result.cost.estimatedMonthlyRunRateUsd, null);
});

test('autonomy counts only persisted facts and leaves uncertain rates unavailable', () => {
  const events = [normalizeObservable(history(1, 'agent_goal_created', 1)),
    normalizeObservable(history(2, 'project_completed', 2))];
  const result = aggregateAutonomy(events, [{ success: true, decision_source: 'fruitfly' }], []);
  assert.equal(result.goals.formed, 1);
  assert.equal(result.plans.completed, 1);
  assert.equal(result.fruitfly.fruitflyAssisted, 1);
  assert.equal(result.cognitionToAction.groundingRate, null);
});

test('autonomy uses exact grouped counts and does not equate projects with cognition plans', () => {
  const result = aggregateAutonomyCounts({
    history: [{ event_type: 'project_completed', count: 2 }, { event_type: 'agent_goal_created', count: 3 }],
    events: [{ event_type: 'world.action_completed', action: 'project_contribute', attributed: true, count: 12 },
      { event_type: 'world.action_completed', action: 'business_work', attributed: false, count: 15000 }],
    uses: [{ decision_source: 'fruitfly', success: true, count: 4 }], eligibleTurns: 5,
    research: { artifacts_produced: 2, jobs_progressed: 3 }
  });
  assert.equal(result.goals.formed, 3);
  assert.equal(result.projects.completed, 2);
  assert.equal(result.plans.created, null);
  assert.equal(result.cognitionToAction.meaningfulWorldActions, 15012);
  assert.equal(result.cognitionToAction.successfulWorldActions, 12);
  assert.equal(result.cognitionToAction.groundingRate, null);
  assert.equal(result.fruitfly.available, false);
  assert.equal(result.fruitfly.capabilityUsesBySource.fruitfly, 4);
  assert.equal(result.tools.artifactsProduced, 2);
});

test('follow stays in browser storage and never calls a World API', () => {
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  assert.equal(readFollowed(storage).size, 0);
  assert.equal(toggleFollow(storage, agentId).has(agentId), true);
  assert.equal(toggleFollow(storage, agentId).has(agentId), false);
  assert.equal([...saved.keys()][0], 'mirrorterra.followedResidents.v1');
});

test('observer routes are public read-only routes behind readiness', () => {
  for (const path of ['/api/world/feed','/api/world/intelligence','/api/agents',
    `/api/agents/${agentId}/summary`, `/api/agents/${agentId}/timeline`]) {
    assert.equal(isAuthExemptRoutePath(path), true);
    assert.equal(isReadinessGatedPublicApiPath(path), true);
  }
});
