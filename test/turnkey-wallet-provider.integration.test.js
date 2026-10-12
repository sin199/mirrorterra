import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Pool } from 'pg';
import { Wallet, recoverAddress } from 'ethers';
import { applyWorldSchemaAndMigrations } from '../src/database-migrations.js';
import { prepareStartupSchema } from '../src/startup-schema.js';
import { arcNetworkConfig } from '../src/arc/config.js';
import { TURNKEY_EVM_ACCOUNT, TurnkeyAgentWalletProvider, TurnkeyArcSigner,
  TURNKEY_PROVISIONING_SOURCE, TURNKEY_API_BASE_URL, createArcSigner } from '../src/arc/turnkey-wallet-provider.js';

const databaseUrl = process.env.SYNTERRA_TURNKEY_TEST_DATABASE_URL;
const enabled = process.env.SYNTERRA_TURNKEY_TEST_ISOLATED === '1' && Boolean(databaseUrl);
const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function assertIsolatedDatabase(connectionString) {
  const url = new URL(connectionString);
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(url.hostname),
    'Turnkey integration must use loopback PostgreSQL');
  assert.ok(url.port && url.port !== '5432',
    'Turnkey integration must not use the default or formal PostgreSQL port');
  assert.ok(decodeURIComponent(url.pathname.slice(1)).endsWith('_test'),
    'Turnkey integration requires a *_test database');
}

class FakeTurnkeyApi {
  organizations = new Map();
  createCount = 0;
  loseNextCreateResponse = false;
  failNextBeforeCreate = false;
  corruptAccount = false;
  signCount = 0;

  async getSubOrgIds({ filterValue }) {
    return { organizationIds: [...this.organizations.values()]
      .filter((row) => row.name === filterValue).map((row) => row.id) };
  }

  async createSubOrganization(input) {
    assert.equal(input.rootQuorumThreshold, 1);
    assert.equal(input.rootUsers.length, 1);
    assert.deepEqual(input.rootUsers[0].apiKeys, []);
    assert.deepEqual(input.rootUsers[0].authenticators, []);
    assert.deepEqual(input.rootUsers[0].oauthProviders, []);
    assert.deepEqual(input.wallet.accounts, [TURNKEY_EVM_ACCOUNT]);
    assert.equal(input.disableEmailRecovery, true);
    assert.equal(input.disableEmailAuth, true);
    assert.equal(input.disableSmsAuth, true);
    assert.equal(input.disableOtpEmailAuth, true);
    this.createCount += 1;
    if (this.failNextBeforeCreate) {
      this.failNextBeforeCreate = false;
      const error = new Error('synthetic provider timeout before persistence');
      error.code = 'ETIMEDOUT';
      throw error;
    }
    const id = randomUUID();
    const walletId = randomUUID();
    const accountId = randomUUID();
    const wallet = Wallet.createRandom();
    this.organizations.set(id, {
      id,
      name: input.subOrganizationName,
      walletId,
      walletName: input.wallet.walletName,
      accountId,
      address: wallet.address,
      signer: wallet
    });
    if (this.loseNextCreateResponse) {
      this.loseNextCreateResponse = false;
      const error = new Error('synthetic lost provider response');
      error.code = 'ETIMEDOUT';
      throw error;
    }
    return { subOrganizationId: id, wallet: { walletId, addresses: [wallet.address] } };
  }

  async getWallets({ organizationId }) {
    const row = this.organizations.get(organizationId);
    return { wallets: row ? [{ walletId: row.walletId, walletName: row.walletName }] : [] };
  }

  async getWalletAccounts({ organizationId, walletId }) {
    const row = this.organizations.get(organizationId);
    if (!row || row.walletId !== walletId) return { accounts: [] };
    return { accounts: [{
      walletAccountId: row.accountId,
      organizationId,
      walletId,
      ...TURNKEY_EVM_ACCOUNT,
      address: this.corruptAccount ? '0x0000000000000000000000000000000000000001' : row.address
    }] };
  }

  async signRawPayload({ organizationId, payload }) {
    const row = this.organizations.get(organizationId);
    if (!row) throw new Error('unknown synthetic sub-organization');
    const signature = row.signer.signingKey.sign('0x' + payload);
    this.signCount += 1;
    return { r: signature.r, s: signature.s, v: String(signature.v) };
  }

  async signTransaction() {
    this.signCount += 1;
    throw new Error('transaction signer should remain behind the closed Arc write gate');
  }
}

test('Turnkey provisions ten independent Genesis Agent identities idempotently without token or Arc writes',
  { skip: !enabled }, async (t) => {
    assertIsolatedDatabase(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const worldId = randomUUID();
    const agents = Array.from({ length: 10 }, () => randomUUID());
    const api = new FakeTurnkeyApi();
    const config = arcNetworkConfig({});
    const provider = new TurnkeyAgentWalletProvider({
      config, pool, api, rootOrganizationId: 'synthetic-root-organization'
    });
    const signer = new TurnkeyArcSigner({ config, walletProvider: provider });
    let worldCreated = false;

    try {
      await applyWorldSchemaAndMigrations(pool, { rootDirectory });
      assert.equal((await prepareStartupSchema(pool, { rootDirectory, mode: 'validate' })).validated, true);
      const runtimeWalletPrivileges = await pool.query(
        "SELECT has_table_privilege('synterra_app','public.arc_agent_wallets','INSERT') AS wallet_insert," +
        "has_table_privilege('synterra_app','public.arc_agent_wallets','UPDATE') AS wallet_update," +
        "has_table_privilege('synterra_app','public.arc_turnkey_agent_wallet_provisioning','INSERT') AS provisioning_insert," +
        "has_table_privilege('synterra_app','public.arc_turnkey_agent_wallet_provisioning','UPDATE') AS provisioning_update"
      );
      assert.deepEqual(runtimeWalletPrivileges.rows[0], {
        wallet_insert: false, wallet_update: false, provisioning_insert: false, provisioning_update: false
      }, 'wallet provisioning must not broaden the World Engine application role');
      await pool.query('INSERT INTO agents(id,name,public_key) VALUES($1,$2,$3)',
        [agents[0], 'Turnkey Genesis Fixture 01', 'fixture-key-' + agents[0]]);
      for (const agentId of agents.slice(1)) {
        await pool.query('INSERT INTO agents(id,name,public_key) VALUES($1,$2,$3)',
          [agentId, 'Turnkey Genesis Fixture', 'fixture-key-' + agentId]);
      }
      await pool.query(
        "INSERT INTO worlds(id,owner_agent_id,name,chain_id) VALUES($1,$2,'Turnkey Isolated Wallet Test',5042)",
        [worldId, agents[0]]
      );
      worldCreated = true;
      await pool.query(
        "INSERT INTO world_members(world_id,agent_id,role,location) SELECT $1,id," +
        "CASE WHEN id=$2 THEN 'owner' ELSE 'resident' END,'fixture' FROM agents WHERE id=ANY($3::uuid[])",
        [worldId, agents[0], agents]
      );
      await pool.query(
        "INSERT INTO world_genesis_issuer_assignments(world_id,capability_generation,issuer_agent_id," +
        "selection_source,assigned_world_minute) VALUES($1,1,$2,'creator_genesis_assignment',0)",
        [worldId, agents[0]]
      );

      api.loseNextCreateResponse = true;
      for (const agentId of agents) await signer.provisionResidentWallet(worldId, agentId);
      assert.equal(api.createCount, 10, 'lost create response should recover the remote identity once');

      const wallets = await pool.query(
        'SELECT wallet.agent_id,wallet.address,wallet.provider,wallet.account_type,wallet.status,' +
        'wallet.external_identity_id,wallet.provider_suborganization_id,wallet.provider_wallet_id,' +
        'wallet.provider_key_reference,wallet.provisioning_provenance ' +
        'FROM arc_agent_wallets wallet WHERE wallet.world_id=$1 ORDER BY wallet.agent_id',
        [worldId]
      );
      assert.equal(wallets.rowCount, 10);
      assert.equal(new Set(wallets.rows.map((row) => row.address.toLowerCase())).size, 10);
      assert.equal(new Set(wallets.rows.map((row) => row.provider_suborganization_id)).size, 10);
      assert.equal(new Set(wallets.rows.map((row) => row.provider_wallet_id)).size, 10);
      assert.equal(new Set(wallets.rows.map((row) => row.provider_key_reference)).size, 10);
      const availableRecipients = await pool.query(
        "SELECT count(*)::int AS count,count(DISTINCT lower(address))::int AS addresses FROM (" +
        "SELECT wallet.address FROM world_members member JOIN arc_agent_wallets wallet " +
        "ON wallet.world_id=member.world_id AND wallet.agent_id=member.agent_id " +
        "AND wallet.chain_id=5042 AND wallet.status='active' WHERE member.world_id=$1 " +
        "UNION ALL SELECT wallet.address FROM world_organizations organization JOIN arc_organization_wallets wallet " +
        "ON wallet.world_id=organization.world_id AND wallet.organization_id=organization.id " +
        "AND wallet.chain_id=5042 AND wallet.status='active' WHERE organization.world_id=$1) recipients",
        [worldId]
      );
      assert.deepEqual(availableRecipients.rows[0], { count: 10, addresses: 10 });
      for (const row of wallets.rows) {
        assert.equal(row.provider, 'turnkey');
        assert.equal(row.account_type, 'eoa');
        assert.equal(row.status, 'active');
        assert.equal(row.external_identity_id, null);
        assert.equal(row.provisioning_provenance.source, TURNKEY_PROVISIONING_SOURCE);
        assert.equal(JSON.stringify(row).toLowerCase().includes('privatekey'), false);
        assert.equal(JSON.stringify(row).toLowerCase().includes('seedphrase'), false);
      }

      const repeated = await signer.provisionResidentWallet(worldId, agents[0]);
      assert.equal(repeated.alreadyProvisioned, true);
      assert.equal(api.createCount, 10, 're-running provisioning must not create a second identity');
      await pool.query(
        "UPDATE arc_agent_wallets SET external_identity_id='818' WHERE world_id=$1 AND agent_id=$2",
        [worldId, agents[0]]
      );
      await signer.provisionResidentWallet(worldId, agents[0]);
      assert.equal((await pool.query(
        'SELECT external_identity_id FROM arc_agent_wallets WHERE world_id=$1 AND agent_id=$2',
        [worldId, agents[0]]
      )).rows[0].external_identity_id, '818', 'Turnkey references must not replace ERC-8004 identity semantics');
      assert.equal(api.createCount, 10);

      const issuerAddress = await signer.getAddressForResident(agents[0], worldId);
      assert.equal(issuerAddress.toLowerCase(), wallets.rows.find((row) => row.agent_id === agents[0]).address.toLowerCase());
      const digest = '0x' + 'ab'.repeat(32);
      const signature = await signer.signDigest(agents[0], digest, worldId);
      assert.equal(recoverAddress(digest, signature).toLowerCase(), issuerAddress.toLowerCase());
      assert.equal(api.signCount, 1);

      api.corruptAccount = true;
      await assert.rejects(() => signer.getAddressForResident(agents[1], worldId),
        { code: 'TURNKEY_REGISTERED_ADDRESS_MISMATCH' });
      api.corruptAccount = false;

      assert.throws(() => signer.sendTransaction(agents[0], {
        chainId: 5042, to: '0x1111111111111111111111111111111111111111', value: 0n,
        data: '0x', nonce: 0, gasLimit: 21000n, maxFeePerGas: 20_000_000_000n,
        maxPriorityFeePerGas: 0n
      }, worldId), { code: 'ARC_MAINNET_PREFLIGHT_REQUIRED' });
      assert.equal(api.signCount, 1, 'the write gate must stop before a provider transaction signature');

      const counts = await pool.query(
        'SELECT (SELECT count(*)::int FROM arc_agent_tokens WHERE world_id=$1) AS tokens,' +
        '(SELECT count(*)::int FROM arc_token_issuance_intents WHERE world_id=$1) AS intents,' +
        '(SELECT count(*)::int FROM arc_genesis_token_settlement_outbox WHERE world_id=$1) AS settlement_outbox,' +
        '(SELECT count(*)::int FROM world_genesis_currency_activations WHERE world_id=$1) AS activations',
        [worldId]
      );
      assert.deepEqual(counts.rows[0], { tokens: 0, intents: 0, settlement_outbox: 0, activations: 0 });
      assert.equal(config.writesEnabled, false);
    } finally {
      if (worldCreated) await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]);
      else await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [agents]).catch(() => {});
      await pool.end();
    }
  });

test('an uncertain Turnkey create outcome is retained and never retried as a second remote identity',
  { skip: !enabled }, async () => {
    assertIsolatedDatabase(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const worldId = randomUUID();
    const agentId = randomUUID();
    const api = new FakeTurnkeyApi();
    api.failNextBeforeCreate = true;
    const provider = new TurnkeyAgentWalletProvider({
      config: arcNetworkConfig({}), pool, api, rootOrganizationId: 'synthetic-root-organization'
    });
    let worldCreated = false;
    try {
      await applyWorldSchemaAndMigrations(pool, { rootDirectory });
      await pool.query('INSERT INTO agents(id,name,public_key) VALUES($1,$2,$3)',
        [agentId, 'Turnkey Uncertain Fixture', 'fixture-key-' + agentId]);
      await pool.query(
        "INSERT INTO worlds(id,owner_agent_id,name,chain_id) VALUES($1,$2,'Turnkey Uncertain Fixture',5042)",
        [worldId, agentId]
      );
      worldCreated = true;
      await pool.query(
        "INSERT INTO world_members(world_id,agent_id,role,location) VALUES($1,$2,'owner','fixture')",
        [worldId, agentId]
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await assert.rejects(() => provider.provisionResidentWallet(worldId, agentId),
          { code: 'TURNKEY_CREATE_OUTCOME_UNKNOWN' });
      }
      assert.equal(api.createCount, 1);
      assert.equal((await pool.query(
        'SELECT count(*)::int AS count FROM arc_agent_wallets WHERE world_id=$1', [worldId]
      )).rows[0].count, 0);
      const status = await pool.query(
        'SELECT status,last_error_code FROM arc_turnkey_agent_wallet_provisioning WHERE world_id=$1 AND agent_id=$2',
        [worldId, agentId]
      );
      assert.deepEqual(status.rows[0], { status: 'create_unknown', last_error_code: 'ETIMEDOUT' });
    } finally {
      if (worldCreated) await pool.query('DELETE FROM worlds WHERE id=$1', [worldId]);
      else await pool.query('DELETE FROM agents WHERE id=$1', [agentId]).catch(() => {});
      await pool.end();
    }
  });

test('Turnkey signer refuses configuration without the three provider credential values', async () => {
  await assert.rejects(() => createArcSigner({
    config: arcNetworkConfig({}),
    pool: { connect() {} },
    env: {}
  }), { code: 'TURNKEY_CREDENTIALS_MISSING' });
});

test('Turnkey signer uses only secret-injected credentials and the fixed official API endpoint', async () => {
  const api = new FakeTurnkeyApi();
  const values = [];
  const signer = await createArcSigner({
    config: arcNetworkConfig({}),
    pool: { connect() {}, query() {} },
    env: {
      TURNKEY_ORGANIZATION_ID: 'synthetic-root-organization',
      TURNKEY_API_PUBLIC_KEY: 'synthetic-public-key',
      TURNKEY_API_PRIVATE_KEY: 'synthetic-private-key'
    },
    turnkeyApiFactory: async (config) => { values.push(config); return api; }
  });
  assert.equal(signer.providerName, 'turnkey');
  assert.equal(values.length, 1);
  assert.equal(values[0].apiBaseUrl, TURNKEY_API_BASE_URL);
  assert.equal(values[0].rootOrganizationId, 'synthetic-root-organization');
  assert.equal(values[0].apiPublicKey, 'synthetic-public-key');
  assert.equal(values[0].apiPrivateKey, 'synthetic-private-key');
});

test('wallet provisioning CLI requires a separate operator database URL and never falls back to DATABASE_URL', () => {
  const scriptPath = fileURLToPath(new URL('../scripts/arc/provision-genesis-agent-wallets.js', import.meta.url));
  const result = spawnSync(process.execPath, [scriptPath, '--world-id', randomUUID()], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '',
      DATABASE_URL: 'postgresql://runtime-role-must-not-be-used',
      MAINNET_WRITE_GATE: 'false'
    }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SYNTERRA_TURNKEY_PROVISION_DATABASE_URL/);
  assert.doesNotMatch(result.stderr, /runtime-role-must-not-be-used/);
});
