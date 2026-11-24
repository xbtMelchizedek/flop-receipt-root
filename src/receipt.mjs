// One receipt at a time: find it in an epoch file, print contract calldata for it, and verify it offline
// (leaf, range, Merkle proof, attester quorum) with an optional re-read from the chain.
// Read-only: nothing here signs or sends anything.
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils';
import { keccak, hex, unhex, word, leafHash } from './codec.mjs';
import { verifyProof } from './merkle.mjs';
import { recoverSigner } from './attest.mjs';
import { compareFacts } from './rpc.mjs';

export const SETTLEMENT = '(bytes32,bytes32,uint64,bytes32,uint32,bytes32,bytes32,bytes32,uint128,uint128,uint128,uint128)';
export const VERIFY_SIG = `verify(uint64,${SETTLEMENT},bytes32[])`;
export const FILL_SIG = `fill(uint256,uint64,${SETTLEMENT},bytes32[])`;
const FIELD_WORDS = [
  ['genesis', 'bytes32'], ['channelId', 'bytes32'], ['settledBlock', 64], ['settledBlockHash', 'bytes32'], ['eventIndex', 32],
  ['agent', 'bytes32'], ['miner', 'bytes32'], ['modelHash', 'bytes32'], ['aggregateGn', 128], ['minerPaid', 128], ['burned', 128], ['escrow', 128],
];

const lc = (s) => String(s ?? '').toLowerCase();

/** The item for a leaf hash, or for a channel settled in a given block. Throws if absent or ambiguous. */
export function findItem(epoch, { leaf, channel, block } = {}) {
  if (!Array.isArray(epoch?.items)) throw new Error('not an epoch file (no items)');
  let hits;
  if (leaf) hits = epoch.items.filter((it) => lc(it.leaf) === lc(leaf));
  else if (channel && block !== undefined) hits = epoch.items.filter((it) => lc(it.fields.channelId) === lc(channel) && String(it.fields.settledBlock) === String(block));
  else throw new Error('give --leaf <0x..> or --channel <0x..> --block <n>');
  if (hits.length === 0) throw new Error(`no settlement ${leaf ?? `${channel}@${block}`} in epoch ${epoch.msg?.epoch}`);
  if (hits.length > 1) throw new Error(`${hits.length} settlements match; use --leaf`);
  return hits[0];
}

/** cast-style tuple and array strings, in the contract's field order. */
export const settlementTuple = (f) => `(${FIELD_WORDS.map(([k]) => f[k]).join(',')})`;
export const proofArg = (p) => `[${p.join(',')}]`;

const selector = (sig) => keccak(utf8ToBytes(sig)).subarray(0, 4);

/** ABI calldata for FlopReceiptRoot.verify, or IntentEscrow.fill when intentId is given. */
export function calldata(epochNumber, fields, proof, { intentId } = {}) {
  const head = intentId === undefined ? [word(epochNumber, 64)] : [word(intentId, 256), word(epochNumber, 64)];
  const s = FIELD_WORDS.map(([k, t]) => word(fields[k], t));
  const offset = word(32 * (head.length + s.length + 1), 256);
  const tail = [word(proof.length, 256), ...proof.map((p) => word(p, 'bytes32'))];
  return hex(concatBytes(selector(intentId === undefined ? VERIFY_SIG : FILL_SIG), ...head, ...s, offset, ...tail));
}

/** Everything `proof` prints for one item. */
export function proofBundle(epoch, item, { contract, intentId, rpcUrl = '$RPC' } = {}) {
  const e = epoch.msg.epoch;
  const to = contract ?? epoch.contract ?? epoch.domain?.verifyingContract ?? '<FlopReceiptRoot>';
  const out = {
    epoch: e, leaf: item.leaf, root: epoch.msg.root,
    settlement: settlementTuple(item.fields), proof: item.proof,
    verifyCalldata: calldata(e, item.fields, item.proof),
    cast: `cast call ${to} '${VERIFY_SIG}(bool)' ${e} '${settlementTuple(item.fields)}' '${proofArg(item.proof)}' --rpc-url ${rpcUrl}`,
  };
  if (intentId !== undefined) out.fillCalldata = calldata(e, item.fields, item.proof, { intentId });
  return out;
}

/**
 * Verify one receipt. Returns [{step, ok, detail}] for each step that ran; `chain` (optional) is
 * { finalized(), readFacts(fields) } as in crossCheck. Quorum runs when a domain (chainId + contract) is known.
 */
export async function verifyReceipt(epoch, item, { chainId, contract, attesters, threshold, chain } = {}) {
  const steps = [];
  const step = (name, ok, detail) => steps.push({ step: name, ok, detail });
  const m = epoch.msg;
  const f = item.fields;

  const leaf = hex(leafHash(f));
  step('leaf', leaf === lc(item.leaf), leaf === lc(item.leaf) ? `fields hash to ${leaf}` : `fields hash to ${leaf}, file says ${item.leaf}`);

  const inRange = lc(f.genesis) === lc(m.genesis) && BigInt(f.settledBlock) >= BigInt(m.fromBlock) && BigInt(f.settledBlock) <= BigInt(m.toBlock);
  step('range', inRange, inRange ? `block ${f.settledBlock} in ${m.fromBlock}..${m.toBlock}, same genesis` : `block ${f.settledBlock} / genesis outside epoch ${m.epoch} (${m.fromBlock}..${m.toBlock})`);

  let proofOk = false;
  try { proofOk = verifyProof(unhex(m.root), unhex(leaf), item.proof.map(unhex)); } catch { /* malformed proof */ }
  step('proof', proofOk, proofOk ? `${item.proof.length} hashes up to root ${m.root}` : `proof does not reach root ${m.root}`);

  const cid = chainId ?? epoch.chainId ?? epoch.domain?.chainId;
  const vc = contract ?? epoch.contract ?? epoch.domain?.verifyingContract;
  if (cid !== undefined && vc) {
    const set = (attesters ?? epoch.attesters ?? []).map(lc);
    const k = Number(threshold ?? epoch.threshold);
    const signers = [];
    const problems = [];
    for (const s of epoch.sigs ?? []) {
      try { signers.push(recoverSigner(m, cid, vc, s)); } catch (e) { problems.push(`bad signature: ${e.message}`); }
    }
    const distinct = new Set(signers);
    if (distinct.size !== signers.length) problems.push('the same attester signed twice');
    const valid = [...distinct].filter((a) => set.includes(a));
    if (valid.length < distinct.size) problems.push(`${distinct.size - valid.length} signer(s) not in the attester set`);
    const ok = Number.isSafeInteger(k) && k > 0 && set.length > 0 && valid.length >= k && problems.length === 0;
    const pinned = attesters ? 'attester set pinned by --attesters' : 'attester set read from the epoch file (pin it with --attesters)';
    step('quorum', ok, `${valid.length} of ${set.length} attesters signed, threshold ${Number.isSafeInteger(k) ? k : '?'}, chain ${cid}, contract ${vc}; ${pinned}${problems.length ? `; ${problems.join('; ')}` : ''}`);
  }

  if (chain) {
    try {
      const fin = await chain.finalized();
      const facts = await chain.readFacts(f);
      const problems = compareFacts(f, facts);
      if (Number(f.settledBlock) > fin.number) problems.push({ field: 'finality', explorer: f.settledBlock, chain: `finalized ${fin.number}` });
      step('chain', problems.length === 0, problems.length ? problems.map((p) => `${p.field}: file ${p.explorer}, chain ${p.chain}`).join('; ') : `chain agrees on every field; block ${f.settledBlock} is finalized (head ${fin.number})`);
    } catch (e) {
      step('chain', false, `could not read the chain: ${e.message}`);
    }
  }
  return steps;
}
