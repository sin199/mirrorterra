import { createHash } from 'node:crypto';
import { getAddress, recoverAddress, Transaction } from 'ethers';
import { Turnkey } from '@turnkey/sdk-server';
import { ARC_MAINNET_CHAIN_ID, assertArcWriteAllowed } from './config.js';
import { ArcSigner, validateArcTransactionEnvelope } from './wallet-provider.js';

export const TURNKEY_API_BASE_URL = 'https://api.turnkey.com';
export const TURNKEY_EVM_ACCOUNT = Object.freeze({
  curve: 'CURVE_SECP256K1',
  pathFormat: 'PATH_FORMAT_BIP32',
  path: "m/44'/60'/0'/0/0",
  addressFormat: 'ADDRESS_FORMAT_ETHEREUM'
});
export const TURNKEY_PROVISIONING_SOURCE = 'operator_approved_genesis_agent_provisioning';
export const TURNKEY_ROOT_USER_API_KEY_NAME = 'MirrorTerra Agent Provisioning API Key';
export const TURNKEY_API_KEY_CURVE = 'API_KEY_CURVE_P256';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const SUBORG_NAME_PREFIX = 'mirrorterra-genesis-agent-';

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw codedError('TURNKEY_PROVISIONING_ID_INVALID', label + ' must be a UUID.');
  }
}

function normalizeProviderCode(error) {
  const value = String(error?.code || 'TURNKEY_PROVIDER_ERROR').toUpperCase();
  return /^[A-Z0-9_]{1,80}$/.test(value) ? value : 'TURNKEY_PROVIDER_ERROR';
}

function requireReference(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw codedError('TURNKEY_PROVIDER_RESPONSE_INVALID', 'Turnkey response is missing a valid ' + label + '.');
  }
  return value.trim();
}

function signedTransactionPayloads(value, payloads = [], seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return payloads;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'signedTransaction') payloads.push(child);
    if (child && typeof child === 'object') signedTransactionPayloads(child, payloads, seen);
  }
  return payloads;
}

function normalizeSignedTransaction(value) {
  if (typeof value !== 'string' || !/^(?:0x)?(?:[0-9a-f]{2})+$/i.test(value)) {
    throw codedError('TURNKEY_SIGNED_TRANSACTION_INVALID',
      'Turnkey did not return a valid serialized EVM transaction.');
  }
  return '0x' + value.replace(/^0x/i, '').toLowerCase();
}

export function parseTurnkeySignedTransactionResponse(response, expected) {
  const activity = response?.activity;
  if (activity?.status !== 'ACTIVITY_STATUS_COMPLETED'
      || activity?.type !== 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2') {
    throw codedError('TURNKEY_SIGNED_TRANSACTION_ACTIVITY_INVALID',
      'Turnkey transaction signing activity did not complete successfully.');
  }

  const nestedPayload = activity?.result?.signTransactionResult?.signedTransaction;
  const topLevelPayload = response?.signedTransaction;
  const payloads = signedTransactionPayloads(response);
  if (typeof topLevelPayload !== 'string' || typeof nestedPayload !== 'string'
      || payloads.length !== 2) {
    throw codedError('TURNKEY_SIGNED_TRANSACTION_RESPONSE_INVALID',
      'Turnkey response must contain exactly one top-level and one activity signed transaction.');
  }

  const signedSerialized = normalizeSignedTransaction(topLevelPayload);
  const nestedSerialized = normalizeSignedTransaction(nestedPayload);
  if (signedSerialized !== nestedSerialized) {
    throw codedError('TURNKEY_SIGNED_TRANSACTION_MISMATCH',
      'Turnkey top-level and activity signed transactions do not match.');
  }

  let expectedFrom;
  let expectedTo;
  let unsigned;
  try {
    expectedFrom = getAddress(expected?.from);
    expectedTo = getAddress(expected?.to);
    if (BigInt(expected?.chainId) !== BigInt(ARC_MAINNET_CHAIN_ID)
        || typeof expected?.data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(expected.data)
        || BigInt(expected?.value) !== 0n
        || typeof expected?.unsignedTransaction !== 'string') {
      throw new Error('invalid expected transaction envelope');
    }
    unsigned = Transaction.from(expected.unsignedTransaction);
  } catch {
    throw codedError('TURNKEY_TRANSACTION_ENVELOPE_INVALID',
      'Expected Arc Mainnet transaction envelope is invalid.');
  }

  const expectedChainId = BigInt(expected.chainId);
  const expectedData = expected.data.toLowerCase();
  const expectedValue = BigInt(expected.value);
  const envelopeMatches = (transaction) => transaction.chainId === expectedChainId
    && transaction.to?.toLowerCase() === expectedTo.toLowerCase()
    && (transaction.data || '0x').toLowerCase() === expectedData
    && (transaction.value ?? 0n) === expectedValue;
  if (!envelopeMatches(unsigned)) {
    throw codedError('TURNKEY_TRANSACTION_ENVELOPE_MISMATCH',
      'Unsigned transaction does not match the expected Arc Mainnet envelope.');
  }

  let signed;
  try {
    signed = Transaction.from(signedSerialized);
  } catch {
    throw codedError('TURNKEY_SIGNED_TRANSACTION_INVALID',
      'Turnkey returned a malformed serialized EVM transaction.');
  }
  if (!signed.signature || signed.from?.toLowerCase() !== expectedFrom.toLowerCase()
      || !envelopeMatches(signed)
      || signed.unsignedHash.toLowerCase() !== unsigned.unsignedHash.toLowerCase()) {
    throw codedError('TURNKEY_SIGNED_TRANSACTION_MISMATCH',
      'Turnkey signed transaction does not match the expected signer or transaction envelope.');
  }
  return { signedTransaction: signedSerialized, transaction: signed, hash: signed.hash };
}

export function turnkeyRootUserApiKeyParams(publicKey) {
  if (typeof publicKey !== 'string' || !publicKey.trim()) {
    throw codedError('TURNKEY_CREDENTIALS_MISSING', 'A Turnkey root-user API public key is required.');
  }
  return {
    apiKeyName: TURNKEY_ROOT_USER_API_KEY_NAME,
    publicKey: publicKey.trim(),
    curveType: TURNKEY_API_KEY_CURVE
  };
}

function provisioningNames(worldId, agentId) {
  const digest = createHash('sha256').update(worldId + ':' + agentId).digest('hex');
  return {
    subOrganizationName: SUBORG_NAME_PREFIX + digest,
    walletName: 'MirrorTerra Genesis Agent EVM wallet'
  };
}

function expectedAccount(account, organizationId, walletId) {
  return account?.organizationId === organizationId
    && account?.walletId === walletId
    && account?.curve === TURNKEY_EVM_ACCOUNT.curve
    && account?.pathFormat === TURNKEY_EVM_ACCOUNT.pathFormat
    && account?.path === TURNKEY_EVM_ACCOUNT.path
    && account?.addressFormat === TURNKEY_EVM_ACCOUNT.addressFormat
    && typeof account?.address === 'string' && ADDRESS.test(account.address)
    && typeof account?.walletAccountId === 'string' && account.walletAccountId.length > 0;
}

async function apiGetSubOrganizations(api, rootOrganizationId, name) {
  const result = await api.getSubOrgIds({
    organizationId: rootOrganizationId,
    filterType: 'NAME',
    filterValue: name
  });
  return Array.isArray(result?.organizationIds) ? result.organizationIds : null;
}

async function apiGetWallets(api, organizationId) {
  const result = await api.getWallets({ organizationId });
  if (!Array.isArray(result?.wallets)) {
    throw codedError('TURNKEY_PROVIDER_RESPONSE_INVALID', 'Turnkey did not return a wallet list.');
  }
  return result.wallets;
}

async function apiGetAccounts(api, organizationId, walletId) {
  const result = await api.getWalletAccounts({ organizationId, walletId });
  if (!Array.isArray(result?.accounts)) {
    throw codedError('TURNKEY_PROVIDER_RESPONSE_INVALID', 'Turnkey did not return a wallet account list.');
  }
  return result.accounts;
}

function rowReferencesMatch(row, account, organizationId, walletId) {
  return row.provider_suborganization_id === organizationId
    && row.provider_wallet_id === walletId
    && row.provider_key_reference === account.walletAccountId
    && row.address.toLowerCase() === account.address.toLowerCase();
}

export class TurnkeyAgentWalletProvider {
  constructor({ config, pool, api, rootOrganizationId, rootUserApiPublicKey }) {
    if (!pool || typeof pool.connect !== 'function' || !api
        || typeof api.getSubOrgIds !== 'function'
        || typeof api.createSubOrganization !== 'function'
        || typeof api.getWallets !== 'function'
        || typeof api.getWalletAccounts !== 'function'
        || typeof api.signRawPayload !== 'function'
        || typeof api.signTransaction !== 'function') {
      throw new TypeError('Turnkey wallet provisioning requires a PostgreSQL pool and complete provider client.');
    }
    if (typeof rootOrganizationId !== 'string' || !rootOrganizationId.trim()) {
      throw codedError('TURNKEY_CREDENTIALS_MISSING', 'TURNKEY_ORGANIZATION_ID is required.');
    }
    const rootUserApiKey = turnkeyRootUserApiKeyParams(rootUserApiPublicKey);
    this.pool = pool;
    this.api = api;
    this.config = config;
    this.rootOrganizationId = rootOrganizationId.trim();
    this.rootUserApiKey = rootUserApiKey;
  }

  async provisionResidentWallet(worldId, agentId) {
    assertUuid(worldId, 'worldId');
    assertUuid(agentId, 'agentId');
    const lockKey = 'turnkey-agent-wallet:' + worldId + ':' + agentId;
    const client = await this.pool.connect();
    let locked = false;
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [lockKey]);
      locked = true;
      const member = await client.query(
        'SELECT agent.name FROM world_members member JOIN agents agent ON agent.id=member.agent_id ' +
        'WHERE member.world_id=$1 AND member.agent_id=$2',
        [worldId, agentId]
      );
      if (!member.rowCount) {
        throw codedError('TURNKEY_AGENT_NOT_IN_WORLD', 'The Agent is not a member of the requested world.');
      }

      const existing = await this.#readAgentWallet(client, worldId, agentId);
      if (existing) {
        if (existing.provider !== 'turnkey') {
          throw codedError('TURNKEY_EXISTING_WALLET_CONFLICT',
            'An Agent wallet already exists under another provider; it will not be replaced.');
        }
        const account = await this.#verifyRegisteredWallet(existing);
        return { worldId, agentId, address: account.address,
          subOrganizationId: existing.provider_suborganization_id,
          walletId: existing.provider_wallet_id, keyReference: existing.provider_key_reference,
          alreadyProvisioned: true };
      }

      const names = provisioningNames(worldId, agentId);
      await client.query('BEGIN');
      try {
        await client.query(
          'INSERT INTO arc_turnkey_agent_wallet_provisioning(world_id,agent_id,suborganization_name,status,provenance) ' +
          "VALUES($1,$2,$3,'requested',$4::jsonb) ON CONFLICT(world_id,agent_id) DO NOTHING",
          [worldId, agentId, names.subOrganizationName,
            JSON.stringify({ source: TURNKEY_PROVISIONING_SOURCE, rootOrganizationId: this.rootOrganizationId })]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }

      const stateResult = await client.query(
        'SELECT * FROM arc_turnkey_agent_wallet_provisioning WHERE world_id=$1 AND agent_id=$2 FOR UPDATE',
        [worldId, agentId]
      );
      const state = stateResult.rows[0];
      if (!state || state.suborganization_name !== names.subOrganizationName) {
        throw codedError('TURNKEY_PROVISIONING_STATE_CONFLICT', 'Turnkey provisioning identity does not match the Agent.');
      }

      let organizationId = state.provider_suborganization_id;
      let walletId = state.provider_wallet_id;
      let accountId = state.provider_key_reference;
      let creationAddresses = null;

      if (!organizationId) {
        const matchingOrganizations = await apiGetSubOrganizations(
          this.api, this.rootOrganizationId, names.subOrganizationName);
        if (!matchingOrganizations) {
          throw codedError('TURNKEY_PROVIDER_RESPONSE_INVALID', 'Turnkey sub-organization lookup was malformed.');
        }
        if (matchingOrganizations.length > 1) {
          throw codedError('TURNKEY_SUBORGANIZATION_AMBIGUOUS',
            'Multiple Turnkey sub-organizations match this deterministic Agent identity.');
        }
        if (matchingOrganizations.length === 1) {
          organizationId = requireReference(matchingOrganizations[0], 'sub-organization ID');
        } else if (state.status === 'requested') {
          await client.query(
            "UPDATE arc_turnkey_agent_wallet_provisioning SET status='create_started',updated_at=now() " +
            'WHERE world_id=$1 AND agent_id=$2',
            [worldId, agentId]
          );
          let created;
          try {
            created = await this.api.createSubOrganization({
              organizationId: this.rootOrganizationId,
              subOrganizationName: names.subOrganizationName,
              rootQuorumThreshold: 1,
              rootUsers: [{
                userName: 'MirrorTerra Agent ' + agentId,
                apiKeys: [this.rootUserApiKey],
                authenticators: [],
                oauthProviders: []
              }],
              wallet: { walletName: names.walletName, accounts: [TURNKEY_EVM_ACCOUNT] },
              disableEmailRecovery: true,
              disableEmailAuth: true,
              disableSmsAuth: true,
              disableOtpEmailAuth: true
            });
          } catch (error) {
            await client.query(
              "UPDATE arc_turnkey_agent_wallet_provisioning SET status='create_unknown',last_error_code=$3,updated_at=now() " +
              'WHERE world_id=$1 AND agent_id=$2',
              [worldId, agentId, normalizeProviderCode(error)]
            );
            const recovered = await apiGetSubOrganizations(
              this.api, this.rootOrganizationId, names.subOrganizationName).catch(() => null);
            if (!Array.isArray(recovered) || recovered.length !== 1) {
              throw codedError('TURNKEY_CREATE_OUTCOME_UNKNOWN',
                'Turnkey sub-organization creation outcome is uncertain; retry will only recover, never create a duplicate.');
            }
            organizationId = requireReference(recovered[0], 'sub-organization ID');
          }
          if (!organizationId) {
            organizationId = requireReference(created?.subOrganizationId, 'sub-organization ID');
            creationAddresses = created?.wallet?.addresses;
            walletId = created?.wallet?.walletId || null;
          }
        } else {
          throw codedError('TURNKEY_CREATE_OUTCOME_UNKNOWN',
            'A prior Turnkey create attempt is unresolved; no duplicate sub-organization will be created.');
        }
      }

      if (state.provider_suborganization_id && state.provider_suborganization_id !== organizationId) {
        throw codedError('TURNKEY_SUBORGANIZATION_MISMATCH',
          'Turnkey sub-organization differs from the persisted provisioning reference.');
      }

      const wallets = await apiGetWallets(this.api, organizationId);
      const matchingWallets = wallets.filter((wallet) => wallet?.walletName === names.walletName
        && (!walletId || wallet.walletId === walletId));
      if (matchingWallets.length !== 1) {
        throw codedError('TURNKEY_WALLET_NOT_UNIQUE',
          'Turnkey must return exactly one wallet for the deterministic Agent identity.');
      }
      walletId = requireReference(matchingWallets[0].walletId, 'wallet ID');
      const accounts = await apiGetAccounts(this.api, organizationId, walletId);
      const matchingAccounts = accounts.filter((account) => expectedAccount(account, organizationId, walletId));
      if (matchingAccounts.length !== 1 || accounts.length !== 1) {
        throw codedError('TURNKEY_ACCOUNT_NOT_UNIQUE',
          'Turnkey must return exactly one CURVE_SECP256K1 Ethereum account for the Agent wallet.');
      }
      const account = matchingAccounts[0];
      accountId = requireReference(account.walletAccountId, 'wallet account ID');
      if (Array.isArray(creationAddresses)
          && (creationAddresses.length !== 1 || creationAddresses[0].toLowerCase() !== account.address.toLowerCase())) {
        throw codedError('TURNKEY_ADDRESS_MISMATCH', 'Turnkey creation and account lookup addresses do not match.');
      }
      if (state.provider_wallet_id && state.provider_wallet_id !== walletId) {
        throw codedError('TURNKEY_WALLET_MISMATCH', 'Turnkey wallet differs from the persisted provisioning reference.');
      }
      if (state.provider_key_reference && state.provider_key_reference !== accountId) {
        throw codedError('TURNKEY_ACCOUNT_MISMATCH', 'Turnkey account differs from the persisted provisioning reference.');
      }

      const provenance = {
        source: TURNKEY_PROVISIONING_SOURCE,
        provider: 'turnkey',
        rootOrganizationId: this.rootOrganizationId,
        worldId,
        agentId,
        subOrganizationName: names.subOrganizationName,
        account: { ...TURNKEY_EVM_ACCOUNT },
        verifiedAt: new Date().toISOString()
      };
      await client.query('BEGIN');
      try {
        const conflictingAddress = await client.query(
          'SELECT world_id,agent_id FROM arc_agent_wallets WHERE world_id=$1 AND chain_id=$2 AND lower(address)=lower($3)',
          [worldId, ARC_MAINNET_CHAIN_ID, account.address]
        );
        if (conflictingAddress.rowCount) {
          throw codedError('TURNKEY_ADDRESS_ALREADY_ASSIGNED',
            'Turnkey returned an address already assigned to a wallet in this world.');
        }
        const inserted = await client.query(
          'INSERT INTO arc_agent_wallets(world_id,agent_id,chain_id,address,provider,account_type,status,metadata,' +
          'provider_suborganization_id,provider_wallet_id,provider_key_reference,provisioning_provenance) ' +
          "VALUES($1,$2,$3,$4,'turnkey','eoa','active','{}'::jsonb,$5,$6,$7,$8::jsonb) " +
          'ON CONFLICT(world_id,agent_id,chain_id) DO NOTHING RETURNING id',
          [worldId, agentId, ARC_MAINNET_CHAIN_ID, getAddress(account.address),
            organizationId, walletId, accountId, JSON.stringify(provenance)]
        );
        const stored = await this.#readAgentWallet(client, worldId, agentId);
        if (!stored || stored.provider !== 'turnkey'
            || !rowReferencesMatch(stored, account, organizationId, walletId)) {
          throw codedError('TURNKEY_WALLET_DATABASE_MISMATCH',
            'Turnkey wallet registration conflicts with the verified provider account.');
        }
        await client.query(
          "UPDATE arc_turnkey_agent_wallet_provisioning SET status='provisioned',provider_suborganization_id=$3," +
          'provider_wallet_id=$4,provider_key_reference=$5,address=$6,provenance=$7::jsonb,last_error_code=NULL,updated_at=now() ' +
          'WHERE world_id=$1 AND agent_id=$2',
          [worldId, agentId, organizationId, walletId, accountId, account.address, JSON.stringify(provenance)]
        );
        await client.query('COMMIT');
        return { worldId, agentId, address: getAddress(account.address), subOrganizationId: organizationId,
          walletId, keyReference: accountId, inserted: inserted.rowCount === 1, alreadyProvisioned: false };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } catch (error) {
      if (error?.code && String(error.code).startsWith('TURNKEY_')) throw error;
      const wrapped = codedError('TURNKEY_PROVISIONING_FAILED',
        'Turnkey Agent wallet provisioning failed without storing provider error details.');
      wrapped.causeCode = normalizeProviderCode(error);
      wrapped.constraint = /^[A-Za-z0-9_]{1,120}$/.test(String(error?.constraint || ''))
        ? String(error.constraint) : null;
      throw wrapped;
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lockKey]).catch(() => {});
      client.release();
    }
  }

  async #readAgentWallet(client, worldId, agentId) {
    const result = await client.query(
      'SELECT world_id,agent_id,address,provider,provider_suborganization_id,provider_wallet_id,' +
      'provider_key_reference,status FROM arc_agent_wallets ' +
      'WHERE world_id=$1 AND agent_id=$2 AND chain_id=$3',
      [worldId, agentId, ARC_MAINNET_CHAIN_ID]
    );
    return result.rows[0] || null;
  }

  async #readRegisteredAccount(row) {
    if (row.provider !== 'turnkey' || !row.provider_suborganization_id
        || !row.provider_wallet_id || !row.provider_key_reference) {
      throw codedError('TURNKEY_WALLET_REFERENCE_INCOMPLETE', 'Registered Turnkey wallet references are incomplete.');
    }
    const accounts = await apiGetAccounts(this.api, row.provider_suborganization_id, row.provider_wallet_id);
    const matches = accounts.filter((account) => expectedAccount(account,
      row.provider_suborganization_id, row.provider_wallet_id)
      && account.walletAccountId === row.provider_key_reference);
    if (matches.length !== 1 || accounts.length !== 1
        || matches[0].address.toLowerCase() !== row.address.toLowerCase()) {
      throw codedError('TURNKEY_REGISTERED_ADDRESS_MISMATCH',
        'Turnkey account identity does not match the address registered for this Agent.');
    }
    return matches[0];
  }

  async #verifyRegisteredWallet(row) {
    return this.#readRegisteredAccount(row);
  }

  async getAddressForResident(agentId, worldId = null) {
    assertUuid(agentId, 'agentId');
    if (worldId !== null) assertUuid(worldId, 'worldId');
    const result = await this.pool.query(
      'SELECT world_id,agent_id,address,provider,provider_suborganization_id,provider_wallet_id,' +
      'provider_key_reference,status FROM arc_agent_wallets ' +
      'WHERE agent_id=$1 AND chain_id=$2 AND provider=$3 AND status=$4 ' +
      (worldId ? 'AND world_id=$5 ' : '') + 'ORDER BY world_id LIMIT 2',
      worldId ? [agentId, ARC_MAINNET_CHAIN_ID, 'turnkey', 'active', worldId]
        : [agentId, ARC_MAINNET_CHAIN_ID, 'turnkey', 'active']
    );
    if (result.rowCount !== 1) {
      throw codedError(result.rowCount ? 'TURNKEY_WALLET_WORLD_AMBIGUOUS' : 'TURNKEY_WALLET_NOT_FOUND',
        'Exactly one active Turnkey wallet must match the Agent and world.');
    }
    const account = await this.#readRegisteredAccount(result.rows[0]);
    if (account.address.toLowerCase() !== result.rows[0].address.toLowerCase()) {
      throw codedError('TURNKEY_REGISTERED_ADDRESS_MISMATCH',
        'Turnkey signer address does not match the registered Agent wallet.');
    }
    return getAddress(account.address);
  }

  async signDigest(agentId, digest, worldId = null) {
    if (typeof digest !== 'string' || !/^0x[0-9a-f]{64}$/i.test(digest)) {
      throw codedError('TURNKEY_DIGEST_INVALID', 'Agent signing requires a 32-byte digest.');
    }
    const address = await this.getAddressForResident(agentId, worldId);
    const wallet = await this.#findWalletRow(agentId, worldId);
    const signature = await this.api.signRawPayload({
      organizationId: wallet.provider_suborganization_id,
      signWith: address,
      payload: digest.slice(2),
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NO_OP'
    });
    const r = String(signature?.r || '').replace(/^0x/i, '').padStart(64, '0');
    const s = String(signature?.s || '').replace(/^0x/i, '').padStart(64, '0');
    const vValue = String(signature?.v || '');
    const vNumber = /^0x[0-9a-f]+$/i.test(vValue) ? Number(BigInt(vValue)) : Number(vValue);
    const normalizedV = vNumber === 0 || vNumber === 1 ? vNumber + 27 : vNumber;
    if (!/^[0-9a-f]{64}$/i.test(r) || !/^[0-9a-f]{64}$/i.test(s) || ![27, 28].includes(normalizedV)) {
      throw codedError('TURNKEY_SIGNATURE_INVALID', 'Turnkey returned an invalid ECDSA signature.');
    }
    const serialized = '0x' + r + s + normalizedV.toString(16).padStart(2, '0');
    if (recoverAddress(digest, serialized).toLowerCase() !== address.toLowerCase()) {
      throw codedError('TURNKEY_SIGNATURE_ADDRESS_MISMATCH',
        'Turnkey signature does not recover to the Agent wallet registered in MirrorTerra.');
    }
    return serialized;
  }

  async sendTransaction(agentId, transaction, worldId = null) {
    assertArcWriteAllowed(this.config, { operation: 'Turnkey Agent transaction submission' });
    validateArcTransactionEnvelope(this.config, transaction);
    const address = await this.getAddressForResident(agentId, worldId);
    const wallet = await this.#findWalletRow(agentId, worldId);
    const unsigned = Transaction.from({ ...transaction });
    if (!unsigned.unsignedSerialized || unsigned.from) {
      throw codedError('TURNKEY_TRANSACTION_INVALID', 'Turnkey requires a valid unsigned EVM transaction.');
    }
    const result = await this.api.signTransaction({
      organizationId: wallet.provider_suborganization_id,
      signWith: address,
      unsignedTransaction: unsigned.unsignedSerialized,
      type: 'TRANSACTION_TYPE_ETHEREUM'
    });
    const signed = parseTurnkeySignedTransactionResponse(result, {
      from: address,
      chainId: unsigned.chainId,
      to: unsigned.to,
      data: unsigned.data,
      value: unsigned.value,
      unsignedTransaction: unsigned.unsignedSerialized
    });
    const { JsonRpcProvider } = await import('ethers');
    const rpc = new JsonRpcProvider(this.config.primaryRpcUrl, ARC_MAINNET_CHAIN_ID);
    const response = await rpc.broadcastTransaction(signed.signedTransaction);
    return { hash: response.hash, providerName: 'turnkey' };
  }

  async #findWalletRow(agentId, worldId = null) {
    const result = await this.pool.query(
      'SELECT world_id,agent_id,address,provider,provider_suborganization_id,provider_wallet_id,' +
      'provider_key_reference,status FROM arc_agent_wallets ' +
      'WHERE agent_id=$1 AND chain_id=$2 AND provider=$3 AND status=$4 ' +
      (worldId ? 'AND world_id=$5 ' : '') + 'ORDER BY world_id LIMIT 2',
      worldId ? [agentId, ARC_MAINNET_CHAIN_ID, 'turnkey', 'active', worldId]
        : [agentId, ARC_MAINNET_CHAIN_ID, 'turnkey', 'active']
    );
    if (result.rowCount !== 1) {
      throw codedError(result.rowCount ? 'TURNKEY_WALLET_WORLD_AMBIGUOUS' : 'TURNKEY_WALLET_NOT_FOUND',
        'Exactly one active Turnkey wallet must match the Agent and world.');
    }
    return result.rows[0];
  }
}

export async function createArcSigner({ config, env = process.env, pool, turnkeyApiFactory = null }) {
  const rootOrganizationId = String(env.TURNKEY_ORGANIZATION_ID || '').trim();
  const apiPublicKey = String(env.TURNKEY_API_PUBLIC_KEY || '').trim();
  const apiPrivateKey = String(env.TURNKEY_API_PRIVATE_KEY || '');
  const missing = [
    !rootOrganizationId && 'TURNKEY_ORGANIZATION_ID',
    !apiPublicKey && 'TURNKEY_API_PUBLIC_KEY',
    !apiPrivateKey && 'TURNKEY_API_PRIVATE_KEY'
  ].filter(Boolean);
  if (missing.length) {
    throw codedError('TURNKEY_CREDENTIALS_MISSING',
      'Turnkey signer is not configured; missing secret-injected variable(s): ' + missing.join(', ') + '.');
  }
  if (!pool || typeof pool.connect !== 'function') {
    throw codedError('TURNKEY_DATABASE_REQUIRED', 'A PostgreSQL pool is required for Turnkey wallet attribution.');
  }
  const api = turnkeyApiFactory
    ? await turnkeyApiFactory({ apiBaseUrl: TURNKEY_API_BASE_URL, rootOrganizationId, apiPublicKey, apiPrivateKey })
    : new Turnkey({
      apiBaseUrl: TURNKEY_API_BASE_URL,
      apiPrivateKey,
      apiPublicKey,
      defaultOrganizationId: rootOrganizationId,
      activityPoller: { intervalMs: 1000, numRetries: 60 }
    }).apiClient();
  return new TurnkeyArcSigner({
    config,
    walletProvider: new TurnkeyAgentWalletProvider({
      config, pool, api, rootOrganizationId, rootUserApiPublicKey: apiPublicKey
    })
  });
}

export class TurnkeyArcSigner extends ArcSigner {
  constructor({ config, walletProvider }) {
    super({ config, providerName: 'turnkey' });
    if (!(walletProvider instanceof TurnkeyAgentWalletProvider)) {
      throw new TypeError('TurnkeyArcSigner requires a TurnkeyAgentWalletProvider.');
    }
    this.walletProvider = walletProvider;
  }

  getAddressForResident(agentId, worldId = null) {
    return this.walletProvider.getAddressForResident(agentId, worldId);
  }

  provisionResidentWallet(worldId, agentId) {
    return this.walletProvider.provisionResidentWallet(worldId, agentId);
  }

  signDigest(agentId, digest, worldId = null) {
    return this.walletProvider.signDigest(agentId, digest, worldId);
  }

  sendTransaction(agentId, transaction, worldId = null) {
    assertArcWriteAllowed(this.config, { operation: 'Turnkey Agent transaction submission' });
    return this.walletProvider.sendTransaction(agentId, transaction, worldId);
  }
}
