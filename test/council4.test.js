// council4: builders actually build, in-range proposals with cooldowns, action back-off, fair cognition,
// and no treasury clawback for reward weights below 1x.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COUNCIL_GOVERNOR_ID, buildEconomyStats, councilProposalOptions, proposalCooldowns, proposalOnCooldown,
  collectCouncilTaxes } from '../src/council.js';
import { LEVER_KEYS, defaultLeverValue, issueResidentReward, resetRewardWeightCache, rewardWeightAdmits } from '../src/treasury.js';
import { ABANDON_AFTER_MINUTES, MAX_ACTIVE_CONTRACTS, MIN_HOLD_MINUTES, WARN_AFTER_MINUTES, WARNING_GRACE_MINUTES,
  NO_BUILDER_CAPACITY, baseProjectKey, builderCapacity, chooseWinningBid, commissionCapacity, contractPriorityChoice, holdSessions,
  publicWorkCandidates, publicWorksNeeds, reassignmentDecision, recommissionKey } from '../src/public-works.js';
import { boundedValueFromTarget, councilDeliberationStep, leverChoices, parseProposal, proposeMessages, economyContext }
  from '../src/council-deliberation.js';
import { BACKOFF_ACTION_MAX_MINUTES, BACKOFF_TARGET_MINUTES, backoffSnapshot, filterBackedOff, isBackedOff,
  recordActionRejection, recordActionSuccess, resetActionBackoff } from '../src/action-backoff.js';
import { buildWorldInitiativeCandidates } from '../src/world-initiatives.js';
import { sleepState } from '../src/world-environment.js';

const SYNC = 1_000_000n;
const WORLD = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const ids = Array.from({ length: 10 }, (_, i) => (i === 0 ? COUNCIL_GOVERNOR_ID
  : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
const defaults = Object.fromEntries(LEVER_KEYS.map((lever) => [lever, defaultLeverValue(lever)]));
const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
const code = (text) => text.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
const work = (over = {}) => ({ id: 'w1', status: 'building', builder_agent_id: ids[3], progress: 0, sessions: 0,
  awarded_world_minute: '1000', last_work_world_minute: '1000', scene_name: 'Public Clinic', name: 'Public Clinic',
  contract_price_raw: String(5n * SYNC), paid_raw: '0', position: { hold: { holder: ids[3], since: 1000, sessionsAtStart: 0,
    warnedAt: null, idleHolders: [] } }, ...over });

test('builders build: an active contract wins over plan/project actions, but food, energy and sleep come first', () => {
  const contract = publicWorkCandidates({ agentId: ids[3], energy: 70, food: 70, location: 'Library' }, [work()])[0];
  assert.equal(contract.contractPriority, true);
  const project = { id: 'project:join:p1', action: 'project_join', score: 99 };
  const agent = { agentId: ids[3], energy: 70, food: 70 };
  assert.equal(contractPriorityChoice(agent, [project, contract])?.id, contract.id, 'contract beats a higher-scored project action');
  assert.equal(contractPriorityChoice({ ...agent, food: 20 }, [project, contract]), null, 'hungry: eat first');
  assert.equal(contractPriorityChoice({ ...agent, energy: 25 }, [project, contract]), null, 'tired: rest first');
  assert.equal(contractPriorityChoice({ ...agent, energy: 60 }, [project, contract], { sleep: { inWindow: true } }), null, 'sleep first');
  assert.equal(contractPriorityChoice({ ...agent, energy: 80 }, [project, contract], { sleep: { inWindow: true } })?.id, contract.id);
  assert.equal(contractPriorityChoice(agent, [project]), null, 'no contract, normal flow');
  // A warned holder's construction candidate scores higher still.
  const warned = publicWorkCandidates({ agentId: ids[3], energy: 70, food: 70 }, [work({ position: { hold: { since: 1000, warnedAt: 1700 } } })])[0];
  assert.ok(warned.score > contract.score);
  assert.ok(sleepState(ids[3], 3 * 60).inWindow !== undefined);
});

test('builders build: at most 2 contracts, and only real capacity (no idle or unstarted contract)', () => {
  assert.equal(MAX_ACTIVE_CONTRACTS, 2);
  assert.equal(builderCapacity(ids[3], [], 2000).hasCapacity, true);
  const started = work({ sessions: 2, last_work_world_minute: '1900' });
  assert.equal(holdSessions(started), 2);
  assert.equal(builderCapacity(ids[3], [started], 2000).hasCapacity, true, 'second contract once the first is being built');
  assert.equal(builderCapacity(ids[3], [work()], 1100).hasCapacity, false, 'first contract not started yet');
  assert.equal(builderCapacity(ids[3], [started, { ...started, id: 'w2' }], 2000).hasCapacity, false, 'two contracts is the cap');
  const idle = work({ sessions: 2, last_work_world_minute: '1000', position: { hold: { since: 1000, sessionsAtStart: 0 } } });
  assert.equal(builderCapacity(ids[3], [idle], 1000 + WARN_AFTER_MINUTES).hasCapacity, false, 'an idle contract blocks new ones');
  assert.equal(builderCapacity(ids[4], [started], 2000).hasCapacity, true, 'other residents unaffected');
});

test('builders build: warn first, minimum hold, 16 idle hours (sleep + travel fit), then reassign; no ping-pong', () => {
  assert.ok(ABANDON_AFTER_MINUTES >= 8 * 60 + 6 * 60, 'an 8 h sleep window plus meals and travel fit in the idle limit');
  const w = work();
  assert.equal(reassignmentDecision(w, 1000 + WARN_AFTER_MINUTES - 1), 'keep');
  assert.equal(reassignmentDecision(w, 1000 + WARN_AFTER_MINUTES), 'warn');
  const warnedAt = 1000 + WARN_AFTER_MINUTES;
  const warned = work({ position: { hold: { ...w.position.hold, warnedAt } } });
  assert.equal(reassignmentDecision(warned, warnedAt + 60), 'keep', 'warned, still in grace');
  assert.equal(reassignmentDecision(warned, 1000 + ABANDON_AFTER_MINUTES - 1), 'keep');
  assert.equal(reassignmentDecision(warned, Math.max(1000 + ABANDON_AFTER_MINUTES, warnedAt + WARNING_GRACE_MINUTES,
    1000 + MIN_HOLD_MINUTES)), 'reassign');
  // A session after the warning resets it: a later idle stretch needs a new warning first.
  const worked = work({ sessions: 1, last_work_world_minute: String(warnedAt + 100), position: { hold: { ...w.position.hold, warnedAt } } });
  assert.equal(reassignmentDecision(worked, warnedAt + 100 + WARN_AFTER_MINUTES), 'warn');
  // A just-reassigned contract is held at least MIN_HOLD_MINUTES even if the idle clock says otherwise.
  const fresh = work({ last_work_world_minute: '500', position: { hold: { since: 1500, warnedAt: 1600 } } });
  assert.equal(reassignmentDecision(fresh, 1500 + ABANDON_AFTER_MINUTES - 10), 'keep');
  assert.equal(reassignmentDecision(work({ progress: 100 }), 99_999), 'keep');
  // The next holder excludes the current holder and residents who held it without building.
  const bids = ids.slice(2, 6).map((agentId, index) => ({ agentId, bidRaw: String(BigInt(3 + index) * SYNC), credible: true, skillValue: 20 }));
  assert.equal(chooseWinningBid(bids, new Set([ids[3], ids[2]])).agentId, ids[4]);
});

test('re-commissioning a cancelled project key', () => {
  assert.equal(baseProjectKey('expansion:ebda99ba:2.r1'), 'expansion:ebda99ba:2');
  assert.equal(recommissionKey('expansion:ebda99ba:2', []), 'expansion:ebda99ba:2');
  assert.equal(recommissionKey('expansion:ebda99ba:2', ['expansion:ebda99ba:2']), 'expansion:ebda99ba:2.r1');
  assert.equal(recommissionKey('expansion:ebda99ba:2', ['expansion:ebda99ba:2', 'expansion:ebda99ba:2.r1']), 'expansion:ebda99ba:2.r2');
  assert.match('expansion:ebda99ba:2.r12', /^[a-z0-9_:.-]{3,80}$/, 'fits the 0030 project_key CHECK');
  // An open re-commissioned work still counts as that project in the needs list.
  const needs = publicWorksNeeds({ open: [{ kind: 'road', projectKey: 'road:1.r1' }], districts: 1 });
  assert.ok(!needs.some((need) => need.projectKey === 'road:1'));
});

test('proposals: exact ranges and current values in the prompt; near misses clamped; far misses refused', () => {
  const policies = { ...defaults, 'multiplier.research_project': { milli: 500 }, 'tax.income': { bps: 100 } };
  const choices = leverChoices(policies);
  const research = choices.find((choice) => choice.lever === 'multiplier.research_project');
  assert.deepEqual(research.allowedRange, [0.25, 1]);
  assert.equal(research.currentTarget, 0.5);
  assert.deepEqual(choices.find((choice) => choice.lever === 'tax.income').allowedRange, [0, 30]);
  assert.equal(choices.find((choice) => choice.lever === 'tax.income').currentTarget, 1);
  assert.deepEqual(choices.find((choice) => choice.lever === 'price.food_service').allowedRange, [0.5, 2]);
  assert.deepEqual(choices.find((choice) => choice.lever === 'good.tools').allowedRange, [0.1, 20]);
  const messages = proposeMessages({ resident: { name: 'MirrorTerra-02' }, context: economyContext({ stats: null, policies }),
    levers: choices, suggestions: [], cooldowns: [{ lever: 'multiplier.research_project', direction: -1, rejections: 7, untilWorldDay: 940 }] });
  assert.match(messages[1].content, /allowedRange/);
  assert.match(messages[1].content, /currentTarget/);
  assert.match(messages[1].content, /"rejectedChange":"lower"/);
  assert.deepEqual(boundedValueFromTarget('multiplier.research_project', 1.25), { value: { milli: 1000 }, clamped: true });
  assert.deepEqual(boundedValueFromTarget('tax.sales', 35), { value: { bps: 3000 }, clamped: true });
  assert.deepEqual(boundedValueFromTarget('tax.sales', '5%'), { value: { bps: 500 }, clamped: false });
  assert.deepEqual(boundedValueFromTarget('price.food_service', 0.3), { value: { milli: 500 }, clamped: true });
  assert.deepEqual(boundedValueFromTarget('good.tools', 25), { value: { priceRaw: '20000000' }, clamped: true });
  assert.equal(boundedValueFromTarget('tax.sales', 300), null);
  assert.equal(boundedValueFromTarget('multiplier.research_project', 'lots'), null);
  assert.deepEqual(parseProposal({ propose: true, lever: 'tax.sales', target: 45, reason: 'Fund the road.' }).value, { bps: 3000 });
  assert.throws(() => parseProposal({ propose: true, lever: 'tax.income', target: 1, reason: 'Same as today.' }, { policies }), /LUNA_TARGET_NO_CHANGE/);
});

test('proposals: cooldown after rejection (identical or same direction), for Luna and the fallback', () => {
  const rejected = Array.from({ length: 7 }, (_, day) => ({ lever_key: 'multiplier.research_project',
    previous_value: { milli: 500 }, proposed_value: { milli: 250 }, opened_world_day: 925 + day }));
  const cooldowns = proposalCooldowns(rejected, 932);
  assert.equal(cooldowns.length, 1);
  assert.equal(cooldowns[0].rejections, 7);
  assert.equal(cooldowns[0].untilWorldDay, 931 + 10, 'escalates 2 days per rejection, capped at 10');
  assert.ok(proposalOnCooldown({ lever: 'multiplier.research_project', previous: { milli: 500 }, value: { milli: 250 } }, cooldowns));
  assert.ok(proposalOnCooldown({ lever: 'multiplier.research_project', previous: { milli: 750 }, value: { milli: 500 } }, cooldowns), 'similar: same direction');
  assert.equal(proposalOnCooldown({ lever: 'multiplier.research_project', previous: { milli: 500 }, value: { milli: 750 } }, cooldowns), null, 'the opposite direction is allowed');
  assert.equal(proposalCooldowns([{ ...rejected[0], opened_world_day: 900 }], 932).length, 0, 'expires');
  const policies = { ...defaults, 'multiplier.research_project': { milli: 500 } };
  assert.throws(() => parseProposal({ propose: true, lever: 'multiplier.research_project', target: 0.25, reason: 'Lower it.' },
    { policies, cooldowns }), /LUNA_PROPOSAL_COOLDOWN/);
  // The fallback skips a cooled-down option.
  const stats = buildEconomyStats({ pool: ids.map((agentId) => ({ source_type: 'research_project', agent_id: agentId, amount: String(8n * SYNC) })),
    spendingRaw: 50n * SYNC, balances: ids.map((agentId, index) => ({ agent_id: agentId, name: `S-${index}`, balance_raw: String(100n * SYNC),
      goal: 'balanced', energy: 50, food: 50, social: 50, happiness: 50, knowledge: 50, fun: 50, hygiene: 50 })),
    treasuryBalanceRaw: '849000000', memberCount: 10 });
  const free = councilProposalOptions({ stats, policies, limit: 1 })[0];
  assert.equal(free.lever, 'multiplier.research_project');
  const cooled = councilProposalOptions({ stats, policies, limit: 1, cooldowns })[0];
  assert.notEqual(cooled?.lever, 'multiplier.research_project');
});

test('action back-off: a rejected action/target is skipped for a while, escalates, and resets on success', () => {
  resetActionBackoff();
  const agent = ids[8];
  const propose = { id: 'project:org-propose:o1:RESEARCH', action: 'project_propose', projectProposal: { projectType: 'RESEARCH' } };
  const eat = { id: 'eat:cafe', action: 'eat' };
  const set = recordActionRejection(agent, { action: 'project_propose', context: { projectProposal: { projectType: 'RESEARCH' } },
    code: 'PROJECT_CAPACITY_REACHED', worldMinutes: 1000 });
  assert.equal(set.strikes, 1);
  assert.deepEqual(filterBackedOff(agent, [propose, eat], 1001).map((item) => item.id), ['eat:cafe']);
  assert.equal(isBackedOff(agent, propose, 1000 + BACKOFF_TARGET_MINUTES), false, 'expires');
  for (let index = 0; index < 8; index += 1) recordActionRejection(agent, { action: 'project_propose', code: 'X', worldMinutes: 1000 + index });
  assert.ok(backoffSnapshot()[agent].project_propose.until - 1007 === BACKOFF_ACTION_MAX_MINUTES, 'escalates to the cap');
  recordActionSuccess(agent, 'project_propose');
  assert.equal(isBackedOff(agent, { action: 'project_propose' }, 1010), false);
  // Target-specific back-off for joins: the other project is still open.
  recordActionRejection(agent, { action: 'project_join', context: { projectId: 'p1' }, code: 'PROJECT_NOT_RECRUITING', worldMinutes: 2000 });
  assert.equal(isBackedOff(agent, { action: 'project_join', projectId: 'p1' }, 2100), true);
  assert.equal(isBackedOff(agent, { action: 'project_join', projectId: 'p2' }, 2100), false);
  assert.equal(isBackedOff(ids[2], { action: 'project_join', projectId: 'p1' }, 2001), false, 'per resident');
  resetActionBackoff();
});

test('action back-off root causes: org openings only offer recruiting projects with room; org proposals respect the owner cap', () => {
  const opening = (id, status, extra = {}) => ({ id, status, title: id, project_type: 'RESEARCH', capacity: 4, participantCount: 1,
    required_skills: { research: 10 }, metadata: {}, ...extra });
  const agent = { agentId: 'resident-a', name: 'A', location: 'Library', energy: 75, food: 70, primaryGoal: 'MASTER_RESEARCH',
    skills: { research: 42, engineering: 17, trading: 11, social: 24 }, relationships: [], projectMemberships: [],
    activeProjects: [], activeProjectsCreated: 2, organizationMemberships: [{ id: 'org-a', name: 'Org A', purpose: 'x',
      status: 'active', memberStatus: 'active', reputation: 10, resources: { effort: 20 }, memberIds: ['resident-a'],
      projectOpenings: [opening('p-active', 'active'), opening('p-full', 'recruiting', { participantCount: 4 }), opening('p-open', 'recruiting')] }] };
  const candidates = buildWorldInitiativeCandidates(agent, { worldMinutes: 100, projects: [] });
  const joins = candidates.filter((item) => item.id.startsWith('project:org-join:')).map((item) => item.projectId);
  assert.deepEqual(joins, ['p-open']);
  assert.ok(!candidates.some((item) => item.id.startsWith('project:org-propose:')), 'owner of 2 open projects: no org proposal');
  const fresh = buildWorldInitiativeCandidates({ ...agent, activeProjectsCreated: 0 }, { worldMinutes: 100, projects: [] });
  assert.ok(fresh.some((item) => item.id.startsWith('project:org-propose:')));
});

test('fair cognition: the work-order target query binds the resident, claims go least-recently-served, reflections recorded', async () => {
  const [context, worker, engine] = await Promise.all(['../src/agent-runtime/open-cognition/context.js',
    '../src/agent-runtime/open-cognition/worker.js', '../src/world-engine.js'].map(read));
  const query = context.slice(context.indexOf("reference.type === 'world_work_order'"), context.indexOf("reference.type === 'cleanup_target'"));
  assert.match(query, /accepted_agent_id<>\$3/);
  assert.match(query, /\[worldId, reference\.id, agentId\]\)/);
  // Every query in the file passes at least as many parameters as it references.
  for (const match of code(context).matchAll(/\.query\(`([^`]*)`,\s*\[([^\]]*)\]/g)) {
    const highest = Math.max(0, ...[...match[1].matchAll(/\$(\d+)/g)].map((item) => Number(item[1])));
    const passed = match[2].split(',').filter((item) => item.trim()).length;
    assert.ok(passed >= highest, `query needs ${highest} params, passes ${passed}: ${match[1].slice(0, 60)}`);
  }
  assert.match(worker, /ORDER BY served\.served_at ASC NULLS FIRST/);
  assert.match(worker, /INSERT INTO world_agent_reflections\(world_id,agent_id,world_minutes,trigger,rationale\)/);
  assert.match(engine, /contractPriorityChoice\(agent, utilityCandidates/);
  assert.ok(engine.indexOf("decisionLayer = 'public_work_contract'") < engine.indexOf("decisionLayer = 'economic_fallback'"),
    'the contract is chosen before the economic fallback');
  assert.match(engine, /filterBackedOff\(agent\.agentId, \[\.\.\.nativeUtilityCandidates/);
  assert.match(engine, /result\.backoff = recordActionRejection\(/);
});

test('treasury inflow: no clawback for weights below 1x; the weight is applied at issuance and the rest stays in the pool', async () => {
  const [council, treasury, works, deliberation] = await Promise.all(['../src/council.js', '../src/treasury.js',
    '../src/public-works.js', '../src/council-deliberation.js'].map(read));
  for (const source of [council, treasury, works, deliberation]) {
    assert.doesNotMatch(code(source), /kind: 'reward_adjustment'/, 'no reward_adjustment entry is posted any more');
  }
  // Deterministic sampling: about weight x of the rewards are issued.
  let admitted = 0;
  for (let index = 0; index < 20_000; index += 1) {
    if (rewardWeightAdmits({ worldId: WORLD, sourceType: 'research_project', sourceEntityId: String(index), milli: 500 })) admitted += 1;
  }
  assert.ok(Math.abs(admitted / 20_000 - 0.5) < 0.02, `about half issued (${admitted})`);
  assert.equal(rewardWeightAdmits({ worldId: WORLD, sourceType: 'x', sourceEntityId: '1', milli: 1000 }), true);
  assert.equal(rewardWeightAdmits({ worldId: WORLD, sourceType: 'x', sourceEntityId: '1', milli: 3000 }), true);
  // issueResidentReward with a 0.25x research weight: skipped rewards never touch the treasury or the pool.
  resetRewardWeightCache();
  const calls = [];
  const client = { async query(sql) {
    calls.push(sql);
    if (sql.includes('FROM world_external_residents')) return { rowCount: 0, rows: [] };
    if (sql.includes('to_regclass')) return { rowCount: 1, rows: [{ ready: true }] };
    if (sql.includes('world_council_policies')) return { rowCount: 1, rows: [{ lever_key: 'multiplier.research_project',
      value: { milli: 250 }, previous_value: { milli: 1000 }, effective_world_day: '1', today: '5' }] };
    if (sql.includes('INSERT INTO arc_sync_resident_reward_contributions')) return { rowCount: 1, rows: [{ id: 'c1', status: 'queued' }] };
    return { rowCount: 1, rows: [{ ready: true, today: '5' }] };
  } };
  let issued = 0, skipped = 0;
  for (let index = 0; index < 400; index += 1) {
    const reward = await issueResidentReward(client, { worldId: WORLD, agentId: ids[1], sourceType: 'research_project',
      sourceEventId: String(index), sourceEntityId: `e${index}`, rewardWeight: '1' }, { env: {} });
    if (reward.skipped) { skipped += 1; assert.equal(reward.funding, 'pool_retained'); } else issued += 1;
  }
  assert.ok(issued > 60 && issued < 140, `about a quarter issued (${issued}/${issued + skipped})`);
  assert.ok(!calls.some((sql) => sql.includes('world_sync_treasury_entries')));
  resetRewardWeightCache();
  // The hourly tax collector posts income tax on what was accrued, and never a reweighting clawback.
  const posted = [];
  const taxClient = { async query(sql, params) {
    if (sql.includes('INSERT INTO world_council_runtime')) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM world_council_runtime')) return { rowCount: 1, rows: [{ income_cursor: 'a', sales_cursor: 'a', now: 'b' }] };
    if (sql.includes('arc_sync_resident_reward_entitlements')) return { rowCount: 1, rows: [{ agent_id: ids[1], source_type: 'research_project', amount: String(10n * SYNC) }] };
    if (sql.includes('arc_sync_internal_balances')) return { rowCount: 1, rows: [{ s: String(100n * SYNC) }] };
    if (sql.includes('INSERT INTO world_sync_treasury_entries')) { posted.push(params[2]); return { rowCount: 1, rows: [{ id: 1 }] }; }
    return { rowCount: 0, rows: [] };
  } };
  const taxes = await collectCouncilTaxes(taxClient, { worldId: WORLD, worldMinutes: 1_340_000,
    policies: { ...defaults, 'multiplier.research_project': { milli: 500 }, 'tax.income': { bps: 100 } } });
  assert.deepEqual(posted, ['income_tax']);
  assert.equal(taxes.incomeTaxRaw, String(10n * SYNC / 100n), 'income tax on the full accrued amount');
  assert.equal(taxes.adjustmentRaw, '0');
});

test('commission skip: no Luna call and no tender while no eligible builder has capacity; one NO_BUILDER_CAPACITY row per world hour', async () => {
  const residents = ids.map((agentId) => ({ agentId, name: agentId.slice(-2), state: {} }));
  // Every non-governor resident holds one contract that has not been started: nobody has capacity.
  const saturated = ids.slice(1).map((agentId, i) => work({ id: `w${i}`, kind: 'expansion', project_key: `expansion:x:${i}`,
    builder_agent_id: agentId, awarded_world_minute: '1440000', last_work_world_minute: '1440000',
    position: { hold: { holder: agentId, since: 1_440_000, sessionsAtStart: 0, warnedAt: null, idleHolders: [] } } }));
  assert.deepEqual(commissionCapacity(residents, saturated, 1_440_100), { eligible: 9, withCapacity: 0, hasCapacity: false });
  // The governor never counts as a builder, even with nothing held.
  assert.equal(commissionCapacity([{ agentId: COUNCIL_GOVERNOR_ID }], [], 1_440_100).hasCapacity, false);
  const started = saturated.map((item, i) => (i === 4 ? { ...item, sessions: 1, last_work_world_minute: '1440090' } : item));
  assert.deepEqual(commissionCapacity(residents, started, 1_440_100), { eligible: 9, withCapacity: 1, hasCapacity: true });

  const day = 1000;
  let minute = day * 1440 + 16 * 60 + 5; // after the vote deadline: only the commission branch can act
  let building = saturated;
  const rows = [], commissioned = [];
  const db = { async query(sql, params = []) {
    const text = String(sql);
    if (text.includes('to_regclass')) return { rowCount: 1, rows: [{ ready: true }] };
    if (text.includes('FROM world_runtime_state')) return { rowCount: 1, rows: [{ world_minutes: String(minute) }] };
    if (text.includes('pg_advisory_xact_lock') || /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(text.trim())) return { rowCount: 0, rows: [] };
    if (text.includes('INSERT INTO world_council_deliberations')) {
      rows.push({ minute: Number(params[2]), phase: params[3], source: params[5], failureCode: params[7], decision: JSON.parse(params[10]) });
      return { rowCount: 1, rows: [] };
    }
    if (text.includes('FROM world_council_deliberations') && text.includes('failure_code=$3')) {
      const [, , code, from, to] = params;
      return { rowCount: rows.filter((row) => row.failureCode === code && row.minute >= from && row.minute < to).length, rows: [{}] };
    }
    if (text.includes('FROM world_council_deliberations') && text.includes("phase='commission'")) {
      assert.match(text, /IS DISTINCT FROM 'NO_BUILDER_CAPACITY'/, 'capacity skips never start the commission cooldown');
      return { rowCount: rows.filter((row) => row.phase === 'commission' && row.failureCode !== NO_BUILDER_CAPACITY
        && row.minute > params[1]).length, rows: [] };
    }
    if (text.includes('FROM world_council_deliberations')) return { rowCount: 0, rows: [] };
    if (text.includes("status='bidding' LIMIT 1")) return { rowCount: 0, rows: [] };
    if (text.includes('work.status=ANY')) {
      const statuses = params[1];
      return { rowCount: 0, rows: building.filter((item) => statuses.includes(item.status)) };
    }
    if (text.includes("work.status='completed'")) return { rowCount: 0, rows: [] };
    // growth1: measured demand -- 20 trips a day into District 1, which has no road yet.
    if (text.includes("event_type='world.action_completed'")) return { rowCount: 20, rows: Array.from({ length: 20 }, () => ({ action: 'work', place: 'Far Place' })) };
    if (text.includes('scene_type AS "sceneType",position,features')) return { rowCount: 1, rows: [{ name: 'Far Place', sceneType: 'lab', position: { x: 1.3, z: 0, district: 1 }, features: {} }] };
    if (text.includes('FROM world_scenes')) return { rowCount: 1, rows: [{ districts: 1 }] };
    if (text.includes('world_sync_treasury_balances')) return { rowCount: 1, rows: [{ balance_raw: String(1000n * SYNC) }] };
    if (text.includes('AS escrow')) return { rowCount: 1, rows: [{ escrow: '0' }] };
    if (text.includes('INSERT INTO world_public_works')) { commissioned.push(params[1]); return { rowCount: 1, rows: [{ id: 'new' }] }; }
    return { rowCount: 0, rows: [] };
  } };
  const pool = { query: db.query, async connect() { return { query: db.query, release() {} }; } };
  const lunaCalls = [];
  const requestModel = async ({ callContext }) => { lunaCalls.push(callContext?.agentId); return { output: { commission: false, reason: 'Wait.' } }; };
  const snapshot = async () => ({ stats: { residents, medianBalanceRaw: String(10n * SYNC) }, policies: defaults });
  const step = () => councilDeliberationStep(pool, { worldId: WORLD, requestModel, env: { MIRRORTERRA_COUNCIL: 'on' }, snapshot });

  const first = await step();
  assert.equal(first?.failureCode, NO_BUILDER_CAPACITY);
  assert.equal(first.skipped, true);
  assert.equal(lunaCalls.length, 0, 'no Luna commission call while nobody could build');
  assert.equal(commissioned.length, 0, 'no tender');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].phase, rows[0].source, rows[0].decision.skipped, rows[0].decision.eligibleBuilders],
    ['commission', 'fallback', NO_BUILDER_CAPACITY, 9]);
  for (const later of [10, 30, 54]) { // same world hour: no spam
    minute = day * 1440 + 16 * 60 + later;
    assert.equal(await step(), null);
  }
  assert.equal(rows.length, 1, 'at most one skip row per world hour');
  minute = day * 1440 + 17 * 60 + 1;
  assert.equal((await step())?.failureCode, NO_BUILDER_CAPACITY, 'next world hour records again');
  assert.equal(rows.length, 2);
  // A builder starts work: capacity is back, the skip rows did not start a cooldown, Luna is asked at once.
  building = started.map((item) => ({ ...item, last_work_world_minute: String(minute - 5) }));
  minute += 2;
  const resumed = await step();
  assert.equal(resumed?.phase, 'commission');
  assert.notEqual(resumed.failureCode, NO_BUILDER_CAPACITY);
  assert.equal(lunaCalls.length, 1, 'Luna commission call once a builder has capacity');
});

test('commission skip: the tick fallback checks builder capacity before commissioning', async () => {
  const source = code(await read('../src/public-works.js'));
  const hour = source.slice(source.indexOf('export async function runPublicWorksHour'), source.indexOf('export function publicWorkCandidates'));
  assert.ok(hour.indexOf('commissionCapacity(') > 0 && hour.indexOf('commissionCapacity(') < hour.indexOf('commissionPublicWork('),
    'capacity is checked before commissioning');
  assert.match(hour, /if \(pick && !capacity\.hasCapacity\)[\s\S]*recordNoCapacitySkip\(/);
  assert.match(hour, /NOT_CAPACITY_SKIP/, 'skip rows do not suppress the fallback');
});
