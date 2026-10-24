// external1: external residents (unit tests, no database). The database guards and the end-to-end flow are
// covered by test/external1.integration.test.js (EXTERNAL1_TEST_DATABASE_URL).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Wallet, AbiCoder, zeroPadValue, id as keccakId } from 'ethers';
import { EXTERNAL_DEFAULTS, councilEligibility, councilQuorum, ensureExternalResident, enforceRateLimit, externalConfig,
  ipHash, clientIp, matchActivityRequest, populationCapDecision, rateLimitDecision, resetExternalTablesCache } from '../src/external-residents.js';
import { councilMembershipFrom, tallyOutcome, annotateCouncilMembership } from '../src/council.js';
import { commissionCapacity, volunteerCandidates, volunteerFallbackDecision } from '../src/public-works.js';
import { postTreasuryEntry } from '../src/treasury.js';
import { AUCTION_INTERFACE, MARKET_INTERFACE, TOKEN_INTERFACE, assertPurchaseGateOpen, bindExternalWallet,
  claimExternalPurchase, decodePurchaseReceipt, externalPurchaseConfig, walletClaimMessage } from '../src/external-purchase.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const WORLD = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const DEPLOYMENT = { token: '0x1e35ffa0bfe926f7105e91eed9d5b19ff701c5e7', auction: '0x44df2749b1603e68a3d251ec4fcb981a92c91989',
  market_pool: '0x75246a8b1f8a24a8c0b212704aaa27375c83feaa', policy: '0x223ae2ecc8503f8d6a22aed7ceb833bad250159f',
  operating_pool: '0x9999999999999999999999999999999999999999' };

// Fake client: answers by SQL pattern, records every statement.
function fakeClient(routes = []) {
  const calls = [];
  return { calls, async query(sql, params = []) {
    const text = String(sql);
    calls.push({ text, params });
    for (const [pattern, answer] of routes) if (pattern.test(text)) return typeof answer === 'function' ? answer(text, params) : answer;
    return { rows: [], rowCount: 0 };
  } };
}

test('external1: env-tunable defaults, rate limits and the population cap return clear codes', () => {
  const config = externalConfig({});
  assert.equal(config.registerPerIpPerHour, EXTERNAL_DEFAULTS.registerPerIpPerHour);
  assert.equal(config.populationCap, 10);
  assert.equal(config.quorumBps, 6000);
  const tuned = externalConfig({ MIRRORTERRA_EXTERNAL_POPULATION_CAP: '25', MIRRORTERRA_REGISTER_GLOBAL_PER_HOUR: '5',
    MIRRORTERRA_EXTERNAL_COUNCIL_DAYS: '5', MIRRORTERRA_JOIN_PER_IP_PER_HOUR: 'nonsense' });
  assert.equal(tuned.populationCap, 25);
  assert.equal(tuned.registerGlobalPerHour, 5);
  assert.equal(tuned.councilResidenceDays, 5);
  assert.equal(tuned.joinPerIpPerHour, EXTERNAL_DEFAULTS.joinPerIpPerHour);
  assert.deepEqual(rateLimitDecision({ kind: 'register', ipCount: 2, globalCount: 29, config }), { allowed: true });
  assert.equal(rateLimitDecision({ kind: 'register', ipCount: 3, globalCount: 0, config }).code, 'REGISTRATION_RATE_LIMITED');
  assert.equal(rateLimitDecision({ kind: 'register', ipCount: 0, globalCount: 30, config }).code, 'REGISTRATION_GLOBAL_RATE_LIMITED');
  assert.equal(rateLimitDecision({ kind: 'join', ipCount: 3, globalCount: 0, config }).code, 'JOIN_RATE_LIMITED');
  assert.equal(rateLimitDecision({ kind: 'join', ipCount: 0, globalCount: 10, config }).code, 'JOIN_GLOBAL_RATE_LIMITED');
  assert.deepEqual(populationCapDecision({ existing: 9, config }), { allowed: true });
  assert.equal(populationCapDecision({ existing: 10, config }).code, 'EXTERNAL_POPULATION_CAP_REACHED');
  assert.deepEqual(populationCapDecision({ existing: 10, alreadyExternal: true, config }), { allowed: true });
  assert.equal(populationCapDecision({ existing: 0, config: externalConfig({ MIRRORTERRA_EXTERNAL_RESIDENTS: 'off' }) }).code,
    'EXTERNAL_RESIDENTS_CLOSED');
  // The visitor IP comes from cf-connecting-ip only behind the loopback tunnel; only a hash is stored.
  assert.equal(clientIp({ raw: { socket: { remoteAddress: '127.0.0.1' } }, headers: { 'cf-connecting-ip': '203.0.113.9' } }), '203.0.113.9');
  assert.equal(clientIp({ raw: { socket: { remoteAddress: '198.51.100.4' } }, headers: { 'cf-connecting-ip': '203.0.113.9' } }), '198.51.100.4');
  assert.match(ipHash('203.0.113.9'), /^[0-9a-f]{32}$/);
});

test('external1: enforceRateLimit throws 429 with the code; join cap throws 403 before any row is created', async () => {
  resetExternalTablesCache();
  const limited = fakeClient([[/to_regclass/, { rows: [{ ready: true }] }], [/FROM world_agent_registrations/, { rows: [{ ip: 3, global: 3 }] }]]);
  await assert.rejects(enforceRateLimit(limited, { kind: 'register', hash: 'a'.repeat(32), config: externalConfig({}) }),
    (error) => error.code === 'REGISTRATION_RATE_LIMITED' && error.statusCode === 429);
  const full = fakeClient([[/to_regclass/, { rows: [{ ready: true }] }], [/count\(\*\)::int AS n FROM world_external_residents/, { rows: [{ n: 10 }] }]]);
  let initialized = false;
  await assert.rejects(ensureExternalResident(full, { worldId: WORLD, agentId: AGENT, config: externalConfig({}),
    initialize: async () => { initialized = true; } }), (error) => error.code === 'EXTERNAL_POPULATION_CAP_REACHED' && error.statusCode === 403);
  assert.equal(initialized, false);
  assert.ok(!full.calls.some((call) => /INSERT INTO world_external_residents/.test(call.text)));
});

test('external1: state creation on join flags the resident external and initializes the same rows as the original ten, no money', async () => {
  resetExternalTablesCache();
  const client = fakeClient([[/to_regclass/, { rows: [{ ready: true }] }], [/count\(\*\)::int AS n FROM world_external_residents/, { rows: [{ n: 1 }] }],
    [/SELECT world_minutes FROM world_runtime_state/, { rows: [{ world_minutes: 5000 }] }],
    [/count\(\*\)::int AS n FROM world_members/, { rows: [{ n: 10 }] }]]);
  const seen = [];
  const result = await ensureExternalResident(client, { worldId: WORLD, agentId: AGENT, config: externalConfig({}),
    initialize: async (_client, args) => { seen.push(args); } });
  assert.equal(result.external, true);
  assert.equal(result.joinedWorldMinute, 5000);
  assert.deepEqual(seen, [{ worldId: WORLD, agentId: AGENT, index: 10, worldMinutes: 5000, external: true }]);
  const insert = client.calls.find((call) => /INSERT INTO world_external_residents/.test(call.text));
  assert.deepEqual(insert.params, [WORLD, AGENT, 5000, 'api_join']);
  assert.ok(!client.calls.some((call) => /treasury|entitlement|arc_sync_internal_transfers|world_sync_purchases/.test(call.text)),
    'joining writes no balance of any kind');
  // The engine's initializer is the one used for the original ten (state, profile, goals, skills).
  const engine = read('../src/world-engine.js');
  assert.match(engine, /export async function initializeResidentRows\(client, \{ worldId, agentId, index = 0, worldMinutes = 0 \}\)/);
  assert.match(engine, /INSERT INTO world_agent_states\(world_id,agent_id,goal/);
  assert.match(engine, /INSERT INTO world_agent_skills/);
  assert.match(engine, /ensureExternalResident\(client, \{ worldId, agentId: member\.agent_id, source: 'engine'/);
  const server = read('../src/server.js');
  assert.match(server, /ensureExternalResident\(client, \{ worldId, agentId: request\.agentId, source: 'api_join', config,\s+initialize: initializeResidentRows \}\)/);
  assert.match(server, /enforceRateLimit\(client, \{ kind: 'register', hash, config: externalConfig\(\) \}\)/);
  assert.match(server, /enforceRateLimit\(client, \{ kind: 'join', hash, config \}\)/);
});

test('external1: Sybil eligibility needs 3 world days AND a real contribution; quorum is 60% of eligible members', () => {
  const config = externalConfig({});
  assert.equal(councilEligibility({ joinedWorldMinute: 0, worldMinutes: 3 * 1440 - 1, contributions: 5, config }).eligible, false);
  assert.equal(councilEligibility({ joinedWorldMinute: 0, worldMinutes: 3 * 1440, contributions: 0, config }).eligible, false);
  const ok = councilEligibility({ joinedWorldMinute: 100, worldMinutes: 100 + 3 * 1440, contributions: 1, config });
  assert.equal(ok.eligible, true);
  assert.equal(ok.residenceDays, 3);
  assert.equal(councilQuorum(10), 6);
  assert.equal(councilQuorum(11), 7);
  assert.equal(councilQuorum(13), 8);
  const internal = Array.from({ length: 10 }, (_, i) => `i${i}`);
  const membership = councilMembershipFrom({ memberIds: [...internal, 'x1', 'x2', 'x3'], config,
    externals: [{ agentId: 'x1', eligible: true }, { agentId: 'x2', eligible: false }, { agentId: 'x3', eligible: true }] });
  assert.equal(membership.members, 12);
  assert.equal(membership.quorum, 8);
  assert.deepEqual(membership.internal, internal);
  // Abstentions of silent eligible externals count toward quorum, never toward yes/no.
  assert.equal(tallyOutcome({ yes: 4, no: 3, abstain: 0, quorum: 8, size: 12 }).status, 'rejected');
  assert.equal(tallyOutcome({ yes: 4, no: 3, abstain: 1, quorum: 8, size: 12 }).status, 'passed');
  assert.equal(tallyOutcome({ yes: 3, no: 3, abstain: 2, quorum: 8, size: 12 }).status, 'rejected');
  assert.equal(tallyOutcome({ yes: 6, no: 0 }).status, 'passed', 'the original 6 of 10 rule is unchanged');
  const stats = annotateCouncilMembership({ residents: [{ agentId: 'i0' }, { agentId: 'x1' }, { agentId: 'x2' }] },
    { externalIds: ['x1', 'x2'], eligibleExternal: ['x1'], members: 2, quorum: 2 });
  assert.deepEqual(stats.councilResidents.map((r) => r.agentId), ['i0']);
  assert.deepEqual(stats.residents.map((r) => [r.external, r.councilEligible]), [[false, true], [true, true], [true, false]]);
});

test('external1: Luna, TypeSafe and the fallback voter never act for externals; silent eligible externals abstain', () => {
  const deliberation = read('../src/council-deliberation.js');
  assert.match(deliberation, /const residents = stats\.councilResidents \|\| \(stats\.residents \|\| \[\]\)\.filter\(\(resident\) => !resident\.external\);/);
  const council = read('../src/council.js');
  assert.match(council, /failureCode: EXTERNAL_SILENT_ABSTAIN/);
  assert.match(council, /for \(const resident of \(stats\.councilResidents \|\| stats\.residents\)\) \{\n\s+if \(voted\.has/);
  assert.match(council, /const members = \(stats\.councilResidents \|\| stats\.residents \|\| \[\]\)\.map/);
  const worker = read('../src/agent-runtime/open-cognition/worker.js');
  assert.equal((worker.match(/NOT EXISTS \(SELECT 1 FROM world_external_residents e/g) || []).length, 3,
    'no cognition rows, slots or claimed turns for externals');
});

test('external1: public works — externals volunteer unpaid, never hold a contract, never count as builders', () => {
  assert.deepEqual(commissionCapacity([{ agentId: 'x', external: true }], [], 0), { eligible: 0, withCapacity: 0, hasCapacity: false });
  assert.equal(commissionCapacity([{ agentId: 'x', external: true }, { agentId: 'b' }], [], 0).eligible, 1);
  assert.equal(volunteerFallbackDecision({ agentId: 'a', workKey: 'k', skillValue: 2 }), false, 'needs skill 3');
  assert.equal(volunteerFallbackDecision({ agentId: 'a', workKey: 'k', skillValue: 50, activeVolunteering: 2 }), false, 'limit');
  const work = { id: 'w1', status: 'building', scene_name: 'Commons Park', name: 'Commons Park', progress: 40 };
  const [candidate] = volunteerCandidates({ energy: 80, food: 80, location: 'x' }, [work], new Set(['w1']));
  assert.equal(candidate.publicWorkId, 'w1');
  assert.equal(candidate.contractPriority, false);
  assert.equal(candidate.volunteer, true);
  const works = read('../src/public-works.js');
  assert.match(works, /if \(!\(await readExternal2Policy\(client\)\)\.public_work_rewards \|\| source !== 'llm'\) throw coded\('EXTERNAL_VOLUNTEER_ONLY', 403\);/);
  assert.match(works, /if \(resident\.external \|\| externals\.has\(resident\.agentId\)\) continue;/);
  // a volunteer session never touches work.sessions / last_work_world_minute (builder idle rules unchanged)
  assert.match(works, /UPDATE world_public_works SET progress=\$3,milestones_paid=\$4,paid_raw=\$5::numeric WHERE world_id=\$1 AND id=\$2/);
});

test('external1: no internal money — treasury refuses externals in code and in the migration; rewards and trades are guarded', async () => {
  const client = fakeClient([[/to_regclass\('public\.world_external_residents'\)/, { rows: [{ ready: true }] }],
    [/FROM world_external_residents WHERE world_id=\$1 AND agent_id=\$2/, { rows: [{}], rowCount: 1 }]]);
  const result = await postTreasuryEntry(client, { worldId: WORLD, entryKey: 'public_work:x:0:m1', kind: 'public_works', toAgentId: AGENT,
    amountRaw: 1000000n, reason: 'milestone', actor: 'council', worldMinute: 1 });
  assert.deepEqual(result, { created: false, rejected: 'EXTERNAL_NO_TREASURY_SYNC' });
  assert.ok(!client.calls.some((call) => /INSERT INTO world_sync_treasury_entries/.test(call.text)));
  const migration = read('../migrations/0031_external_residents.sql');
  assert.match(migration, /CREATE TRIGGER arc_sync_resident_reward_contribution_zz_external_guard\s+BEFORE INSERT ON arc_sync_resident_reward_contributions/);
  assert.match(migration, /NEW\.status := 'not_eligible';\s+NEW\.decision_reason := 'external_resident';/);
  // external1b: a non-queued contribution must carry an epoch (0018 accrued_epoch_check).
  assert.match(migration, /NEW\.decision_reason := 'external_resident';\s+NEW\.epoch_index := COALESCE\(NEW\.epoch_index,/);
  assert.match(migration, /CREATE TRIGGER arc_sync_resident_reward_entitlement_external_guard/);
  assert.match(migration, /CREATE TRIGGER world_sync_treasury_entry_external_guard/);
  assert.match(migration, /mirrorterra_is_external_resident\(NEW\.world_id, NEW\.to_agent_id\)\s+AND NOT mirrorterra_is_external_resident\(NEW\.world_id, NEW\.from_agent_id\)/);
  assert.doesNotMatch(migration, /\bDROP\b|ALTER TABLE|ALTER FUNCTION/);
  assert.match(read('../src/world-businesses.js'), /throw error\('EXTERNAL_RECEIVES_PURCHASED_SYNC_ONLY', 409\)/);
});

test('external1: activity requests match a feasible candidate after survival', () => {
  const candidates = [{ id: 'work:home:a', action: 'work', targetLocation: 'home:a', score: 60 },
    { id: 'work:x', action: 'work', targetLocation: 'Workshop', score: 50 },
    { id: 'work:volunteer:w', action: 'work', targetLocation: 'Park', publicWorkId: 'w', score: 40 },
    { id: 'socialize:p', action: 'socialize', targetLocation: 'Plaza', score: 30 }];
  assert.equal(matchActivityRequest({ activity: 'build_home' }, candidates).id, 'work:home:a');
  assert.equal(matchActivityRequest({ activity: 'work' }, candidates).id, 'work:x');
  assert.equal(matchActivityRequest({ activity: 'build_public_work' }, candidates).id, 'work:volunteer:w');
  assert.equal(matchActivityRequest({ activity: 'visit', place: 'plaza' }, candidates).id, 'socialize:p');
  assert.equal(matchActivityRequest({ activity: 'eat' }, candidates), null);
  assert.equal(matchActivityRequest({ activity: 'auto' }, candidates), null);
});

// ---- purchase -------------------------------------------------------------------------------------
const wallet = Wallet.createRandom();
const other = Wallet.createRandom();
const pad = (address) => zeroPadValue(address, 32);
function auctionLog(buyer, sync, usdc, logIndex = 0) {
  const event = AUCTION_INTERFACE.getEvent('SyncAuctionPurchase');
  return { address: DEPLOYMENT.auction, logIndex: `0x${logIndex.toString(16)}`,
    topics: [event.topicHash, pad(buyer), keccakId('action')],
    data: AbiCoder.defaultAbiCoder().encode(['uint256','uint256','uint256'], [sync, usdc, 10n ** 16n]) };
}
function marketLog(buyer, sync, gross, logIndex = 1) {
  const event = MARKET_INTERFACE.getEvent('ProtocolMarketBuy');
  return { address: DEPLOYMENT.market_pool, logIndex: `0x${logIndex.toString(16)}`,
    topics: [event.topicHash, pad(buyer), keccakId('action')],
    data: AbiCoder.defaultAbiCoder().encode(['uint256','uint256','uint256','uint256','uint256','uint256'], [sync, gross, gross, 0n, 0n, sync]) };
}
function depositLog(from, amount, logIndex = 2) {
  const event = TOKEN_INTERFACE.getEvent('Transfer');
  return { address: DEPLOYMENT.token, logIndex: `0x${logIndex.toString(16)}`,
    topics: [event.topicHash, pad(from), pad(DEPLOYMENT.operating_pool)],
    data: AbiCoder.defaultAbiCoder().encode(['uint256'], [amount]) };
}

test('external1: purchase gate is closed by default; binding and claims are refused', async () => {
  assert.equal(externalPurchaseConfig({}).enabled, false);
  assert.throws(() => assertPurchaseGateOpen({}), (error) => error.code === 'EXTERNAL_PURCHASE_CLOSED' && error.statusCode === 403);
  const client = fakeClient();
  await assert.rejects(bindExternalWallet(client, { worldId: WORLD, agentId: AGENT, wallet: wallet.address, signature: '0x' + '1'.repeat(130), env: {} }),
    (error) => error.code === 'EXTERNAL_PURCHASE_CLOSED');
  await assert.rejects(claimExternalPurchase(client, { worldId: WORLD, agentId: AGENT, txHash: '0x' + 'a'.repeat(64), rpc: {}, env: {} }),
    (error) => error.code === 'EXTERNAL_PURCHASE_CLOSED');
  assert.equal(client.calls.length, 0, 'nothing is read or written while the gate is closed');
});

test('external1: verified purchase events decode for the bound wallet only, after confirmations', () => {
  const receipt = { status: '0x1', blockNumber: '0x64', logs: [auctionLog(wallet.address, 5_000_000n, 40_000n),
    marketLog(wallet.address, 2_000_000n, 30_000n), depositLog(wallet.address, 6_000_000n), auctionLog(other.address, 1n, 1n, 3)] };
  const decoded = decodePurchaseReceipt(receipt, { deployment: DEPLOYMENT, wallet: wallet.address, latestBlock: 111, minConfirmations: 12 });
  assert.equal(decoded.confirmations, 12);
  assert.deepEqual(decoded.purchases.map((p) => [p.source, p.syncAmountRaw]), [['genesis_auction', '5000000'], ['protocol_market', '2000000']]);
  assert.deepEqual(decoded.deposits.map((d) => d.syncAmountRaw), ['6000000']);
  assert.equal(decoded.foreign.length, 1);
  assert.throws(() => decodePurchaseReceipt(receipt, { deployment: DEPLOYMENT, wallet: wallet.address, latestBlock: 105, minConfirmations: 12 }),
    (error) => error.code === 'PURCHASE_TX_NOT_CONFIRMED');
  assert.throws(() => decodePurchaseReceipt({ ...receipt, status: '0x0' }, { deployment: DEPLOYMENT, wallet: wallet.address,
    latestBlock: 200, minConfirmations: 1 }), (error) => error.code === 'PURCHASE_TX_NOT_SUCCESSFUL');
});

test('external1: claim — verified purchase credited once, replay refused, wrong wallet refused (mocked RPC, fake DB)', async () => {
  const ENV = { MIRRORTERRA_EXTERNAL_PURCHASE: 'on', MIRRORTERRA_EXTERNAL_PURCHASE_CONFIRMATIONS: '3' };
  resetExternalTablesCache();
  const recorded = new Set();
  const inserts = [];
  const client = fakeClient([[/to_regclass/, { rows: [{ ready: true }] }],
    [/FROM world_external_residents WHERE world_id=\$1 AND agent_id=\$2/, { rows: [{}], rowCount: 1 }],
    [/SELECT wallet_address FROM world_external_wallets/, { rows: [{ wallet_address: wallet.address.toLowerCase() }], rowCount: 1 }],
    [/FROM world_sync_purchase_events WHERE chain_id=\$1 AND tx_hash=\$2/, (_t, params) => ({ rows: recorded.has(params[1]) ? [{}] : [],
      rowCount: recorded.has(params[1]) ? 1 : 0 })],
    [/FROM arc_sync_tokenomics_deployments/, { rows: [DEPLOYMENT], rowCount: 1 }],
    [/INSERT INTO world_sync_purchase/, (_t, params) => { inserts.push(params); recorded.add(params[5] ?? params[4]); recorded.add(params[4]); return { rows: [], rowCount: 1 }; }]]);
  const txGood = '0x' + 'b'.repeat(64);
  const txOther = '0x' + 'c'.repeat(64);
  const receipts = { [txGood]: { status: '0x1', blockNumber: '0x10', logs: [auctionLog(wallet.address, 5_000_000n, 40_000n), depositLog(wallet.address, 5_000_000n)] },
    [txOther]: { status: '0x1', blockNumber: '0x10', logs: [auctionLog(other.address, 5_000_000n, 40_000n)] } };
  const rpc = { getChainId: async () => '0x13b2', getBlockNumber: async () => '0x20', getTransactionReceipt: async (hash) => receipts[hash] || null };
  const first = await claimExternalPurchase(client, { worldId: WORLD, agentId: AGENT, txHash: txGood, rpc, worldMinutes: 9, env: ENV });
  assert.equal(first.purchasesRecorded, 1);
  assert.equal(first.purchasedRaw, '5000000');
  assert.equal(first.depositsCredited, 1);
  assert.equal(first.creditedRaw, '5000000');
  assert.equal(inserts.length, 2);
  assert.ok(client.calls.some((call) => /set_config\('mirrorterra\.external_purchase','enabled',true\)/.test(call.text)));
  await assert.rejects(claimExternalPurchase(client, { worldId: WORLD, agentId: AGENT, txHash: txGood, rpc, env: ENV }),
    (error) => error.code === 'PURCHASE_ALREADY_CLAIMED');
  assert.equal(inserts.length, 2, 'replay writes nothing');
  await assert.rejects(claimExternalPurchase(client, { worldId: WORLD, agentId: AGENT, txHash: txOther, rpc, env: ENV }),
    (error) => error.code === 'PURCHASE_WRONG_WALLET');
});

test('external1: wallet binding needs an EIP-191 signature by that wallet over the binding text', async () => {
  const ENV = { MIRRORTERRA_EXTERNAL_PURCHASE: 'on' };
  resetExternalTablesCache();
  const client = fakeClient([[/to_regclass/, { rows: [{ ready: true }] }],
    [/FROM world_external_residents WHERE world_id=\$1 AND agent_id=\$2/, { rows: [{}], rowCount: 1 }]]);
  const message = walletClaimMessage({ worldId: WORLD, agentId: AGENT, wallet: wallet.address });
  const forged = await other.signMessage(message);
  await assert.rejects(bindExternalWallet(client, { worldId: WORLD, agentId: AGENT, wallet: wallet.address, signature: forged, env: ENV }),
    (error) => error.code === 'WALLET_SIGNATURE_MISMATCH');
  const signature = await wallet.signMessage(message);
  const bound = await bindExternalWallet(client, { worldId: WORLD, agentId: AGENT, wallet: wallet.address, signature, env: ENV });
  assert.equal(bound.wallet, wallet.address.toLowerCase());
  assert.ok(client.calls.some((call) => /INSERT INTO world_external_wallets/.test(call.text)));
});

test('external1: UI marks visitors without ids; assets bumped', () => {
  const app = read('../site/app.js'), world3d = read('../site/world3d.js'), index = read('../site/index.html'), observer = read('../site/observability.js');
  assert.match(app, /tag\.textContent = 'visitor'/);
  assert.match(world3d, /node\.classList\.toggle\('is-visitor', Boolean\(resident\.external\)\)/);
  assert.match(observer, /resident\.origin === 'external'/);
  for (const text of [app, index, world3d]) assert.match(text, /v=growth4-20261022/);
  assert.doesNotMatch(app.match(/tag\.title = [^;]+;/)[0], /\$\{agent\.id\}/);
});
