// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Test fixtures only. These model ordered atomic calls and the two independent
// allowance layers, not Circle authentication, Arc USDC, Permit2 or swap pricing.
contract AtomicTradeAccountFixture {
    struct Call { address target; uint256 value; bytes data; }
    address private immutable owner;

    constructor() { owner = msg.sender; }

    function executeBatch(Call[] calldata calls) external payable returns (bytes[] memory results) {
        require(msg.sender == owner, "owner only");
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; i++) {
            (bool ok, bytes memory result) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) assembly { revert(add(result, 32), mload(result)) }
            results[i] = result;
        }
    }
}

contract AtomicTradeTokenFixture {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        require(allowance[from][msg.sender] >= amount, "token allowance");
        require(balanceOf[from] >= amount, "token balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

contract AtomicTradePermitFixture {
    struct Allowance { uint160 amount; uint48 expiration; }
    mapping(address => mapping(address => mapping(address => Allowance))) public allowance;
    event Approval(address indexed owner, address indexed token, address indexed spender, uint160 amount);

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        allowance[msg.sender][token][spender] = Allowance(amount, expiration);
        emit Approval(msg.sender, token, spender, amount);
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        Allowance storage approved = allowance[from][token][msg.sender];
        require(approved.amount >= amount && approved.expiration >= block.timestamp, "permit allowance");
        approved.amount -= amount;
        AtomicTradeTokenFixture(token).transferFrom(from, to, amount);
    }
}

contract AtomicTradeRouterFixture {
    AtomicTradePermitFixture private immutable permit;
    AtomicTradeTokenFixture private immutable output;
    event Swap(address indexed account, address indexed recipient, uint256 amountIn, uint256 amountOut);

    constructor(AtomicTradePermitFixture permit_, AtomicTradeTokenFixture output_) {
        permit = permit_;
        output = output_;
    }

    function swap(address input, address recipient, uint160 amount, uint256 minimumOutput) external {
        // Deliberately check output after the input transfer. A failed final
        // check must roll back the earlier approvals and this balance movement.
        permit.transferFrom(msg.sender, address(this), amount, input);
        uint256 received = uint256(amount) * 2;
        require(received >= minimumOutput, "minimum output");
        output.mint(recipient, received);
        emit Swap(msg.sender, recipient, amount, received);
    }
}
