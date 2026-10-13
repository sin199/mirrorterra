// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ISyncProtocolMarketPolicy {
    function releaseProtocolMarketSale(uint256 amountRaw, bytes32 actionId) external;
}

/// @notice Immutable linear market curve with permanently retained, non-withdrawable trading fees.
contract SyncProtocolMarketPool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TOKEN_SCALE = 10 ** 6;
    uint256 public constant CURVE_K_RAW = 10_000_000 * TOKEN_SCALE;
    uint256 public constant MAX_TOTAL_SUPPLY_RAW = 1_000_000_000 * TOKEN_SCALE;
    uint256 public constant BUY_FEE_BPS = 50;
    uint256 public constant SELL_FEE_BPS = 50;
    uint256 private constant FEE_BPS_DENOMINATOR = 10_000;
    uint256 private constant FIXED_ONE = 1e18;

    IERC20 public immutable sync;
    IERC20 public immutable usdc;
    address public immutable genesisPolicy;
    bool public marketActive;
    uint256 public initialAuctionQuantityRaw;
    uint256 public initialAuctionVwapE18;
    uint256 public outstandingMarketQuantityRaw;
    uint256 public pricingLiquidityUsdcRaw;
    uint256 public accumulatedBuyFeesUsdcRaw;
    uint256 public accumulatedSellFeesUsdcRaw;

    error PolicyOnly();
    error MarketInactive();
    error InvalidTrade();
    error InsufficientLiquidity();
    error InputExceedsCurveCapacity();

    event ProtocolMarketActivated(uint256 q0Raw, uint256 p0UsdcPerSyncE18);
    event ProtocolMarketBuy(address indexed buyer, uint256 syncAmountRaw, uint256 grossUsdcRaw,
        uint256 netUsdcRaw, uint256 feeUsdcRaw, uint256 quantityBeforeRaw, uint256 quantityAfterRaw,
        bytes32 indexed actionId);
    event ProtocolMarketSell(address indexed seller, uint256 syncAmountRaw, uint256 grossUsdcRaw,
        uint256 netUsdcRaw, uint256 feeUsdcRaw, uint256 quantityBeforeRaw, uint256 quantityAfterRaw,
        bytes32 indexed actionId);

    constructor(address sync_, address usdc_, address genesisPolicy_) {
        if (sync_ == address(0) || usdc_ == address(0) || genesisPolicy_ == address(0)) revert InvalidTrade();
        sync = IERC20(sync_);
        usdc = IERC20(usdc_);
        genesisPolicy = genesisPolicy_;
    }

    function activate(uint256 q0Raw, uint256 p0UsdcPerSyncE18, uint256 auctionUsdcProceedsRaw) external {
        if (msg.sender != genesisPolicy) revert PolicyOnly();
        if (marketActive || q0Raw == 0 || p0UsdcPerSyncE18 == 0 || auctionUsdcProceedsRaw == 0
            || q0Raw > MAX_TOTAL_SUPPLY_RAW || usdc.balanceOf(address(this)) < auctionUsdcProceedsRaw) {
            revert InvalidTrade();
        }
        marketActive = true;
        initialAuctionQuantityRaw = q0Raw;
        initialAuctionVwapE18 = p0UsdcPerSyncE18;
        outstandingMarketQuantityRaw = q0Raw;
        pricingLiquidityUsdcRaw = auctionUsdcProceedsRaw;
        emit ProtocolMarketActivated(q0Raw, p0UsdcPerSyncE18);
    }

    function currentPriceUsdcPerSyncE18() external view returns (bool defined, uint256 priceE18) {
        if (!marketActive) return (false, 0);
        uint256 numerator = CURVE_K_RAW + outstandingMarketQuantityRaw - initialAuctionQuantityRaw;
        return (true, Math.mulDiv(initialAuctionVwapE18, numerator, CURVE_K_RAW));
    }

    /// @notice Spend an exact gross USDC amount; the post-fee net is the curve input.
    function buy(uint256 grossUsdcRaw, uint256 minimumSyncAmountRaw, bytes32 actionId) external nonReentrant {
        if (!marketActive) revert MarketInactive();
        if (grossUsdcRaw == 0 || actionId == bytes32(0)) revert InvalidTrade();
        uint256 feeUsdcRaw = Math.mulDiv(grossUsdcRaw, BUY_FEE_BPS, FEE_BPS_DENOMINATOR);
        uint256 netUsdcRaw = grossUsdcRaw - feeUsdcRaw;
        uint256 beforeQuantity = outstandingMarketQuantityRaw;
        uint256 syncAmountRaw = _maximumSyncForUsdc(beforeQuantity, netUsdcRaw);
        if (syncAmountRaw == 0 || syncAmountRaw < minimumSyncAmountRaw) revert InvalidTrade();
        uint256 afterQuantity = beforeQuantity + syncAmountRaw;

        usdc.safeTransferFrom(msg.sender, address(this), grossUsdcRaw);
        pricingLiquidityUsdcRaw += netUsdcRaw;
        accumulatedBuyFeesUsdcRaw += feeUsdcRaw;
        uint256 inventory = sync.balanceOf(address(this));
        if (inventory < syncAmountRaw) {
            ISyncProtocolMarketPolicy(genesisPolicy).releaseProtocolMarketSale(syncAmountRaw - inventory, actionId);
        }
        outstandingMarketQuantityRaw = afterQuantity;
        sync.safeTransfer(msg.sender, syncAmountRaw);
        emit ProtocolMarketBuy(msg.sender, syncAmountRaw, grossUsdcRaw, netUsdcRaw, feeUsdcRaw,
            beforeQuantity, afterQuantity, actionId);
    }

    function sell(uint256 syncAmountRaw, uint256 minimumUsdcRaw, bytes32 actionId) external nonReentrant {
        if (!marketActive) revert MarketInactive();
        uint256 beforeQuantity = outstandingMarketQuantityRaw;
        if (syncAmountRaw == 0 || syncAmountRaw > beforeQuantity || actionId == bytes32(0)) revert InvalidTrade();
        uint256 afterQuantity = beforeQuantity - syncAmountRaw;
        uint256 grossUsdcRaw = _integratedCost(afterQuantity, beforeQuantity, false);
        if (grossUsdcRaw == 0) revert InvalidTrade();
        uint256 feeUsdcRaw = Math.mulDiv(grossUsdcRaw, SELL_FEE_BPS, FEE_BPS_DENOMINATOR);
        uint256 netUsdcRaw = grossUsdcRaw - feeUsdcRaw;
        if (netUsdcRaw < minimumUsdcRaw) revert InvalidTrade();
        if (pricingLiquidityUsdcRaw < grossUsdcRaw || usdc.balanceOf(address(this)) < netUsdcRaw) {
            revert InsufficientLiquidity();
        }
        outstandingMarketQuantityRaw = afterQuantity;
        pricingLiquidityUsdcRaw -= grossUsdcRaw;
        accumulatedSellFeesUsdcRaw += feeUsdcRaw;
        sync.safeTransferFrom(msg.sender, address(this), syncAmountRaw);
        usdc.safeTransfer(msg.sender, netUsdcRaw);
        emit ProtocolMarketSell(msg.sender, syncAmountRaw, grossUsdcRaw, netUsdcRaw, feeUsdcRaw,
            beforeQuantity, afterQuantity, actionId);
    }

    function _maximumSyncForUsdc(uint256 quantityBeforeRaw, uint256 netUsdcRaw) private view returns (uint256) {
        if (quantityBeforeRaw >= MAX_TOTAL_SUPPLY_RAW || netUsdcRaw == 0) revert InvalidTrade();
        uint256 capacity = MAX_TOTAL_SUPPLY_RAW - quantityBeforeRaw;
        uint256 maximumCost = _integratedCost(quantityBeforeRaw, MAX_TOTAL_SUPPLY_RAW, true);
        if (netUsdcRaw > maximumCost) revert InputExceedsCurveCapacity();

        uint256 low;
        uint256 high = capacity;
        while (low < high) {
            uint256 midpoint = low + (high - low + 1) / 2;
            uint256 cost = _integratedCost(quantityBeforeRaw, quantityBeforeRaw + midpoint, true);
            if (cost <= netUsdcRaw) low = midpoint;
            else high = midpoint - 1;
        }
        return low;
    }

    /// @dev Integrates P(q) from q1 through q2, rounding buy cost up and sell proceeds down to USDC base units.
    function _integratedCost(uint256 q1, uint256 q2, bool roundUp) private view returns (uint256) {
        if (q2 <= q1 || q1 > uint256(type(int256).max) || q2 > uint256(type(int256).max)) revert InvalidTrade();
        int256 offset = int256(q1) + int256(q2) - 2 * int256(initialAuctionQuantityRaw);
        int256 factorNumeratorSigned = int256(2 * CURVE_K_RAW) + offset;
        if (factorNumeratorSigned <= 0) revert InvalidTrade();
        uint256 areaNumerator = (q2 - q1) * uint256(factorNumeratorSigned);
        uint256 denominator = FIXED_ONE * 2 * CURVE_K_RAW;
        return roundUp ? Math.mulDiv(initialAuctionVwapE18, areaNumerator, denominator, Math.Rounding.Ceil)
        : Math.mulDiv(initialAuctionVwapE18, areaNumerator, denominator);
    }
}
