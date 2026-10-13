// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice SYNC operating liquidity. Payout execution is restricted to the immutable ledger worker.
contract SyncWorldOperatingPool {
    using SafeERC20 for IERC20;

    uint256 public constant TARGET = 10_000_000 * 10 ** 6;
    uint256 public constant REFILL_TRIGGER = 2_500_000 * 10 ** 6;
    IERC20 public immutable token;
    address public immutable genesisPolicy;
    address public immutable settlementWorker;
    mapping(bytes32 actionId => bool executed) public executedPayouts;

    error WorkerOnly();
    error InvalidPayout();
    error PayoutAlreadyExecuted();

    event OperatingPoolPayout(bytes32 indexed actionId, address indexed recipient, uint256 amountRaw);

    constructor(address token_, address genesisPolicy_, address settlementWorker_) {
        if (token_ == address(0) || genesisPolicy_ == address(0) || settlementWorker_ == address(0)) {
            revert InvalidPayout();
        }
        token = IERC20(token_);
        genesisPolicy = genesisPolicy_;
        settlementWorker = settlementWorker_;
    }

    function executeCommittedPayout(bytes32 actionId, address recipient, uint256 amountRaw) external {
        if (msg.sender != settlementWorker) revert WorkerOnly();
        if (actionId == bytes32(0) || recipient == address(0) || amountRaw == 0) revert InvalidPayout();
        if (executedPayouts[actionId]) revert PayoutAlreadyExecuted();
        executedPayouts[actionId] = true;
        token.safeTransfer(recipient, amountRaw);
        emit OperatingPoolPayout(actionId, recipient, amountRaw);
    }
}
