// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

interface IReceiptRoot {
    struct Settlement {
        bytes32 genesis;
        bytes32 channelId;
        uint64 settledBlock;
        bytes32 settledBlockHash;
        uint32 eventIndex;
        bytes32 agent;
        bytes32 miner;
        bytes32 modelHash;
        uint128 aggregateGn;
        uint128 minerPaid;
        uint128 burned;
        uint128 escrow;
    }

    function verify(uint64 epoch, Settlement calldata s, bytes32[] calldata proof) external view returns (bool);
    function leafOf(Settlement calldata s) external pure returns (bytes32);
}

/// @title IntentEscrow (local prototype)
/// @notice An agent escrows USDC for an inference job ("run this model for at least N G_n, paid by this
///         Flop account, before this deadline"). A bonded solver claims it, buys the compute on Flop, and is
///         paid only when a finalized Flop settlement matching the intent is proven against FlopReceiptRoot.
///         Otherwise the agent is refunded at the deadline and a claimed-but-silent solver's bond goes to the
///         agent. Swap, don't wrap: FLOP never touches this contract. Anvil and Foundry tests only.
/// @dev No owner, no fees, no setters. One choke point (_pay) moves tokens out; inflows are balance-checked.
contract IntentEscrow {
    struct Intent {
        address agent; // EVM payer, gets refunds
        address solver; // zero until claimed
        uint96 amount; // USDC paid to the solver on fill
        uint96 bond; // solver bond locked on claim
        uint64 deadline; // unix seconds
        uint64 minFlopBlock; // settlement must be at or after this Flop block (posted after the intent)
        bytes32 flopAgent; // Flop account (32-byte key) that must be the settlement's payer
        bytes32 modelHash; // model the settlement must be for
        uint128 minGn; // compute the settlement must cover
        uint8 state; // 0 none, 1 open, 2 claimed, 3 filled, 4 refunded
    }

    uint8 private constant NONE = 0;
    uint8 private constant OPEN = 1;
    uint8 private constant CLAIMED = 2;
    uint8 private constant FILLED = 3;
    uint8 private constant REFUNDED = 4;

    IERC20Min public immutable USDC;
    IReceiptRoot public immutable ROOTS;
    uint96 public immutable MAX_AMOUNT; // per-intent cap bounds what a bad root can drain per intent
    uint16 public immutable BOND_BPS; // bond = amount * BOND_BPS / 10_000, rounded up
    uint64 public immutable MIN_CLAIM_WINDOW; // a solver needs at least this long between claim and deadline

    uint256 public nextId = 1;
    mapping(uint256 => Intent) public intents;
    mapping(address => uint256) public freeBond;
    mapping(bytes32 => uint256) public settlementUsedBy; // leaf => intent id; one settlement fills one intent
    uint256 private _lock = 1;

    event Posted(uint256 indexed id, address indexed agent, uint96 amount, uint64 deadline, bytes32 flopAgent, bytes32 modelHash, uint128 minGn);
    event Claimed(uint256 indexed id, address indexed solver, uint96 bond);
    event Filled(uint256 indexed id, address indexed solver, bytes32 leaf, uint64 epoch);
    event Refunded(uint256 indexed id, uint96 amount, uint96 slashed);
    event Bonded(address indexed solver, uint256 amount);
    event Unbonded(address indexed solver, uint256 amount);

    error BadConfig();
    error Reentered();
    error BadAmount(uint256 amount);
    error BadDeadline(uint64 deadline);
    error NotOpen(uint256 id, uint8 state);
    error NotClaimed(uint256 id, uint8 state);
    error NotAgent(uint256 id);
    error NotSolver(uint256 id);
    error InsufficientBond(uint256 free, uint256 need);
    error TooLateToClaim(uint256 id);
    error Expired(uint256 id);
    error NotExpired(uint256 id);
    error ProofRejected(uint256 id);
    error Mismatch(uint256 id, uint8 field);
    error SettlementUsed(bytes32 leaf, uint256 by);
    error ShortTransfer(uint256 got, uint256 want);
    error TransferFailed();

    modifier locked() {
        if (_lock != 1) revert Reentered();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(IERC20Min usdc, IReceiptRoot roots, uint96 maxAmount, uint16 bondBps, uint64 minClaimWindow) {
        if (address(usdc).code.length == 0 || address(roots).code.length == 0) revert BadConfig();
        if (maxAmount == 0 || bondBps == 0 || bondBps > 10_000 || minClaimWindow == 0) revert BadConfig();
        USDC = usdc;
        ROOTS = roots;
        MAX_AMOUNT = maxAmount;
        BOND_BPS = bondBps;
        MIN_CLAIM_WINDOW = minClaimWindow;
    }

    function bondFor(uint96 amount) public view returns (uint96) {
        return uint96((uint256(amount) * BOND_BPS + 9_999) / 10_000); // round up, against the solver
    }

    // ------------------------------------------------------------------ agent

    function post(uint96 amount, uint64 deadline, uint64 minFlopBlock, bytes32 flopAgent, bytes32 modelHash, uint128 minGn)
        external
        locked
        returns (uint256 id)
    {
        if (amount == 0 || amount > MAX_AMOUNT) revert BadAmount(amount);
        if (deadline <= block.timestamp + MIN_CLAIM_WINDOW || deadline > block.timestamp + 30 days) revert BadDeadline(deadline);
        if (flopAgent == bytes32(0) || modelHash == bytes32(0) || minGn == 0) revert Mismatch(0, 0);
        id = nextId++;
        intents[id] = Intent({
            agent: msg.sender,
            solver: address(0),
            amount: amount,
            bond: 0,
            deadline: deadline,
            minFlopBlock: minFlopBlock,
            flopAgent: flopAgent,
            modelHash: modelHash,
            minGn: minGn,
            state: OPEN
        });
        _pull(msg.sender, amount);
        emit Posted(id, msg.sender, amount, deadline, flopAgent, modelHash, minGn);
    }

    /// @notice Unclaimed intents can be withdrawn at any time.
    function cancel(uint256 id) external locked {
        Intent storage it = intents[id];
        if (it.state != OPEN) revert NotOpen(id, it.state);
        if (it.agent != msg.sender) revert NotAgent(id);
        it.state = REFUNDED;
        emit Refunded(id, it.amount, 0);
        _pay(it.agent, it.amount);
    }

    // ------------------------------------------------------------------ solver

    function deposit(uint256 amount) external locked {
        if (amount == 0) revert BadAmount(0);
        freeBond[msg.sender] += amount;
        _pull(msg.sender, amount);
        emit Bonded(msg.sender, amount);
    }

    function withdraw(uint256 amount) external locked {
        uint256 f = freeBond[msg.sender];
        if (amount == 0 || amount > f) revert InsufficientBond(f, amount);
        freeBond[msg.sender] = f - amount;
        emit Unbonded(msg.sender, amount);
        _pay(msg.sender, amount);
    }

    function claim(uint256 id) external locked {
        Intent storage it = intents[id];
        if (it.state != OPEN) revert NotOpen(id, it.state);
        if (block.timestamp + MIN_CLAIM_WINDOW > it.deadline) revert TooLateToClaim(id);
        uint96 b = bondFor(it.amount);
        uint256 f = freeBond[msg.sender];
        if (f < b) revert InsufficientBond(f, b);
        freeBond[msg.sender] = f - b;
        it.solver = msg.sender;
        it.bond = b;
        it.state = CLAIMED;
        emit Claimed(id, msg.sender, b);
    }

    /// @notice Paid only against a settlement the receipt root proves, matching every term of the intent.
    function fill(uint256 id, uint64 epoch, IReceiptRoot.Settlement calldata s, bytes32[] calldata proof) external locked {
        Intent storage it = intents[id];
        if (it.state != CLAIMED) revert NotClaimed(id, it.state);
        if (it.solver != msg.sender) revert NotSolver(id);
        if (block.timestamp > it.deadline) revert Expired(id);
        if (s.agent != it.flopAgent) revert Mismatch(id, 1);
        if (s.modelHash != it.modelHash) revert Mismatch(id, 2);
        if (s.aggregateGn < it.minGn) revert Mismatch(id, 3);
        if (s.settledBlock < it.minFlopBlock) revert Mismatch(id, 4);
        bytes32 leaf = ROOTS.leafOf(s);
        uint256 by = settlementUsedBy[leaf];
        if (by != 0) revert SettlementUsed(leaf, by);
        if (!ROOTS.verify(epoch, s, proof)) revert ProofRejected(id);

        settlementUsedBy[leaf] = id;
        it.state = FILLED;
        freeBond[msg.sender] += it.bond; // bond returns to the solver's free balance
        emit Filled(id, msg.sender, leaf, epoch);
        _pay(msg.sender, it.amount);
    }

    // ------------------------------------------------------------------ anyone, after the deadline

    /// @notice After the deadline an unfilled intent refunds the agent; a claimed one also hands the agent
    ///         the solver's locked bond. Anyone may trigger it (keeper-friendly); funds only go to the agent.
    function refund(uint256 id) external locked {
        Intent storage it = intents[id];
        uint8 st = it.state;
        if (st != OPEN && st != CLAIMED) revert NotOpen(id, st);
        if (block.timestamp <= it.deadline) revert NotExpired(id);
        it.state = REFUNDED;
        uint96 slashed = st == CLAIMED ? it.bond : 0;
        emit Refunded(id, it.amount, slashed);
        _pay(it.agent, uint256(it.amount) + slashed);
    }

    // ------------------------------------------------------------------ token plumbing

    function _pull(address from, uint256 amount) private {
        uint256 before = USDC.balanceOf(address(this));
        _call(abi.encodeCall(IERC20Min.transferFrom, (from, address(this), amount)));
        uint256 got = USDC.balanceOf(address(this)) - before;
        if (got != amount) revert ShortTransfer(got, amount); // fee-on-transfer or lying token
    }

    function _pay(address to, uint256 amount) private {
        _call(abi.encodeCall(IERC20Min.transfer, (to, amount)));
    }

    function _call(bytes memory data) private {
        (bool ok, bytes memory ret) = address(USDC).call(data);
        if (!ok || (ret.length != 0 && (ret.length != 32 || abi.decode(ret, (uint256)) != 1))) revert TransferFailed();
    }
}
