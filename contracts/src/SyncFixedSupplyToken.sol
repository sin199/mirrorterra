// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fixed-supply SYNC token. The only mint occurs in its constructor.
contract SyncFixedSupplyToken is ERC20 {
    uint8 public constant DECIMALS = 6;
    uint256 public constant GENESIS_SUPPLY = 1_000_000_000 * 10 ** DECIMALS;

    bytes32 public immutable tokenomicsManifestHash;
    address public immutable genesisDeployment;

    error InvalidGenesis();

    constructor(string memory name_, string memory symbol_, address genesisDeployment_, bytes32 manifestHash_)
        ERC20(name_, symbol_)
    {
        if (bytes(name_).length == 0 || bytes(symbol_).length == 0 || genesisDeployment_ == address(0)
            || manifestHash_ == bytes32(0)) revert InvalidGenesis();
        genesisDeployment = genesisDeployment_;
        tokenomicsManifestHash = manifestHash_;
        _mint(genesisDeployment_, GENESIS_SUPPLY);
    }

    function decimals() public pure override returns (uint8) { return DECIMALS; }
}
