// End to end on a throwaway local anvil chain only: deploy, sign an epoch with fresh throwaway attester
// keys, submit it, verify settlements, then run the intent escrow against mock USDC.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAnvil, msgTuple, settlementTuple, proofArg, ROOT_MSG, VERIFY, FILL, POST } from './lib/anvil.mjs';

const work = mkdtempSync(join(tmpdir(), 'frr-e2e-'));
process.env.FRR_KEY_DIR = join(work, 'keys');
const c = await startAnvil();
try {
  const [from, solver] = c.accounts;
  const { main } = await import('../src/cli.mjs');
  let keyOut;
  await main(['keygen', '--n', '3'], { out: (s) => (keyOut = JSON.parse(s)) });
  const attesters = keyOut.attesters;
  const fx = JSON.parse(readFileSync(new URL('../test/fixtures/epoch.json', import.meta.url), 'utf8'));
  const m = fx.msg;
  const addr = c.create(from, 'contracts/src/FlopReceiptRoot.sol:FlopReceiptRoot', [m.genesis, m.fromBlock, `[${attesters.join(',')}]`, '2']);
  const epochFile = join(work, 'epoch.json');
  writeFileSync(epochFile, JSON.stringify({ msg: m, items: fx.items, sigs: [] }));
  await main(['sign', '--epoch-file', epochFile, '--chain-id', '31337', '--contract', addr, '--keys', '1,3'], { out: () => {} });
  const signed = JSON.parse(readFileSync(epochFile, 'utf8'));
  const tx = c.send(from, addr, `submit(${ROOT_MSG},bytes[])`, msgTuple(m), `[${signed.sigs.join(',')}]`);
  let ok = 0;
  for (const it of fx.items) if (c.call(addr, VERIFY, '1', settlementTuple(it.fields), proofArg(it.proof)) === 'true') ok++;
  const bad = { ...fx.items[0].fields, minerPaid: String(BigInt(fx.items[0].fields.minerPaid) + 1n) };
  const tampered = c.call(addr, VERIFY, '1', settlementTuple(bad), proofArg(fx.items[0].proof));
  // The CLI's `proof` calldata, sent raw, must verify on the real contract; `verify` must pass offline with the
  // attester set pinned to the keys the contract was deployed with.
  let bundle;
  await main(['proof', '--epoch-file', epochFile, '--leaf', fx.items[0].leaf, '--contract', addr], { out: (s) => (bundle = JSON.parse(s)) });
  const rawCall = JSON.parse(c.rpcCall('eth_call', JSON.stringify({ to: addr, data: bundle.verifyCalldata }), '"latest"'));
  const cliProofVerifies = BigInt(rawCall) === 1n;
  const steps = [];
  const cliVerifyExit = await main(['verify', '--epoch-file', epochFile, '--leaf', fx.items[0].leaf, '--attesters', attesters.join(','), '--threshold', '2'], { out: (s) => steps.push(JSON.parse(s)) });
  const verifyGas = c.estimate(addr, VERIFY.replace('(bool)', ''), '1', settlementTuple(fx.items[0].fields), proofArg(fx.items[0].proof));

  // Intent escrow against a test-only mock USDC: post, bond, claim, fill with a real devnet settlement.
  const usdc = c.create(from, 'contracts/test/mocks/MockUSDC.sol:MockUSDC');
  const esc = c.create(from, 'contracts/src/IntentEscrow.sol:IntentEscrow', [usdc, addr, '1000000000', '2000', '3600']);
  const AMT = 10_000_000n; // 10 mock USDC
  for (const w of [from, solver]) {
    c.send(w, usdc, 'mint(address,uint256)', w, '100000000');
    c.send(w, usdc, 'approve(address,uint256)', esc, '100000000');
  }
  const it5 = fx.items[5];
  const f5 = it5.fields;
  const now = c.now();
  c.send(from, esc, POST, String(AMT), String(now + 86400), f5.settledBlock, f5.agent, f5.modelHash, f5.aggregateGn);
  c.send(solver, esc, 'deposit(uint256)', '2000000');
  c.send(solver, esc, 'claim(uint256)', '1');
  const tamperedFill = c.tries(solver, esc, FILL, '1', '1', settlementTuple({ ...f5, minerPaid: String(BigInt(f5.minerPaid) + 1n) }), proofArg(it5.proof));
  const before = c.balance(usdc, solver);
  const fillTx = c.send(solver, esc, FILL, '1', '1', settlementTuple(f5), proofArg(it5.proof));
  const solverGot = c.balance(usdc, solver) - before;
  c.send(from, esc, POST, String(AMT), String(now + 86400), f5.settledBlock, f5.agent, f5.modelHash, f5.aggregateGn);
  c.send(solver, esc, 'claim(uint256)', '2');
  const reuse = c.tries(solver, esc, FILL, '2', '1', settlementTuple(f5), proofArg(it5.proof));
  const escrowHeld = c.balance(usdc, esc);
  const escrow = { mockUsdc: usdc, escrow: esc, tamperedFill, fillStatus: fillTx.status, fillGas: Number(fillTx.gasUsed), solverPaid: String(solverGot), sameSettlementAgain: reuse, escrowHolds: String(escrowHeld) };
  console.log(JSON.stringify({ chain: 'anvil 31337 @127.0.0.1', contract: addr, attesters, threshold: 2, submitStatus: tx.status, submitGas: Number(tx.gasUsed), verified: `${ok}/${fx.items.length}`, tamperedVerifies: tampered, verifyGasEstimate: verifyGas, cliProofVerifies, cliVerify: { exit: cliVerifyExit, steps: steps.map((x) => `${x.step}:${x.ok}`) }, escrow }, null, 1));
  // After fill 1: solver's 2 USDC bond is free again and re-locked by claim 2; escrow holds intent 2 (10) + that bond (2).
  if (ok !== fx.items.length || !cliProofVerifies || cliVerifyExit !== 0 || steps.length !== 4 || tampered !== 'false' || tamperedFill !== 'reverted' || reuse !== 'reverted' || solverGot !== AMT || escrowHeld !== AMT + 2_000_000n) process.exitCode = 1;
} finally {
  c.stop();
}
