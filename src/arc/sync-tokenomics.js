import { readFileSync } from 'node:fs';
import { keccak256, toUtf8Bytes } from 'ethers';
import { ARC_MAINNET_USDC_ADDRESS } from './config.js';

const manifestUrl = new URL('../../config/sync-genesis-tokenomics.json', import.meta.url);
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

export const SYNC_TOKENOMICS_MANIFEST = deepFreeze(JSON.parse(readFileSync(manifestUrl, 'utf8')));
export const SYNC_GENESIS_ISSUER_AGENT_ID = 'f952ef0a-001f-408e-8e5d-684b63f133ac';
export const EXPECTED_TOKENOMICS_MANIFEST_HASH = '0x01f5b27328f71c465660cc59394d72d19c473b3d3b85c4ef60bbed7d23cc7596';
export const TOKENOMICS_MANIFEST_HASH = keccak256(toUtf8Bytes(JSON.stringify(SYNC_TOKENOMICS_MANIFEST)));
export const SYNC_TOTAL_SUPPLY = BigInt(SYNC_TOKENOMICS_MANIFEST.token.totalSupply);
export const SYNC_DECIMALS = Number(SYNC_TOKENOMICS_MANIFEST.token.decimals);
export const SYNC_USDC_ADDRESS = SYNC_TOKENOMICS_MANIFEST.deployment.usdcTokenAddress;
export const SYNC_OPERATING_POOL_GENESIS = BigInt(SYNC_TOKENOMICS_MANIFEST.genesisAllocation.worldOperatingPool);
export const SYNC_GENESIS_RESERVE = BigInt(SYNC_TOKENOMICS_MANIFEST.genesisAllocation.genesisReserve);
export const SYNC_TOTAL_SUPPLY_RAW = SYNC_TOTAL_SUPPLY * (10n ** BigInt(SYNC_DECIMALS));
export const SYNC_OPERATING_POOL_GENESIS_RAW = SYNC_OPERATING_POOL_GENESIS * (10n ** BigInt(SYNC_DECIMALS));
export const SYNC_GENESIS_RESERVE_RAW = SYNC_GENESIS_RESERVE * (10n ** BigInt(SYNC_DECIMALS));

export function validateSyncTokenomicsManifest(manifest = SYNC_TOKENOMICS_MANIFEST) {
  const fail = () => { throw syncTokenomicsError('SYNC_TOKENOMICS_MANIFEST_INVALID'); };
  const canonicalHash = manifest && typeof manifest === 'object'
    ? keccak256(toUtf8Bytes(JSON.stringify(manifest))) : null;
  if (!manifest || manifest.manifest !== 'SYNC_GENESIS_TOKENOMICS' || manifest.version !== 1
      || canonicalHash !== EXPECTED_TOKENOMICS_MANIFEST_HASH
      || manifest.hashAlgorithm !== 'keccak256' || manifest.chainId !== 5042
      || manifest.token?.totalSupply !== '1000000000' || manifest.token?.decimals !== 6
      || manifest.token?.creatorInitialAllocation !== '0' || manifest.token?.genesisAgentInitialAllocation !== '0'
      || manifest.genesisAllocation?.worldOperatingPool !== '10000000'
      || manifest.genesisAllocation?.genesisReserve !== '990000000'
      || !Array.isArray(manifest.genesisAllocation?.agentCreatorDistribution)
      || manifest.genesisAllocation.agentCreatorDistribution.length !== 0
      || manifest.reserveRelease?.epochDurationSeconds !== 2_592_000
      || manifest.reserveRelease?.fixedEpochCap !== '10000000'
      || manifest.reserveRelease?.economyQuotaNumerator !== 70
      || manifest.reserveRelease?.marketQuotaNumerator !== 30
      || manifest.reserveRelease?.unusedQuotaCarriesForward !== false
      || manifest.worldOperatingPool?.refillTriggerBelow !== '2500000'
      || manifest.worldOperatingPool?.target !== '10000000'
      || manifest.worldOperatingPool?.creatorManualPayout !== false
      || manifest.genesisAuction?.firstBatch !== '100000'
      || manifest.genesisAuction?.maximumDurationSeconds !== 604_800
      || manifest.genesisAuction?.halfLifeSeconds !== 43_200
      || manifest.genesisAuction?.startPriceCeilingUsdcPerSync !== '0.01'
      || manifest.genesisAuction?.unsoldSync !== 'remains_in_genesis_reserve'
      || manifest.protocolMarketPool?.curveK !== '10000000'
      || manifest.externalMarketFee?.buyFeeBps !== 50
      || manifest.externalMarketFee?.sellFeeBps !== 50
      || manifest.externalMarketFee?.destination !== 'protocol_market_pool'
      || manifest.externalMarketFee?.mutable !== false
      || manifest.externalMarketFee?.appliesAfterGenesisAuctionOnly !== true
      || manifest.externalMarketFee?.rounding !== 'floor_to_usdc_base_unit'
      || manifest.externalMarketFee?.accounting !== 'separate_pricing_liquidity_and_accumulated_protocol_fees'
      || manifest.protocolMarketPool?.allBuyUsdcRetainedInPool !== true
      || manifest.protocolMarketPool?.inactiveWhenQ0Zero !== true
      || manifest.protocolMarketPool?.sellRestoresGrossQuota !== false
      || manifest.deployment?.upgradeable !== false || manifest.deployment?.proxy !== false
      || manifest.deployment?.postGenesisMint !== false
      || manifest.deployment?.usdcTokenAddress?.toLowerCase() !== ARC_MAINNET_USDC_ADDRESS.toLowerCase()
      || manifest.deployment?.usdcTokenDecimals !== 6) fail();
  const total = BigInt(manifest.token.totalSupply);
  const pool = BigInt(manifest.genesisAllocation.worldOperatingPool);
  const reserve = BigInt(manifest.genesisAllocation.genesisReserve);
  if (pool + reserve !== total
      || pool * (10n ** BigInt(manifest.token.decimals)) !== SYNC_OPERATING_POOL_GENESIS_RAW
      || reserve * (10n ** BigInt(manifest.token.decimals)) !== SYNC_GENESIS_RESERVE_RAW) fail();
  return { valid: true, hash: canonicalHash };
}

validateSyncTokenomicsManifest();

export const SYNC_TOKENOMICS_FIXED_FIELDS = Object.freeze({
  decimals: SYNC_DECIMALS,
  distribution: Object.freeze([]),
  reserveAmount: SYNC_GENESIS_RESERVE.toString(),
  unallocatedSupplyHandling: 'protocol_managed_reserve',
  ownershipModel: 'erc20_holder_owned',
  authorityModel: 'immutable_protocol_rules'
});

const DESCRIPTIVE_FIELDS = Object.freeze(['name', 'symbol', 'meaning', 'purpose', 'rationale']);
const ALLOWED_FIELDS = new Set([...DESCRIPTIVE_FIELDS, ...Object.keys(SYNC_TOKENOMICS_FIXED_FIELDS)]);

function syncTokenomicsError(code) {
  return Object.assign(new Error(code), { code });
}

function text(value, field, maxBytes) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value.trim(), 'utf8') > maxBytes) {
    throw syncTokenomicsError(`SYNC_SPEC_${field.toUpperCase()}_INVALID`);
  }
  return value.trim();
}

export function inspectSyncTokenomicsSpecification(value, { requireIssuer = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw syncTokenomicsError('SYNC_SPEC_OBJECT_REQUIRED');
  const unknown = Object.keys(value).filter((key) => !ALLOWED_FIELDS.has(key));
  if (unknown.length) throw syncTokenomicsError('SYNC_SPEC_UNKNOWN_FIELD');
  const missing = [...ALLOWED_FIELDS].filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw syncTokenomicsError(`SYNC_SPEC_FIELDS_MISSING:${missing.join(',')}`);
  for (const [key, fixed] of Object.entries(SYNC_TOKENOMICS_FIXED_FIELDS)) {
    const actual = value[key];
    if (Array.isArray(fixed) ? !Array.isArray(actual) || actual.length !== 0
      : actual !== fixed) throw syncTokenomicsError(`SYNC_SPEC_FIXED_FIELD_MISMATCH:${key}`);
  }

  const name = text(value.name, 'name', 64);
  const symbol = text(value.symbol, 'symbol', 12);
  if (!/^[A-Za-z0-9._-]{1,12}$/.test(symbol)) throw syncTokenomicsError('SYNC_SPEC_SYMBOL_INVALID');
  const meaning = text(value.meaning, 'meaning', 1000);
  const purpose = text(value.purpose, 'purpose', 1000);
  const rationale = text(value.rationale, 'rationale', 2000);
  const totalSupplyRaw = SYNC_TOTAL_SUPPLY_RAW;
  const operatingPoolRaw = SYNC_OPERATING_POOL_GENESIS_RAW;
  const reserveRaw = SYNC_GENESIS_RESERVE_RAW;
  const distributionRaw = 0n;
  if (operatingPoolRaw + reserveRaw + distributionRaw !== totalSupplyRaw) {
    throw syncTokenomicsError('SYNC_SPEC_GENESIS_SUPPLY_INVARIANT_FAILED');
  }
  const canonicalSpec = {
    schema: 'sync-tokenomics-genesis-spec-v1',
    tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH,
    name,
    symbol,
    meaning,
    purpose,
    rationale,
    decimals: SYNC_DECIMALS,
    distribution: [],
    reserveAmount: SYNC_GENESIS_RESERVE.toString(),
    operatingPoolGenesis: SYNC_OPERATING_POOL_GENESIS.toString(),
    unallocatedSupplyHandling: SYNC_TOKENOMICS_FIXED_FIELDS.unallocatedSupplyHandling,
    ownershipModel: SYNC_TOKENOMICS_FIXED_FIELDS.ownershipModel,
    authorityModel: SYNC_TOKENOMICS_FIXED_FIELDS.authorityModel,
    totalSupply: SYNC_TOTAL_SUPPLY.toString(),
    totalSupplyRaw: totalSupplyRaw.toString(),
    reserveRaw: reserveRaw.toString(),
    operatingPoolRaw: operatingPoolRaw.toString(),
    initialAgentDistributionRaw: distributionRaw.toString()
  };
  return { complete: true, canonicalSpec, specificationHash: keccak256(toUtf8Bytes(JSON.stringify(canonicalSpec))),
    totalSupply: SYNC_TOTAL_SUPPLY, totalSupplyRaw, reserveRaw, operatingPoolRaw,
    tokenomicsManifestHash: TOKENOMICS_MANIFEST_HASH,
    ...(requireIssuer ? { issuerRequired: true } : {}) };
}
