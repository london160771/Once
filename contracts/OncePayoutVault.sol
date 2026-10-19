// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract OncePayoutVault is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    uint256 public approvedBudget;
    uint256 public totalPaid;
    mapping(bytes32 => bool) public paidIntents;
    mapping(address => bool) public allowedPayers;

    error NOT_PAYER();
    error INTENT_EXPIRED();
    error DUPLICATE_INTENT();
    error OVER_BUDGET();

    event Funded(address indexed from, uint256 amount);
    event BudgetSet(uint256 oldBudget, uint256 newBudget);
    event Paid(bytes32 indexed intentId, address indexed to, uint256 amount);
    event PayerAdded(address indexed payer);
    event PayerRemoved(address indexed payer);
    event Withdrawn(address indexed to, uint256 amount);

    constructor(address _usdc, address _owner) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
        _transferOwnership(_owner);
    }

    function fund(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    function setBudget(uint256 newBudget) external onlyOwner {
        if (newBudget < totalPaid) revert OVER_BUDGET();

        uint256 oldBudget = approvedBudget;
        approvedBudget = newBudget;

        emit BudgetSet(oldBudget, newBudget);
    }

    function addPayer(address payer) external onlyOwner {
        allowedPayers[payer] = true;
        emit PayerAdded(payer);
    }

    function removePayer(address payer) external onlyOwner {
        allowedPayers[payer] = false;
        emit PayerRemoved(payer);
    }

    function pay(bytes32 intentId, address to, uint256 amount, uint64 expiresAt) external {
        if (!allowedPayers[msg.sender] && msg.sender != owner()) revert NOT_PAYER();
        if (block.timestamp > expiresAt) revert INTENT_EXPIRED();
        if (paidIntents[intentId]) revert DUPLICATE_INTENT();
        if (totalPaid + amount > approvedBudget) revert OVER_BUDGET();

        paidIntents[intentId] = true;
        totalPaid += amount;
        usdc.safeTransfer(to, amount);

        emit Paid(intentId, to, amount);
    }

    function withdrawUnspent() external onlyOwner {
        uint256 committedRemaining = approvedBudget - totalPaid;
        uint256 balance = usdc.balanceOf(address(this));

        uint256 amount;
        if (balance > committedRemaining) {
            amount = balance - committedRemaining;
            usdc.safeTransfer(owner(), amount);
        }

        emit Withdrawn(owner(), amount);
    }
}
