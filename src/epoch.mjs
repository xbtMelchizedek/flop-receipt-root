// Build one epoch: finalized settlements from a pinned network -> leaves -> root -> message to sign.
import { toLeafFields, leafHash, hex } from './codec.mjs';
import { buildTree, proofFor, hexProof } from './merkle.mjs';

export const NETWORKS = {
  devnet: { explorer: 'https://explorer.devnet.flop.network', rpc: 'https://rpc.devnet.flop.network', genesis: '0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631' },
  // Testnet RPC: the testnet FAQ (docs.flop.network/docs/network-testnet, 2026-11-24) gives wss://testnet.flop.network/;
  // the same host answers HTTPS JSON-RPC. connectRpc refuses it unless its genesis is the one pinned here.
  testnet: { explorer: 'https://testnet.flopscan.io', rpc: 'https://testnet.flop.network',
    genesis: '0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800' },
};

/**
 * rows: explorer settlement rows. finalized: { number, hash } of a finalized block read from the same pinned chain.
 * Only rows at or below the finalized block are used. Rows must be "settled" or "force_settled" events.
 */
export function buildEpoch({ rows, finalized, genesis, epoch, fromBlock }) {
  const kept = [];
  const dropped = { notFinal: 0, beforeFrom: 0, notSettled: 0 };
  for (const r of rows) {
    if (!/^computeChannel\./.test(r.settlementEvent ?? '')) { dropped.notSettled++; continue; }
    if (Number(r.settledBlock) > finalized.number) { dropped.notFinal++; continue; }
    if (Number(r.settledBlock) < fromBlock) { dropped.beforeFrom++; continue; }
    kept.push(toLeafFields(r, genesis));
  }
  if (kept.length === 0) throw new Error('epoch: no finalized settlements in range');
  // One leaf per settlement event; a repeat of the same event in the feed is deduped, never double-counted.
  const seen = new Map();
  for (const f of kept) seen.set(`${f.channelId}:${f.settledBlock}:${f.eventIndex}`, f);
  const fields = [...seen.values()].sort((a, b) => Number(a.settledBlock) - Number(b.settledBlock) || a.channelId.localeCompare(b.channelId));
  const leaves = fields.map(leafHash);
  const tree = buildTree(leaves);
  const msg = {
    genesis,
    epoch: String(epoch),
    fromBlock: String(fromBlock),
    toBlock: String(finalized.number),
    toBlockHash: finalized.hash.toLowerCase(),
    count: String(fields.length),
    root: hex(tree.root),
  };
  const items = fields.map((f, i) => ({ fields: f, leaf: hex(leaves[i]), proof: hexProof(proofFor(tree, leaves[i])) }));
  const totals = fields.reduce((t, f) => ({ minerPaid: t.minerPaid + BigInt(f.minerPaid), aggregateGn: t.aggregateGn + BigInt(f.aggregateGn) }), { minerPaid: 0n, aggregateGn: 0n });
  return { msg, items, dropped, totals: { minerPaid: String(totals.minerPaid), aggregateGn: String(totals.aggregateGn) } };
}
