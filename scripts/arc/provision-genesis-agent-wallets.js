import { Pool } from 'pg';
import { arcNetworkConfig } from '../../src/arc/config.js';
import { loadConfiguredArcSigner } from '../../src/arc/signer-loader.js';

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
}

function fail(message, code = 'GENESIS_WALLET_PROVISIONING_INVALID') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

const worldId = argumentValue('--world-id');
if (!worldId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(worldId)) {
  fail('Pass the exact formal world UUID with --world-id.');
}
const provisioningDatabaseUrl = String(process.env.SYNTERRA_TURNKEY_PROVISION_DATABASE_URL || '').trim();
if (!provisioningDatabaseUrl) {
  fail('SYNTERRA_TURNKEY_PROVISION_DATABASE_URL must be provided through the operator secret mechanism; DATABASE_URL is not used.');
}
if (String(process.env.MAINNET_WRITE_GATE || '').toLowerCase() === 'true') {
  fail('MAINNET_WRITE_GATE must remain false for wallet provisioning.');
}

const config = arcNetworkConfig(process.env);
if (config.writesEnabled !== false) fail('This build does not permit Arc Mainnet writes.');
const pool = new Pool({ connectionString: provisioningDatabaseUrl, max: 2 });
try {
  const databaseIdentity = await pool.query('SELECT current_user::text AS current_role,session_user::text AS session_role');
  if ([databaseIdentity.rows[0]?.current_role, databaseIdentity.rows[0]?.session_role]
    .some((role) => String(role || '').toLowerCase() === 'synterra_app')) {
    fail('Wallet provisioning requires a dedicated operator database role; synterra_app is not permitted.');
  }
  const issuerResult = await pool.query(
    'SELECT issuer_agent_id,selection_source FROM world_genesis_issuer_assignments ' +
    'WHERE world_id=$1 AND capability_generation=1',
    [worldId]
  );
  if (issuerResult.rowCount !== 1 || issuerResult.rows[0].selection_source !== 'creator_genesis_assignment') {
    fail('The world must have exactly one Generation 1 creator_genesis_assignment issuer.');
  }
  const members = await pool.query(
    'SELECT member.agent_id,agent.name FROM world_members member ' +
    'JOIN agents agent ON agent.id=member.agent_id WHERE member.world_id=$1 ORDER BY member.agent_id',
    [worldId]
  );
  if (members.rowCount !== 10) fail('Provisioning is restricted to exactly 10 existing Genesis Agent members.');
  if (!members.rows.some((member) => member.agent_id === issuerResult.rows[0].issuer_agent_id)) {
    fail('The Generation 1 issuer must be one of the existing 10 world members.');
  }

  const { signer } = await loadConfiguredArcSigner({
    config,
    env: { ...process.env, ARC_SIGNER_PROVIDER: 'turnkey', ARC_SIGNER_ADAPTER_MODULE: '' },
    pool
  });
  for (const member of members.rows) {
    await signer.provisionResidentWallet(worldId, member.agent_id);
  }

  const result = await pool.query(
    "WITH agent_wallets AS (" +
    "SELECT wallet.* FROM world_members member JOIN arc_agent_wallets wallet " +
    "ON wallet.world_id=member.world_id AND wallet.agent_id=member.agent_id " +
    "WHERE member.world_id=$1 AND wallet.chain_id=5042 AND wallet.status='active' AND wallet.provider='turnkey'), " +
    "available_recipients AS (" +
    "SELECT 'agent'::text AS type,member.agent_id AS id,wallet.address FROM world_members member " +
    "JOIN arc_agent_wallets wallet ON wallet.world_id=member.world_id AND wallet.agent_id=member.agent_id " +
    "AND wallet.chain_id=5042 AND wallet.status='active' WHERE member.world_id=$1 " +
    "UNION ALL SELECT 'organization'::text,organization.id,wallet.address FROM world_organizations organization " +
    "JOIN arc_organization_wallets wallet ON wallet.world_id=organization.world_id " +
    "AND wallet.organization_id=organization.id AND wallet.chain_id=5042 AND wallet.status='active' " +
    "WHERE organization.world_id=$1) " +
    "SELECT (SELECT count(*)::int FROM agent_wallets) AS agent_wallets," +
    "(SELECT count(DISTINCT lower(address))::int FROM agent_wallets) AS agent_addresses," +
    "(SELECT count(DISTINCT provider_suborganization_id)::int FROM agent_wallets) AS suborganizations," +
    "(SELECT count(DISTINCT provider_wallet_id)::int FROM agent_wallets) AS wallets," +
    "(SELECT count(DISTINCT provider_key_reference)::int FROM agent_wallets) AS accounts," +
    "(SELECT count(*)::int FROM agent_wallets WHERE agent_id=$2) AS issuer_wallets," +
    "(SELECT count(*)::int FROM available_recipients) AS available_recipients," +
    "(SELECT count(DISTINCT lower(address))::int FROM available_recipients) AS recipient_addresses",
    [worldId, issuerResult.rows[0].issuer_agent_id]
  );
  const counts = result.rows[0];
  if (counts.agent_wallets !== 10 || counts.agent_addresses !== 10 || counts.suborganizations !== 10
      || counts.wallets !== 10 || counts.accounts !== 10 || counts.issuer_wallets !== 1
      || counts.available_recipients !== 10 || counts.recipient_addresses !== 10) {
    fail('Turnkey provisioning did not produce exactly 10 unique active Agent wallets and one issuer wallet.',
      'GENESIS_WALLET_PROVISIONING_INCOMPLETE');
  }
  process.stdout.write(JSON.stringify({
    worldId,
    provisionedGenesisAgents: counts.agent_wallets,
    availableRecipients: counts.available_recipients,
    uniqueAddresses: counts.agent_addresses,
    uniqueSubOrganizations: counts.suborganizations,
    uniqueWallets: counts.wallets,
    uniqueAccounts: counts.accounts,
    issuerWalletPresent: true,
    arcWritesEnabled: false
  }) + '\n');
} finally {
  await pool.end();
}
