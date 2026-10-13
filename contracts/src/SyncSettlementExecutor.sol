// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SyncWorldOperatingPool} from "./SyncWorldOperatingPool.sol";

/// @notice Executes ledger-authorized SYNC payouts from one immutable Operating Pool only.
/// @dev The signer attests committed off-chain double-entry ledger actions. No arbitrary calls,
///      reserve releases, approvals, withdrawals, setters or administrative roles exist.
contract SyncSettlementExecutor is EIP712, ReentrancyGuard {
    bytes32 public constant PAYOUT_TYPEHASH = keccak256("Payout(bytes32 payoutId,address recipient,uint256 amount,address asset)");
    address public immutable ledgerSigner;
    address public immutable asset;
    SyncWorldOperatingPool public immutable operatingPool;
    mapping(bytes32 payoutId => bool executed) public executedPayouts;

    error InvalidBinding();
    error InvalidAuthorization();
    error PayoutAlreadyExecuted();

    event LedgerPayoutExecuted(bytes32 indexed payoutId, address indexed recipient, uint256 amount, address asset);

    constructor(address signer_, address asset_, address operatingPool_) EIP712("MirrorTerra SYNC Settlement", "1") {
        if (signer_ == address(0) || asset_ == address(0) || operatingPool_ == address(0)
            || address(SyncWorldOperatingPool(operatingPool_).token()) != asset_
            || SyncWorldOperatingPool(operatingPool_).settlementWorker() != address(this)) revert InvalidBinding();
        ledgerSigner = signer_;
        asset = asset_;
        operatingPool = SyncWorldOperatingPool(operatingPool_);
    }

    function payoutDigest(bytes32 payoutId, address recipient, uint256 amount, address asset_) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(PAYOUT_TYPEHASH, payoutId, recipient, amount, asset_)));
    }

    function executePayout(bytes32 payoutId, address recipient, uint256 amount, address asset_, bytes calldata authorization)
        external nonReentrant
    {
        if (payoutId == bytes32(0) || recipient == address(0) || amount == 0 || asset_ != asset) revert InvalidAuthorization();
        if (executedPayouts[payoutId]) revert PayoutAlreadyExecuted();
        if (ECDSA.recover(payoutDigest(payoutId, recipient, amount, asset_), authorization) != ledgerSigner) revert InvalidAuthorization();
        executedPayouts[payoutId] = true;
        operatingPool.executeCommittedPayout(payoutId, recipient, amount);
        emit LedgerPayoutExecuted(payoutId, recipient, amount, asset_);
    }
}
