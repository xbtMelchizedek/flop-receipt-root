# Changelog

Versions follow [semver](https://semver.org). Before 1.0, minor versions may change the leaf or epoch file format; the contract and the JS codec always change together.

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
