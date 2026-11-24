// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {FlopReceiptRoot} from "../src/FlopReceiptRoot.sol";
import {IntentEscrow, IReceiptRoot, IERC20Min} from "../src/IntentEscrow.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Shared setup: the real devnet epoch from test/fixtures/epoch.json, accepted by FlopReceiptRoot.
abstract contract EscrowBase is Test {
    string json;
    FlopReceiptRoot roots;
    IntentEscrow esc;
    MockUSDC usdc;
    address constant AT = 0x000000000000000000000000000000000000F10b;
    bytes32 constant DEVNET = 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631;
    address agent = makeAddr("agent");
    address solver = makeAddr("solver");
    address other = makeAddr("other");
    uint96 constant AMT = 10e6; // 10 mock USDC
    uint64 constant WINDOW = 1 hours;

    function _u(string memory k) internal view returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, k));
    }

    function _b(string memory k) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, k);
    }

    function setUpBase() internal {
        json = vm.readFile("test/fixtures/epoch.json");
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        deployCodeTo(
            "FlopReceiptRoot.sol:FlopReceiptRoot",
            abi.encode(DEVNET, uint64(_u(".msg.fromBlock")), vm.parseJsonAddressArray(json, ".attesters"), uint256(2)),
            AT
        );
        roots = FlopReceiptRoot(AT);
        FlopReceiptRoot.RootMsg memory m = FlopReceiptRoot.RootMsg({
            genesis: _b(".msg.genesis"),
            epoch: uint64(_u(".msg.epoch")),
            fromBlock: uint64(_u(".msg.fromBlock")),
            toBlock: uint64(_u(".msg.toBlock")),
            toBlockHash: _b(".msg.toBlockHash"),
            count: uint32(_u(".msg.count")),
            root: _b(".msg.root")
        });
        roots.submit(m, vm.parseJsonBytesArray(json, ".sigs"));
        usdc = new MockUSDC();
        esc = new IntentEscrow(IERC20Min(address(usdc)), IReceiptRoot(address(roots)), 1_000e6, 2_000, WINDOW);
        vm.warp(1_795_548_000);
        for (uint256 i; i < 3; ++i) {
            address a = [agent, solver, other][i];
            usdc.mint(a, 1_000_000e6);
            vm.prank(a);
            usdc.approve(address(esc), type(uint256).max);
        }
    }

    function item(uint256 i) internal view returns (IReceiptRoot.Settlement memory s, bytes32[] memory proof) {
        string memory p = string.concat(".items[", vm.toString(i), "]");
        string memory f = string.concat(p, ".fields");
        s.genesis = _b(string.concat(f, ".genesis"));
        s.channelId = _b(string.concat(f, ".channelId"));
        s.settledBlock = uint64(_u(string.concat(f, ".settledBlock")));
        s.settledBlockHash = _b(string.concat(f, ".settledBlockHash"));
        s.eventIndex = uint32(_u(string.concat(f, ".eventIndex")));
        s.agent = _b(string.concat(f, ".agent"));
        s.miner = _b(string.concat(f, ".miner"));
        s.modelHash = _b(string.concat(f, ".modelHash"));
        s.aggregateGn = uint128(_u(string.concat(f, ".aggregateGn")));
        s.minerPaid = uint128(_u(string.concat(f, ".minerPaid")));
        s.burned = uint128(_u(string.concat(f, ".burned")));
        s.escrow = uint128(_u(string.concat(f, ".escrow")));
        proof = vm.parseJsonBytes32Array(json, string.concat(p, ".proof"));
    }

    /// Post an intent that settlement `i` satisfies exactly.
    function postFor(uint256 i) internal returns (uint256 id) {
        (IReceiptRoot.Settlement memory s,) = item(i);
        vm.prank(agent);
        id = esc.post(AMT, uint64(block.timestamp + 1 days), s.settledBlock, s.agent, s.modelHash, s.aggregateGn);
    }

    function bondAndClaim(uint256 id) internal {
        vm.startPrank(solver);
        esc.deposit(esc.bondFor(AMT));
        esc.claim(id);
        vm.stopPrank();
    }
}

contract IntentEscrowTest is EscrowBase {
    function setUp() public {
        setUpBase();
    }

    function test_happyPath_paysSolverOnlyAgainstProvenSettlement() public {
        uint256 id = postFor(5);
        bondAndClaim(id);
        (IReceiptRoot.Settlement memory s, bytes32[] memory proof) = item(5);
        uint256 before = usdc.balanceOf(solver);
        vm.prank(solver);
        esc.fill(id, 1, s, proof);
        assertEq(usdc.balanceOf(solver) - before, AMT);
        assertEq(esc.freeBond(solver), esc.bondFor(AMT), "bond back to free balance");
        assertEq(usdc.balanceOf(address(esc)), esc.bondFor(AMT));
        assertEq(esc.settlementUsedBy(IReceiptRoot(address(roots)).leafOf(s)), id);
    }

    function test_oneSettlementFillsOneIntent() public {
        uint256 a = postFor(5);
        uint256 b = postFor(5);
        vm.startPrank(solver);
        esc.deposit(2 * esc.bondFor(AMT));
        esc.claim(a);
        esc.claim(b);
        (IReceiptRoot.Settlement memory s, bytes32[] memory proof) = item(5);
        esc.fill(a, 1, s, proof);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.SettlementUsed.selector, IReceiptRoot(address(roots)).leafOf(s), a));
        esc.fill(b, 1, s, proof);
        vm.stopPrank();
    }

    function test_fillRejectsEveryMismatch() public {
        uint256 id = postFor(5);
        bondAndClaim(id);
        (IReceiptRoot.Settlement memory s, bytes32[] memory proof) = item(5);
        (IReceiptRoot.Settlement memory t, bytes32[] memory tp) = item(6);
        vm.startPrank(solver);
        if (t.agent != s.agent) {
            vm.expectRevert(abi.encodeWithSelector(IntentEscrow.Mismatch.selector, id, 1));
            esc.fill(id, 1, t, tp);
        }
        IReceiptRoot.Settlement memory x = _copy(s); // memory assignment aliases; copy explicitly
        x.modelHash = keccak256("other model");
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.Mismatch.selector, id, 2));
        esc.fill(id, 1, x, proof);
        x = _copy(s);
        x.aggregateGn = s.aggregateGn - 1;
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.Mismatch.selector, id, 3));
        esc.fill(id, 1, x, proof);
        x = _copy(s);
        x.settledBlock = s.settledBlock - 1;
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.Mismatch.selector, id, 4));
        esc.fill(id, 1, x, proof);
        x = _copy(s);
        x.minerPaid += 1; // matches terms, but the proof no longer holds
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.ProofRejected.selector, id));
        esc.fill(id, 1, x, proof);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.ProofRejected.selector, id));
        esc.fill(id, 2, s, proof); // unknown epoch
        vm.stopPrank();
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.NotSolver.selector, id));
        esc.fill(id, 1, s, proof);
    }

    function test_unclaimedIntentCannotBeFilled_andCancelRefunds() public {
        uint256 id = postFor(5);
        (IReceiptRoot.Settlement memory s, bytes32[] memory proof) = item(5);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.NotClaimed.selector, id, 1));
        esc.fill(id, 1, s, proof);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.NotAgent.selector, id));
        esc.cancel(id);
        uint256 before = usdc.balanceOf(agent);
        vm.prank(agent);
        esc.cancel(id);
        assertEq(usdc.balanceOf(agent) - before, AMT);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.NotOpen.selector, id, 4));
        esc.cancel(id);
    }

    function test_deadline_refundsAgentAndSlashesSilentSolver() public {
        uint256 id = postFor(5);
        bondAndClaim(id);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.NotExpired.selector, id));
        esc.refund(id);
        (,,,, uint64 deadline,,,,,) = esc.intents(id);
        vm.warp(deadline + 1);
        (IReceiptRoot.Settlement memory s, bytes32[] memory proof) = item(5);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.Expired.selector, id));
        esc.fill(id, 1, s, proof);
        uint256 before = usdc.balanceOf(agent);
        vm.prank(other); // anyone may trigger; money only goes to the agent
        esc.refund(id);
        assertEq(usdc.balanceOf(agent) - before, AMT + esc.bondFor(AMT));
        assertEq(esc.freeBond(solver), 0);
        assertEq(usdc.balanceOf(address(esc)), 0);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.NotOpen.selector, id, 4));
        esc.refund(id);
    }

    function test_claimRules() public {
        uint256 id = postFor(5);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.InsufficientBond.selector, 0, esc.bondFor(AMT)));
        esc.claim(id);
        bondAndClaim(id);
        vm.startPrank(other);
        esc.deposit(esc.bondFor(AMT));
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.NotOpen.selector, id, 2));
        esc.claim(id);
        vm.stopPrank();
        uint256 late = postFor(6);
        (,,,, uint64 deadline,,,,,) = esc.intents(late);
        vm.warp(deadline - WINDOW + 1);
        vm.prank(other);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.TooLateToClaim.selector, late));
        esc.claim(late);
    }

    function test_postValidation() public {
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.BadAmount.selector, 0));
        esc.post(0, uint64(block.timestamp + 1 days), 1, bytes32("a"), bytes32("m"), 1);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.BadAmount.selector, 1_000e6 + 1));
        esc.post(1_000e6 + 1, uint64(block.timestamp + 1 days), 1, bytes32("a"), bytes32("m"), 1);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.BadDeadline.selector, uint64(block.timestamp + WINDOW)));
        esc.post(AMT, uint64(block.timestamp + WINDOW), 1, bytes32("a"), bytes32("m"), 1);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.BadDeadline.selector, uint64(block.timestamp + 31 days)));
        esc.post(AMT, uint64(block.timestamp + 31 days), 1, bytes32("a"), bytes32("m"), 1);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.Mismatch.selector, 0, 0));
        esc.post(AMT, uint64(block.timestamp + 1 days), 1, bytes32(0), bytes32("m"), 1);
        vm.stopPrank();
    }

    function test_bondRoundsUpAgainstSolver() public view {
        assertEq(esc.bondFor(1), 1);
        assertEq(esc.bondFor(5), 1);
        assertEq(esc.bondFor(10e6), 2e6);
    }

    function test_frozenRootsPayNobody() public {
        uint256 id = postFor(5);
        bondAndClaim(id);
        // Freeze the root contract with an equivocating second root signed by test attesters 2 and 3.
        FlopReceiptRoot.RootMsg memory a = FlopReceiptRoot.RootMsg({
            genesis: _b(".msg.genesis"), epoch: 1, fromBlock: uint64(_u(".msg.fromBlock")), toBlock: uint64(_u(".msg.toBlock")),
            toBlockHash: _b(".msg.toBlockHash"), count: uint32(_u(".msg.count")), root: _b(".msg.root")
        });
        FlopReceiptRoot.RootMsg memory b = FlopReceiptRoot.RootMsg(a.genesis, a.epoch, a.fromBlock, a.toBlock, a.toBlockHash, a.count, a.root);
        b.root = keccak256("fake");
        bytes[] memory sb = new bytes[](2);
        address[2] memory who;
        for (uint256 i; i < 2; ++i) {
            uint256 k = uint256(keccak256(bytes(string.concat("flop-receipt-root test attester ", vm.toString(i + 2)))));
            (uint8 v, bytes32 r, bytes32 sv) = vm.sign(k, roots.digest(b));
            sb[i] = abi.encodePacked(r, sv, v);
            who[i] = vm.addr(k);
        }
        if (who[1] < who[0]) (sb[0], sb[1]) = (sb[1], sb[0]);
        roots.freeze(a, vm.parseJsonBytesArray(json, ".sigs"), b, sb);
        (IReceiptRoot.Settlement memory s, bytes32[] memory proof) = item(5);
        vm.prank(solver);
        vm.expectRevert(abi.encodeWithSelector(IntentEscrow.ProofRejected.selector, id));
        esc.fill(id, 1, s, proof);
    }

    function _copy(IReceiptRoot.Settlement memory s) internal pure returns (IReceiptRoot.Settlement memory t) {
        t = IReceiptRoot.Settlement(
            s.genesis, s.channelId, s.settledBlock, s.settledBlockHash, s.eventIndex, s.agent, s.miner, s.modelHash,
            s.aggregateGn, s.minerPaid, s.burned, s.escrow
        );
    }
}

/// Handler for stateful fuzzing: random posts, claims, fills, refunds, cancels, deposits, withdrawals, warps.
contract EscrowHandler is Test {
    IntentEscrow esc;
    MockUSDC usdc;
    EscrowInvariant t;
    address[3] actors;
    uint256[] public ids;
    uint256 public ghostOpenAmounts; // sum of amounts of intents in OPEN or CLAIMED
    uint256 public ghostBonds; // free + locked bonds
    uint256 public fills;
    mapping(uint256 => uint8) itemOf; // intent id => the settlement it was posted for

    constructor(IntentEscrow e, MockUSDC u, EscrowInvariant inv, address[3] memory a) {
        esc = e;
        usdc = u;
        t = inv;
        actors = a;
    }

    function post(uint256 who, uint96 amt, uint8 item) external {
        amt = uint96(bound(amt, 1, 1_000e6));
        item = uint8(bound(item, 0, 98));
        (IReceiptRoot.Settlement memory s,) = t.itemPublic(item);
        vm.prank(actors[who % 3]);
        uint256 id = esc.post(amt, uint64(block.timestamp + 1 days), s.settledBlock, s.agent, s.modelHash, s.aggregateGn);
        ids.push(id);
        itemOf[id] = item;
        ghostOpenAmounts += amt;
    }

    function deposit(uint256 who, uint96 amt) external {
        amt = uint96(bound(amt, 1, 500e6));
        vm.prank(actors[who % 3]);
        esc.deposit(amt);
        ghostBonds += amt;
    }

    function withdraw(uint256 who, uint96 amt) external {
        address a = actors[who % 3];
        uint256 f = esc.freeBond(a);
        if (f == 0) return;
        amt = uint96(bound(amt, 1, f));
        vm.prank(a);
        esc.withdraw(amt);
        ghostBonds -= amt;
    }

    function claim(uint256 who, uint256 pick) external {
        if (ids.length == 0) return;
        uint256 id = ids[pick % ids.length];
        address a = actors[who % 3];
        (,,,,,,,,, uint8 st) = esc.intents(id);
        (,, uint96 amt,, uint64 deadline,,,,,) = esc.intents(id);
        if (st != 1 || block.timestamp + esc.MIN_CLAIM_WINDOW() > deadline) return;
        uint256 need = esc.bondFor(amt);
        uint256 f = esc.freeBond(a);
        vm.startPrank(a);
        if (f < need) {
            esc.deposit(need - f); // top up so claims (and then fills) actually happen in most runs
            ghostBonds += need - f;
        }
        esc.claim(id);
        vm.stopPrank();
    }

    /// Usually the matching settlement (so fills happen); sometimes a random one (so mismatches are exercised).
    function fill(uint256 pick, uint8 item, bool matching) external {
        if (ids.length == 0) return;
        uint256 id = ids[pick % ids.length];
        (, address solver, uint96 amt,, uint64 deadline,,,,, uint8 st) = esc.intents(id);
        if (st != 2 || block.timestamp > deadline) return;
        (IReceiptRoot.Settlement memory s, bytes32[] memory proof) = t.itemPublic(matching ? itemOf[id] : uint8(bound(item, 0, 98)));
        vm.prank(solver);
        try esc.fill(id, 1, s, proof) {
            ghostOpenAmounts -= amt;
            fills++;
        } catch {}
    }

    function refund(uint256 pick) external {
        if (ids.length == 0) return;
        uint256 id = ids[pick % ids.length];
        (,, uint96 amt, uint96 bond, uint64 deadline,,,,, uint8 st) = esc.intents(id);
        if ((st != 1 && st != 2) || block.timestamp <= deadline) return;
        esc.refund(id);
        ghostOpenAmounts -= amt;
        if (st == 2) ghostBonds -= bond;
    }

    function cancel(uint256 pick) external {
        if (ids.length == 0) return;
        uint256 id = ids[pick % ids.length];
        (address agent,, uint96 amt,,,,,,, uint8 st) = esc.intents(id);
        if (st != 1) return;
        vm.prank(agent);
        esc.cancel(id);
        ghostOpenAmounts -= amt;
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 2 days));
    }
}

contract EscrowInvariant is StdInvariant, EscrowBase {
    EscrowHandler h;
    IReceiptRoot.Settlement[] cachedS; // parsed once in setUp; JSON parsing per call is too slow for fuzzing
    bytes32[][] cachedP;

    function setUp() public {
        setUpBase();
        h = new EscrowHandler(esc, usdc, this, [agent, solver, other]);
        for (uint256 i; i < 3; ++i) {
            address a = [agent, solver, other][i];
            vm.prank(a);
            usdc.approve(address(esc), type(uint256).max);
        }
        for (uint256 i; i < 99; ++i) {
            (IReceiptRoot.Settlement memory s, bytes32[] memory p) = item(i);
            cachedS.push(s);
            cachedP.push(p);
        }
        targetContract(address(h));
    }

    function itemPublic(uint8 i) external view returns (IReceiptRoot.Settlement memory, bytes32[] memory) {
        return (cachedS[i], cachedP[i]);
    }

    /// The contract's own bond books (free + locked in claimed intents) match every bond ever deposited minus
    /// withdrawals and slashes.
    function invariant_bondBooks() public view {
        uint256 sum = esc.freeBond(agent) + esc.freeBond(solver) + esc.freeBond(other);
        uint256 n = h.idsLength();
        for (uint256 i; i < n; ++i) {
            (,,, uint96 bond,,,,,, uint8 st) = esc.intents(h.ids(i));
            if (st == 2) sum += bond;
        }
        assertEq(sum, h.ghostBonds());
    }

    /// Conservation: the escrow holds exactly the open intent amounts plus every bond, free or locked.
    function invariant_conservation() public view {
        assertEq(usdc.balanceOf(address(esc)), h.ghostOpenAmounts() + h.ghostBonds());
    }

    /// The handler's fill path really reaches a paid fill (checked separately, since the fuzzer won't tell us).
    function test_handlerReachesFill() public {
        h.post(0, 10e6, 7);
        h.claim(1, 0);
        h.fill(0, 0, true);
        assertEq(h.fills(), 1);
        assertEq(usdc.balanceOf(address(esc)), h.ghostOpenAmounts() + h.ghostBonds());
    }

    /// No value from nothing: total mock USDC never changes, only moves.
    function invariant_supplyConstant() public view {
        assertEq(usdc.totalSupply(), 3_000_000e6);
    }
}
