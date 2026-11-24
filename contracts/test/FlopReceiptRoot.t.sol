// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FlopReceiptRoot} from "../src/FlopReceiptRoot.sol";

/// Differential + adversarial tests. The JS builder (src/) produced test/fixtures/epoch.json from real
/// devnet settlements; these tests recompute every leaf, the EIP-712 digest and every proof on-chain.
contract FlopReceiptRootTest is Test {
    string json;
    FlopReceiptRoot c;
    address constant AT = 0x000000000000000000000000000000000000F10b;
    bytes32 constant DEVNET = 0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631;
    uint256 n;

    function setUp() public {
        json = vm.readFile("test/fixtures/epoch.json");
        address[] memory at = vm.parseJsonAddressArray(json, ".attesters");
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        deployCodeTo(
            "FlopReceiptRoot.sol:FlopReceiptRoot", abi.encode(DEVNET, uint64(_u(".msg.fromBlock")), at, uint256(2)), AT
        );
        c = FlopReceiptRoot(AT);
        n = _u(".msg.count");
    }

    // ---------------------------------------------------------------- fixture readers

    function _u(string memory k) internal view returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, k));
    }

    function _b(string memory k) internal view returns (bytes32) {
        return vm.parseJsonBytes32(json, k);
    }

    function _msg() internal view returns (FlopReceiptRoot.RootMsg memory m) {
        m.genesis = _b(".msg.genesis");
        m.epoch = uint64(_u(".msg.epoch"));
        m.fromBlock = uint64(_u(".msg.fromBlock"));
        m.toBlock = uint64(_u(".msg.toBlock"));
        m.toBlockHash = _b(".msg.toBlockHash");
        m.count = uint32(_u(".msg.count"));
        m.root = _b(".msg.root");
    }

    function _sigs() internal view returns (bytes[] memory) {
        return vm.parseJsonBytesArray(json, ".sigs");
    }

    function _item(uint256 i)
        internal
        view
        returns (FlopReceiptRoot.Settlement memory s, bytes32 leaf, bytes32[] memory proof)
    {
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
        leaf = _b(string.concat(p, ".leaf"));
        proof = vm.parseJsonBytes32Array(json, string.concat(p, ".proof"));
    }

    function _key(uint256 i) internal pure returns (uint256) {
        return uint256(keccak256(bytes(string.concat("flop-receipt-root test attester ", vm.toString(i)))));
    }

    /// Quorum-sign any message with test keys `ids`, sorted by signer address.
    function _sign(FlopReceiptRoot.RootMsg memory m, uint256[] memory ids) internal view returns (bytes[] memory out) {
        bytes32 d = c.digest(m);
        out = new bytes[](ids.length);
        address[] memory who = new address[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(_key(ids[i]), d);
            out[i] = abi.encodePacked(r, s, v);
            who[i] = vm.addr(_key(ids[i]));
        }
        for (uint256 i; i < ids.length; ++i) {
            for (uint256 j = i + 1; j < ids.length; ++j) {
                if (who[j] < who[i]) {
                    (who[i], who[j]) = (who[j], who[i]);
                    (out[i], out[j]) = (out[j], out[i]);
                }
            }
        }
    }

    function _ids(uint256 a, uint256 b) internal pure returns (uint256[] memory x) {
        x = new uint256[](2);
        x[0] = a;
        x[1] = b;
    }

    // ---------------------------------------------------------------- differential

    function test_digestMatchesJs() public view {
        assertEq(c.digest(_msg()), _b(".digest"));
    }

    function test_everyLeafAndProofMatchesJs() public {
        c.submit(_msg(), _sigs());
        for (uint256 i; i < n; ++i) {
            (FlopReceiptRoot.Settlement memory s, bytes32 leaf, bytes32[] memory proof) = _item(i);
            assertEq(c.leafOf(s), leaf, "leaf differs from JS");
            assertTrue(c.verify(1, s, proof), "proof rejected");
        }
    }

    function test_submitAcceptsJsSignedRootAndAdvances() public {
        FlopReceiptRoot.RootMsg memory m = _msg();
        c.submit(m, _sigs());
        (bytes32 root, uint64 from, uint64 to, uint32 count) = c.epochs(1);
        assertEq(root, m.root);
        assertEq(from, m.fromBlock);
        assertEq(to, m.toBlock);
        assertEq(count, m.count);
        assertEq(c.lastEpoch(), 1);
        assertEq(c.nextFromBlock(), m.toBlock + 1);
    }

    // ---------------------------------------------------------------- adversarial: roots

    function test_rejectsReplayAndGaps() public {
        FlopReceiptRoot.RootMsg memory m = _msg();
        bytes[] memory sigs = _sigs();
        c.submit(m, sigs);
        vm.expectRevert(abi.encodeWithSelector(FlopReceiptRoot.WrongEpoch.selector, 1, 2));
        c.submit(m, sigs);
        m.epoch = 2;
        bytes[] memory sgEpoch2 = _sign(m, _ids(1, 2));
        vm.expectRevert(
            abi.encodeWithSelector(FlopReceiptRoot.WrongFromBlock.selector, m.fromBlock, uint64(_u(".msg.toBlock")) + 1)
        );
        c.submit(m, sgEpoch2);
    }

    function test_rejectsWrongGenesisAndRanges() public {
        FlopReceiptRoot.RootMsg memory m = _msg();
        m.genesis = bytes32(uint256(1));
        bytes[] memory sgGenesis = _sign(m, _ids(1, 2));
        vm.expectRevert(abi.encodeWithSelector(FlopReceiptRoot.WrongGenesis.selector, m.genesis));
        c.submit(m, sgGenesis);
        m = _msg();
        m.toBlock = m.fromBlock - 1;
        bytes[] memory sgRange = _sign(m, _ids(1, 2));
        vm.expectRevert(abi.encodeWithSelector(FlopReceiptRoot.BadRange.selector, m.fromBlock, m.toBlock));
        c.submit(m, sgRange);
        m = _msg();
        m.root = bytes32(0);
        bytes[] memory sgEmpty = _sign(m, _ids(1, 2));
        vm.expectRevert(abi.encodeWithSelector(FlopReceiptRoot.EmptyRoot.selector, m.count));
        c.submit(m, sgEmpty);
        m = _msg();
        m.count = 0;
        bytes[] memory sgZero = _sign(m, _ids(1, 2));
        vm.expectRevert(abi.encodeWithSelector(FlopReceiptRoot.EmptyRoot.selector, 0));
        c.submit(m, sgZero);
    }

    function test_rejectsTamperedRootUnderOldSigs() public {
        FlopReceiptRoot.RootMsg memory m = _msg();
        bytes[] memory sigs = _sigs();
        m.count += 1; // same signatures, edited field: recovers to some non-attester
        vm.expectPartialRevert(FlopReceiptRoot.NotAttester.selector);
        c.submit(m, sigs);
    }

    function test_quorumRules() public {
        FlopReceiptRoot.RootMsg memory m = _msg();
        bytes[] memory two = _sign(m, _ids(1, 2));
        bytes[] memory one = new bytes[](1);
        one[0] = two[0];
        vm.expectRevert(abi.encodeWithSelector(FlopReceiptRoot.BelowThreshold.selector, 1, 2));
        c.submit(m, one);
        bytes[] memory dup = new bytes[](2);
        dup[0] = two[0];
        dup[1] = two[0];
        vm.expectPartialRevert(FlopReceiptRoot.SignersNotAscending.selector);
        c.submit(m, dup);
        bytes[] memory rev = new bytes[](2);
        rev[0] = two[1];
        rev[1] = two[0];
        vm.expectPartialRevert(FlopReceiptRoot.SignersNotAscending.selector);
        c.submit(m, rev);
        bytes[] memory stranger = _sign(m, _ids(1, 9));
        vm.expectPartialRevert(FlopReceiptRoot.NotAttester.selector);
        c.submit(m, stranger);
        bytes[] memory four = new bytes[](4);
        vm.expectRevert(abi.encodeWithSelector(FlopReceiptRoot.TooManySigs.selector, 4));
        c.submit(m, four);
    }

    function test_rejectsHighSAndBadV() public {
        FlopReceiptRoot.RootMsg memory m = _msg();
        bytes[] memory sigs = _sign(m, _ids(1, 2));
        // Flip s to n - s and v: same signer, malleated encoding. Must be refused.
        bytes memory s0 = sigs[0];
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(s0, 32))
            s := mload(add(s0, 64))
            v := byte(0, mload(add(s0, 96)))
        }
        uint256 N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        sigs[0] = abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(abi.encodeWithSelector(FlopReceiptRoot.BadSignature.selector, 0));
        c.submit(m, sigs);
        sigs = _sign(m, _ids(1, 2));
        sigs[1] = bytes.concat(sigs[1], hex"00");
        vm.expectRevert(abi.encodeWithSelector(FlopReceiptRoot.BadSignature.selector, 1));
        c.submit(m, sigs);
    }

    function test_signaturesDoNotReplayAcrossChainsOrContracts() public {
        FlopReceiptRoot.RootMsg memory m = _msg();
        bytes[] memory sigs = _sigs();
        vm.chainId(1);
        vm.expectPartialRevert(FlopReceiptRoot.NotAttester.selector);
        c.submit(m, sigs);
        vm.chainId(31337);
        FlopReceiptRoot other =
            new FlopReceiptRoot(DEVNET, m.fromBlock, vm.parseJsonAddressArray(json, ".attesters"), 2);
        vm.expectPartialRevert(FlopReceiptRoot.NotAttester.selector);
        other.submit(m, sigs);
    }

    function test_constructorRejectsWeakSets() public {
        address[] memory a = vm.parseJsonAddressArray(json, ".attesters");
        vm.expectRevert(abi.encodeWithSelector(FlopReceiptRoot.BadAttesterSet.selector, 3, 1));
        new FlopReceiptRoot(DEVNET, 1, a, 1); // 1 of 3 is not a majority
        vm.expectRevert(abi.encodeWithSelector(FlopReceiptRoot.BadAttesterSet.selector, 3, 4));
        new FlopReceiptRoot(DEVNET, 1, a, 4);
        a[2] = a[0];
        vm.expectRevert(abi.encodeWithSelector(FlopReceiptRoot.BadAttester.selector, a[0]));
        new FlopReceiptRoot(DEVNET, 1, a, 2);
        a[2] = address(0);
        vm.expectRevert(abi.encodeWithSelector(FlopReceiptRoot.BadAttester.selector, address(0)));
        new FlopReceiptRoot(DEVNET, 1, a, 2);
    }

    // ---------------------------------------------------------------- adversarial: equivocation

    function test_equivocationFreezesForGood() public {
        FlopReceiptRoot.RootMsg memory a = _msg();
        FlopReceiptRoot.RootMsg memory b = _msg();
        b.root = keccak256("a different root");
        bytes[] memory sa = _sigs();
        bytes[] memory sb = _sign(b, _ids(2, 3));
        c.submit(a, sa);
        (FlopReceiptRoot.Settlement memory s,, bytes32[] memory proof) = _item(0);
        assertTrue(c.verify(1, s, proof));
        vm.expectRevert(FlopReceiptRoot.NotEquivocation.selector);
        c.freeze(a, sa, a, sa);
        c.freeze(a, sa, b, sb);
        assertTrue(c.frozen());
        assertFalse(c.verify(1, s, proof), "frozen contract must verify nothing");
        a.epoch = 2;
        a.fromBlock = c.nextFromBlock();
        bytes[] memory s2 = _sign(a, _ids(1, 2));
        vm.expectRevert(FlopReceiptRoot.IsFrozen.selector);
        c.submit(a, s2);
    }

    // ---------------------------------------------------------------- adversarial: verify

    function test_verifyRejectsEveryEditedField() public {
        c.submit(_msg(), _sigs());
        (FlopReceiptRoot.Settlement memory s,, bytes32[] memory proof) = _item(7);
        assertTrue(c.verify(1, s, proof));
        FlopReceiptRoot.Settlement memory t;
        t = s;
        t.minerPaid += 1;
        assertFalse(c.verify(1, t, proof));
        t = _copy(s);
        t.aggregateGn += 1;
        assertFalse(c.verify(1, t, proof));
        t = _copy(s);
        t.miner = bytes32(uint256(t.miner) ^ 1);
        assertFalse(c.verify(1, t, proof));
        t = _copy(s);
        t.agent = bytes32(uint256(t.agent) ^ 1);
        assertFalse(c.verify(1, t, proof));
        t = _copy(s);
        t.modelHash = bytes32(0);
        assertFalse(c.verify(1, t, proof));
        t = _copy(s);
        t.eventIndex += 1;
        assertFalse(c.verify(1, t, proof));
        t = _copy(s);
        t.genesis = bytes32(0);
        assertFalse(c.verify(1, t, proof));
        assertFalse(c.verify(2, s, proof), "unknown epoch");
        bytes32[] memory shortProof = new bytes32[](proof.length - 1);
        for (uint256 i; i < shortProof.length; ++i) shortProof[i] = proof[i];
        assertFalse(c.verify(1, s, shortProof));
        assertFalse(c.verify(1, s, new bytes32[](65)), "over MAX_PROOF");
    }

    function test_shorterProofFromInnerNodeFails() public {
        c.submit(_msg(), _sigs());
        (, bytes32 leaf0, bytes32[] memory proof) = _item(0);
        // Leaves are double-hashed, so a settlement can't hash to an inner node without a keccak preimage.
        // What an attacker can try cheaply is to start one level up with a shortened proof. It must fail.
        bytes32 inner = leaf0 <= proof[0]
            ? keccak256(abi.encodePacked(leaf0, proof[0]))
            : keccak256(abi.encodePacked(proof[0], leaf0));
        assertTrue(inner != leaf0);
        (FlopReceiptRoot.Settlement memory s,,) = _item(0);
        bytes32[] memory rest = new bytes32[](proof.length - 1);
        for (uint256 i; i < rest.length; ++i) rest[i] = proof[i + 1];
        assertFalse(c.verify(1, s, rest));
    }

    function testFuzz_randomSettlementNeverVerifies(FlopReceiptRoot.Settlement memory s, uint8 which) public {
        c.submit(_msg(), _sigs());
        (,, bytes32[] memory proof) = _item(uint256(which) % n);
        s.genesis = DEVNET;
        s.settledBlock = uint64(bound(s.settledBlock, _u(".msg.fromBlock"), _u(".msg.toBlock")));
        assertFalse(c.verify(1, s, proof));
    }

    function testFuzz_settledBlockOutsideRangeNeverVerifies(uint64 blk, uint8 which) public {
        c.submit(_msg(), _sigs());
        (FlopReceiptRoot.Settlement memory s,, bytes32[] memory proof) = _item(uint256(which) % n);
        vm.assume(blk < _u(".msg.fromBlock") || blk > _u(".msg.toBlock"));
        s.settledBlock = blk;
        assertFalse(c.verify(1, s, proof));
    }

    function _copy(FlopReceiptRoot.Settlement memory s) internal pure returns (FlopReceiptRoot.Settlement memory t) {
        t = FlopReceiptRoot.Settlement(
            s.genesis,
            s.channelId,
            s.settledBlock,
            s.settledBlockHash,
            s.eventIndex,
            s.agent,
            s.miner,
            s.modelHash,
            s.aggregateGn,
            s.minerPaid,
            s.burned,
            s.escrow
        );
    }
}
