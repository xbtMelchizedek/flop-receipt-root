// A throwaway local anvil chain and small helpers around forge/cast. 127.0.0.1 only; refuses anything but a
// fresh chain 31337 on a port the OS just handed us, so it can never talk to someone else's node or fork.
// Anvil's own unlocked dev accounts send every transaction, so no key appears anywhere.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const foundryBin = (n) => {
  const home = join(process.env.HOME ?? '', '.foundry', 'bin', n);
  return existsSync(home) ? home : n; // fall back to PATH (CI installs foundry there)
};
export const sh = (cmd, args) => execFileSync(foundryBin(cmd), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const freePort = () => new Promise((res, rej) => {
  const srv = createServer().once('error', rej).listen(0, '127.0.0.1', () => {
    const p = srv.address().port;
    srv.close(() => res(p));
  });
});

/** Start anvil, check it is ours and fresh, return helpers. Always call stop(). */
export async function startAnvil() {
  const port = await freePort();
  const rpc = `http://127.0.0.1:${port}`;
  const proc = spawn(foundryBin('anvil'), ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
  const stop = () => proc.kill();
  try {
    let id = null;
    for (let i = 0; i < 50 && id === null; i++) {
      try { id = sh('cast', ['chain-id', '--rpc-url', rpc]); } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    if (id !== '31337' || proc.exitCode !== null) throw new Error(`not our fresh anvil (chain id ${id})`);
    if (sh('cast', ['block-number', '--rpc-url', rpc]) !== '0') throw new Error('anvil is not fresh');
  } catch (e) {
    stop();
    throw e;
  }
  const accounts = JSON.parse(sh('cast', ['rpc', 'eth_accounts', '--rpc-url', rpc]));
  const create = (from, what, args = []) => {
    const out = sh('forge', ['create', what, '--rpc-url', rpc, '--unlocked', '--from', from, '--broadcast', '--json', ...(args.length ? ['--constructor-args', ...args] : [])]);
    return JSON.parse(out.slice(out.indexOf('{'))).deployedTo;
  };
  const send = (from, to, sig, ...a) => JSON.parse(sh('cast', ['send', to, sig, ...a, '--rpc-url', rpc, '--unlocked', '--from', from, '--json']));
  const tries = (from, to, sig, ...a) => { try { send(from, to, sig, ...a); return 'accepted'; } catch { return 'reverted'; } };
  const call = (to, sig, ...a) => sh('cast', ['call', to, sig, ...a, '--rpc-url', rpc]);
  const estimate = (to, sig, ...a) => Number(sh('cast', ['estimate', to, sig, ...a, '--rpc-url', rpc]));
  const balance = (token, who) => BigInt(call(token, 'balanceOf(address)(uint256)', who).split(' ')[0]);
  const now = () => Number(sh('cast', ['block', 'latest', '--field', 'timestamp', '--rpc-url', rpc]));
  return { rpc, accounts, create, send, tries, call, estimate, balance, now, stop };
}

export const ROOT_MSG = '(bytes32,uint64,uint64,uint64,bytes32,uint32,bytes32)';
export const SETTLEMENT = '(bytes32,bytes32,uint64,bytes32,uint32,bytes32,bytes32,bytes32,uint128,uint128,uint128,uint128)';
export const VERIFY = `verify(uint64,${SETTLEMENT},bytes32[])(bool)`;
export const FILL = `fill(uint256,uint64,${SETTLEMENT},bytes32[])`;
export const POST = 'post(uint96,uint64,uint64,bytes32,bytes32,uint128)';
export const msgTuple = (m) => `(${m.genesis},${m.epoch},${m.fromBlock},${m.toBlock},${m.toBlockHash},${m.count},${m.root})`;
export const settlementTuple = (f) => `(${f.genesis},${f.channelId},${f.settledBlock},${f.settledBlockHash},${f.eventIndex},${f.agent},${f.miner},${f.modelHash},${f.aggregateGn},${f.minerPaid},${f.burned},${f.escrow})`;
export const proofArg = (p) => `[${p.join(',')}]`;
