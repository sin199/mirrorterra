// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SyncFixedSupplyToken} from "./SyncFixedSupplyToken.sol";
import {SyncGenesisReserve} from "./SyncGenesisReserve.sol";
import {SyncWorldOperatingPool} from "./SyncWorldOperatingPool.sol";
import {SyncGenesisDutchAuction} from "./SyncGenesisDutchAuction.sol";
import {SyncProtocolMarketPool} from "./SyncProtocolMarketPool.sol";

/// @notice Immutable policy root deploying and wiring the SYNC tokenomics v1 contracts atomically.
contract SyncTokenomicsGenesis {
    using SafeERC20 for IERC20;

    uint256 public constant ARC_MAINNET_CHAIN_ID = 5042;
    address public constant ARC_MAINNET_USDC = 0x3600000000000000000000000000000000000000;
    uint256 public constant EPOCH_DURATION = 30 days;
    uint256 public constant MAX_EPOCH_RELEASE_RAW = 10_000_000 * 10 ** 6;
    uint256 public constant INITIAL_OPERATING_POOL_RAW = 10_000_000 * 10 ** 6;
    uint256 public constant INITIAL_RESERVE_RAW = 990_000_000 * 10 ** 6;
    uint256 public constant MANIFEST_HASH_VERSION = 1;
    bytes32 public constant TOKENOMICS_MANIFEST_HASH = 0x01f5b27328f71c465660cc59394d72d19c473b3d3b85c4ef60bbed7d23cc7596;

    bytes32 private constant RELEASE_ECONOMY = keccak256("SYNC_ECONOMY_REFILL_V1");
    bytes32 private constant RELEASE_AUCTION = keccak256("SYNC_GENESIS_AUCTION_V1");
    bytes32 private constant RELEASE_MARKET = keccak256("SYNC_PROTOCOL_MARKET_V1");
    uint256 private constant GENESIS_ALLOCATION = INITIAL_OPERATING_POOL_RAW + INITIAL_RESERVE_RAW;
    uint256 private constant GENESIS_SUPPLY_RAW = 1_000_000_000 * 10 ** 6;

    address public immutable issuerWallet;
    uint256 public immutable issuerIdentityId;
    bytes16 public immutable worldId;
    bytes32 public immutable specificationHash;
    uint64 public immutable deploymentTimestamp;
    SyncFixedSupplyToken public immutable token;
    SyncGenesisReserve public immutable reserve;
    SyncWorldOperatingPool public immutable operatingPool;
    SyncGenesisDutchAuction public immutable genesisAuction;
    SyncProtocolMarketPool public immutable protocolMarketPool;

    uint64 public epochIndex;
    uint64 public epochStart;
    uint256 public reserveBalanceAtEpochStart;
    uint256 public epochReleaseCap;
    uint256 public economyQuota;
    uint256 public marketQuota;
    uint256 public economyReleased;
    uint256 public marketReleased;
    bool public genesisAuctionFinalized;

    error ArcMainnetOnly();
    error IssuerMismatch();
    error InvalidGenesis();
    error AuctionOnly();
    error MarketOnly();
    error EpochQuotaExceeded();

    event SyncGenesisDeployed(bytes16 indexed worldId, address indexed issuerWallet, uint256 issuerIdentityId,
        bytes32 indexed specificationHash, bytes32 manifestHash, address token, address reserve,
        address operatingPool, address genesisAuction, address protocolMarketPool, uint64 deploymentTimestamp);
    event MonetaryEpochStarted(uint64 indexed epochIndex, uint64 epochStart, uint256 reserveBalanceAtStart,
        uint256 releaseCap, uint256 economyQuota, uint256 marketQuota);
    event OperatingPoolRefilled(uint64 indexed epochIndex, uint256 amountRaw, uint256 resultingBalanceRaw);

    constructor(bytes16 worldId_, uint256 issuerIdentityId_, address issuerWallet_,
        address settlementWorker_, string memory name_, string memory symbol_, bytes32 specificationHash_)
    {
        if (block.chainid != ARC_MAINNET_CHAIN_ID) revert ArcMainnetOnly();
        if (worldId_ == bytes16(0) || issuerIdentityId_ == 0 || issuerWallet_ == address(0)
            || msg.sender != issuerWallet_ || settlementWorker_ == address(0)
            || bytes(name_).length == 0 || bytes(symbol_).length == 0 || specificationHash_ == bytes32(0)) {
            revert InvalidGenesis();
        }
        if (GENESIS_ALLOCATION != GENESIS_SUPPLY_RAW) revert InvalidGenesis();
        issuerWallet = issuerWallet_;
        issuerIdentityId = issuerIdentityId_;
        worldId = worldId_;
        specificationHash = specificationHash_;
        deploymentTimestamp = uint64(block.timestamp);

        SyncFixedSupplyToken newToken = new SyncFixedSupplyToken(name_, symbol_, address(this), TOKENOMICS_MANIFEST_HASH);
        token = newToken;
        SyncGenesisReserve newReserve = new SyncGenesisReserve(address(newToken), address(this));
        reserve = newReserve;
        SyncWorldOperatingPool newPool = new SyncWorldOperatingPool(address(newToken), address(this), settlementWorker_);
        operatingPool = newPool;
        SyncProtocolMarketPool newMarket = new SyncProtocolMarketPool(address(newToken), ARC_MAINNET_USDC, address(this));
        protocolMarketPool = newMarket;
        SyncGenesisDutchAuction newAuction = new SyncGenesisDutchAuction(ARC_MAINNET_USDC, address(this), address(newMarket));
        genesisAuction = newAuction;

        IERC20(address(newToken)).safeTransfer(address(newPool), INITIAL_OPERATING_POOL_RAW);
        IERC20(address(newToken)).safeTransfer(address(newReserve), INITIAL_RESERVE_RAW);
        _startEpoch(0);
        emit SyncGenesisDeployed(worldId_, issuerWallet_, issuerIdentityId_, specificationHash_, TOKENOMICS_MANIFEST_HASH,
            address(newToken), address(newReserve), address(newPool), address(newAuction), address(newMarket), deploymentTimestamp);
    }

    function refillOperatingPool() external returns (uint256 amountRaw) {
        _syncEpoch();
        uint256 balance = token.balanceOf(address(operatingPool));
        if (balance >= operatingPool.REFILL_TRIGGER()) return 0;
        uint256 targetGap = operatingPool.TARGET() - balance;
        uint256 remainingEconomy = economyQuota > economyReleased ? economyQuota - economyReleased : 0;
        uint256 reserveBalance = token.balanceOf(address(reserve));
        amountRaw = _min(targetGap, _min(remainingEconomy, reserveBalance));
        if (amountRaw == 0) return 0;
        economyReleased += amountRaw;
        reserve.release(address(operatingPool), amountRaw, RELEASE_ECONOMY,
            keccak256(abi.encodePacked("sync-pool-refill", epochIndex, economyReleased)));
        emit OperatingPoolRefilled(epochIndex, amountRaw, balance + amountRaw);
    }

    function releaseAuctionSale(address recipient, uint256 amountRaw, bytes32 actionId) external {
        if (msg.sender != address(genesisAuction)) revert AuctionOnly();
        _consumeMarketQuota(recipient, amountRaw, RELEASE_AUCTION, actionId);
    }

    function finalizeGenesisAuction() external {
        if (msg.sender != address(genesisAuction)) revert AuctionOnly();
        if (genesisAuctionFinalized) return;
        genesisAuctionFinalized = true;
        uint256 sold = genesisAuction.totalSyncSoldRaw();
        if (sold == 0) return;
        uint256 vwapE18 = Math.mulDiv(genesisAuction.totalUsdcReceivedRaw(), 1e18, sold);
        protocolMarketPool.activate(sold, vwapE18, genesisAuction.totalUsdcReceivedRaw());
    }

    function releaseProtocolMarketSale(uint256 amountRaw, bytes32 actionId) external {
        if (msg.sender != address(protocolMarketPool)) revert MarketOnly();
        _consumeMarketQuota(address(protocolMarketPool), amountRaw, RELEASE_MARKET, actionId);
    }

    function _consumeMarketQuota(address recipient, uint256 amountRaw, bytes32 releaseKind, bytes32 actionId) private {
        _syncEpoch();
        uint256 remaining = marketQuota > marketReleased ? marketQuota - marketReleased : 0;
        if (amountRaw == 0 || amountRaw > remaining || amountRaw > token.balanceOf(address(reserve))) {
            revert EpochQuotaExceeded();
        }
        marketReleased += amountRaw;
        reserve.release(recipient, amountRaw, releaseKind, actionId);
    }

    function _syncEpoch() private {
        uint256 elapsed = block.timestamp - deploymentTimestamp;
        uint64 current = uint64(elapsed / EPOCH_DURATION);
        if (current <= epochIndex) return;
        _startEpoch(current);
    }

    function _startEpoch(uint64 nextIndex) private {
        epochIndex = nextIndex;
        epochStart = uint64(uint256(deploymentTimestamp) + uint256(nextIndex) * EPOCH_DURATION);
        reserveBalanceAtEpochStart = token.balanceOf(address(reserve));
        uint256 cap = Math.mulDiv(reserveBalanceAtEpochStart, 1, 100);
        epochReleaseCap = _min(MAX_EPOCH_RELEASE_RAW, cap);
        economyQuota = Math.mulDiv(epochReleaseCap, 70, 100);
        marketQuota = epochReleaseCap - economyQuota;
        economyReleased = 0;
        marketReleased = 0;
        emit MonetaryEpochStarted(epochIndex, epochStart, reserveBalanceAtEpochStart, epochReleaseCap, economyQuota, marketQuota);
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) { return a < b ? a : b; }
}
