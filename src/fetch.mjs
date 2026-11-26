// Read-only explorer reads with the genesis pinned. Source one of two: src/rpc.mjs re-reads every row from the chain.
import { NETWORKS } from './epoch.mjs';

const UA = { 'user-agent': 'flop-receipt-root/0.1 (+https://github.com/xbtMelchizedek/flop-receipt-root)', accept: 'application/json' };
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

async function getJson(fetchImpl, url) {
  const r = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${new URL(url).pathname} HTTP ${r.status}`);
  return r.json();
}

function isHealthMissing(err) {
  return /\/api\/health HTTP 404(?:\b|$)/.test(err?.message ?? '');
}

async function rpcCall(fetchImpl, rpcUrl, method, params) {
  const r = await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { ...UA, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`rpc ${method} HTTP ${r.status}`);
  const j = await r.json();
  if (j?.error) throw new Error(`rpc ${method}: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

function hexNumber(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) {
    const n = Number.parseInt(value, 16);
    if (Number.isSafeInteger(n)) return n;
  }
  return null;
}

async function finalizedHeadFromHealth(net, network, fetchImpl) {
  const h = await getJson(fetchImpl, `${net.explorer}/api/health`);
  const w = h?.writer ?? {};
  if (w.genesis !== net.genesis) throw new Error(`explorer genesis ${w.genesis} is not the pinned ${network} genesis`);
  if (!Number.isSafeInteger(w.sourceFinalizedHead) || !HASH_RE.test(w.sourceFinalizedHash ?? '')) {
    throw new Error('explorer health has no finalized head');
  }
  // The indexer must have caught up to the finalized block, or the epoch could silently miss settlements.
  if (!Number.isSafeInteger(w.indexedHead) || w.indexedHead < w.sourceFinalizedHead) {
    throw new Error(`explorer indexed head ${w.indexedHead} is behind finalized ${w.sourceFinalizedHead}`);
  }
  return { number: w.sourceFinalizedHead, hash: w.sourceFinalizedHash };
}

/** When /api/health is unpublished (testnet.flopscan.io returns 404), use /api/stats plus /api/blocks, then pin genesis and the block hash on the official RPC. */
async function finalizedHeadFromStats(net, network, fetchImpl, rpcFetch) {
  const s = await getJson(fetchImpl, `${net.explorer}/api/stats`);
  const pa = s?.protocolAccounts ?? {};
  const candidates = [pa.finalizedBlock, s?.finality?.finalizedBlock].filter((n) => Number.isSafeInteger(n));
  if (candidates.length === 0) throw new Error('explorer stats has no finalized head');
  const number = Math.min(...candidates);

  let hash = null;
  if (pa.finalizedBlock === number && HASH_RE.test(pa.finalizedHash ?? '')) {
    hash = String(pa.finalizedHash).toLowerCase();
  }
  const block = await getJson(fetchImpl, `${net.explorer}/api/blocks/${number}`);
  if (!HASH_RE.test(block?.hash ?? '') || Number(block.number) !== number) {
    throw new Error(`explorer block ${number} is unreadable`);
  }
  const blockHash = String(block.hash).toLowerCase();
  if (hash && hash !== blockHash) {
    throw new Error(`explorer stats hash ${hash} does not match /api/blocks/${number} ${blockHash}`);
  }
  hash = blockHash;

  const genesis = await rpcCall(rpcFetch, net.rpc, 'chain_getBlockHash', [0]);
  if (typeof genesis !== 'string' || genesis.toLowerCase() !== net.genesis) {
    throw new Error(`rpc genesis ${genesis} is not the pinned ${network} genesis`);
  }
  const rpcHash = await rpcCall(rpcFetch, net.rpc, 'chain_getBlockHash', [number]);
  if (typeof rpcHash !== 'string' || rpcHash.toLowerCase() !== hash) {
    throw new Error(`explorer finalized hash ${hash} does not match rpc block ${number} ${rpcHash}`);
  }
  const rpcFinHash = await rpcCall(rpcFetch, net.rpc, 'chain_getFinalizedHead', []);
  const rpcFinHeader = await rpcCall(rpcFetch, net.rpc, 'chain_getHeader', [rpcFinHash]);
  const rpcFinNum = hexNumber(rpcFinHeader?.number);
  if (!Number.isSafeInteger(rpcFinNum)) throw new Error('rpc finalized head has no block number');
  if (rpcFinNum < number) throw new Error(`explorer finalized ${number} is ahead of rpc finalized ${rpcFinNum}`);
  return { number, hash };
}

/** Finalized head as the explorer's writer saw it, refused unless the genesis is the pinned one. */
export async function finalizedHead(network, fetchImpl = globalThis.fetch, opts = {}) {
  const net = NETWORKS[network];
  if (!net) throw new Error(`unknown network ${network}`);
  try {
    return await finalizedHeadFromHealth(net, network, fetchImpl);
  } catch (e) {
    if (!isHealthMissing(e)) throw e;
    const rpcFetch = opts.rpcFetch ?? fetchImpl;
    return await finalizedHeadFromStats(net, network, fetchImpl, rpcFetch);
  }
}

/** Newest-first settlement rows down to fromBlock. Throws if maxRows would cut the range short. */
export async function settlementsSince(network, fromBlock, { maxRows = 1000, fetchImpl = globalThis.fetch } = {}) {
  const net = NETWORKS[network];
  if (!net) throw new Error(`unknown network ${network}`);
  const out = [];
  // The explorer caps a page at 100 rows; advance by what it actually returned.
  for (let offset = 0, pages = 0; out.length <= maxRows; pages++) {
    if (pages > 1000) throw new Error('settlement-prices: too many pages');
    const j = await getJson(fetchImpl, `${net.explorer}/api/settlement-prices?limit=100&offset=${offset}`);
    const rows = Array.isArray(j?.data) ? j.data : null;
    if (!rows) throw new Error('settlement-prices: no data array');
    if (rows.length === 0) return out;
    offset += rows.length;
    for (const r of rows) {
      if (Number(r.settledBlock) < fromBlock) return out;
      if (out.length >= maxRows) throw new Error(`more than ${maxRows} settlements since block ${fromBlock}; raise --max or a later --from`);
      out.push(r);
    }
    if (!j.pagination?.hasMore) return out;
  }
  throw new Error(`more than ${maxRows} settlements since block ${fromBlock}`);
}
