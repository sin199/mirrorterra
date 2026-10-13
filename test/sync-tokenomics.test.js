import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectSyncTokenomicsSpecification, SYNC_GENESIS_RESERVE, SYNC_OPERATING_POOL_GENESIS,
  SYNC_TOTAL_SUPPLY, SYNC_TOTAL_SUPPLY_RAW, SYNC_TOKENOMICS_FIXED_FIELDS, SYNC_TOKENOMICS_MANIFEST,
  TOKENOMICS_MANIFEST_HASH, validateSyncTokenomicsManifest } from '../src/arc/sync-tokenomics.js';

const VALID_SPECIFICATION = {
  name: 'A synthetic currency',
  symbol: 'SYN',
  meaning: 'A test-only unit.',
  purpose: 'Validate the fixed Tokenomics v1.0 contract.',
  rationale: 'A synthetic rationale for a local parser test.',
  decimals: SYNC_TOKENOMICS_FIXED_FIELDS.decimals,
  distribution: [],
  reserveAmount: SYNC_GENESIS_RESERVE.toString(),
  unallocatedSupplyHandling: SYNC_TOKENOMICS_FIXED_FIELDS.unallocatedSupplyHandling,
  ownershipModel: SYNC_TOKENOMICS_FIXED_FIELDS.ownershipModel,
  authorityModel: SYNC_TOKENOMICS_FIXED_FIELDS.authorityModel
};

test('SYNC Tokenomics v1.0 manifest hash and genesis allocation are fixed', () => {
  const result = validateSyncTokenomicsManifest();
  assert.equal(result.valid, true);
  assert.equal(result.hash, TOKENOMICS_MANIFEST_HASH);
  assert.equal(result.hash, '0x01f5b27328f71c465660cc59394d72d19c473b3d3b85c4ef60bbed7d23cc7596');
  assert.equal(SYNC_TOTAL_SUPPLY, 1_000_000_000n);
  assert.equal(SYNC_TOTAL_SUPPLY_RAW, 1_000_000_000_000_000n);
  assert.equal(SYNC_OPERATING_POOL_GENESIS + SYNC_GENESIS_RESERVE, SYNC_TOTAL_SUPPLY);
  assert.equal(SYNC_TOKENOMICS_FIXED_FIELDS.decimals, 6);
  assert.deepEqual(SYNC_TOKENOMICS_FIXED_FIELDS.distribution, []);
});

test('manifest binds immutable post-auction 0.5 percent market fees to the pool', () => {
  assert.equal(validateSyncTokenomicsManifest().valid, true);
  const fee = SYNC_TOKENOMICS_MANIFEST.externalMarketFee;
  assert.deepEqual(fee, {
    buyFeeBps: 50,
    sellFeeBps: 50,
    destination: 'protocol_market_pool',
    mutable: false,
    appliesAfterGenesisAuctionOnly: true,
    rounding: 'floor_to_usdc_base_unit',
    accounting: 'separate_pricing_liquidity_and_accumulated_protocol_fees'
  });
});

test('SYNC specification accepts exactly the 11 canonical fields with zero initial distribution', () => {
  const result = inspectSyncTokenomicsSpecification(VALID_SPECIFICATION);
  assert.equal(result.complete, true);
  assert.equal(result.totalSupplyRaw, 1_000_000_000_000_000n);
  assert.equal(result.operatingPoolRaw + result.reserveRaw + 0n, result.totalSupplyRaw);
  assert.equal(result.canonicalSpec.tokenomicsManifestHash, TOKENOMICS_MANIFEST_HASH);
  assert.equal(result.canonicalSpec.operatingPoolGenesis, '10000000');
  assert.deepEqual(result.canonicalSpec.distribution, []);
  assert.match(result.specificationHash, /^0x[0-9a-f]{64}$/);
});

test('SYNC specification rejects changes to fixed monetary fields and unknown supply aliases', () => {
  for (const [field, value] of [
    ['decimals', 18],
    ['distribution', [{ recipientType: 'agent', recipientId: 'a', recipientAddress: '0x1111111111111111111111111111111111111111', amount: '1' }]],
    ['reserveAmount', '989999999'],
    ['authorityModel', 'issuer_controlled_reserve']
  ]) {
    assert.throws(() => inspectSyncTokenomicsSpecification({ ...VALID_SPECIFICATION, [field]: value }),
      (error) => error.code === `SYNC_SPEC_FIXED_FIELD_MISMATCH:${field}`);
  }
  assert.throws(() => inspectSyncTokenomicsSpecification({ ...VALID_SPECIFICATION, initialSupply: '1000000000' }),
    (error) => error.code === 'SYNC_SPEC_UNKNOWN_FIELD');
});
