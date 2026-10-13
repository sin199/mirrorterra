// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice SYNC reserve custody. Only the immutable genesis policy contract can release tokens.
contract SyncGenesisReserve {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable genesisPolicy;

    error PolicyOnly();
    error InvalidRelease();

    event ReserveReleased(address indexed recipient, uint256 amountRaw, bytes32 indexed releaseKind, bytes32 indexed actionId);

    constructor(address token_, address genesisPolicy_) {
        if (token_ == address(0) || genesisPolicy_ == address(0)) revert InvalidRelease();
        token = IERC20(token_);
        genesisPolicy = genesisPolicy_;
    }

    function release(address recipient, uint256 amountRaw, bytes32 releaseKind, bytes32 actionId) external {
        if (msg.sender != genesisPolicy) revert PolicyOnly();
        if (recipient == address(0) || amountRaw == 0 || releaseKind == bytes32(0) || actionId == bytes32(0)) {
            revert InvalidRelease();
        }
        token.safeTransfer(recipient, amountRaw);
        emit ReserveReleased(recipient, amountRaw, releaseKind, actionId);
    }
}
