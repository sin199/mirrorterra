import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { getAddress } from 'ethers';
import { turnkeyApiFromKeychain } from '../../src/arc/turnkey-keychain.js';
import { TURNKEY_EVM_ACCOUNT, turnkeyRootUserApiKeyParams } from '../../src/arc/turnkey-wallet-provider.js';

const worldId = process.argv[2];
const output = path.resolve(process.argv[3] || '.synterra/settlement-identity.json');
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let lock;
async function save(value) {
  const temp = output + '.tmp';
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, output);
}
try {
  if (process.env.MAINNET_WRITE_GATE !== 'false' || !/^[0-9a-f-]{36}$/i.test(worldId || '')) fail('SETTLEMENT_PROVISIONING_BOUNDARY_INVALID');
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  lock = await fs.open(output + '.lock', 'wx', 0o600);
  const world = await pool.query('SELECT id,chain_id FROM worlds WHERE id=$1', [worldId]);
  if (world.rowCount !== 1 || Number(world.rows[0].chain_id) !== 5042) fail('SETTLEMENT_WORLD_MISMATCH');
  const agents = await pool.query("SELECT address FROM arc_agent_wallets WHERE world_id=$1 AND status='active' AND chain_id=5042", [worldId]);
  if (agents.rowCount !== 10) fail('SETTLEMENT_GENESIS_WALLETS_NOT_READY');
  const { api, rootOrganizationId, publicKey } = await turnkeyApiFromKeychain();
  const who = await api.getWhoami({ organizationId: rootOrganizationId });
  if (who.organizationId !== rootOrganizationId) fail('TURNKEY_ROOT_ORGANIZATION_MISMATCH');
  const name = 'mirrorterra-sync-settlement-' + createHash('sha256').update(worldId).digest('hex');
  let previous = null;
  try { previous = JSON.parse(await fs.readFile(output, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (previous && (previous.worldId !== worldId || previous.subOrganizationName !== name)) fail('SETTLEMENT_IDENTITY_FILE_CONFLICT');
  const found = await api.getSubOrgIds({ organizationId: rootOrganizationId, filterType: 'NAME', filterValue: name });
  if (!Array.isArray(found.organizationIds) || found.organizationIds.length > 1) fail('SETTLEMENT_IDENTITY_AMBIGUOUS');
  let subOrganizationId = found.organizationIds[0];
  if (previous && !subOrganizationId) fail('SETTLEMENT_CREATION_OUTCOME_UNKNOWN');
  if (!subOrganizationId) {
    await save({ worldId, provider: 'turnkey', subOrganizationName: name, status: 'creating',
      provenance: 'operator_approved_immutable_sync_settlement_identity', agentBinding: null, allocation: '0' });
    // This marker survives ambiguous submission; retries only reconcile by stable name.
    const created = await api.createSubOrganization({ organizationId: rootOrganizationId,
      subOrganizationName: name, rootQuorumThreshold: 1,
      rootUsers: [{ userName: 'MirrorTerra SYNC ledger settlement executor',
        apiKeys: [turnkeyRootUserApiKeyParams(publicKey)], authenticators: [], oauthProviders: [] }],
      wallet: { walletName: 'MirrorTerra infrastructure settlement EVM wallet', accounts: [TURNKEY_EVM_ACCOUNT] },
      disableEmailRecovery: true, disableEmailAuth: true, disableSmsAuth: true, disableOtpEmailAuth: true });
    subOrganizationId = created.subOrganizationId;
    if (typeof subOrganizationId !== 'string' || !subOrganizationId) fail('TURNKEY_CREATE_RESPONSE_INVALID');
  }
  if (previous?.subOrganizationId && previous.subOrganizationId !== subOrganizationId) fail('SETTLEMENT_IDENTITY_CONFLICT');
  const wallets = await api.getWallets({ organizationId: subOrganizationId });
  if (wallets.wallets?.length !== 1) fail('SETTLEMENT_WALLET_AMBIGUOUS');
  const walletId = wallets.wallets[0].walletId;
  const response = await api.getWalletAccounts({ organizationId: subOrganizationId, walletId });
  if (response.accounts?.length !== 1) fail('SETTLEMENT_ACCOUNT_AMBIGUOUS');
  const account = response.accounts[0];
  if (account.organizationId !== subOrganizationId || account.walletId !== walletId
      || Object.entries(TURNKEY_EVM_ACCOUNT).some(([k,v]) => account[k] !== v)
      || !account.walletAccountId) fail('SETTLEMENT_ACCOUNT_INVALID');
  const address = getAddress(account.address);
  if (agents.rows.some((w) => w.address.toLowerCase() === address.toLowerCase())) fail('SETTLEMENT_AGENT_WALLET_COLLISION');
  if (previous?.address && previous.address.toLowerCase() !== address.toLowerCase()) fail('SETTLEMENT_ADDRESS_CHANGED');
  const identity = { worldId, chainId: 5042, provider: 'turnkey', status: 'verified', address,
    subOrganizationName: name, subOrganizationId, walletId, walletAccountId: account.walletAccountId,
    accountParameters: TURNKEY_EVM_ACCOUNT, provenance: 'operator_approved_immutable_sync_settlement_identity',
    agentBinding: null, allocation: '0', permission: 'committed_operating_pool_payouts_only',
    verifiedAt: new Date().toISOString() };
  await save(identity);
  console.log(JSON.stringify({ status: 'verified', address, agentBinding: null, allocation: '0',
    walletSigningCalls: 0, mainnetWrites: 0, output }));
} catch (error) {
  console.error(JSON.stringify({ code: /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'SETTLEMENT_PROVISIONING_FAILED' }));
  process.exitCode = 1;
} finally {
  await pool.end();
  if (lock) { await lock.close(); await fs.unlink(output + '.lock').catch(() => {}); }
}
