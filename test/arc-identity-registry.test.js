import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { arcNetworkConfig, ARC_MAINNET_CHAIN_ID } from '../src/arc/config.js';
import { parsePositiveIdentityId, verifyArc8004IdentityOwner } from '../src/arc/identity-registry.js';

const registry = arcNetworkConfig().erc8004.identity;
const owner = '0x29Fef6FE7d56b929Afe613C0358B81c054652d42';
const otherOwner = '0x1111111111111111111111111111111111111111';
const identityInterface = new Interface(['function ownerOf(uint256 tokenId) view returns (address)']);

function fakeRpc({ ownerAddress = owner, code = '0x6000', chainId = ARC_MAINNET_CHAIN_ID,
  callError = null, response = null } = {}) {
  const calls = [];
  return { calls,
    async getChainId() { return chainId; },
    async getCode(address, blockTag) { calls.push({ method: 'getCode', address, blockTag }); return code; },
    async call(transaction, blockTag) {
      calls.push({ method: 'call', transaction, blockTag });
      if (callError) throw callError;
      return response ?? identityInterface.encodeFunctionResult('ownerOf', [ownerAddress]);
    }
  };
}

test('positive ERC-8004 identity owner must match the active issuer wallet', async () => {
  const rpc = fakeRpc();
  const result = await verifyArc8004IdentityOwner({ rpc, config: arcNetworkConfig(), identityId: '818', issuerWallet: owner });
  assert.equal(result.ready, true);
  assert.equal(result.identityId, '818');
  assert.equal(result.owner, owner);
  assert.equal(result.registryAddress, registry);
  assert.equal(rpc.calls[0].address, registry);
  assert.equal(rpc.calls[1].transaction.to, registry);
  assert.equal(rpc.calls[1].transaction.data.slice(0, 10), identityInterface.getFunction('ownerOf').selector);
});

test('missing, malformed, nonexistent, mismatched, and unreadable identity fail closed', async (t) => {
  const invalidIds = [null, undefined, '', '0', '-1', '01', 'not-an-id', ((1n << 256n)).toString()];
  for (const identityId of invalidIds) {
    const result = await verifyArc8004IdentityOwner({ rpc: fakeRpc(), config: arcNetworkConfig(), identityId,
      issuerWallet: owner });
    assert.equal(result.ready, false, `identity ${String(identityId)} must not pass`);
    assert.equal(result.code, 'TOKEN_ISSUER_IDENTITY_NOT_READY');
  }

  const noRegistry = await verifyArc8004IdentityOwner({ rpc: fakeRpc(), config: { ...arcNetworkConfig(), erc8004: {} },
    identityId: '818', issuerWallet: owner });
  assert.equal(noRegistry.ready, false);
  assert.equal(noRegistry.reason, 'identity_registry_not_configured');

  const noCode = await verifyArc8004IdentityOwner({ rpc: fakeRpc({ code: '0x' }), config: arcNetworkConfig(),
    identityId: '818', issuerWallet: owner });
  assert.equal(noCode.ready, false);
  assert.equal(noCode.reason, 'identity_registry_code_missing');

  const nonexistent = await verifyArc8004IdentityOwner({ rpc: fakeRpc({ ownerAddress: '0x0000000000000000000000000000000000000000' }),
    config: arcNetworkConfig(), identityId: '818', issuerWallet: owner });
  assert.equal(nonexistent.ready, false);
  assert.equal(nonexistent.reason, 'identity_not_found');

  const mismatch = await verifyArc8004IdentityOwner({ rpc: fakeRpc({ ownerAddress: otherOwner }),
    config: arcNetworkConfig(), identityId: '818', issuerWallet: owner });
  assert.equal(mismatch.ready, false);
  assert.equal(mismatch.reason, 'identity_owner_mismatch');

  const rpcFailure = await verifyArc8004IdentityOwner({ rpc: fakeRpc({ callError: new Error('private RPC detail') }),
    config: arcNetworkConfig(), identityId: '818', issuerWallet: owner });
  assert.equal(rpcFailure.ready, false);
  assert.equal(rpcFailure.code, 'TOKEN_ISSUER_IDENTITY_NOT_READY');
  assert.notEqual(rpcFailure.reason, 'private RPC detail');

  const wrongChain = await verifyArc8004IdentityOwner({ rpc: fakeRpc({ chainId: 1 }),
    config: arcNetworkConfig(), identityId: '818', issuerWallet: owner });
  assert.equal(wrongChain.ready, false);
  assert.equal(wrongChain.code, 'TOKEN_ISSUER_IDENTITY_NOT_READY');
});

test('identity ID parser accepts only positive canonical uint256 decimal strings', () => {
  assert.equal(parsePositiveIdentityId('1'), 1n);
  assert.equal(parsePositiveIdentityId('818'), 818n);
  assert.equal(parsePositiveIdentityId('0'), null);
  assert.equal(parsePositiveIdentityId('01'), null);
  assert.equal(parsePositiveIdentityId('1e3'), null);
});
