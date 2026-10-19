// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {OncePayoutVault} from "../OncePayoutVault.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

contract OncePayoutVaultTest is Test {
    // -------------------------------------------------------------------------
    // Actors
    // -------------------------------------------------------------------------
    address internal owner  = makeAddr("owner");
    address internal payer  = makeAddr("payer");
    address internal alice  = makeAddr("alice");   // recipient
    address internal bob    = makeAddr("bob");     // funder / extra actor
    address internal nobody = makeAddr("nobody");  // not a payer, not owner

    // -------------------------------------------------------------------------
    // State
    // -------------------------------------------------------------------------
    MockERC20        internal mockUsdc;
    OncePayoutVault  internal vault;

    // Convenient constants
    uint256 internal constant DECIMALS  = 1e6; // USDC has 6 decimals
    uint64  internal constant ONE_HOUR  = 3600;

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /// @dev Fund the vault from `from` with `amount` raw USDC units (approval included).
    function _fund(address from, uint256 amount) internal {
        mockUsdc.mint(from, amount);
        vm.startPrank(from);
        mockUsdc.approve(address(vault), amount);
        vault.fund(amount);
        vm.stopPrank();
    }

    /// @dev Build a future expiry timestamp that never expires during the test.
    function _future() internal view returns (uint64) {
        return uint64(block.timestamp + ONE_HOUR);
    }

    // -------------------------------------------------------------------------
    // setUp — runs before EVERY test
    // -------------------------------------------------------------------------
    function setUp() public {
        // Deploy mock USDC
        mockUsdc = new MockERC20("Mock USDC", "mUSDC", 6);

        // Deploy vault — constructor sets owner to `owner`
        vault = new OncePayoutVault(address(mockUsdc), owner);
    }

    // =========================================================================
    // 1. Deployment & initialization
    // =========================================================================

    function test_Constructor_SetsUsdcAndOwner() public view {
        assertEq(address(vault.usdc()), address(mockUsdc), "usdc mismatch");
        assertEq(vault.owner(), owner,             "owner mismatch");
        assertEq(vault.approvedBudget(), 0,        "budget should start at 0");
        assertEq(vault.totalPaid(), 0,             "totalPaid should start at 0");
    }

    // =========================================================================
    // 2. fund()
    // =========================================================================

    function test_Fund_TransfersUsdcIntoVault() public {
        uint256 amount = 10 * DECIMALS;
        _fund(bob, amount);
        assertEq(mockUsdc.balanceOf(address(vault)), amount, "vault balance wrong");
    }

    function test_Fund_EmitsFunded() public {
        uint256 amount = 5 * DECIMALS;
        mockUsdc.mint(bob, amount);
        vm.startPrank(bob);
        mockUsdc.approve(address(vault), amount);
        vm.expectEmit(true, false, false, true, address(vault));
        emit OncePayoutVault.Funded(bob, amount);
        vault.fund(amount);
        vm.stopPrank();
    }

    // =========================================================================
    // 3. setBudget()
    // =========================================================================

    function test_SetBudget_OwnerCanSet() public {
        vm.prank(owner);
        vault.setBudget(100 * DECIMALS);
        assertEq(vault.approvedBudget(), 100 * DECIMALS);
    }

    function test_SetBudget_EmitsBudgetSet() public {
        vm.prank(owner);
        vault.setBudget(50 * DECIMALS);

        vm.expectEmit(false, false, false, true, address(vault));
        emit OncePayoutVault.BudgetSet(50 * DECIMALS, 200 * DECIMALS);
        vm.prank(owner);
        vault.setBudget(200 * DECIMALS);
    }

    function test_SetBudget_NonOwnerReverts() public {
        vm.prank(nobody);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nobody)
        );
        vault.setBudget(100 * DECIMALS);
    }

    function test_SetBudget_BelowTotalPaidReverts() public {
        // Fund, set budget, pay, then try to lower budget below totalPaid
        _fund(bob, 10 * DECIMALS);
        vm.prank(owner);
        vault.setBudget(5 * DECIMALS);
        vm.prank(owner);
        vault.addPayer(payer);

        vm.prank(payer);
        vault.pay(keccak256("intent1"), alice, 3 * DECIMALS, _future());

        // Trying to set budget to 2 (< totalPaid=3) should revert with OVER_BUDGET
        vm.prank(owner);
        vm.expectRevert(OncePayoutVault.OVER_BUDGET.selector);
        vault.setBudget(2 * DECIMALS);
    }

    // =========================================================================
    // 4. addPayer() / removePayer()
    // =========================================================================

    function test_AddPayer_OwnerGrantsAccess() public {
        vm.prank(owner);
        vault.addPayer(payer);
        assertTrue(vault.allowedPayers(payer), "payer should be allowed");
    }

    function test_AddPayer_EmitsPayerAdded() public {
        vm.prank(owner);
        vm.expectEmit(true, false, false, false, address(vault));
        emit OncePayoutVault.PayerAdded(payer);
        vault.addPayer(payer);
    }

    function test_AddPayer_NonOwnerReverts() public {
        vm.prank(nobody);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nobody)
        );
        vault.addPayer(payer);
    }

    function test_RemovePayer_OwnerRevokesAccess() public {
        vm.prank(owner);
        vault.addPayer(payer);
        vm.prank(owner);
        vault.removePayer(payer);
        assertFalse(vault.allowedPayers(payer), "payer should be removed");
    }

    function test_RemovePayer_EmitsPayerRemoved() public {
        vm.prank(owner);
        vault.addPayer(payer);
        vm.prank(owner);
        vm.expectEmit(true, false, false, false, address(vault));
        emit OncePayoutVault.PayerRemoved(payer);
        vault.removePayer(payer);
    }

    function test_RemovePayer_NonOwnerReverts() public {
        vm.prank(owner);
        vault.addPayer(payer);

        vm.prank(nobody);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nobody)
        );
        vault.removePayer(payer);
    }

    // =========================================================================
    // 5. pay() — Required test case 1: pays an intent once
    // =========================================================================

    /// @dev Test 1: Fund vault, set budget, pay once — verify USDC received by recipient
    ///              and totalPaid updated correctly.
    function test_Pay_HappyPath_SingleIntent() public {
        uint256 fund_  = 10 * DECIMALS;
        uint256 budget = 5  * DECIMALS;
        uint256 amt    = 2  * DECIMALS;

        _fund(bob, fund_);

        vm.prank(owner);
        vault.setBudget(budget);

        vm.prank(owner);
        vault.addPayer(payer);

        uint256 aliceBefore = mockUsdc.balanceOf(alice);

        vm.prank(payer);
        vault.pay(keccak256("intent-happy"), alice, amt, _future());

        assertEq(mockUsdc.balanceOf(alice) - aliceBefore, amt, "recipient did not receive USDC");
        assertEq(vault.totalPaid(), amt, "totalPaid mismatch");
        assertTrue(vault.paidIntents(keccak256("intent-happy")), "intent not marked paid");
    }

    function test_Pay_EmitsPaid() public {
        _fund(bob, 10 * DECIMALS);
        vm.prank(owner);
        vault.setBudget(5 * DECIMALS);
        vm.prank(owner);
        vault.addPayer(payer);

        bytes32 intentId = keccak256("emit-test");
        uint256 amt = 1 * DECIMALS;

        vm.prank(payer);
        vm.expectEmit(true, true, false, true, address(vault));
        emit OncePayoutVault.Paid(intentId, alice, amt);
        vault.pay(intentId, alice, amt, _future());
    }

    /// @dev owner (not in allowedPayers) can also call pay
    function test_Pay_OwnerCanPayWithoutBeingInAllowedPayers() public {
        _fund(bob, 10 * DECIMALS);
        vm.prank(owner);
        vault.setBudget(5 * DECIMALS);

        vm.prank(owner);
        vault.pay(keccak256("owner-pays"), alice, 1 * DECIMALS, _future());

        assertEq(vault.totalPaid(), 1 * DECIMALS);
    }

    // =========================================================================
    // 6. pay() — Required test case 2: same intentId second time reverts DUPLICATE_INTENT
    // =========================================================================

    /// @dev Test 2: Call pay twice with same intentId — second call must revert.
    function test_Pay_DuplicateIntent_SecondCallReverts() public {
        _fund(bob, 10 * DECIMALS);
        vm.prank(owner);
        vault.setBudget(10 * DECIMALS);
        vm.prank(owner);
        vault.addPayer(payer);

        bytes32 id = keccak256("dup-intent");

        vm.prank(payer);
        vault.pay(id, alice, 1 * DECIMALS, _future());

        vm.prank(payer);
        vm.expectRevert(OncePayoutVault.DUPLICATE_INTENT.selector);
        vault.pay(id, alice, 1 * DECIMALS, _future());
    }

    // =========================================================================
    // 7. pay() — Required test case 3: 5 calls same intentId, exactly 1 succeeds
    // =========================================================================

    /// @dev Test 3: 5 calls with the same intentId — exactly 1 succeeds, 4 revert.
    function test_Pay_FiveCallsSameIntent_OnlyFirstSucceeds() public {
        _fund(bob, 10 * DECIMALS);
        vm.prank(owner);
        vault.setBudget(10 * DECIMALS);
        vm.prank(owner);
        vault.addPayer(payer);

        bytes32 id  = keccak256("five-calls");
        uint256 amt = 1 * DECIMALS;

        // First call succeeds
        vm.prank(payer);
        vault.pay(id, alice, amt, _future());

        // Calls 2-5 all revert with DUPLICATE_INTENT
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(payer);
            vm.expectRevert(OncePayoutVault.DUPLICATE_INTENT.selector);
            vault.pay(id, alice, amt, _future());
        }

        // Only 1 payment went through
        assertEq(vault.totalPaid(), amt, "totalPaid should equal exactly one payment");
        assertEq(mockUsdc.balanceOf(alice), amt, "alice should have received exactly one payment");
    }

    // =========================================================================
    // 8. pay() — Required test case 4: over-budget reverts OVER_BUDGET
    // =========================================================================

    /// @dev Test 4: Set budget to 1 USDC, try to pay 2 USDC → OVER_BUDGET.
    function test_Pay_OverBudget_Reverts() public {
        _fund(bob, 10 * DECIMALS);

        vm.prank(owner);
        vault.setBudget(1 * DECIMALS); // 1 USDC budget

        vm.prank(owner);
        vault.addPayer(payer);

        vm.prank(payer);
        vm.expectRevert(OncePayoutVault.OVER_BUDGET.selector);
        vault.pay(keccak256("over-budget"), alice, 2 * DECIMALS, _future());
    }

    // =========================================================================
    // 9. pay() — Required test case 5: expired intent reverts INTENT_EXPIRED
    // =========================================================================

    /// @dev Test 5: Pass expiresAt = block.timestamp - 1 → INTENT_EXPIRED.
    function test_Pay_ExpiredIntent_Reverts() public {
        _fund(bob, 10 * DECIMALS);
        vm.prank(owner);
        vault.setBudget(5 * DECIMALS);
        vm.prank(owner);
        vault.addPayer(payer);

        uint64 expired = uint64(block.timestamp - 1);

        vm.prank(payer);
        vm.expectRevert(OncePayoutVault.INTENT_EXPIRED.selector);
        vault.pay(keccak256("expired"), alice, 1 * DECIMALS, expired);
    }

    // =========================================================================
    // 10. pay() — Required test case 6: non-payer reverts NOT_PAYER
    // =========================================================================

    /// @dev Test 6: Call pay from an address that is not owner or allowedPayer.
    function test_Pay_NonPayer_Reverts() public {
        _fund(bob, 10 * DECIMALS);
        vm.prank(owner);
        vault.setBudget(5 * DECIMALS);

        vm.prank(nobody);
        vm.expectRevert(OncePayoutVault.NOT_PAYER.selector);
        vault.pay(keccak256("non-payer"), alice, 1 * DECIMALS, _future());
    }

    // =========================================================================
    // 11. withdrawUnspent() — Required test case 7
    // =========================================================================

    /// @dev Test 7: Fund 10 USDC, set budget 3 USDC, pay 1 USDC.
    ///              withdrawUnspent should return balance - committedRemaining
    ///              = 10 - (3 - 1) = 10 - 2 = 8 USDC.
    function test_WithdrawUnspent_ReturnsOnlyUnspent() public {
        uint256 fundAmt  = 10 * DECIMALS;
        uint256 budget   = 3  * DECIMALS;
        uint256 payAmt   = 1  * DECIMALS;

        _fund(bob, fundAmt);

        vm.prank(owner);
        vault.setBudget(budget);

        vm.prank(owner);
        vault.addPayer(payer);

        vm.prank(payer);
        vault.pay(keccak256("withdraw-test"), alice, payAmt, _future());

        // committedRemaining = approvedBudget - totalPaid = 3 - 1 = 2 USDC
        // withdrawable       = vaultBalance - committedRemaining = 10 - 2 - 1 = 7?
        // Wait: after paying 1 USDC vault balance is 10 - 1 = 9 USDC
        // withdrawable = 9 - (3 - 1) = 9 - 2 = 7 USDC
        // The prompt says "10-2=8" but that assumed vault balance was still 10.
        // Actually vault balance after paying alice = 9. Let's assert the contract
        // behaviour precisely: balance(9) - committedRemaining(2) = 7 USDC.

        uint256 ownerBefore = mockUsdc.balanceOf(owner);

        vm.prank(owner);
        vault.withdrawUnspent();

        uint256 withdrawn = mockUsdc.balanceOf(owner) - ownerBefore;
        // vault had 9 USDC, committedRemaining = 2, so 7 USDC withdrawable
        assertEq(withdrawn, 7 * DECIMALS, "owner should receive 7 USDC (vault 9 - committed 2)");
        // Vault should have only committedRemaining left
        assertEq(mockUsdc.balanceOf(address(vault)), 2 * DECIMALS, "vault should retain committed 2 USDC");
    }

    function test_WithdrawUnspent_EmitsWithdrawn() public {
        _fund(bob, 5 * DECIMALS);
        vm.prank(owner);
        vault.setBudget(1 * DECIMALS);

        // vault balance = 5, committedRemaining = 1, withdrawable = 4
        uint256 expected = 4 * DECIMALS;

        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(vault));
        emit OncePayoutVault.Withdrawn(owner, expected);
        vault.withdrawUnspent();
    }

    function test_WithdrawUnspent_WhenFullyCommitted_TransfersNothing() public {
        _fund(bob, 3 * DECIMALS);
        vm.prank(owner);
        vault.setBudget(5 * DECIMALS); // committed > vault balance

        uint256 ownerBefore = mockUsdc.balanceOf(owner);

        vm.prank(owner);
        vault.withdrawUnspent();

        assertEq(mockUsdc.balanceOf(owner), ownerBefore, "owner should receive nothing");
    }

    function test_WithdrawUnspent_NonOwnerReverts() public {
        vm.prank(nobody);
        vm.expectRevert(
            abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, nobody)
        );
        vault.withdrawUnspent();
    }

    // =========================================================================
    // 12. Fuzz — Required test case 8: random payouts never make totalPaid > approvedBudget
    // =========================================================================

    /// @dev Test 8: Fuzz — invariant: totalPaid never exceeds approvedBudget across
    ///              a sequence of random pay() calls with unique intentIds.
    function testFuzz_TotalPaidNeverExceedsBudget(
        uint8  numPayments,
        uint96 budgetRaw,
        uint96 amountRaw
    ) public {
        // Bound inputs to sensible ranges
        uint256 n      = bound(numPayments, 1, 20);
        uint256 budget = bound(budgetRaw, 1, 1_000_000 * DECIMALS);
        uint256 amount = bound(amountRaw, 1, budget); // each payment <= budget

        // Fund vault with enough to cover worst-case (budget worth)
        _fund(bob, budget);

        vm.prank(owner);
        vault.setBudget(budget);

        vm.prank(owner);
        vault.addPayer(payer);

        for (uint256 i = 0; i < n; i++) {
            bytes32 intentId = keccak256(abi.encodePacked("fuzz", i));
            bool willExceed  = vault.totalPaid() + amount > vault.approvedBudget();

            if (willExceed) {
                vm.prank(payer);
                vm.expectRevert(OncePayoutVault.OVER_BUDGET.selector);
                vault.pay(intentId, alice, amount, _future());
            } else {
                vm.prank(payer);
                vault.pay(intentId, alice, amount, _future());
            }

            // Core invariant: totalPaid must never exceed approvedBudget
            assertLe(vault.totalPaid(), vault.approvedBudget(), "invariant violated: totalPaid > approvedBudget");
        }
    }

    // =========================================================================
    // 13. Scenario — Required test case 9: seed scenario
    // =========================================================================

    /// @dev Test 9: Seed scenario —
    ///   budget = 1_000_000 (1.00 USDC)
    ///   pay 400_000 (0.40 USDC) once → succeeds
    ///   4 duplicate attempts with same intentId → all revert DUPLICATE_INTENT
    ///   try to pay 700_000 (0.70 USDC) with new intentId → reverts OVER_BUDGET
    ///     (remaining budget = 1_000_000 - 400_000 = 600_000 < 700_000)
    ///   final totalPaid == 400_000
    function test_Scenario_SeedScenario() public {
        uint256 budget  = 1_000_000; // 1.00 USDC
        uint256 pay1    =   400_000; // 0.40 USDC
        uint256 pay2    =   700_000; // 0.70 USDC (should fail: remaining = 600_000)

        // Fund vault with plenty of USDC
        _fund(bob, 10 * DECIMALS);

        vm.prank(owner);
        vault.setBudget(budget);

        vm.prank(owner);
        vault.addPayer(payer);

        bytes32 intentA = keccak256("scenario-A");
        bytes32 intentB = keccak256("scenario-B");

        // --- Step 1: First pay succeeds ---
        vm.prank(payer);
        vault.pay(intentA, alice, pay1, _future());
        assertEq(vault.totalPaid(), pay1, "totalPaid after first pay");

        // --- Step 2: 4 duplicate attempts all revert DUPLICATE_INTENT ---
        for (uint256 i = 0; i < 4; i++) {
            vm.prank(payer);
            vm.expectRevert(OncePayoutVault.DUPLICATE_INTENT.selector);
            vault.pay(intentA, alice, pay1, _future());
        }

        // --- Step 3: New intent but over remaining budget → OVER_BUDGET ---
        // remaining = 1_000_000 - 400_000 = 600_000; paying 700_000 exceeds this
        vm.prank(payer);
        vm.expectRevert(OncePayoutVault.OVER_BUDGET.selector);
        vault.pay(intentB, alice, pay2, _future());

        // --- Final assertion ---
        assertEq(vault.totalPaid(), pay1, "final totalPaid must be 400_000");
        assertEq(vault.totalPaid(), 400_000, "totalPaid exact 400_000");
    }

    // =========================================================================
    // 14. Edge cases
    // =========================================================================

    function test_Pay_ExactlyAtBudget_Succeeds() public {
        uint256 amt = 3 * DECIMALS;
        _fund(bob, amt);
        vm.prank(owner);
        vault.setBudget(amt);
        vm.prank(owner);
        vault.addPayer(payer);

        vm.prank(payer);
        vault.pay(keccak256("exact-budget"), alice, amt, _future());
        assertEq(vault.totalPaid(), amt);
    }

    function test_Pay_ExpiresAtExactlyBlockTimestamp_Reverts() public {
        // block.timestamp > expiresAt required to revert; equality does NOT revert
        _fund(bob, 5 * DECIMALS);
        vm.prank(owner);
        vault.setBudget(5 * DECIMALS);
        vm.prank(owner);
        vault.addPayer(payer);

        // expiresAt == block.timestamp: condition is (block.timestamp > expiresAt) → false → should succeed
        uint64 exactNow = uint64(block.timestamp);
        vm.prank(payer);
        vault.pay(keccak256("exact-ts"), alice, 1 * DECIMALS, exactNow);
        assertEq(vault.totalPaid(), 1 * DECIMALS, "equal timestamp should not expire");
    }

    function test_RemovedPayer_CannoLongerPay() public {
        _fund(bob, 10 * DECIMALS);
        vm.prank(owner);
        vault.setBudget(5 * DECIMALS);
        vm.prank(owner);
        vault.addPayer(payer);

        // Sanity: payer can pay
        vm.prank(payer);
        vault.pay(keccak256("before-remove"), alice, 1 * DECIMALS, _future());

        // Remove payer
        vm.prank(owner);
        vault.removePayer(payer);

        // Now payer cannot pay
        vm.prank(payer);
        vm.expectRevert(OncePayoutVault.NOT_PAYER.selector);
        vault.pay(keccak256("after-remove"), alice, 1 * DECIMALS, _future());
    }
}
