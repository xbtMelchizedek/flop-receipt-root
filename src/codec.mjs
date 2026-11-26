// Encoding shared with contracts/src/FlopReceiptRoot.sol. Any change here must change the contract and
// the differential test (contracts/test/FlopReceiptRoot.t.sol reads test/fixtures/epoch.json).
import { keccak_256 } from '@noble/hashes/sha3';
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils';

export const keccak = (b) => keccak_256(b);
export const hex = (b) => '0x' + bytesToHex(b);
export const unhex = (h) => {
  if (typeof h !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(h)) throw new Error(`not 0x hex: ${String(h).slice(0, 20)}`);
  return hexToBytes(h.slice(2));
};

export const LEAF_TYPE =
  'FlopSettlementLeaf(bytes32 genesis,bytes32 channelId,uint64 settledBlock,bytes32 settledBlockHash,uint32 eventIndex,bytes32 agent,bytes32 miner,bytes32 modelHash,uint128 aggregateGn,uint128 minerPaid,uint128 burned,uint128 escrow)';
export const LEAF_TYPEHASH = keccak(utf8ToBytes(LEAF_TYPE));
export const ROOT_TYPE =
  'ReceiptRoot(bytes32 genesis,uint64 epoch,uint64 fromBlock,uint64 toBlock,bytes32 toBlockHash,uint32 count,bytes32 root)';
export const ROOT_TYPEHASH = keccak(utf8ToBytes(ROOT_TYPE));
const DOMAIN_TYPEHASH = keccak(utf8ToBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
export const DOMAIN_NAME = 'FlopReceiptRoot';
export const DOMAIN_VERSION = '1';

/** One ABI word. Throws instead of truncating (dev-taste R5: check fixed-width overflow in clients too). */
export function word(v, bits) {
  if (bits === 'bytes32') {
    const b = typeof v === 'string' ? unhex(v) : v;
    if (b.length !== 32) throw new Error(`bytes32 has ${b.length} bytes`);
    return b;
  }
  const n = BigInt(v);
  if (n < 0n || n >= 1n << BigInt(bits)) throw new Error(`${v} does not fit uint${bits}`);
  return hexToBytes(n.toString(16).padStart(64, '0'));
}

// --- SS58 (Substrate addresses) -> 32-byte public key, checksum verified ---
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error('ss58: bad base58 char');
    n = n * 58n + BigInt(i);
  }
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  const body = n === 0n ? new Uint8Array() : hexToBytes(h);
  let zeros = 0;
  while (s[zeros] === '1') zeros++;
  return concatBytes(new Uint8Array(zeros), body);
}
export function ss58ToPubkey(addr) {
  if (typeof addr !== 'string' || addr.length < 40 || addr.length > 60) throw new Error('ss58: bad length');
  const raw = b58decode(addr);
  const prefixLen = raw[0] & 0b0100_0000 ? 2 : 1;
  if (raw.length !== prefixLen + 32 + 2) throw new Error(`ss58: ${raw.length} bytes is not a 32-byte account`);
  const body = raw.subarray(0, prefixLen + 32);
  const sum = blake2b(concatBytes(utf8ToBytes('SS58PRE'), body), { dkLen: 64 });
  if (sum[0] !== raw[prefixLen + 32] || sum[1] !== raw[prefixLen + 33]) throw new Error('ss58: checksum mismatch');
  return hex(raw.subarray(prefixLen, prefixLen + 32));
}

/** Explorer settlement row -> leaf fields. Every field is checked; nothing is defaulted to zero. */
export function toLeafFields(row, genesis) {
  const need = (k) => {
    if (row[k] === undefined || row[k] === null) throw new Error(`settlement ${row.channelId ?? '?'} missing ${k}`);
    return row[k];
  };
  const int = (k) => {
    const v = String(need(k));
    if (!/^\d+$/.test(v)) throw new Error(`settlement ${row.channelId} ${k} is not an integer`);
    return v;
  };
  return {
    genesis,
    channelId: need('channelId').toLowerCase(),
    settledBlock: int('settledBlock'),
    settledBlockHash: need('settledBlockHash').toLowerCase(),
    eventIndex: int('eventIndex'),
    agent: ss58ToPubkey(need('agent')),
    miner: ss58ToPubkey(need('miner')),
    modelHash: need('modelHash').toLowerCase(),
    aggregateGn: int('aggregateGn'),
    minerPaid: int('minerPaid'),
    burned: int('burned'),
    escrow: int('escrow'),
  };
}

export function encodeLeaf(f) {
  return concatBytes(
    LEAF_TYPEHASH,
    word(f.genesis, 'bytes32'), word(f.channelId, 'bytes32'), word(f.settledBlock, 64),
    word(f.settledBlockHash, 'bytes32'), word(f.eventIndex, 32), word(f.agent, 'bytes32'),
    word(f.miner, 'bytes32'), word(f.modelHash, 'bytes32'), word(f.aggregateGn, 128),
    word(f.minerPaid, 128), word(f.burned, 128), word(f.escrow, 128),
  );
}

/** Double hash, so a 64-byte inner node can never be presented as a leaf (second-preimage guard). */
export const leafHash = (f) => keccak(keccak(encodeLeaf(f)));

/**
 * Stable job id for one settlement event (normative, see README "Job id"). Independent of the leaf
 * layout, so a later leaf change does not remap ids. Keep leafHash for Merkle proofs.
 * jobId = keccak256(abi.encode(bytes32 JOB_ID_TAG, bytes32 genesis, bytes32 channelId, uint64 settledBlock, uint32 eventIndex))
 */
export const JOB_ID_TAG_STRING = 'FlopReceiptRoot.jobId.v1';
export const JOB_ID_TAG = keccak(utf8ToBytes(JOB_ID_TAG_STRING));
export const encodeJobId = (f) => concatBytes(
  JOB_ID_TAG, word(f.genesis, 'bytes32'), word(f.channelId, 'bytes32'), word(f.settledBlock, 64), word(f.eventIndex, 32),
);
export const jobId = (f) => keccak(encodeJobId(f));

export function rootStructHash(m) {
  return keccak(concatBytes(
    ROOT_TYPEHASH, word(m.genesis, 'bytes32'), word(m.epoch, 64), word(m.fromBlock, 64), word(m.toBlock, 64),
    word(m.toBlockHash, 'bytes32'), word(m.count, 32), word(m.root, 'bytes32'),
  ));
}

export function domainSeparator(chainId, verifyingContract) {
  const addr = unhex(verifyingContract);
  if (addr.length !== 20) throw new Error('verifyingContract must be 20 bytes');
  return keccak(concatBytes(
    DOMAIN_TYPEHASH, keccak(utf8ToBytes(DOMAIN_NAME)), keccak(utf8ToBytes(DOMAIN_VERSION)),
    word(chainId, 256), concatBytes(new Uint8Array(12), addr),
  ));
}

export const digest712 = (m, chainId, verifyingContract) =>
  keccak(concatBytes(new Uint8Array([0x19, 0x01]), domainSeparator(chainId, verifyingContract), rootStructHash(m)));
