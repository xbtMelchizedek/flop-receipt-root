// End to end on a throwaway local anvil chain only: deploy, sign an epoch with fresh throwaway attester
// keys, submit it, verify settlements. The RPC is hardcoded to 127.0.0.1; it never touches a real network.
// Anvil's own unlocked dev account sends the transactions, so no key appears here.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

// Take a port the OS says is free, so we can never talk to someone else's anvil (or fork) by accident.
const PORT = await new Promise((res, rej) => {
  const srv = createServer().once('error', rej).listen(0, '127.0.0.1', () => {
    const p = srv.address().port;
    srv.close(() => res(p));
  });
});
const RPC = `http://127.0.0.1:${PORT}`;
const bin = (n) => join(process.env.HOME, '.foundry', 'bin', n);
const sh = (cmd, args) => execFileSync(bin(cmd), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const work = mkdtempSync(join(tmpdir(), 'frr-e2e-'));
process.env.FRR_KEY_DIR = join(work, 'keys');

const anvil = spawn(bin('anvil'), ['--host', '127.0.0.1', '--port', String(PORT), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
try {
  let id = null;
  for (let i = 0; i < 50 && id === null; i++) {
    try { id = sh('cast', ['chain-id', '--rpc-url', RPC]); } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  if (id !== '31337' || anvil.exitCode !== null) throw new Error(`not our fresh anvil (chain id ${id})`);
  if (sh('cast', ['block-number', '--rpc-url', RPC]) !== '0') throw new Error('anvil is not fresh');
  const from = JSON.parse(sh('cast', ['rpc', 'eth_accounts', '--rpc-url', RPC]))[0];
  const { main } = await import('../src/cli.mjs');
  let keyOut;
  await main(['keygen', '--n', '3'], { out: (s) => (keyOut = JSON.parse(s)) });
  const attesters = keyOut.attesters;
  const fx = JSON.parse(readFileSync(new URL('../test/fixtures/epoch.json', import.meta.url), 'utf8'));
  const m = fx.msg;
  const dep = sh('forge', [
    'create', 'contracts/src/FlopReceiptRoot.sol:FlopReceiptRoot', '--rpc-url', RPC, '--unlocked', '--from', from, '--broadcast', '--json',
    '--constructor-args', m.genesis, m.fromBlock, `[${attesters.join(',')}]`, '2',
  ]);
  const addr = JSON.parse(dep.slice(dep.indexOf('{'))).deployedTo;
  const epochFile = join(work, 'epoch.json');
  writeFileSync(epochFile, JSON.stringify({ msg: m, items: fx.items, sigs: [] }));
  await main(['sign', '--epoch-file', epochFile, '--chain-id', '31337', '--contract', addr, '--keys', '1,3'], { out: () => {} });
  const signed = JSON.parse(readFileSync(epochFile, 'utf8'));
  const tuple = `(${m.genesis},${m.epoch},${m.fromBlock},${m.toBlock},${m.toBlockHash},${m.count},${m.root})`;
  const tx = JSON.parse(sh('cast', ['send', addr, 'submit((bytes32,uint64,uint64,uint64,bytes32,uint32,bytes32),bytes[])', tuple, `[${signed.sigs.join(',')}]`, '--rpc-url', RPC, '--unlocked', '--from', from, '--json']));
  const S = 'verify(uint64,(bytes32,bytes32,uint64,bytes32,uint32,bytes32,bytes32,bytes32,uint128,uint128,uint128,uint128),bytes32[])(bool)';
  const st = (f) => `(${f.genesis},${f.channelId},${f.settledBlock},${f.settledBlockHash},${f.eventIndex},${f.agent},${f.miner},${f.modelHash},${f.aggregateGn},${f.minerPaid},${f.burned},${f.escrow})`;
  let ok = 0;
  for (const it of fx.items) if (sh('cast', ['call', addr, S, '1', st(it.fields), `[${it.proof.join(',')}]`, '--rpc-url', RPC]) === 'true') ok++;
  const bad = { ...fx.items[0].fields, minerPaid: String(BigInt(fx.items[0].fields.minerPaid) + 1n) };
  const tampered = sh('cast', ['call', addr, S, '1', st(bad), `[${fx.items[0].proof.join(',')}]`, '--rpc-url', RPC]);
  const verifyGas = sh('cast', ['estimate', addr, S.replace('(bool)', ''), '1', st(fx.items[0].fields), `[${fx.items[0].proof.join(',')}]`, '--rpc-url', RPC]);

  // Intent escrow against a test-only mock USDC: post, bond, claim, fill with a real devnet settlement.
  const solver = JSON.parse(sh('cast', ['rpc', 'eth_accounts', '--rpc-url', RPC]))[1];
  const create = (what, args = []) => {
    const out = sh('forge', ['create', what, '--rpc-url', RPC, '--unlocked', '--from', from, '--broadcast', '--json', ...(args.length ? ['--constructor-args', ...args] : [])]);
    return JSON.parse(out.slice(out.indexOf('{'))).deployedTo;
  };
  const send = (who, to, sig, ...a) => JSON.parse(sh('cast', ['send', to, sig, ...a, '--rpc-url', RPC, '--unlocked', '--from', who, '--json']));
  const tries = (who, to, sig, ...a) => { try { send(who, to, sig, ...a); return 'accepted'; } catch { return 'reverted'; } };
  const bal = (tok, who) => BigInt(sh('cast', ['call', tok, 'balanceOf(address)(uint256)', who, '--rpc-url', RPC]).split(' ')[0]);
  const usdc = create('contracts/test/mocks/MockUSDC.sol:MockUSDC');
  const esc = create('contracts/src/IntentEscrow.sol:IntentEscrow', [usdc, addr, '1000000000', '2000', '3600']);
  const AMT = 10_000_000n; // 10 mock USDC
  for (const w of [from, solver]) {
    send(w, usdc, 'mint(address,uint256)', w, '100000000');
    send(w, usdc, 'approve(address,uint256)', esc, '100000000');
  }
  const it5 = fx.items[5];
  const f5 = it5.fields;
  const now = Number(sh('cast', ['block', 'latest', '--field', 'timestamp', '--rpc-url', RPC]));
  send(from, esc, 'post(uint96,uint64,uint64,bytes32,bytes32,uint128)', String(AMT), String(now + 86400), f5.settledBlock, f5.agent, f5.modelHash, f5.aggregateGn);
  send(solver, esc, 'deposit(uint256)', '2000000');
  send(solver, esc, 'claim(uint256)', '1');
  const F = 'fill(uint256,uint64,(bytes32,bytes32,uint64,bytes32,uint32,bytes32,bytes32,bytes32,uint128,uint128,uint128,uint128),bytes32[])';
  const tamperedFill = tries(solver, esc, F, '1', '1', st({ ...f5, minerPaid: String(BigInt(f5.minerPaid) + 1n) }), `[${it5.proof.join(',')}]`);
  const before = bal(usdc, solver);
  const fillTx = send(solver, esc, F, '1', '1', st(f5), `[${it5.proof.join(',')}]`);
  const solverGot = bal(usdc, solver) - before;
  send(from, esc, 'post(uint96,uint64,uint64,bytes32,bytes32,uint128)', String(AMT), String(now + 86400), f5.settledBlock, f5.agent, f5.modelHash, f5.aggregateGn);
  send(solver, esc, 'claim(uint256)', '2');
  const reuse = tries(solver, esc, F, '2', '1', st(f5), `[${it5.proof.join(',')}]`);
  const escrowHeld = bal(usdc, esc);
  const escrow = { mockUsdc: usdc, escrow: esc, tamperedFill, fillStatus: fillTx.status, fillGas: Number(fillTx.gasUsed), solverPaid: String(solverGot), sameSettlementAgain: reuse, escrowHolds: String(escrowHeld) };
  console.log(JSON.stringify({ chain: 'anvil 31337 @127.0.0.1', contract: addr, attesters, threshold: 2, submitStatus: tx.status, submitGas: Number(tx.gasUsed), verified: `${ok}/${fx.items.length}`, tamperedVerifies: tampered, verifyGasEstimate: Number(verifyGas), escrow }, null, 1));
  // After fill 1: solver's 2 USDC bond is free again and re-locked by claim 2; escrow holds intent 2 (10) + that bond (2).
  if (ok !== fx.items.length || tampered !== 'false' || tamperedFill !== 'reverted' || reuse !== 'reverted' || solverGot !== AMT || escrowHeld !== AMT + 2_000_000n) process.exitCode = 1;
} finally {
  anvil.kill();
}
