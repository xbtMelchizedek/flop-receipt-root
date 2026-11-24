// Read-only explorer reads with the genesis pinned. Source one of two: src/rpc.mjs re-reads every row from the chain.
import { NETWORKS } from './epoch.mjs';

const UA = { 'user-agent': 'flop-receipt-root/0.1 (+https://github.com/xbtMelchizedek/flop-receipt-root)', accept: 'application/json' };

async function getJson(fetchImpl, url) {
  const r = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${new URL(url).pathname} HTTP ${r.status}`);
  return r.json();
}

/** Finalized head as the explorer's writer saw it, refused unless the genesis is the pinned one. */
export async function finalizedHead(network, fetchImpl = globalThis.fetch) {
  const net = NETWORKS[network];
  if (!net) throw new Error(`unknown network ${network}`);
  const h = await getJson(fetchImpl, `${net.explorer}/api/health`);
  const w = h?.writer ?? {};
  if (w.genesis !== net.genesis) throw new Error(`explorer genesis ${w.genesis} is not the pinned ${network} genesis`);
  if (!Number.isSafeInteger(w.sourceFinalizedHead) || !/^0x[0-9a-f]{64}$/.test(w.sourceFinalizedHash ?? '')) {
    throw new Error('explorer health has no finalized head');
  }
  // The indexer must have caught up to the finalized block, or the epoch could silently miss settlements.
  if (!Number.isSafeInteger(w.indexedHead) || w.indexedHead < w.sourceFinalizedHead) {
    throw new Error(`explorer indexed head ${w.indexedHead} is behind finalized ${w.sourceFinalizedHead}`);
  }
  return { number: w.sourceFinalizedHead, hash: w.sourceFinalizedHash };
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
