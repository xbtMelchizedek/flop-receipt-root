#!/usr/bin/env node
// flop-receipt-root CLI. Reads public explorer data, builds roots, signs with throwaway local keys.
// It never sends a transaction to any network.
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildEpoch, NETWORKS } from './epoch.mjs';
import { finalizedHead, settlementsSince } from './fetch.mjs';
import { addressOf, signRoot, sortBySigner } from './attest.mjs';
import { connectRpc, crossCheck, readChainFacts, rpcFinalized, rpcHashAt } from './rpc.mjs';

/** The real chain as a second source. Tests inject their own. */
async function openChain(network, url) {
  const api = await connectRpc(network, url);
  return {
    finalized: () => rpcFinalized(api),
    hashAt: (n) => rpcHashAt(api, n),
    readFacts: (f) => readChainFacts(api, f),
    close: () => api.disconnect(),
  };
}

const HELP = `flop-receipt-root
  build  --network devnet|testnet --from <block> [--max <rows>] [--epoch <n>] [--rpc <https url>] --out <file>
         # every leaf is re-read from the chain over JSON-RPC; any disagreement refuses the build
  check  --epoch-file <file> [--rpc <https url>]   # re-run the chain cross-check on an existing epoch file
  keygen --n <count>                      # throwaway attester keys in ~/.secrets/flop-receipt-root (mode 600)
  sign   --epoch-file <file> --chain-id <id> --contract <0x..> [--keys 1,2]   # adds sigs to the file
Never broadcasts. Keys are local test keys with no funds; never reuse them anywhere.`;

const KEY_DIR = process.env.FRR_KEY_DIR ?? join(homedir(), '.secrets', 'flop-receipt-root');

function args(argv) {
  const [cmd, ...rest] = argv;
  const o = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) throw new Error(`bad argument ${rest[i]}`);
    o[rest[i].slice(2)] = rest[i + 1];
  }
  return { cmd, o };
}
const uint = (k, v) => {
  if (!/^\d+$/.test(v ?? '')) throw new Error(`--${k} must be a whole number`);
  return Number(v);
};

export async function main(argv, { fetchImpl = globalThis.fetch, out = console.log, chainImpl } = {}) {
  const { cmd, o } = args(argv);
  if (cmd === 'build') {
    if (!NETWORKS[o.network]) throw new Error('--network must be devnet or testnet');
    const fromBlock = uint('from', o.from);
    const epoch = uint('epoch', o.epoch ?? '1');
    const maxRows = uint('max', o.max ?? '1000');
    if (!o.out) throw new Error('--out is required');
    const finalized = await finalizedHead(o.network, fetchImpl);
    const rows = await settlementsSince(o.network, fromBlock, { maxRows, fetchImpl });
    const e = buildEpoch({ rows, finalized, genesis: NETWORKS[o.network].genesis, epoch, fromBlock });
    const chain = chainImpl ?? (await openChain(o.network, o.rpc));
    let cc;
    try {
      cc = await crossCheck(e, chain);
    } catch (err) {
      if (err.problems) out(JSON.stringify({ ok: false, error: err.message, problems: err.problems.slice(0, 50) }));
      throw err; // nothing is written: a root the chain disagrees with is never built
    } finally {
      await chain.close?.();
    }
    const sources = { explorer: NETWORKS[o.network].explorer, rpc: o.rpc ?? NETWORKS[o.network].rpc, rpcChecked: cc.checked, rpcFinalized: cc.finalized.number };
    writeFileSync(o.out, JSON.stringify({ network: o.network, builtAt: new Date().toISOString(), source: NETWORKS[o.network].explorer, sources, ...e, sigs: [] }, null, 1));
    out(JSON.stringify({ ok: true, ...e.msg, dropped: e.dropped, totals: e.totals, rpcChecked: cc.checked }));
    return 0;
  }
  if (cmd === 'check') {
    const e = JSON.parse(readFileSync(o['epoch-file'], 'utf8'));
    const network = e.network ?? Object.keys(NETWORKS).find((k) => NETWORKS[k].genesis === e.msg?.genesis);
    if (!NETWORKS[network] || NETWORKS[network].genesis !== e.msg?.genesis) throw new Error('epoch genesis is not a pinned network');
    const chain = chainImpl ?? (await openChain(network, o.rpc));
    try {
      const cc = await crossCheck(e, chain);
      out(JSON.stringify({ ok: true, network, checked: cc.checked, root: e.msg.root, rpcFinalized: cc.finalized.number }));
      return 0;
    } catch (err) {
      if (!err.problems) throw err;
      out(JSON.stringify({ ok: false, error: err.message, problems: err.problems.slice(0, 50) }));
      return 1;
    } finally {
      await chain.close?.();
    }
  }
  if (cmd === 'keygen') {
    const n = uint('n', o.n);
    if (n < 1 || n > 16) throw new Error('--n must be 1..16');
    mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
    chmodSync(KEY_DIR, 0o700);
    const addrs = [];
    for (let i = 1; i <= n; i++) {
      const f = join(KEY_DIR, `attester-${i}.key`);
      if (!existsSync(f)) writeFileSync(f, '0x' + randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
      if ((statSync(f).mode & 0o077) !== 0) throw new Error(`${f} is readable by others; refusing`);
      addrs.push(addressOf(readFileSync(f, 'utf8').trim()));
    }
    out(JSON.stringify({ ok: true, dir: KEY_DIR, attesters: addrs })); // addresses only, never keys
    return 0;
  }
  if (cmd === 'sign') {
    const file = o['epoch-file'];
    const e = JSON.parse(readFileSync(file, 'utf8'));
    const chainId = uint('chain-id', o['chain-id']);
    if (!/^0x[0-9a-fA-F]{40}$/.test(o.contract ?? '')) throw new Error('--contract must be a 20-byte address');
    const ids = (o.keys ?? '1').split(',').map((x) => uint('keys', x));
    const sigs = ids.map((i) => signRoot(e.msg, chainId, o.contract, readFileSync(join(KEY_DIR, `attester-${i}.key`), 'utf8').trim()));
    e.sigs = sortBySigner(e.msg, chainId, o.contract, sigs);
    e.domain = { chainId, verifyingContract: o.contract };
    writeFileSync(file, JSON.stringify(e, null, 1));
    out(JSON.stringify({ ok: true, signed: e.sigs.length }));
    return 0;
  }
  out(HELP);
  return cmd ? 2 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(2); });
}
