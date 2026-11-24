import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ss58ToPubkey, toLeafFields, leafHash, word, hex, digest712 } from '../src/codec.mjs';
import { buildTree, proofFor, verifyProof } from '../src/merkle.mjs';
import { addressOf, signRoot, recoverSigner, sortBySigner } from '../src/attest.mjs';
import { buildEpoch, NETWORKS } from '../src/epoch.mjs';
import { finalizedHead, settlementsSince } from '../src/fetch.mjs';

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const rows = fx('devnet_settlements.json').data;
const health = fx('devnet_health.json');
const G = NETWORKS.devnet.genesis;
const fin = { number: health.writer.sourceFinalizedHead, hash: health.writer.sourceFinalizedHash };

test('ss58: decodes to 32 bytes, rejects a flipped checksum and junk', () => {
  const pk = ss58ToPubkey(rows[0].agent);
  assert.match(pk, /^0x[0-9a-f]{64}$/);
  const a = rows[0].agent;
  const flipped = a.slice(0, -1) + (a.at(-1) === 'a' ? 'b' : 'a');
  assert.throws(() => ss58ToPubkey(flipped), /checksum|bytes/);
  assert.throws(() => ss58ToPubkey('0OIl' + a.slice(4)), /base58/);
  assert.throws(() => ss58ToPubkey('short'), /length/);
});

test('word: refuses values that do not fit, never truncates', () => {
  assert.throws(() => word(2n ** 64n, 64), /does not fit/);
  assert.throws(() => word(-1, 32), /does not fit/);
  assert.throws(() => word('0x00', 'bytes32'), /bytes32/);
  assert.equal(word(255, 8).at(-1), 255);
});

test('leaf fields: every field required; non-integers refused', () => {
  const f = toLeafFields(rows[0], G);
  assert.equal(f.minerPaid, rows[0].minerPaid);
  for (const k of ['channelId', 'settledBlockHash', 'modelHash', 'minerPaid', 'agent']) {
    const r = { ...rows[0] };
    delete r[k];
    assert.throws(() => toLeafFields(r, G), new RegExp(k));
  }
  assert.throws(() => toLeafFields({ ...rows[0], burned: '1.5' }, G), /not an integer/);
  const g = { ...f, minerPaid: String(BigInt(f.minerPaid) + 1n) };
  assert.notEqual(hex(leafHash(f)), hex(leafHash(g)));
});

test('merkle: root independent of order, every proof verifies, edits and duplicates refused', () => {
  const leaves = rows.slice(0, 13).map((r) => leafHash(toLeafFields(r, G)));
  const t1 = buildTree(leaves);
  const t2 = buildTree([...leaves].reverse());
  assert.equal(hex(t1.root), hex(t2.root));
  for (const l of leaves) assert.ok(verifyProof(t1.root, l, proofFor(t1, l)));
  const p = proofFor(t1, leaves[3]);
  assert.ok(!verifyProof(t1.root, leaves[4], p));
  assert.throws(() => buildTree([leaves[0], leaves[0]]), /duplicate/);
  assert.throws(() => buildTree([]), /no leaves/);
  assert.ok(verifyProof(buildTree([leaves[0]]).root, leaves[0], []));
});

test('epoch: only finalized rows in range, deduped, totals exact', () => {
  const oldest = Math.min(...rows.map((r) => Number(r.settledBlock)));
  const e = buildEpoch({ rows: [...rows, rows[0]], finalized: fin, genesis: G, epoch: 1, fromBlock: oldest + 1 });
  assert.equal(e.msg.count, String(e.items.length));
  assert.equal(e.dropped.beforeFrom, rows.filter((r) => Number(r.settledBlock) === oldest).length);
  const sum = rows.filter((r) => Number(r.settledBlock) > oldest).reduce((s, r) => s + BigInt(r.minerPaid), 0n);
  assert.equal(e.totals.minerPaid, String(sum));
  const early = buildEpoch({ rows, finalized: { number: oldest + 10, hash: fin.hash }, genesis: G, epoch: 1, fromBlock: oldest });
  assert.ok(early.dropped.notFinal > 0, 'rows above the finalized block are left out');
  assert.throws(() => buildEpoch({ rows, finalized: fin, genesis: G, epoch: 1, fromBlock: fin.number + 1 }), /no finalized/);
  const odd = { ...rows[0], settlementEvent: 'balances.Transfer' };
  assert.equal(buildEpoch({ rows: [odd, rows[1]], finalized: fin, genesis: G, epoch: 1, fromBlock: 0 }).dropped.notSettled, 1);
});

test('attest: EIP-712 sign/recover, low s, signer order, domain binds chain and contract', () => {
  const m = fx('epoch.json').msg;
  const k = '0x' + '11'.repeat(32);
  const C = '0x000000000000000000000000000000000000f10b';
  const sig = signRoot(m, 31337, C, k);
  assert.equal(recoverSigner(m, 31337, C, sig), addressOf(k));
  assert.notEqual(recoverSigner(m, 1, C, sig), addressOf(k));
  assert.notEqual(recoverSigner(m, 31337, '0x' + '00'.repeat(19) + '01', sig), addressOf(k));
  assert.notEqual(recoverSigner({ ...m, count: '1' }, 31337, C, sig), addressOf(k));
  const k2 = '0x' + '22'.repeat(32);
  const sorted = sortBySigner(m, 31337, C, [signRoot(m, 31337, C, k), signRoot(m, 31337, C, k2)]);
  const who = sorted.map((s) => BigInt(recoverSigner(m, 31337, C, s)));
  assert.ok(who[0] < who[1]);
  assert.throws(() => recoverSigner(m, 31337, C, sig.slice(0, -2) + '1d'), /bad v/);
});

test('fixture is reproducible from the captured rows (differential anchor for forge)', () => {
  const f = fx('epoch.json');
  const oldest = Math.min(...rows.map((r) => Number(r.settledBlock)));
  const e = buildEpoch({ rows, finalized: fin, genesis: G, epoch: 1, fromBlock: oldest + 1 });
  assert.deepEqual(e.msg, f.msg);
  assert.equal(hex(digest712(f.msg, f.chainId, f.contract)), f.digest);
  assert.equal(f.sigs.length, 2);
});

const fake = (routes) => {
  const f = async (url) => {
    f.calls.push(url);
    const u = new URL(url);
    const r = routes.find(([p]) => u.pathname.startsWith(p));
    return r ? new Response(JSON.stringify(typeof r[1] === 'function' ? r[1](u) : r[1]), { status: 200 }) : new Response('no', { status: 404 });
  };
  f.calls = [];
  return f;
};

test('fetch: genesis pinned, indexer must have reached finality, page cap enforced', async () => {
  assert.deepEqual(await finalizedHead('devnet', fake([['/api/health', health]])), fin);
  const wrong = structuredClone(health);
  wrong.writer.genesis = NETWORKS.testnet.genesis;
  await assert.rejects(finalizedHead('devnet', fake([['/api/health', wrong]])), /not the pinned devnet genesis/);
  const behind = structuredClone(health);
  behind.writer.indexedHead = behind.writer.sourceFinalizedHead - 1;
  await assert.rejects(finalizedHead('devnet', fake([['/api/health', behind]])), /behind finalized/);
  await assert.rejects(finalizedHead('mainnet', fake([])), /unknown network/);
  const page = (u) => {
    const off = Number(u.searchParams.get('offset'));
    return { data: rows.slice(off, off + 100), pagination: { hasMore: off + 100 < rows.length } };
  };
  const oldest = Math.min(...rows.map((r) => Number(r.settledBlock)));
  const got = await settlementsSince('devnet', oldest + 1, { fetchImpl: fake([['/api/settlement-prices', page]]) });
  assert.equal(got.length, rows.filter((r) => Number(r.settledBlock) > oldest).length);
  await assert.rejects(settlementsSince('devnet', 0, { maxRows: 10, fetchImpl: fake([['/api/settlement-prices', page]]) }), /more than 10/);
});

test('cli keygen: keys mode 600 in a 700 dir, output has addresses only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frr-'));
  process.env.FRR_KEY_DIR = join(dir, 'keys');
  const { main } = await import(`../src/cli.mjs?${Date.now()}`);
  const out = [];
  assert.equal(await main(['keygen', '--n', '3'], { out: (s) => out.push(s) }), 0);
  const r = JSON.parse(out[0]);
  assert.equal(r.attesters.length, 3);
  for (const f of readdirSync(process.env.FRR_KEY_DIR)) {
    assert.equal(statSync(join(process.env.FRR_KEY_DIR, f)).mode & 0o777, 0o600);
    const key = readFileSync(join(process.env.FRR_KEY_DIR, f), 'utf8').trim();
    assert.ok(!out[0].includes(key.slice(2)), 'key never printed');
  }
  assert.equal(statSync(process.env.FRR_KEY_DIR).mode & 0o777, 0o700);
});
