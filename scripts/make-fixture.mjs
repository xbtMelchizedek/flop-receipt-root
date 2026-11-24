// Build test/fixtures/epoch.json from the captured devnet rows, signed by three deterministic TEST keys.
// These keys are public by construction (derived from a fixed string) and must never hold anything.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildEpoch, NETWORKS } from '../src/epoch.mjs';
import { keccak, hex, digest712 } from '../src/codec.mjs';
import { addressOf, signRoot, sortBySigner } from '../src/attest.mjs';
import { utf8ToBytes } from '@noble/hashes/utils';

export const TEST_CHAIN_ID = 31337;
export const TEST_CONTRACT = '0x000000000000000000000000000000000000f10b';
export const testKey = (i) => hex(keccak(utf8ToBytes(`flop-receipt-root test attester ${i}`)));

const dir = new URL('../test/fixtures/', import.meta.url);
const health = JSON.parse(readFileSync(new URL('devnet_health.json', dir)));
const rows = JSON.parse(readFileSync(new URL('devnet_settlements.json', dir))).data;
// The capture is the newest 100 rows; start one block above the oldest so no block is half-covered.
const fromBlock = Math.min(...rows.map((r) => Number(r.settledBlock))) + 1;
const e = buildEpoch({
  rows,
  finalized: { number: health.writer.sourceFinalizedHead, hash: health.writer.sourceFinalizedHash },
  genesis: NETWORKS.devnet.genesis,
  epoch: 1,
  fromBlock,
});
const keys = [1, 2, 3].map(testKey);
const sigs = sortBySigner(e.msg, TEST_CHAIN_ID, TEST_CONTRACT, keys.slice(0, 2).map((k) => signRoot(e.msg, TEST_CHAIN_ID, TEST_CONTRACT, k)));
const out = {
  note: 'devnet settlements captured 2026-11-24 ~2:25 PM ET from explorer.devnet.flop.network; signed by public TEST keys',
  chainId: TEST_CHAIN_ID,
  contract: TEST_CONTRACT,
  attesters: keys.map(addressOf).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)),
  threshold: 2,
  digest: hex(digest712(e.msg, TEST_CHAIN_ID, TEST_CONTRACT)),
  msg: e.msg,
  sigs,
  dropped: e.dropped,
  totals: e.totals,
  items: e.items,
};
writeFileSync(new URL('epoch.json', dir), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify({ count: e.msg.count, root: e.msg.root, fromBlock, toBlock: e.msg.toBlock, dropped: e.dropped }));
