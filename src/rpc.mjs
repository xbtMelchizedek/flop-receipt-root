// Second source: the Flop chain itself over JSON-RPC (HTTPS). For every settlement the explorer reports,
// read the block, its events and the channel as it stood one block earlier, and compare field by field.
// Read-only: nothing here builds, signs or submits an extrinsic.
import { ss58ToPubkey } from './codec.mjs';
import { NETWORKS } from './epoch.mjs';

const lc = (s) => String(s).toLowerCase();
const int = (v) => {
  if (v === null || v === undefined) throw new Error('missing number');
  const s = typeof v === 'string' && v.startsWith('0x') ? BigInt(v).toString() : BigInt(String(v).replace(/,/g, '')).toString();
  return s;
};

/**
 * Plain-JSON chain facts for one explorer leaf. `api` is a connected @polkadot/api ApiPromise.
 * Everything is read by block hash, so the facts describe one fixed state.
 */
export async function readChainFacts(api, f) {
  const block = Number(f.settledBlock);
  const hash = (await api.rpc.chain.getBlockHash(block)).toHex();
  const header = await api.rpc.chain.getHeader(hash);
  const events = await (await api.at(hash)).query.system.events();
  const perPhase = new Map();
  const settled = [];
  events.forEach((rec, i) => {
    const phase = JSON.stringify(rec.phase.toJSON());
    const k = (perPhase.get(phase) ?? -1) + 1; // index of the event inside its extrinsic: the explorer's eventIndex
    perPhase.set(phase, k);
    const ev = rec.event;
    if (ev.section !== 'computeChannel' || ev.method !== 'Settled') return;
    settled.push({
      blockEventIndex: i, eventIndex: k,
      channelId: lc(ev.data[0].toHex()), minerPaid: ev.data[1].toString(), burned: ev.data[2].toString(), aggregateGn: ev.data[3].toString(),
    });
  });
  const parent = await api.at(header.parentHash);
  const ch = (await parent.query.computeChannel.channels(f.channelId)).toJSON();
  return {
    settledBlock: String(block),
    blockHash: lc(hash),
    settled,
    channel: ch ? { agent: ch.agent, miner: ch.miner, modelHash: lc(ch.modelHash), escrow: int(ch.escrow) } : null,
  };
}

/** Every way an explorer leaf can disagree with chain facts. An empty list means they agree. */
export function compareFacts(f, facts) {
  const bad = [];
  const id = `${f.channelId}@${f.settledBlock}#${f.eventIndex}`;
  const miss = (field, explorer, chain) => bad.push({ id, field, explorer: String(explorer), chain: String(chain) });
  if (!facts) return [{ id, field: 'facts', explorer: 'present', chain: 'missing' }];
  if (facts.settledBlock !== String(f.settledBlock)) miss('settledBlock', f.settledBlock, facts.settledBlock);
  if (facts.blockHash !== lc(f.settledBlockHash)) miss('settledBlockHash', f.settledBlockHash, facts.blockHash);
  const ev = facts.settled.filter((e) => e.channelId === lc(f.channelId) && String(e.eventIndex) === String(f.eventIndex));
  if (ev.length !== 1) miss('Settled event', `channel at index ${f.eventIndex}`, `${ev.length} matching of ${facts.settled.length}`);
  else {
    for (const k of ['minerPaid', 'burned', 'aggregateGn']) if (int(ev[0][k]) !== int(f[k])) miss(k, f[k], ev[0][k]);
  }
  const c = facts.channel;
  if (!c) miss('channel', 'open before settlement', 'absent');
  else {
    let agent, miner;
    try { agent = ss58ToPubkey(c.agent); } catch (e) { agent = `undecodable (${e.message})`; }
    try { miner = ss58ToPubkey(c.miner); } catch (e) { miner = `undecodable (${e.message})`; }
    if (agent !== lc(f.agent)) miss('agent', f.agent, agent);
    if (miner !== lc(f.miner)) miss('miner', f.miner, miner);
    if (c.modelHash !== lc(f.modelHash)) miss('modelHash', f.modelHash, c.modelHash);
    if (int(c.escrow) !== int(f.escrow)) miss('escrow', f.escrow, c.escrow);
  }
  return bad;
}

/** Connect over HTTPS JSON-RPC, refusing any chain whose genesis is not the pinned one. */
export async function connectRpc(network, url) {
  const net = NETWORKS[network];
  if (!net) throw new Error(`unknown network ${network}`);
  const rpc = url ?? net.rpc;
  if (!rpc) throw new Error(`no public RPC is known for ${network}; pass --rpc <https url>`);
  if (!/^https:\/\//.test(rpc) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(rpc)) throw new Error('--rpc must be https (or http on localhost)');
  const { ApiPromise, HttpProvider } = await import('@polkadot/api');
  const api = await ApiPromise.create({ provider: new HttpProvider(rpc), noInitWarn: true, throwOnConnect: true });
  const g = api.genesisHash.toHex();
  if (g !== net.genesis) {
    await api.disconnect();
    throw new Error(`rpc genesis ${g} is not the pinned ${network} genesis`);
  }
  return api;
}

/** Finalized head straight from the chain, so the explorer's own claim is checked too. */
export async function rpcFinalized(api) {
  const hash = await api.rpc.chain.getFinalizedHead();
  return { number: (await api.rpc.chain.getHeader(hash)).number.toNumber(), hash: lc(hash.toHex()) };
}

/** Canonical hash at a height, as the chain reports it. */
export async function rpcHashAt(api, n) {
  return lc((await api.rpc.chain.getBlockHash(n)).toHex());
}

/**
 * Cross-check an epoch built from the explorer. Throws, listing every disagreement, unless the chain agrees on
 * the finalized boundary and on every leaf. `chain` = { finalized(), hashAt(n), readFacts(fields) }; tests inject one.
 */
export async function crossCheck(epoch, chain, { concurrency = 4 } = {}) {
  const problems = [];
  const fin = await chain.finalized();
  const toBlock = Number(epoch.msg.toBlock);
  if (toBlock > fin.number) problems.push({ id: 'epoch', field: 'toBlock', explorer: toBlock, chain: `finalized ${fin.number}` });
  else {
    const h = await chain.hashAt(toBlock);
    if (h !== lc(epoch.msg.toBlockHash)) problems.push({ id: 'epoch', field: 'toBlockHash', explorer: epoch.msg.toBlockHash, chain: h });
  }
  const items = epoch.items;
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++];
      problems.push(...compareFacts(it.fields, await chain.readFacts(it.fields)));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (problems.length) {
    const e = new Error(`explorer and chain disagree on ${problems.length} point(s); refusing to build a root`);
    e.problems = problems;
    throw e;
  }
  return { checked: items.length, finalized: fin };
}
