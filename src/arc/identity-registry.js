import { getAddress, Interface } from 'ethers';
import { assertArcChainId } from './config.js';

const IDENTITY_REGISTRY_INTERFACE = new Interface([
  'function ownerOf(uint256 tokenId) view returns (address)'
]);
const UINT256_MAX = (1n << 256n) - 1n;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

function notReady(reason) {
  return { ready: false, code: 'TOKEN_ISSUER_IDENTITY_NOT_READY', reason };
}

export function parsePositiveIdentityId(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (!/^[1-9]\d*$/.test(text)) return null;
  try {
    const id = BigInt(text);
    return id <= UINT256_MAX ? id : null;
  } catch { return null; }
}

export async function verifyArc8004IdentityOwner({ rpc, config, identityId, issuerWallet }) {
  const id = parsePositiveIdentityId(identityId);
  if (id === null) return notReady('identity_id_invalid');
  if (!rpc || typeof rpc.getChainId !== 'function' || typeof rpc.getCode !== 'function'
      || typeof rpc.call !== 'function') return notReady('rpc_unavailable');

  const configuredRegistry = config?.erc8004?.identity;
  if (typeof configuredRegistry !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(configuredRegistry)
      || /^0x0{40}$/i.test(configuredRegistry)) return notReady('identity_registry_not_configured');

  let registryAddress;
  let normalizedIssuerWallet;
  try {
    registryAddress = getAddress(configuredRegistry);
    normalizedIssuerWallet = getAddress(issuerWallet);
  } catch { return notReady('identity_registry_or_issuer_wallet_invalid'); }

  try {
    assertArcChainId(await rpc.getChainId(), config);
    const code = await rpc.getCode(registryAddress, 'latest');
    if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) {
      return notReady('identity_registry_code_missing');
    }
    const data = IDENTITY_REGISTRY_INTERFACE.encodeFunctionData('ownerOf', [id]);
    const response = await rpc.call({ to: registryAddress, data }, 'latest');
    const [ownerValue] = IDENTITY_REGISTRY_INTERFACE.decodeFunctionResult('ownerOf', response);
    const owner = getAddress(ownerValue);
    if (owner.toLowerCase() === ZERO_ADDRESS) return notReady('identity_not_found');
    if (owner.toLowerCase() !== normalizedIssuerWallet.toLowerCase()) {
      return notReady('identity_owner_mismatch');
    }
    return { ready: true, identityId: id.toString(), registryAddress, owner };
  } catch { return notReady('identity_registry_read_failed'); }
}
