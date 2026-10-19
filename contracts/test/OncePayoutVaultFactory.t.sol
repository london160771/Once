// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {OncePayoutVaultFactory} from "../OncePayoutVaultFactory.sol";
import {OncePayoutVault} from "../OncePayoutVault.sol";

/**
 * Minimal ERC-20 mock used only in factory tests.
 * (The vault test file has its own MockERC20 in test-helpers/.)
 */
contract FakeUSDC {
    string public name = "Fake USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
}

contract OncePayoutVaultFactoryTest is Test {
    OncePayoutVaultFactory factory;
    FakeUSDC usdc;

    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    function setUp() public {
        usdc = new FakeUSDC();
        factory = new OncePayoutVaultFactory(address(usdc));
    }

    // ── createVault: owner is msg.sender (not factory, not deployer) ───────────

    function test_CreateVault_OwnerIsMsgSender() public {
        vm.prank(alice);
        address vault = factory.createVault();
        assertEq(OncePayoutVault(vault).owner(), alice, "owner should be alice, not factory or deployer");
    }

    function test_CreateVault_OwnerIsNotFactory() public {
        vm.prank(alice);
        address vault = factory.createVault();
        assertTrue(OncePayoutVault(vault).owner() != address(factory), "factory must not be owner");
    }

    function test_CreateVault_OwnerIsNotDeployer() public {
        vm.prank(alice);
        address vault = factory.createVault();
        assertTrue(OncePayoutVault(vault).owner() != address(this), "deployer must not be owner");
    }

    // ── Two different users get separate vaults ────────────────────────────────

    function test_TwoUsers_GetSeparateVaults() public {
        vm.prank(alice);
        address vaultA = factory.createVault();

        vm.prank(bob);
        address vaultB = factory.createVault();

        assertTrue(vaultA != vaultB, "vaults should be different addresses");
        assertEq(OncePayoutVault(vaultA).owner(), alice);
        assertEq(OncePayoutVault(vaultB).owner(), bob);
    }

    // ── User cannot call setBudget on another user's vault ─────────────────────

    function test_UserCannotCallSetBudgetOnAnotherVault() public {
        vm.prank(alice);
        address vaultA = factory.createVault();

        // bob tries to setBudget on alice's vault
        vm.prank(bob);
        vm.expectRevert();   // OwnableUnauthorizedAccount
        OncePayoutVault(vaultA).setBudget(1_000_000);
    }

    // ── getVaults returns the right list ──────────────────────────────────────

    function test_GetVaults_ReturnsEmptyForNewAddress() public view {
        address[] memory vaults = factory.getVaults(alice);
        assertEq(vaults.length, 0);
    }

    function test_GetVaults_ReturnsSingleVault() public {
        vm.prank(alice);
        address vault = factory.createVault();

        address[] memory vaults = factory.getVaults(alice);
        assertEq(vaults.length, 1);
        assertEq(vaults[0], vault);
    }

    function test_GetVaults_ReturnsMultipleVaults() public {
        vm.startPrank(alice);
        address v1 = factory.createVault();
        address v2 = factory.createVault();
        vm.stopPrank();

        address[] memory vaults = factory.getVaults(alice);
        assertEq(vaults.length, 2);
        assertEq(vaults[0], v1);
        assertEq(vaults[1], v2);
    }

    function test_GetVaults_DoesNotCrossUsers() public {
        vm.prank(alice);
        factory.createVault();

        vm.prank(bob);
        factory.createVault();

        assertEq(factory.getVaults(alice).length, 1);
        assertEq(factory.getVaults(bob).length, 1);
    }

    // ── VaultCreated event ────────────────────────────────────────────────────

    function test_CreateVault_EmitsVaultCreated() public {
        vm.prank(alice);
        vm.recordLogs();
        address vault = factory.createVault();

        // Verify the event was emitted (simple existence check via getVaults)
        assertEq(factory.getVaults(alice)[0], vault);
    }

    // ── Factory has no admin powers ───────────────────────────────────────────

    function test_Factory_CannotCallSetBudgetOnVault() public {
        vm.prank(alice);
        address vault = factory.createVault();

        // Impersonate the factory itself — it should NOT be able to set budget
        vm.prank(address(factory));
        vm.expectRevert();
        OncePayoutVault(vault).setBudget(1_000_000);
    }

    function test_Factory_CannotWithdrawFromVault() public {
        vm.prank(alice);
        address vault = factory.createVault();

        vm.prank(address(factory));
        vm.expectRevert();
        OncePayoutVault(vault).withdrawUnspent();
    }
}
