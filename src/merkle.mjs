// Sorted-pair keccak Merkle tree (same rule as OpenZeppelin's MerkleProof): parent = keccak(min(a,b) || max(a,b)).
// Leaves are sorted before building so the root is independent of input order.
import { keccak, hex } from './codec.mjs';
import { concatBytes } from '@noble/hashes/utils';

const cmp = (a, b) => {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
const pair = (a, b) => (cmp(a, b) <= 0 ? keccak(concatBytes(a, b)) : keccak(concatBytes(b, a)));

export function buildTree(leaves) {
  if (leaves.length === 0) throw new Error('merkle: no leaves');
  const sorted = [...leaves].sort(cmp);
  for (let i = 1; i < sorted.length; i++) if (cmp(sorted[i - 1], sorted[i]) === 0) throw new Error('merkle: duplicate leaf');
  const layers = [sorted];
  while (layers.at(-1).length > 1) {
    const prev = layers.at(-1);
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? pair(prev[i], prev[i + 1]) : prev[i]);
    layers.push(next);
  }
  return { root: layers.at(-1)[0], layers };
}

export function proofFor(tree, leaf) {
  let idx = tree.layers[0].findIndex((l) => cmp(l, leaf) === 0);
  if (idx < 0) throw new Error('merkle: leaf not in tree');
  const proof = [];
  for (const layer of tree.layers.slice(0, -1)) {
    const sib = idx ^ 1;
    if (sib < layer.length) proof.push(layer[sib]);
    idx >>= 1;
  }
  return proof;
}

export function verifyProof(root, leaf, proof) {
  let h = leaf;
  for (const p of proof) h = pair(h, p);
  return cmp(h, root) === 0;
}

export const hexProof = (p) => p.map(hex);
