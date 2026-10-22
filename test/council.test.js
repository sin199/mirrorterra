import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { COUNCIL_GOVERNOR_ID, COUNCIL_QUORUM, buildCouncilCandidates, buildCouncilSummary, buildEconomyStats,
  councilCloseMinute, councilProposalOptions, deterministicStance, proposalTitle,
  tallyOutcome } from '../src/council.js';
import * as councilModule from '../src/council.js';
import { LEVER_KEYS, councilEnabled, defaultLeverValue,
  issueResidentReward, leverValueValid, rewardAmounts, taxDue, wealthTaxDue } from '../src/treasury.js';
import { quoteSyncInternalServicePrice } from '../src/world-businesses.js';
import { centralBankInfoRows } from '../site/world-places3d.js';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WORLD = 'ce434421-8bcd-4aac-b9ba-183383c713de';
const ids = Array.from({ length: 10 }, (_, i) => (i === 0 ? COUNCIL_GOVERNOR_ID
  : `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`));
const defaults = Object.fromEntries(LEVER_KEYS.map((lever) => [lever, defaultLeverValue(lever)]));
const SYNC = 1_000_000n;

function statsFixture({ incomeBySource = { skill_output: 90n * SYNC, research_project: 10n * SYNC }, spending = 2n * SYNC,
  treasury = 0n } = {}) {
  const pool = [];
  ids.forEach((agentId, index) => {
    for (const [source, amount] of Object.entries(incomeBySource)) {
      pool.push({ source_type: source, agent_id: agentId, amount: String(amount / 10n + BigInt(index) * 1000n) });
    }
  });
  return buildEconomyStats({ pool, spendingRaw: spending,
    balances: ids.map((agentId, index) => ({ agent_id: agentId, name: `Synterra-${String(index + 1).padStart(2, '0')}`,
      balance_raw: index === 7 ? '500000' : String(BigInt(200 + index * 15) * SYNC), goal: ['wealth','learn','community','wellbeing','balanced'][index % 5],
      energy: 60, food: 60, social: 50, happiness: 60, knowledge: 30, risk_tolerance: 0.3 + index * 0.05,
      sociability: 0.5, curiosity: 0.5, discipline: 0.5, ambition: 0.5 })),
    outputs: [{ drive: 'curiosity', count: 40 }, { drive: 'mastery', count: 22 }, { drive: 'belonging', count: 1 }],
    owners: [{ agent_id: ids[3], service_type: 'food_service' }], treasuryBalanceRaw: String(treasury), memberCount: 10 });
}

test('treasury tax math: rates in bps, capped by the payer balance, bounded 0-30%', () => {
  assert.equal(taxDue(1_000_000n, 500), 50_000n);
  assert.equal(taxDue(1_000_000n, 500, 20_000n), 20_000n, 'never more than the payer holds');
  assert.equal(taxDue(1_000_000n, 500, 0n), 0n);
  assert.equal(taxDue(1_000_000n, 9_999), 300_000n, 'rate clamps to 30%');
  assert.equal(taxDue(1_000_000n, -5), 0n);
  assert.equal(taxDue('-7', 500), 0n);
  // idle-balance tax: monthly rate charged daily (/30) above a 50 SYNC exemption, never more than the balance
  assert.equal(wealthTaxDue(40n * SYNC, 3_000), 0n);
  assert.equal(wealthTaxDue(350n * SYNC, 3_000), 300n * SYNC * 3_000n / 10_000n / 30n);
  assert.equal(wealthTaxDue(350n * SYNC, 0), 0n);
});

test('reward amounts: multiplier then income tax withheld; pool weight math unchanged', () => {
  const plain = rewardAmounts({ rewardWeight: '2', sourceType: 'skill_output', policies: defaults, rawPerWeight: '100000' });
  assert.equal(plain.baseRaw, 200_000n);
  assert.equal(plain.netRaw, 200_000n);
  const policies = { ...defaults, 'multiplier.skill_output': { milli: 750 }, 'tax.income': { bps: 1_000 } };
  const taxed = rewardAmounts({ rewardWeight: '2', sourceType: 'skill_output', policies, rawPerWeight: '100000' });
  assert.equal(taxed.grossRaw, 150_000n);
  assert.equal(taxed.incomeTaxRaw, 15_000n);
  assert.equal(taxed.netRaw, 135_000n);
  assert.equal(taxed.grossRaw, taxed.netRaw + taxed.incomeTaxRaw, 'conservation inside one reward');
});

test('lever bounds: taxes 0-30%, multipliers 0.25-3x, prices 0.5-2x, goods 0.1-20 SYNC, guidance enum', () => {
  assert.equal(leverValueValid('tax.sales', { bps: 0 }), true);
  assert.equal(leverValueValid('tax.sales', { bps: 3_000 }), true);
  assert.equal(leverValueValid('tax.sales', { bps: 3_001 }), false);
  assert.equal(leverValueValid('tax.wealth', { bps: 12.5 }), false);
  assert.equal(leverValueValid('multiplier.skill_output', { milli: 249 }), false);
  assert.equal(leverValueValid('multiplier.skill_output', { milli: 250 }), true);
  assert.equal(leverValueValid('multiplier.research_project', { milli: 3_001 }), false);
  assert.equal(leverValueValid('price.food_service', { milli: 499 }), false);
  assert.equal(leverValueValid('price.food_service', { milli: 2_000 }), true);
  assert.equal(leverValueValid('good.tools', { priceRaw: '99999' }), false);
  assert.equal(leverValueValid('good.tools', { priceRaw: '20000000' }), true);
  assert.equal(leverValueValid('good.tools', { priceRaw: '20000001' }), false);
  assert.equal(leverValueValid('good.tools', { offered: false }), true);
  assert.equal(leverValueValid('treasury.guidance', { mode: 'save' }), true);
  assert.equal(leverValueValid('treasury.guidance', { mode: 'print_money' }), false);
  assert.equal(leverValueValid('reserve.release', { bps: 1 }), false, 'no lever reaches the reserve');
  for (const lever of LEVER_KEYS) assert.equal(leverValueValid(lever, defaultLeverValue(lever)), true, lever);
});

test('migration 0028 mirrors the bounds, keeps gates, and is additive', async () => {
  const sql = (await readFile(new URL('../migrations/0028_council_treasury.sql', import.meta.url), 'utf8'))
    .split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  assert.match(sql, /n BETWEEN 0 AND 3000/);
  assert.match(sql, /n BETWEEN 250 AND 3000/);
  assert.match(sql, /n BETWEEN 500 AND 2000/);
  assert.match(sql, /n BETWEEN 100000 AND 20000000/);
  assert.match(sql, /spent_today \+ NEW\.amount_raw > 50000000/);
  assert.match(sql, /RAISE EXCEPTION 'SYNC treasury entry exceeds the resident balance'/);
  assert.match(sql, /CREATE UNIQUE INDEX world_council_policy_history_one_change_key/);
  assert.match(sql, /CREATE UNIQUE INDEX world_council_proposals_open_lever_key/);
  assert.match(sql, /REVOKE ALL ON FUNCTION mirrorterra_council_ops_veto\(uuid,text\) FROM PUBLIC/);
  assert.doesNotMatch(sql, /DROP (TABLE|VIEW|COLUMN|CONSTRAINT|TRIGGER)/i);
  assert.doesNotMatch(sql, /arc_sync_payout_outbox|arc_sync_ledger_postings|planned_action/);
  assert.doesNotMatch(sql, /GRANT[^;]*(UPDATE|DELETE)[^;(]*ON world_sync_treasury_entries/);
  // the view keeps its 0027 columns in order and only appends
  assert.match(sql, /AS spendable_raw,\s+COALESCE\(treasury_in\.amount_raw,0\)::numeric\(78,0\) AS treasury_received_raw,/);
});

test('council3: the council2 recirculation is gone (no grants, prizes, purchases, bounties or any-work contracts)', async () => {
  for (const name of ['recirculationPlan','runTreasuryRecirculation','governorTreasurySpend','contractBids','settleTreasuryContests',
    'settleTreasuryBounties','RECIRCULATION_SPLITS']) assert.equal(councilModule[name], undefined, `${name} removed`);
  const source = await readFile(new URL('../src/council.js', import.meta.url), 'utf8');
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /kind: '(grant|subsidy|bounty|service_purchase|reward_bonus)'/);
  assert.doesNotMatch(code, /kind: 'reward'/);
  assert.match(code, /runPublicWorksHour\(client/);
});

test('quorum 6 of 10, simple majority, ties and no-quorum reject', () => {
  assert.equal(COUNCIL_QUORUM, 6);
  assert.equal(tallyOutcome({ yes: 4, no: 2 }).status, 'passed');
  assert.equal(tallyOutcome({ yes: 3, no: 3 }).status, 'rejected');
  assert.equal(tallyOutcome({ yes: 5, no: 0 }).status, 'rejected');
  assert.match(tallyOutcome({ yes: 5, no: 0 }).reason, /No quorum/);
  assert.equal(tallyOutcome({ yes: 7, no: 3 }).status, 'passed');
  // decided at 15:00 the same world day (or the next day's 15:00 when opened late); effect next day
  assert.equal(councilCloseMinute(900 * 1440 + 600), 900 * 1440 + 900);
  assert.equal(councilCloseMinute(900 * 1440 + 16 * 60), 901 * 1440 + 900);
});

test('fallback liveness: the heuristic always has a bounded proposal and every resident always has a stance', () => {
  const dominant = statsFixture();
  const [first] = councilProposalOptions({ stats: dominant, policies: defaults });
  assert.equal(first.lever, 'multiplier.skill_output', 'one source above 70% -> lower its multiplier');
  assert.deepEqual(first.value, { milli: 750 });
  const lowSpend = statsFixture({ incomeBySource: { skill_output: 50n * SYNC, research_project: 50n * SYNC }, spending: 1n * SYNC });
  assert.equal(councilProposalOptions({ stats: lowSpend, policies: defaults })[0].lever, 'good.tools');
  const empty = buildEconomyStats({});
  const quiet = councilProposalOptions({ stats: empty, policies: defaults });
  assert.ok(quiet.length >= 1 && quiet.every((option) => leverValueValid(option.lever, option.value)));
  const blocked = councilProposalOptions({ stats: dominant, policies: defaults,
    blockedLevers: new Set(['multiplier.skill_output','good.tools','tax.sales','tax.income']) });
  assert.ok(blocked.length >= 1 && blocked.every((option) => !['multiplier.skill_output','good.tools'].includes(option.lever)));
  for (const option of [...councilProposalOptions({ stats: dominant, policies: defaults, limit: 6 }), ...quiet]) {
    const proposal = { id: 'p1', lever_key: option.lever, proposed_value: option.value, previous_value: defaults[option.lever] };
    let votes = 0;
    for (const resident of dominant.residents) {
      const vote = deterministicStance({ proposal, resident, stats: dominant });
      assert.ok(['yes','no'].includes(vote.stance));
      assert.ok(vote.reason.length >= 3 && vote.reason.length <= 200);
      votes += 1;
    }
    assert.ok(votes >= COUNCIL_QUORUM, 'every resident votes, so quorum is always reachable');
  }
  assert.equal(proposalTitle('tax.sales', { bps: 0 }, { bps: 300 }), 'Sales tax: 0% → 3%');
});

test('council affordances (council3): open cognition keeps only owner pricing; votes/proposals/commissions go through Luna calls', () => {
  const snapshot = { openProposals: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001', lever_key: 'tax.sales', title: 'Sales tax: 0% → 3%',
    reason: 'Spending is low.', voters: [ids[1]] }],
  proposalOptions: [{ lever: 'good.tools', value: { priceRaw: '1000000' }, reason: 'Give SYNC a use.' }],
  governorOptions: [{ type: 'grant', agentId: ids[3], amountRaw: '1000000', reason: 'legacy' }],
  priceOptions: [{ serviceId: 'svc-1', ownerAgentId: ids[3], serviceName: 'Meals', fromMilli: 1000, toMilli: 950,
    direction: 'lower', reason: '2 competitor(s).' }] };
  assert.equal(buildCouncilCandidates({ agentId: ids[2], location: 'Library' }, snapshot).length, 0);
  assert.equal(buildCouncilCandidates({ agentId: COUNCIL_GOVERNOR_ID, location: 'MirrorTerra Central Bank' }, snapshot).length, 0,
    'no treasury_spend affordance');
  const owner = buildCouncilCandidates({ agentId: ids[3], location: 'Cafe' }, snapshot);
  assert.deepEqual(owner.map((candidate) => candidate.action), ['business_sync_price']);
  assert.equal(buildCouncilCandidates({ agentId: ids[2] }, null).length, 0);
});

test('kill switch MIRRORTERRA_COUNCIL=off (and SYNC economy off) restores the pool-only reward path', async () => {
  assert.equal(councilEnabled({}), true);
  assert.equal(councilEnabled({ MIRRORTERRA_COUNCIL: 'off' }), false);
  assert.equal(councilEnabled({ MIRRORTERRA_SYNC_ECONOMY: 'off' }), false);
  const calls = [];
  const client = { async query(sql) { calls.push(sql); return sql.includes('INSERT INTO arc_sync_resident_reward_contributions')
    ? { rowCount: 1, rows: [{ id: 'c1', status: 'queued' }] } : { rowCount: 0, rows: [] }; } };
  const result = await issueResidentReward(client, { worldId: WORLD, agentId: ids[1], sourceType: 'skill_output',
    sourceEventId: '1', sourceEntityId: '9', rewardWeight: '1' }, { env: { MIRRORTERRA_COUNCIL: 'off' } });
  assert.equal(result.funding, 'pool');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /INSERT INTO arc_sync_resident_reward_contributions/);
});

function fakeTreasuryClient({ treasuryRaw }) {
  const calls = [];
  return { calls, async query(sql, params = []) {
    calls.push({ sql, params });
    if (sql.includes("to_regclass('public.world_sync_treasury_entries')")) return { rows: [{ ready: true }] };
    if (sql.includes('FROM world_sync_treasury_entries') && sql.includes('entry_key=$2')) return { rowCount: 0, rows: [] };
    if (sql.startsWith('SELECT 1 FROM arc_sync_resident_reward_contributions')) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM world_council_policies')) return { rows: [] };
    if (sql.includes('world_sync_treasury_balances')) return { rows: [{ balance_raw: String(treasuryRaw) }] };
    if (sql.includes('INSERT INTO world_sync_treasury_entries')) return { rowCount: 1, rows: [{ id: 't1' }] };
    if (sql.includes('INSERT INTO arc_sync_resident_reward_contributions')) return { rowCount: 1, rows: [{ id: 'c1', status: 'queued' }] };
    return { rowCount: 0, rows: [] };
  } };
}

test('reward issuance (council3): always the unchanged pool path, even with a full treasury', async () => {
  const args = { worldId: WORLD, agentId: ids[1], sourceType: 'skill_output', sourceEventId: '77', sourceEntityId: '501',
    rewardWeight: '2', worldMinute: 900 * 1440 };
  const rich = fakeTreasuryClient({ treasuryRaw: 5_000_000_000n });
  const paid = await issueResidentReward(rich, args, { env: {} });
  assert.equal(paid.funding, 'pool');
  assert.ok(rich.calls.some((call) => call.sql.includes('INSERT INTO arc_sync_resident_reward_contributions')));
  assert.ok(!rich.calls.some((call) => call.sql.includes('INSERT INTO world_sync_treasury_entries')), 'the treasury pays no reward');
});

test('council price lever scales only the deterministic base price', () => {
  const plain = quoteSyncInternalServicePrice({ serviceType: 'food_service', demandCount: 0, stockUnits: 0 });
  const doubled = quoteSyncInternalServicePrice({ serviceType: 'food_service', demandCount: 0, stockUnits: 0, priceMultiplierMilli: 2000 });
  const clamped = quoteSyncInternalServicePrice({ serviceType: 'food_service', demandCount: 0, stockUnits: 0, priceMultiplierMilli: 99_999 });
  assert.equal(plain.priceRaw, '120000');
  assert.equal(doubled.priceRaw, '240000');
  assert.equal(clamped.priceRaw, '240000', '2x ceiling holds even for a bad input');
  assert.equal(quoteSyncInternalServicePrice({ serviceType: 'food_service', publishedPriceRaw: '5', priceMultiplierMilli: 2000 }).priceRaw, '5');
});

test('bank panel council section: public works, llm/fallback votes with reasons, names and amounts only, no UUIDs, small', () => {
  const council = buildCouncilSummary({ worldMinutes: 900 * 1440 + 700,
    treasury: { balance_raw: '12500000', taxes_raw: '13000000', construction_raw: '8000000', reserved_raw: '10000000' },
    policies: [{ lever_key: 'tax.sales', value: { bps: 300 }, previous_value: { bps: 0 }, effective_world_day: '900' },
      { lever_key: 'multiplier.skill_output', value: { milli: 750 }, previous_value: { milli: 1000 }, effective_world_day: '901' }],
    open: [{ id: 'p-open', title: 'Tools: not offered → 1 SYNC', yes_count: 4, no_count: 3, proposer: 'Synterra-03', source: 'cognition' }],
    decided: [{ id: 'p-done', title: 'Sales tax: 0% → 3%', status: 'passed', yes_count: 7, no_count: 3, proposer: 'Synterra-01', source: 'session_fallback' }],
    spends: [{ kind: 'public_works', amount_raw: '2000000', reason: "Public works: Town Paths milestone 1/4 (25% built)", to_name: 'Synterra-04', created_at: '2026-10-20T04:00:00Z' }],
    memberCount: 10,
    votes: [{ proposal_id: 'p-open', name: 'Synterra-02', stance: 'yes', reason: 'Tools give my SYNC a use.', source: 'cognition' },
      { proposal_id: 'p-open', name: 'Synterra-05', stance: 'no', reason: 'Too expensive for me now.', source: 'session_fallback' }],
    flows: { in_raw: '30000000', out_raw: '6000000', construction_raw: '6000000' },
    publicWorks: { projects: [{ kind: 'road', label: 'Road', name: 'Town Paths', status: 'building', priceRaw: '8000000',
      contractPriceRaw: '6200000', paidRaw: '1550000', progress: 30, milestonesPaid: 1, builder: 'MirrorTerra-04', bids: 9, llmBids: 7 },
    { kind: 'clinic', label: 'Public Clinic', name: 'Public Clinic', status: 'bidding', priceRaw: '10000000', paidRaw: '0',
      progress: 0, milestonesPaid: 0, builder: null, bids: 4, llmBids: 4, lowestBidRaw: '6800000' }],
    completed: [{ kind: 'park', label: 'Park', name: 'Commons Park', builder: 'MirrorTerra-06', contractPriceRaw: '4400000', level: 1,
      effect: 'Park: every resident regains +1 fun and +1 social each hour.' }], paidCount: 5, paidRaw: '8000000',
    deliberation: { lastWorldDay: { llm: 27, fallback: 3 }, byPhase: {} } } });
  assert.equal(council.taxes.sales, '3%');
  assert.equal(council.openProposals[0].voted, 7);
  assert.deepEqual(council.openProposals[0].sources, { llm: 1, fallback: 1 });
  assert.equal(council.openProposals[0].votes[0].source, 'llm');
  assert.equal(council.treasury.freeRaw, '2500000');
  assert.ok(council.policies.some((policy) => /from tomorrow/.test(policy.value)));
  const rows = centralBankInfoRows({ available: true, name: 'MirrorTerra Central Bank', role: 'Keeps the books.',
    token: { symbol: 'SYNC', decimals: 6 }, governor: {}, ledger: { available: false }, council }, { timeZone: 'UTC' });
  const text = JSON.stringify(rows);
  for (const label of ['Treasury & council', 'Last world day', 'Taxes', 'Public works (2)', 'Built public works (1)',
    'Open proposals (1)', 'Last decisions', 'Treasury payments', 'Council minds (last day)']) {
    assert.ok(rows.rows.some((row) => row[0] === label), label);
  }
  assert.match(text, /12\.5 SYNC · 10 SYNC reserved for construction · free 2\.5 SYNC/);
  assert.match(text, /building · MirrorTerra-04 · 30% · paid 1\.55 SYNC of 6\.2 SYNC · 1\/4 milestones/);
  assert.match(text, /tender · price 10 SYNC · 4 bids \(4 llm\) · lowest 6\.8 SYNC/);
  assert.match(text, /by MirrorTerra-06 · 4\.4 SYNC/);
  assert.match(text, /4 yes · 3 no · 7\/10 voted · by MirrorTerra-03 \(llm\) · llm 1 \/ fallback 1/);
  assert.match(text, /· MirrorTerra-02 yes","llm · Tools give my SYNC a use\./);
  assert.match(text, /· MirrorTerra-05 no","fallback · Too expensive for me now\./);
  assert.match(text, /Passed 7–3/);
  assert.match(text, /27 Luna decisions · 3 fallback/);
  assert.match(text, /Treasury → MirrorTerra-04/);
  assert.match(text, /construction milestone/);
  assert.match(text, /In 30 SYNC · Out 6 SYNC · construction 6 SYNC/);
  assert.doesNotMatch(text, UUID);
  assert.doesNotMatch(JSON.stringify(council), UUID);
  assert.ok(Buffer.byteLength(JSON.stringify(council)) < 4_500);
});

test('engine, reward and context wiring; no gate, chain, pool or reserve writes', async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  const [engine, projects, skills, server, context, council, treasury, schema] = await Promise.all([
    '../src/world-engine.js', '../src/world-projects.js', '../src/world-skill-library.js', '../src/server.js',
    '../src/agent-runtime/open-cognition/context.js', '../src/council.js', '../src/treasury.js', '../src/startup-schema.js'].map(read));
  assert.match(engine, /const councilHour = await runCouncilHourSafely\(client, \{ worldId, worldMinutes \}\);/);
  assert.ok(engine.indexOf('runCouncilHourSafely(client') > engine.indexOf('ensureCentralBankPlaceSafely(client'));
  assert.match(engine, /\.\.\.\(institutionalPlanEligible \? \[institutionalPlan\] : \[\]\), \.\.\.councilCandidates\]/);
  const intercept = engine.indexOf('if (COUNCIL_ACTIONS.includes(activity.action)) {');
  assert.ok(intercept > engine.indexOf('plannedContext.cognitionExpectedOutcome = cognitionSelection.expectedOutcome'));
  assert.ok(intercept < engine.indexOf("UPDATE world_agent_states SET status='walking',planned_action=$3"),
    'council actions never become a planned_action');
  for (const source of [engine, projects, skills, server]) {
    assert.match(source, /issueResidentReward\(client, \{ worldId, agentId/);
    assert.doesNotMatch(source, /await enqueueSyncResidentRewardContribution\(client/);
  }
  assert.match(context, /\['world\.council_vote','council_vote'/);
  assert.match(context, /\.\.\.\(economy \? \{ economy \} : \{\}\)/);
  for (const source of [council, treasury]) {
    assert.doesNotMatch(source, /MAINNET_WRITE_GATE|SYNC_COMMITTED_PAYOUT_WRITE_GATE|SYNC_RESIDENT_REWARD_COMMIT_ENABLED/);
    assert.doesNotMatch(source, /INSERT INTO arc_|UPDATE arc_|DELETE FROM|arc_sync_payout_outbox|arc_sync_ledger_postings|reserve\(/);
  }
  assert.match(schema, /'0028_council_treasury\.sql', '0029_council_recirculation\.sql', '0030_public_works\.sql',\s+'0031_external_residents\.sql'(, '0032_public_works_growth\.sql')?\]/);
  assert.match(schema, /\['world_sync_treasury_entries', 'world_sync_treasury_entry_check'\]/);
});
