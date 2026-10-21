import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateAutonomy, aggregateIntelligence, normalizeObservable,
  parseObservabilityPage, projectEventPage } from '../src/observability.js';
import { readObservableEvents, readWorldFeed } from '../src/observability-data.js';
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

test('distinct persisted milestones retain stable source-key pagination', () => {
  const rows = [history(1, 'project_started', 4), history(2, 'project_started', 4),
    history(3, 'project_completed', 3)];
  rows[1].entity_id = rows[0].entity_id;
  const first = projectEventPage(rows, { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].id, 'h:2');
  const next = projectEventPage(rows, { limit: 2, cursor: parseObservabilityPage({ cursor: first.nextCursor }).cursor });
  assert.deepEqual(next.items.map((item) => item.id), ['h:1','h:3']);
  assert.throws(() => parseObservabilityPage({ limit: '100' }), /LIMIT_INVALID/);
  assert.throws(() => parseObservabilityPage({ cursor: 'nonsense' }), /CURSOR_INVALID/);
});

test('timeline scopes every source to the requested resident and handles empty history', async () => {
  const queries = [];
  const pool = { async query(sql, values) { queries.push({ sql, values }); return { rows: [], rowCount: 0 }; } };
  const page = await readObservableEvents(pool, { worldId, agentId, limit: 7 });
  assert.deepEqual(page, { items: [], nextCursor: null });
  assert.equal(queries.length, 6);
  assert.ok(queries.every(({ values }) => values[0] === worldId && values[1] === agentId && values[5] === 8));
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
  assert.equal(result.usage.inputTokens, null);
  assert.equal(result.usage.knownInputTokens, 100);
  assert.equal(result.escalationCount, 0);
  assert.equal(result.cost.knownUsd24h, 0.01);
  assert.equal(result.cost.complete, false);
  assert.equal(result.cost.estimatedMonthlyRunRateUsd, null);
});

test('autonomy never substitutes project counts or ordinary World actions for model evidence', () => {
  const result = aggregateAutonomy({ model_goals: 2, model_plans: 3, attributed_actions: 0,
    completed_steps: 0, completed_plans: 0, world_actions: 3456, tool_calls: 1,
    tool_succeeded: 1, tool_failed: 0, grounded_calls: 0, grounding_outcomes: 0 });
  assert.equal(result.plans.created, 3);
  assert.equal(result.plans.completed, 0);
  assert.equal(result.goals.revised, null);
  assert.equal(result.cognitionToAction.successfulWorldActions, 0);
  assert.equal(result.cognitionToAction.unattributedWorldActions, 3456);
  assert.equal(result.cognitionToAction.eligibleTurns, null);
  assert.equal(result.evidence.status, 'no_attributed_execution_evidence');
  assert.equal(result.fruitfly.fruitflyAssisted, null);
});

test('attributed execution metrics use distinct persisted facts and known grounding outcomes', () => {
  const result = aggregateAutonomy({ attributed_actions: 4, world_actions: 9,
    grounded_calls: 3, grounding_outcomes: 4, unknown_groundings: 7,
    completed_steps: 4, completed_plans: 2 });
  assert.equal(result.cognitionToAction.groundingRate, 0.75);
  assert.equal(result.cognitionToAction.unknownGroundingOutcomes, 7);
  assert.equal(result.plans.completed, 2);
  assert.equal(result.evidence.status, 'persisted_attribution');
});

// More than the original seen-array cap; ties, shuffled input and newly arriving
// records cannot grow the cursor or invalidate the original browsing window.
for (const limit of [20,40,50]) test(`bounded cursor continues across 20 pages at limit ${limit}`, () => {
  const rows = Array.from({ length: 1100 }, (_, i) => ({ ...history(i+1, 'project_completed', Math.floor(i/30)),
    sort_at: `2026-10-18T00:00:00.${String(i).padStart(6,'0')}Z` }));
  let cursor = null; const ids = [];
  for (let page = 0; page < 60; page++) {
    const currentRows = page ? [...rows].reverse().concat(history(99999, 'project_started', 120)) : rows;
    const result = projectEventPage(currentRows, { limit, cursor,
      until: '2026-10-18T00:00:01.000000Z' });
    ids.push(...result.items.map((r) => r.id));
    if (!result.nextCursor) break;
    assert.ok(result.nextCursor.length < 512);
    cursor = parseObservabilityPage({ cursor: result.nextCursor }).cursor;
  }
  assert.equal(ids.length, 1100);
  assert.equal(new Set(ids).size, ids.length);
});

test('rolling timeline lower bound stays fixed in its cursor; legacy large cursors remain readable', () => {
  const rows = [history(1,'project_completed',1),history(2,'project_completed',2)];
  const first = projectEventPage(rows, { limit:1, since:at(0), until:'2026-10-18T01:00:00.000000Z' });
  const cursor = parseObservabilityPage({cursor:first.nextCursor}).cursor;
  assert.equal(cursor.since,'2026-10-18T00:00:00.000000Z');
  const next = projectEventPage(rows, {limit:1,cursor,since:at(10)});
  assert.equal(next.items[0].id,'h:1');
  const legacy = Buffer.from(JSON.stringify({at:at(2),id:'h:2',seen:Array(100).fill('x'.repeat(30))})).toString('base64url');
  assert.ok(legacy.length>2048);
  assert.equal(parseObservabilityPage({cursor:legacy}).cursor.id,'h:2');
});

test('Luna semantic tiers are not upgrades; a truncated all-failed sample is not a cost total', () => {
  const rows = ['haiku','sonnet','opus'].map((tier,i)=>({created_at:at(i),provider_started_at:at(i),
    model:'gpt-6-luna',tier,status:'failed',cost_source:'reservation',effective_cost_nano_usd:'100000000',
    correlation_id:'same',agent_id:agentId,trigger:i?'resident_escalation':'routine'}));
  const data=aggregateIntelligence(rows,new Date(at(30)),{truncated:true});
  assert.equal(data.escalationCount,0);
  assert.equal(data.failureRate,1);
  assert.equal(data.cost.knownUsd24h,null);
  assert.equal(data.cost.unknownCalls,3);
  assert.equal(data.cost.estimatedMonthlyRunRateUsd,null);
  assert.equal(data.window.truncated,true);
  assert.equal(data.usage.inputTokens,null);
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

test('SQL eligibility filters run before pagination and do not cast historical abandonment reasons to boolean', async () => {
  const queries = [];
  await readObservableEvents({ async query(sql) { queries.push(sql); return { rows: [] }; } }, { worldId });
  const events = queries.find(sql => sql.includes('FROM world_events e'));
  assert.match(events, /e\.data->>'status'='completed'/);
  assert.match(events, /e\.data->'abandoned'/);
  assert.doesNotMatch(events, /abandoned'\)::boolean/);
  assert.equal(normalizeObservable({source:'e',id:1,created_at:at(1),event_type:'world.action_completed',data:{action:'project_contribute',status:'completed',abandoned:'EXTERNAL_RECEIVES_PURCHASED_SYNC_ONLY'}}), null);
});
