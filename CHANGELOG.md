# Changelog

Versions follow [semver](https://semver.org). Before 1.0, minor versions may change the leaf or epoch file format; the contract and the JS codec always change together.

## Unreleased

- **Normative job id.** `jobId = keccak256(abi.encode(JOB_ID_TAG, genesis, channelId, uint64 settledBlock, uint32 eventIndex))` with `JOB_ID_TAG = keccak256("FlopReceiptRoot.jobId.v1")`. JS `jobId`/`encodeJobId`, Solidity `jobIdOf`/`JOB_ID_TAG`, README section, and 6 vectors from an independent Python generator, checked by node and forge. Leaf format and root unchanged. For #4.

## 0.3.2 (2026-11-26)

- Testnet explorer `finalizedHead`: when `/api/health` is missing (HTTP 404 on `testnet.flopscan.io`), fall back to `/api/stats` and `/api/blocks/<n>` for the finalized number and hash, then refuse unless the official Testnet RPC (`https://testnet.flop.network`) reports the pinned genesis `0x918abd58…cfd800`, the same block hash, and a finalized head at or above that block. A 503 or other health error still fails closed and does not fall back. Settlements are still re-read on chain before a root is written.

## 0.3.1 (2026-11-24)

- Testnet RPC: `NETWORKS.testnet.rpc` is now `https://testnet.flop.network`, so `check`, `verify --chain` and `connectRpc('testnet')` work without `--rpc`. The testnet genesis stays pinned: a node that reports a different genesis is refused. The testnet explorer's settlement API is not up yet, so a testnet `build` still has nothing to read. The public node rate-limits: at 4:29 PM ET on 2026-11-24 it answered `429 Too Many Requests` to the API's start-up calls, so retry later if that happens.

## 0.3.0 (2026-11-24)

- **`proof` command.** Prints one receipt's settlement tuple, proof, ABI calldata for `verify` (and `fill` with `--intent`), and a ready `cast call` line. The calldata matches `cast calldata` byte for byte, and the anvil e2e sends it raw to the deployed contract, which returns `true`.
- **`verify` command.** Checks one receipt offline in steps (leaf, range, proof, attester quorum), plus an optional re-read from the chain with `--rpc`. It prints one JSON line per step, exits 0 only if all of them pass, and lets you pin the attester set with `--attesters`. Closes #2.
- Library: `findItem`, `calldata`, `proofBundle`, `verifyReceipt` (also exported as `flop-receipt-root/receipt`).
- 23 node tests, including all 99 fixture receipts through every step, each tampering case caught at its step, and the CLI through an npx-style symlink.
- README: "Check one receipt" and the agent inference kit links.

## 0.2.0 (2026-11-24)

- **Second source.** `build` re-reads every leaf from the Flop chain over HTTPS JSON-RPC before it writes anything: block hash, the `computeChannel.Settled` event at its index, and the channel's agent, miner, model and escrow one block earlier, plus the boundary block hash. Any disagreement refuses the build. New `check` command; `--last <blocks>` option.
- **IntentEscrow.sol.** USDC intent escrow that pays a bonded solver only against a settlement `FlopReceiptRoot.verify` accepts. One settlement fills one intent, and an unfilled claim forfeits its bond to the agent. Includes unit and invariant tests and an anvil e2e. Not deployed.
- **`npm run demo`.** One local loop: justweight quote → settlement checked on chain → intent posted → solver fills → root verifies.
- **Live verifier page.** It recomputes any settlement's leaf and proof in the browser and shows a tampered one failing. CI rebuilds the latest devnet epoch every 6 hours, cross-checked on chain.
- Packaging (library entry, `exports`, `files`), CONTRIBUTING.md, SECURITY.md, this changelog.

## 0.1.0 (2026-11-24)

- Builder: explorer settlements → leaves → sorted-pair Merkle root → EIP-712 root signed by throwaway attester keys.
- `FlopReceiptRoot.sol`: majority quorum, contiguous epochs, low-s only, strictly ascending signers, equivocation freeze, and a `verify` view that never reverts.
- Differential tests over 99 real devnet settlements (JS ↔ Solidity), plus an anvil e2e.
