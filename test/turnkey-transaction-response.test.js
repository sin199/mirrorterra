import test from 'node:test';
import assert from 'node:assert/strict';
import { Transaction, Wallet } from 'ethers';
import { parseTurnkeySignedTransactionResponse } from '../src/arc/turnkey-wallet-provider.js';

const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const REGISTER_CALLDATA = '0x1aa3a008';
const CHAIN_ID = 5042;

async function sdkResponseFixture() {
  const wallet = Wallet.createRandom();
  const request = {
    type: 2,
    chainId: CHAIN_ID,
    nonce: 7,
    maxPriorityFeePerGas: 1_000_000n,
    maxFeePerGas: 50_000_000n,
    gasLimit: 108899n,
    to: IDENTITY_REGISTRY,
    data: REGISTER_CALLDATA,
    value: 0n
  };
  const unsigned = Transaction.from(request);
  const signedTransaction = (await wallet.signTransaction(request)).slice(2);
  const activity = {
    id: 'synthetic-sign-activity',
    organizationId: 'synthetic-suborganization',
    status: 'ACTIVITY_STATUS_COMPLETED',
    type: 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2',
    intent: {},
    result: { signTransactionResult: { signedTransaction } },
    votes: [],
    fingerprint: 'synthetic-fingerprint',
    canApprove: false,
    canReject: false,
    createdAt: { seconds: '1', nanos: '0' },
    updatedAt: { seconds: '1', nanos: '0' }
  };
  return {
    wallet,
    unsigned,
    response: { signedTransaction, activity },
    expected: {
      from: wallet.address,
      chainId: CHAIN_ID,
      to: IDENTITY_REGISTRY,
      data: REGISTER_CALLDATA,
      value: 0n,
      unsignedTransaction: unsigned.unsignedSerialized
    }
  };
}

test('parses the SDK 8.6.0 response shape with a no-0x signed transaction', async () => {
  const fixture = await sdkResponseFixture();
  assert.equal(fixture.response.signedTransaction.startsWith('0x'), false);
  assert.equal(fixture.response.activity.result.signTransactionResult.signedTransaction,
    fixture.response.signedTransaction);

  const parsed = parseTurnkeySignedTransactionResponse(fixture.response, fixture.expected);
  assert.equal(parsed.signedTransaction, '0x' + fixture.response.signedTransaction.toLowerCase());
  assert.equal(parsed.transaction.from, fixture.wallet.address);
  assert.equal(parsed.transaction.chainId, BigInt(CHAIN_ID));
  assert.equal(parsed.transaction.to.toLowerCase(), IDENTITY_REGISTRY.toLowerCase());
  assert.equal(parsed.transaction.data, REGISTER_CALLDATA);
  assert.equal(parsed.transaction.value, 0n);
  assert.equal(parsed.hash, parsed.transaction.hash);
});

test('fails closed unless the SDK activity completed as a transaction-signing activity', async () => {
  const fixture = await sdkResponseFixture();
  assert.throws(() => parseTurnkeySignedTransactionResponse({
    ...fixture.response,
    activity: { ...fixture.response.activity, status: 'ACTIVITY_STATUS_PENDING' }
  }, fixture.expected), { code: 'TURNKEY_SIGNED_TRANSACTION_ACTIVITY_INVALID' });
  assert.throws(() => parseTurnkeySignedTransactionResponse({
    ...fixture.response,
    activity: { ...fixture.response.activity, type: 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' }
  }, fixture.expected), { code: 'TURNKEY_SIGNED_TRANSACTION_ACTIVITY_INVALID' });
});

test('fails closed when the top-level and nested signed payloads differ or are malformed', async () => {
  const fixture = await sdkResponseFixture();
  assert.throws(() => parseTurnkeySignedTransactionResponse({
    ...fixture.response,
    signedTransaction: fixture.response.signedTransaction.slice(0, -2) + '00'
  }, fixture.expected), { code: 'TURNKEY_SIGNED_TRANSACTION_MISMATCH' });
  assert.throws(() => parseTurnkeySignedTransactionResponse({
    ...fixture.response,
    signedTransaction: 'not-serialized-hex',
    activity: {
      ...fixture.response.activity,
      result: { signTransactionResult: { signedTransaction: 'not-serialized-hex' } }
    }
  }, fixture.expected), { code: 'TURNKEY_SIGNED_TRANSACTION_INVALID' });
});

test('fails closed when the signer or expected transaction envelope differs', async () => {
  const fixture = await sdkResponseFixture();
  assert.throws(() => parseTurnkeySignedTransactionResponse(fixture.response, {
    ...fixture.expected,
    from: Wallet.createRandom().address
  }), { code: 'TURNKEY_SIGNED_TRANSACTION_MISMATCH' });
  assert.throws(() => parseTurnkeySignedTransactionResponse(fixture.response, {
    ...fixture.expected,
    data: '0xdeadbeef'
  }), { code: 'TURNKEY_TRANSACTION_ENVELOPE_MISMATCH' });
  assert.throws(() => parseTurnkeySignedTransactionResponse(fixture.response, {
    ...fixture.expected,
    value: 1n
  }), { code: 'TURNKEY_TRANSACTION_ENVELOPE_INVALID' });
});
