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
const sh = (cmd, args) => execFileSync(bin(cmd), args, { encoding: 'utf8' }).trim();
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
  console.log(JSON.stringify({ chain: 'anvil 31337 @127.0.0.1', contract: addr, attesters, threshold: 2, submitStatus: tx.status, submitGas: Number(tx.gasUsed), verified: `${ok}/${fx.items.length}`, tamperedVerifies: tampered, verifyGasEstimate: Number(verifyGas) }, null, 1));
  if (ok !== fx.items.length || tampered !== 'false') process.exitCode = 1;
} finally {
  anvil.kill();
}
