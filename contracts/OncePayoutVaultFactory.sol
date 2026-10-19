// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {OncePayoutVault} from "./OncePayoutVault.sol";

/**
 * @title OncePayoutVaultFactory
 * @notice Anyone can deploy their own OncePayoutVault. The factory has NO admin
 *         powers and can never touch vault funds.
 */
contract OncePayoutVaultFactory {
    /// @notice The USDC token passed to every vault at deploy time.
    address public immutable usdc;

    /// @notice owner => list of vault addresses they created.
    mapping(address => address[]) private _vaultsOf;

    event VaultCreated(address indexed owner, address indexed vault);

    constructor(address _usdc) {
        usdc = _usdc;
    }

    /**
     * @notice Deploys a new OncePayoutVault owned by msg.sender.
     * @return vault The address of the newly deployed vault.
     */
    function createVault() external returns (address vault) {
        OncePayoutVault v = new OncePayoutVault(usdc, msg.sender);
        vault = address(v);
        _vaultsOf[msg.sender].push(vault);
        emit VaultCreated(msg.sender, vault);
    }

    /**
     * @notice Returns all vaults created by `owner`.
     */
    function getVaults(address owner) external view returns (address[] memory) {
        return _vaultsOf[owner];
    }
}
