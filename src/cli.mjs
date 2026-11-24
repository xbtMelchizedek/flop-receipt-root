#!/usr/bin/env node
// flop-receipt-root CLI. Reads public explorer data, builds roots, signs with throwaway local keys.
// It never sends a transaction to any network.
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildEpoch, NETWORKS } from './epoch.mjs';
import { finalizedHead, settlementsSince } from './fetch.mjs';
import { addressOf, signRoot, sortBySigner } from './attest.mjs';
import { connectRpc, crossCheck, readChainFacts, rpcFinalized, rpcHashAt } from './rpc.mjs';
import { findItem, proofBundle, verifyReceipt } from './receipt.mjs';

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
  build  --network devnet|testnet (--from <block> | --last <blocks>) [--max <rows>] [--epoch <n>] [--rpc <https url>] --out <file>
         # every leaf is re-read from the chain over JSON-RPC; any disagreement refuses the build
  check  --epoch-file <file> [--rpc <https url>]   # re-run the chain cross-check on an existing epoch file
  proof  --epoch-file <file> (--leaf <0x..> | --channel <0x..> --block <n>) [--contract <0x..>] [--intent <id>]
         # settlement tuple, proof, ABI calldata for verify (and fill with --intent), and a ready cast call line
  verify --epoch-file <file> (--leaf <0x..> | --channel <0x..> --block <n>) [--chain-id <id> --contract <0x..>]
         [--attesters 0x..,0x..] [--threshold <k>] [--rpc <https url> | --chain]
         # offline: leaf, range, proof, attester quorum; --rpc/--chain also re-reads the settlement from the chain
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
    if ((o.from === undefined) === (o.last === undefined)) throw new Error('give exactly one of --from <block> or --last <blocks>');
    const epoch = uint('epoch', o.epoch ?? '1');
    const maxRows = uint('max', o.max ?? '1000');
    if (!o.out) throw new Error('--out is required');
    const finalized = await finalizedHead(o.network, fetchImpl);
    const fromBlock = o.from !== undefined ? uint('from', o.from) : Math.max(0, finalized.number - uint('last', o.last));
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
  if (cmd === 'proof' || cmd === 'verify') {
    const e = JSON.parse(readFileSync(o['epoch-file'], 'utf8'));
    const item = findItem(e, { leaf: o.leaf, channel: o.channel, block: o.block });
    if (o.contract !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(o.contract)) throw new Error('--contract must be a 20-byte address');
    if (cmd === 'proof') {
      const intentId = o.intent === undefined ? undefined : String(uint('intent', o.intent));
      out(JSON.stringify(proofBundle(e, item, { contract: o.contract, intentId }), null, 1));
      return 0;
    }
    const attesters = o.attesters?.split(',').map((a) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`--attesters: ${a} is not an address`);
      return a.toLowerCase();
    });
    let chain = null;
    if (o.rpc !== undefined || o.chain !== undefined) {
      const network = Object.keys(NETWORKS).find((k) => NETWORKS[k].genesis === e.msg?.genesis);
      if (!network) throw new Error('epoch genesis is not a pinned network; cannot re-read the chain');
      chain = chainImpl ?? (await openChain(network, o.rpc));
    }
    try {
      const steps = await verifyReceipt(e, item, {
        chainId: o['chain-id'] === undefined ? undefined : uint('chain-id', o['chain-id']),
        contract: o.contract, attesters, threshold: o.threshold === undefined ? undefined : uint('threshold', o.threshold), chain,
      });
      for (const s of steps) out(JSON.stringify(s));
      return steps.every((s) => s.ok) ? 0 : 1;
    } finally {
      await chain?.close?.();
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

/** True when this file is the process entry, also through an npm/npx bin symlink. */
function isEntry() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntry()) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(JSON.stringify({ ok: false, error: e.message })); process.exit(2); });
}
