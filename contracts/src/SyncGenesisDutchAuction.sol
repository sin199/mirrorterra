// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ISyncGenesisAuctionPolicy {
    function releaseAuctionSale(address recipient, uint256 amountRaw, bytes32 actionId) external;
    function finalizeGenesisAuction() external;
}

/// @notice Permissionless first-sale auction with a fixed exponential Dutch-price curve.
contract SyncGenesisDutchAuction is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TOKEN_SCALE = 10 ** 6;
    uint256 public constant FIRST_BATCH = 100_000 * TOKEN_SCALE;
    uint256 public constant MAX_DURATION = 7 days;
    uint256 public constant HALF_LIFE = 12 hours;
    uint256 public constant START_PRICE_USDC_PER_SYNC_E18 = 1e16; // 0.01 USDC per SYNC
    uint256 private constant FIXED_ONE = 1e18;
    uint256 private constant PER_SECOND_DECAY_E18 = 999_983_955_055_097_300;

    IERC20 public immutable usdc;
    address public immutable genesisPolicy;
    address public immutable marketPool;
    uint64 public immutable startedAt;
    uint256 public totalSyncSoldRaw;
    uint256 public totalUsdcReceivedRaw;
    bool public finalized;

    error PolicyOnly();
    error AuctionClosed();
    error InvalidPurchase();
    error PriceCeilingExceeded();

    event SyncAuctionPurchase(address indexed buyer, uint256 syncAmountRaw, uint256 usdcAmountRaw,
        uint256 priceUsdcPerSyncE18, bytes32 indexed actionId);
    event SyncAuctionFinalized(uint256 totalSyncSoldRaw, uint256 totalUsdcReceivedRaw, uint256 realizedVwapE18);

    constructor(address usdc_, address genesisPolicy_, address marketPool_) {
        if (usdc_ == address(0) || genesisPolicy_ == address(0) || marketPool_ == address(0)) revert InvalidPurchase();
        usdc = IERC20(usdc_);
        genesisPolicy = genesisPolicy_;
        marketPool = marketPool_;
        startedAt = uint64(block.timestamp);
    }

    function currentPriceUsdcPerSyncE18() public view returns (uint256) {
        uint256 elapsed = block.timestamp > startedAt ? block.timestamp - startedAt : 0;
        if (elapsed > MAX_DURATION) elapsed = MAX_DURATION;
        return Math.mulDiv(START_PRICE_USDC_PER_SYNC_E18, _rpow(PER_SECOND_DECAY_E18, elapsed), FIXED_ONE);
    }

    function buy(uint256 syncAmountRaw, uint256 maximumUsdcRaw, bytes32 actionId) external nonReentrant {
        if (finalized || block.timestamp >= uint256(startedAt) + MAX_DURATION) revert AuctionClosed();
        if (syncAmountRaw == 0 || actionId == bytes32(0)
            || totalSyncSoldRaw + syncAmountRaw > FIRST_BATCH) revert InvalidPurchase();
        uint256 price = currentPriceUsdcPerSyncE18();
        uint256 usdcAmountRaw = Math.mulDiv(syncAmountRaw, price, FIXED_ONE, Math.Rounding.Ceil);
        if (usdcAmountRaw == 0 || usdcAmountRaw > maximumUsdcRaw) revert PriceCeilingExceeded();

        totalSyncSoldRaw += syncAmountRaw;
        totalUsdcReceivedRaw += usdcAmountRaw;
        usdc.safeTransferFrom(msg.sender, marketPool, usdcAmountRaw);
        ISyncGenesisAuctionPolicy(genesisPolicy).releaseAuctionSale(msg.sender, syncAmountRaw, actionId);
        emit SyncAuctionPurchase(msg.sender, syncAmountRaw, usdcAmountRaw, price, actionId);
        if (totalSyncSoldRaw == FIRST_BATCH) _finalize();
    }

    function finalize() external {
        if (finalized || block.timestamp < uint256(startedAt) + MAX_DURATION) revert AuctionClosed();
        _finalize();
    }

    function _finalize() private {
        finalized = true;
        ISyncGenesisAuctionPolicy(genesisPolicy).finalizeGenesisAuction();
        uint256 vwap = totalSyncSoldRaw == 0 ? 0 : Math.mulDiv(totalUsdcReceivedRaw, FIXED_ONE, totalSyncSoldRaw);
        emit SyncAuctionFinalized(totalSyncSoldRaw, totalUsdcReceivedRaw, vwap);
    }

    function _rpow(uint256 x, uint256 n) private pure returns (uint256 z) {
        z = (n & 1) == 1 ? x : FIXED_ONE;
        for (n >>= 1; n != 0; n >>= 1) {
            x = Math.mulDiv(x, x, FIXED_ONE);
            if ((n & 1) == 1) z = Math.mulDiv(z, x, FIXED_ONE);
        }
    }
}
