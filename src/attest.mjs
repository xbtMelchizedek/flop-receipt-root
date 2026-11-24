// Attester signatures over an epoch root (EIP-712). Keys here are throwaway local test keys only.
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak, hex, unhex, digest712 } from './codec.mjs';

export function addressOf(privHex) {
  const pub = secp256k1.getPublicKey(unhex(privHex), false).subarray(1);
  return hex(keccak(pub).subarray(12));
}

/** 65-byte r||s||v with low s (the contract rejects high s). */
export function signRoot(m, chainId, verifyingContract, privHex) {
  const sig = secp256k1.sign(digest712(m, chainId, verifyingContract), unhex(privHex), { lowS: true });
  const r = sig.r.toString(16).padStart(64, '0');
  const s = sig.s.toString(16).padStart(64, '0');
  return `0x${r}${s}${(27 + sig.recovery).toString(16)}`;
}

export function recoverSigner(m, chainId, verifyingContract, sigHex) {
  const b = unhex(sigHex);
  if (b.length !== 65) throw new Error('signature must be 65 bytes');
  const v = b[64];
  if (v !== 27 && v !== 28) throw new Error('bad v');
  const sig = secp256k1.Signature.fromCompact(b.subarray(0, 64)).addRecoveryBit(v - 27);
  if (sig.hasHighS()) throw new Error('high s');
  const pub = sig.recoverPublicKey(digest712(m, chainId, verifyingContract)).toRawBytes(false).subarray(1);
  return hex(keccak(pub).subarray(12));
}

/** Signatures sorted by signer address ascending, which is how the contract proves they are distinct. */
export function sortBySigner(m, chainId, verifyingContract, sigs) {
  return sigs
    .map((s) => ({ s, a: recoverSigner(m, chainId, verifyingContract, s) }))
    .sort((x, y) => (BigInt(x.a) < BigInt(y.a) ? -1 : 1))
    .map((x) => x.s);
}
