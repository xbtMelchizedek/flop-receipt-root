// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title FlopReceiptRoot
/// @notice Holds Merkle roots of finalized Flop compute-channel settlements, each signed by a fixed
///         N-of-M attester set, and verifies single settlements against them. It moves no value and
///         holds no token: what crosses chains is information, never FLOP. Local/anvil use only.
/// @dev No owner, no setters, no upgrade. Attesters and threshold are fixed at construction.
///      Epochs are contiguous block ranges. If a threshold of attesters ever signs two different roots
///      for the same epoch, anyone can prove it and the contract freezes for good (fail closed).
contract FlopReceiptRoot {
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

    struct RootMsg {
        bytes32 genesis;
        uint64 epoch;
        uint64 fromBlock;
        uint64 toBlock;
        bytes32 toBlockHash;
        uint32 count;
        bytes32 root;
    }

    struct Epoch {
        bytes32 root;
        uint64 fromBlock;
        uint64 toBlock;
        uint32 count;
    }

    bytes32 public constant LEAF_TYPEHASH = keccak256(
        "FlopSettlementLeaf(bytes32 genesis,bytes32 channelId,uint64 settledBlock,bytes32 settledBlockHash,uint32 eventIndex,bytes32 agent,bytes32 miner,bytes32 modelHash,uint128 aggregateGn,uint128 minerPaid,uint128 burned,uint128 escrow)"
    );
    bytes32 public constant ROOT_TYPEHASH = keccak256(
        "ReceiptRoot(bytes32 genesis,uint64 epoch,uint64 fromBlock,uint64 toBlock,bytes32 toBlockHash,uint32 count,bytes32 root)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    uint256 public constant MAX_ATTESTERS = 16;
    uint256 public constant MAX_PROOF = 64;

    bytes32 public immutable GENESIS;
    uint256 public immutable THRESHOLD;
    uint64 public immutable START_BLOCK;
    uint256 private immutable _CHAIN_ID;
    bytes32 private immutable _DOMAIN;

    mapping(address => bool) public isAttester;
    address[] private _attesters;

    mapping(uint64 => Epoch) public epochs;
    uint64 public lastEpoch;
    uint64 public nextFromBlock;
    bool public frozen;

    event RootAccepted(uint64 indexed epoch, bytes32 root, uint64 fromBlock, uint64 toBlock, uint32 count);
    event Frozen(uint64 indexed epoch, bytes32 digestA, bytes32 digestB);

    error BadAttesterSet(uint256 n, uint256 threshold);
    error BadAttester(address a);
    error IsFrozen();
    error WrongGenesis(bytes32 got);
    error WrongEpoch(uint64 got, uint64 want);
    error WrongFromBlock(uint64 got, uint64 want);
    error BadRange(uint64 fromBlock, uint64 toBlock);
    error EmptyRoot(uint32 count);
    error TooManySigs(uint256 n);
    error BadSignature(uint256 i);
    error SignersNotAscending(uint256 i, address signer);
    error NotAttester(uint256 i, address signer);
    error BelowThreshold(uint256 got, uint256 want);
    error NotEquivocation();
    error ProofTooLong(uint256 n);

    constructor(bytes32 genesis, uint64 startBlock, address[] memory attesterSet, uint256 threshold) {
        uint256 n = attesterSet.length;
        // A majority threshold means two conflicting roots need overlapping signers, which freeze() catches.
        if (n == 0 || n > MAX_ATTESTERS || threshold * 2 <= n || threshold > n) revert BadAttesterSet(n, threshold);
        for (uint256 i; i < n; ++i) {
            address a = attesterSet[i];
            if (a == address(0) || isAttester[a]) revert BadAttester(a);
            isAttester[a] = true;
        }
        _attesters = attesterSet;
        GENESIS = genesis;
        THRESHOLD = threshold;
        START_BLOCK = startBlock;
        nextFromBlock = startBlock;
        _CHAIN_ID = block.chainid;
        _DOMAIN = _domain();
    }

    function attesters() external view returns (address[] memory) {
        return _attesters;
    }

    // ------------------------------------------------------------------ hashing

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == _CHAIN_ID ? _DOMAIN : _domain();
    }

    function _domain() private view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("FlopReceiptRoot"), keccak256("1"), block.chainid, address(this))
        );
    }

    function digest(RootMsg calldata m) public view returns (bytes32) {
        bytes32 s = keccak256(
            abi.encode(ROOT_TYPEHASH, m.genesis, m.epoch, m.fromBlock, m.toBlock, m.toBlockHash, m.count, m.root)
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), s));
    }

    /// @dev Double hash so an inner node (64 bytes) can never pass as a leaf.
    function leafOf(Settlement calldata s) public pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        LEAF_TYPEHASH,
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
                    )
                )
            )
        );
    }

    // ------------------------------------------------------------------ roots

    /// @notice Anyone may relay a root; only the attesters' signatures make it count.
    function submit(RootMsg calldata m, bytes[] calldata sigs) external {
        if (frozen) revert IsFrozen();
        if (m.genesis != GENESIS) revert WrongGenesis(m.genesis);
        if (m.epoch != lastEpoch + 1) revert WrongEpoch(m.epoch, lastEpoch + 1);
        if (m.fromBlock != nextFromBlock) revert WrongFromBlock(m.fromBlock, nextFromBlock);
        if (m.toBlock < m.fromBlock) revert BadRange(m.fromBlock, m.toBlock);
        // An empty range must say so with a zero root; a non-empty one must carry a root.
        if ((m.count == 0) != (m.root == bytes32(0))) revert EmptyRoot(m.count);
        _checkQuorum(digest(m), sigs);

        epochs[m.epoch] = Epoch({root: m.root, fromBlock: m.fromBlock, toBlock: m.toBlock, count: m.count});
        lastEpoch = m.epoch;
        nextFromBlock = m.toBlock + 1;
        emit RootAccepted(m.epoch, m.root, m.fromBlock, m.toBlock, m.count);
    }

    /// @notice Two quorum-signed, different messages for one epoch freeze the contract forever.
    function freeze(RootMsg calldata a, bytes[] calldata sigsA, RootMsg calldata b, bytes[] calldata sigsB) external {
        if (frozen) revert IsFrozen();
        bytes32 da = digest(a);
        bytes32 db = digest(b);
        if (a.epoch != b.epoch || da == db) revert NotEquivocation();
        _checkQuorum(da, sigsA);
        _checkQuorum(db, sigsB);
        frozen = true;
        emit Frozen(a.epoch, da, db);
    }

    function _checkQuorum(bytes32 d, bytes[] calldata sigs) private view {
        uint256 n = sigs.length;
        if (n > _attesters.length) revert TooManySigs(n);
        address prev;
        for (uint256 i; i < n; ++i) {
            address s = _recover(d, sigs[i], i);
            // Strictly ascending signers prove they are distinct without a seen-set.
            if (s <= prev) revert SignersNotAscending(i, s);
            if (!isAttester[s]) revert NotAttester(i, s);
            prev = s;
        }
        if (n < THRESHOLD) revert BelowThreshold(n, THRESHOLD);
    }

    function _recover(bytes32 d, bytes calldata sig, uint256 i) private pure returns (address s) {
        if (sig.length != 65) revert BadSignature(i);
        bytes32 r = bytes32(sig[0:32]);
        bytes32 sv = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(sv) > HALF_N || (v != 27 && v != 28)) revert BadSignature(i);
        s = ecrecover(d, v, r, sv);
        if (s == address(0)) revert BadSignature(i);
    }

    // ------------------------------------------------------------------ verify

    /// @notice True only if the settlement is in an accepted epoch's root, on this genesis, inside its range,
    ///         and the contract is not frozen. Reads only; never reverts on a bad proof.
    function verify(uint64 epoch, Settlement calldata s, bytes32[] calldata proof) external view returns (bool) {
        if (frozen || proof.length > MAX_PROOF) return false;
        Epoch memory e = epochs[epoch];
        if (e.root == bytes32(0) || s.genesis != GENESIS) return false;
        if (s.settledBlock < e.fromBlock || s.settledBlock > e.toBlock) return false;
        bytes32 h = leafOf(s);
        for (uint256 i; i < proof.length; ++i) {
            bytes32 p = proof[i];
            h = h <= p ? keccak256(abi.encodePacked(h, p)) : keccak256(abi.encodePacked(p, h));
        }
        return h == e.root;
    }
}
