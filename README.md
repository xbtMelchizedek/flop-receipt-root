# flop-receipt-root

Prove a Flop compute settlement to an EVM contract without a bridge.

Read **finalized** compute-channel settlements from a Flop network, put them in a Merkle tree, have a fixed N-of-M set of attesters sign the root (EIP-712), and verify any single settlement against that root in a small Solidity contract. What crosses chains is information. No FLOP is wrapped, minted, locked or moved.

Status: local prototype (receipt root + intent escrow). Tested with Foundry and on a throwaway anvil chain only. **Not deployed anywhere.** The attester keys are throwaway local keys with no funds. Unaffiliated with Flop Labs.

**Live verifier:** https://xbtmelchizedek.github.io/flop-receipt-root/ (check any settlement's proof in your browser, then tamper with it)

## Quickstart

```sh
npx github:xbtMelchizedek/flop-receipt-root build --network devnet --last 3600 --out epoch.json   # latest hour of devnet, cross-checked on chain
```

Or clone it and run the whole agent loop locally (needs [Foundry](https://getfoundry.sh)): `npm ci && npm run demo`.

As a library (npm package name `flop-receipt-root`): `import { leafHash, verifyProof, crossCheck, verifyReceipt, calldata } from 'flop-receipt-root'`.

Check one receipt: `npx github:xbtMelchizedek/flop-receipt-root verify --epoch-file epoch.json --leaf 0x...` (see [Check one receipt](#check-one-receipt)).

[Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Good first issues](https://github.com/xbtMelchizedek/flop-receipt-root/issues?q=is%3Aopen+label%3A%22good+first+issue%22)

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
node src/cli.mjs build --network devnet --from 4552000 --out epoch.json   # explorer rows, each re-checked on chain over RPC
node src/cli.mjs check --epoch-file epoch.json                          # re-run the chain cross-check
node src/cli.mjs proof  --epoch-file epoch.json --leaf 0x...            # tuple, proof, calldata, cast line for one receipt
node src/cli.mjs verify --epoch-file epoch.json --leaf 0x... --attesters 0x..,0x..,0x.. --threshold 2 [--rpc https://...]
node src/cli.mjs keygen --n 3        # throwaway keys in ~/.secrets/flop-receipt-root, mode 600; prints addresses only
node src/cli.mjs sign --epoch-file epoch.json --chain-id 31337 --contract 0x... --keys 1,2
npm run e2e                          # fresh anvil on a free 127.0.0.1 port: deploy, sign, submit, verify all, escrow
npm run demo                         # quote -> intent -> fill -> verify, one command
```

## Check one receipt

You have an epoch file and one settlement in it. Two commands cover it.

**`proof`** prints everything a contract call needs: the settlement tuple in the contract's field order, the proof, ABI calldata for `FlopReceiptRoot.verify` (and for `IntentEscrow.fill` with `--intent <id>`), and a ready `cast call` line. The calldata matches `cast calldata` byte for byte. `npm run e2e` sends it raw to the deployed test contract, which returns `true`.

```sh
npx github:xbtMelchizedek/flop-receipt-root proof --epoch-file test/fixtures/epoch.json \
  --leaf 0xaa8c1f1bb1500d6eafeadf22c091c42eb93eb5777f6950baff3f57136b4fb53b
```

**`verify`** checks the receipt offline, one JSON line per step. It exits 0 only if every step that ran passed.

| step | checks |
|---|---|
| `leaf` | The 12 fields hash to the stored leaf, using the same encoding as the contract. |
| `range` | Same genesis, and the settled block is inside the epoch's block range. |
| `proof` | The proof reaches the epoch root. |
| `quorum` | The root's EIP-712 signatures recover to distinct attesters in the set, at least `threshold` of them, for that chain id and contract. Pin the set with `--attesters`; otherwise it's read from the file and the output says so. |
| `chain` | With `--rpc <https url>`, the settlement is re-read from Flop: block hash, the `Settled` event at its index, and the channel one block earlier. The block must also be finalized. |

```
{"step":"leaf","ok":true,"detail":"fields hash to 0xaa8c…b53b"}
{"step":"range","ok":true,"detail":"block 4548714 in 4548551..4552514, same genesis"}
{"step":"proof","ok":true,"detail":"7 hashes up to root 0xa206…a511"}
{"step":"quorum","ok":true,"detail":"2 of 3 attesters signed, threshold 2, chain 31337, contract 0x…f10b; attester set read from the epoch file (pin it with --attesters)"}
```

Each kind of tampering fails at its own step, and the tests cover every case: a changed field, a reordered proof, a block outside the range, one signature, the same signature twice, an outsider in a pinned set, the wrong chain id, and a chain that disagrees.

## Demo: quote, intent, fill, verify (all local)

```sh
npm ci && npm run demo        # needs Foundry (anvil, forge, cast) and network for the quote and the RPC check
```

It runs the loop an agent would use, end to end:

1. **Quote.** justweight's `infer` tool (pinned as a dev dependency) quotes a mid-tier, no-retention job from the published price snapshot. It is quote-only: it spends nothing and holds no keys.
2. **Check the settlement on Flop.** One finalized devnet settlement from the bundled epoch is re-read from `rpc.devnet.flop.network` and compared field by field.
3. **Post.** A fresh anvil chain gets the receipt root (signed by throwaway attesters), mock USDC and the escrow. The agent posts an intent for the quoted price, rounded up to USDC units.
4. **Fill.** A solver bonds, claims and fills with that settlement and its proof. The escrow pays only after `FlopReceiptRoot.verify` accepts it.

A run at 3:20 PM ET on Nov 24 quoted near-ai on OpenRouter at $0.0010806. It posted a 1,081-unit intent, the chain cross-check found 0 disagreements, the fill used 129,053 gas, the solver received exactly 1,081 units and `verify` returned true.

`--offline --snapshot <file>` uses recorded chain facts instead of the RPC.

**The gap, stated plainly:** Flop testnet has no models listed yet, so nobody can buy this exact job on Flop today. The settlement is a real finalized devnet settlement standing in for it. The quote comes from OpenRouter-side prices because those venues are live. When testnet lists models, step 2 becomes a testnet settlement and justweight's Flop column fills in (see justweight's watcher).

## Second source: the chain itself

`build` no longer trusts the explorer alone. For every leaf, `src/rpc.mjs` reads the chain at that leaf's block hash over HTTPS JSON-RPC and checks:

- **The block:** the canonical hash at `settledBlock` is the explorer's `settledBlockHash`.
- **The event:** exactly one `computeChannel.Settled` event for this channel sits at `eventIndex` (the event's position inside its extrinsic). Its `minerPaid`, `burned` and `aggregateGn` must match.
- **The channel:** the channel as it stood one block earlier must match the explorer's agent and miner keys (SS58 decoded by our own code, checksum verified), `modelHash` and `escrow`.
- **The boundary:** the epoch's `toBlock` is finalized according to the RPC, and the chain's hash at that height is `toBlockHash`.

If any of these disagree, the build writes nothing and prints every disagreement by field. `check --epoch-file` re-runs the same test on an existing epoch.

- On the 99-settlement test epoch, all 99 leaves agree field by field. The chain's view is recorded in `test/fixtures/chain_facts.json` (re-record with `node scripts/record-chain-facts.mjs`).
- A live devnet build at 3:17 PM ET on Nov 24 cross-checked 2 of 2 new settlements in 14 s.
- Devnet RPC is `https://rpc.devnet.flop.network`. Testnet RPC is `https://testnet.flop.network` (the testnet FAQ gives `wss://testnet.flop.network/`; the same host answers HTTPS JSON-RPC). On both, the genesis hash is pinned, so a node on another chain is refused. `--rpc` still overrides.

## Intent escrow (local prototype, mock USDC)

`contracts/src/IntentEscrow.sol` is the first consumer of the root: pay a solver in USDC only after Flop shows the compute was settled. Swap, don't wrap: the USDC stays on the EVM chain, the FLOP stays on Flop, and only the receipt crosses.

1. **post** (agent): lock `amount` with the terms a settlement must meet: the Flop payer key (`flopAgent`), `modelHash`, `minGn`, and `minFlopBlock` (set it to the Flop head when you post, so old settlements can't count).
2. **claim** (solver): lock a bond of `BOND_BPS` of the amount (rounded up) from a deposited balance. You need at least `MIN_CLAIM_WINDOW` before the deadline.
3. **fill** (that solver): show a settlement and its proof under a root epoch. All four terms must match, `ROOTS.verify` must return true, and each settlement leaf can fill only one intent. The solver gets the amount and the bond comes back.
4. **refund** (anyone, after the deadline): the agent gets the amount back, plus the solver's bond if it was claimed and not filled. **cancel** (agent) works only while the intent is unclaimed.

No owner, no fees, no setters, no upgrade. Per-intent `MAX_AMOUNT` is fixed at deploy. Inflows are balance-checked (a fee-on-transfer token reverts), there is a reentrancy lock, and every error is named. A frozen root contract verifies nothing, so nothing pays.

**Tests.** 9 unit tests, plus a stateful invariant suite: random posts, claims, fills, refunds, cancels, deposits, withdrawals and time warps by 3 actors, 256 runs × 128 calls in CI. It checks three things:
- the escrow holds exactly the open amounts plus all bonds;
- the contract's own bond books (free plus locked) match;
- the mock supply never changes.

**On anvil** (`node scripts/e2e-anvil.mjs`): post 10 mock USDC, bond 2, claim, then fill with devnet settlement #5 from the signed epoch. The fill uses **129,053 gas**, and the solver is paid exactly 10. A tampered settlement reverts, and reusing the same settlement for a second intent reverts.

**Known limit, stated plainly.** A Flop settlement can't carry an intent id today. So any settlement by the agent's own Flop key, for that model and at least that much G_n after `minFlopBlock`, satisfies the intent, whoever arranged it. That is fine when the agent's Flop key only ever spends through the solver it hired. It is not a general marketplace. The fix is the commitment field asked for on flop-labs/network#49. `MockUSDC` is test-only (anyone can mint) and lives under `contracts/test/`.

## Trust model, stated plainly

- **Attesters are a trust assumption.** A colluding quorum can post a fake root. They can't mint or move FLOP (there is none here), but anything paying out against a root (an escrow) is exposed up to its own limits. Mitigations: majority quorum, equivocation freeze, every leaf re-checkable by anyone against finalized Flop state, and consumers that cap value per epoch.
- **Two data sources, and the build refuses when they disagree.** The explorer supplies the rows. Then every leaf is re-read from the chain over HTTPS JSON-RPC (see below), along with the boundary block's hash. Both read the same pinned genesis, but they are separate services; if both are wrong the same way, this can't tell.
- **Finality is the explorer writer's finalized head**, read from the same pinned genesis. Phase 2 would verify AlephBFT finality directly; feasibility on an EVM is unknown.
- **Challenge window.** Flop's fraud-proof window is documented at about 7 days. Long-lived uses (reputation) should wait it out; this contract does not encode it.
- **Testnet** has 0 settlements on Nov 24 2026 (no models listed yet), so the test epoch is devnet, where FLOP has no value.

## Proposed schema for Flop Labs

If Flop publishes a canonical settlement export, the leaf above is what an EVM consumer needs: payer (`agent`), `miner`, `modelHash`, `aggregateGn`, `minerPaid`, `burned`, `escrow`, `channelId`, `settledBlock` and its hash, and the event index, all bound to the network `genesis`. Missing today: precision and decode-policy hash per settlement, and a free-form commitment field to bind an external intent id (asked on flop-labs/network#49).

## Part of the agent inference kit

Small tools that each do one job and work together. Use any one on its own.

- [justweight](https://github.com/xbtMelchizedek/justweight): one price table for every inference venue (Flop, Pearl, Venice, Chutes, each OpenRouter provider, local) in one unit, with each price linked to its source.
- [justweight `infer`](https://github.com/xbtMelchizedek/justweight#infer-route-one-call-with-caps-and-a-receipt): an MCP tool that routes one call to the cheapest venue meeting your privacy floor, under hard spend caps, and returns chained receipts.
- [agent-price-feed](https://github.com/xbtMelchizedek/agent-price-feed): alerts by JSON Feed, RSS, CLI and MCP when those prices move, a cheaper route appears, or Flop lists a model.
- [agent-spendcap](https://github.com/xbtMelchizedek/agent-spendcap): a budget policy for agents: holds before each call, settlement from real usage, a hash-chained ledger, and a drop-in fetch for OpenAI-compatible APIs.
- [agent-cost-proxy](https://github.com/xbtMelchizedek/agent-cost-proxy): one command, a local proxy for coding agents that records each call's real cost and the cheapest listed price for the same tokens, with optional caps.
- [x402-price-check](https://github.com/xbtMelchizedek/x402-price-check): checks an x402 402 quote against justweight list prices and your agent-spendcap budget before an agent pays.
- [flop-receipt-root](https://github.com/xbtMelchizedek/flop-receipt-root) (this repo): proves a Flop compute settlement to an EVM contract without a bridge, and checks one receipt offline.
- [flop-spend](https://github.com/xbtMelchizedek/flop-spend): has an address spent on Flop inference yet? Settled spend per address, re-read on chain, as a CLI, MCP tool and dashboard.

## Review notes (dev-taste G1 and R, short)

- G1: no owner, no setters, no upgrade, no token, no value held; attesters and threshold fixed at construction; every path goes through `_checkQuorum`; loops bounded (≤16 signatures, ≤64 proof hashes).
- R: replay blocked by epoch sequencing and the EIP-712 domain (chain id + contract, recomputed if the chain id changes); signature malleability refused (high s, bad v, wrong length); signer distinctness by strict ordering; equal-hash edges handled (`<=` in pair ordering matches the JS); a frozen contract verifies nothing; missing data in the builder is an error, never zero.

MIT. `lib/forge-std` (MIT/Apache-2.0) is a submodule. JS uses `@noble/hashes` and `@noble/curves` (MIT).
