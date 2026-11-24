# flop-receipt-root

Prove a Flop compute settlement to an EVM contract without a bridge.

Read **finalized** compute-channel settlements from a Flop network, put them in a Merkle tree, have a fixed N-of-M set of attesters sign the root (EIP-712), and verify any single settlement against that root in a small Solidity contract. What crosses chains is information. No FLOP is wrapped, minted, locked or moved.

Status: local prototype. Tested with Foundry and on a throwaway anvil chain only. **Not deployed anywhere.** The attester keys are throwaway local keys with no funds. Unaffiliated with Flop Labs.

## Why

Flop's docs say to "build that part on an EVM chain and settle compute on FLOP", and that FLOP has no smart contracts and will not build bridges. An EVM app that pays for inference (an intent escrow, a router, a reputation registry) needs one fact from Flop: *did this agent's channel with this miner settle, for this model, for this much G_n and FLOP?* This repo is the smallest honest answer: a signed summary of finalized state, checkable leaf by leaf.

## Numbers from the test epoch (devnet, captured Tue Nov 24 2026 ~2:21 PM ET)

- 99 finalized `computeChannel.Settled` events, blocks 4,548,551 to 4,552,514 (explorer finalized head), one root.
- Every one of the 99 leaves and proofs recomputed on-chain matches the JS builder (differential test).
- On anvil: `submit` with 2 of 3 signatures used **99,106 gas**; `verify` estimates **41,220 gas** with a 7-hash proof (both include the 21,000 base).

## How it works

| step | where | what |
|---|---|---|
| 1 | `src/fetch.mjs` | Read the explorer's `/api/health`: refuse unless the genesis is the pinned one and the indexer has reached the finalized head. Read `/api/settlement-prices` newest-first down to `--from`; refuse if `--max` would cut the range. |
| 2 | `src/epoch.mjs` | Keep only `computeChannel.*` rows at or below the finalized block and inside the range; dedupe by (channel, block, event index). |
| 3 | `src/codec.mjs` | Each settlement becomes a leaf: `keccak(keccak(abi.encode(LEAF_TYPEHASH, genesis, channelId, settledBlock, settledBlockHash, eventIndex, agent, miner, modelHash, aggregateGn, minerPaid, burned, escrow)))`. SS58 addresses are decoded to 32-byte keys with the checksum verified. Values that don't fit their width throw. |
| 4 | `src/merkle.mjs` | Sorted-pair keccak tree (OpenZeppelin's rule). |
| 5 | `src/attest.mjs` | EIP-712 `ReceiptRoot(genesis, epoch, fromBlock, toBlock, toBlockHash, count, root)` under domain `FlopReceiptRoot`/`1`/chainId/contract. Low-s signatures, sorted by signer. |
| 6 | `contracts/src/FlopReceiptRoot.sol` | `submit(msg, sigs)`: next epoch only, contiguous block ranges, pinned genesis, majority quorum of distinct attesters. `verify(epoch, settlement, proof)`: view, returns false instead of reverting. `freeze(a, sigsA, b, sigsB)`: two quorum-signed different roots for one epoch freeze the contract for good. |

## Use (local only)

```sh
npm ci && npm test && forge test
node src/cli.mjs build --network devnet --from 4552000 --out epoch.json   # reads public explorer data
node src/cli.mjs keygen --n 3        # throwaway keys in ~/.secrets/flop-receipt-root, mode 600; prints addresses only
node src/cli.mjs sign --epoch-file epoch.json --chain-id 31337 --contract 0x... --keys 1,2
node scripts/e2e-anvil.mjs           # fresh anvil on a free 127.0.0.1 port: deploy, sign, submit, verify all
```

## Trust model, stated plainly

- **Attesters are a trust assumption.** A colluding quorum can post a fake root. They can't mint or move FLOP (there is none here), but anything paying out against a root (an escrow) is exposed up to its own limits. Mitigations: majority quorum, equivocation freeze, every leaf re-checkable by anyone against finalized Flop state, and consumers that cap value per epoch.
- **One data source today.** The builder reads the explorer's indexer. Cross-checking each row against the chain's `computeChannel.Settled` event over RPC (as [flopscan](https://github.com/xbtMelchizedek/flopscan) does) is the next step. Until then an attester inherits the explorer's correctness.
- **Finality is the explorer writer's finalized head**, read from the same pinned genesis. Phase 2 would verify AlephBFT finality directly; feasibility on an EVM is unknown.
- **Challenge window.** Flop's fraud-proof window is documented at about 7 days. Long-lived uses (reputation) should wait it out; this contract does not encode it.
- **Testnet** has 0 settlements on Nov 24 2026 (no models listed yet), so the test epoch is devnet, where FLOP has no value.

## Proposed schema for Flop Labs

If Flop publishes a canonical settlement export, the leaf above is what an EVM consumer needs: payer (`agent`), `miner`, `modelHash`, `aggregateGn`, `minerPaid`, `burned`, `escrow`, `channelId`, `settledBlock` and its hash, and the event index, all bound to the network `genesis`. Missing today: precision and decode-policy hash per settlement, and a free-form commitment field to bind an external intent id (asked on flop-labs/network#49).

## Review notes (dev-taste G1 and R, short)

- G1: no owner, no setters, no upgrade, no token, no value held; attesters and threshold fixed at construction; every path goes through `_checkQuorum`; loops bounded (≤16 signatures, ≤64 proof hashes).
- R: replay blocked by epoch sequencing and the EIP-712 domain (chain id + contract, recomputed if the chain id changes); signature malleability refused (high s, bad v, wrong length); signer distinctness by strict ordering; equal-hash edges handled (`<=` in pair ordering matches the JS); a frozen contract verifies nothing; missing data in the builder is an error, never zero.

MIT. `lib/forge-std` (MIT/Apache-2.0) is a submodule. JS uses `@noble/hashes` and `@noble/curves` (MIT).
