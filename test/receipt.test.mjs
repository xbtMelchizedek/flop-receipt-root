import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findItem, calldata, proofBundle, verifyReceipt, settlementTuple, VERIFY_SIG } from '../src/receipt.mjs';
import { main } from '../src/cli.mjs';

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const epoch = fx('epoch.json');
const cf = fx('chain_facts.json'); // recorded from https://rpc.devnet.flop.network
const key = (f) => `${f.channelId}:${f.settledBlock}:${f.eventIndex}`;
const chain = (edit = (x) => x) => ({
  finalized: async () => ({ number: Number(cf.finalizedAtRecording) }),
  readFacts: async (f) => edit(structuredClone(cf.facts[key(f)] ?? null)),
  closed: 0, async close() { this.closed++; },
});
const it0 = epoch.items[0];
const verdict = (steps) => Object.fromEntries(steps.map((s) => [s.step, s.ok]));

test('findItem: by leaf or channel+block; absent and ambiguous are errors', () => {
  assert.equal(findItem(epoch, { leaf: it0.leaf.toUpperCase().replace('0X', '0x') }), it0);
  assert.equal(findItem(epoch, { channel: it0.fields.channelId, block: it0.fields.settledBlock }), it0);
  assert.throws(() => findItem(epoch, { leaf: '0x' + '0'.repeat(64) }), /no settlement/);
  assert.throws(() => findItem(epoch, {}), /--leaf/);
});

test('calldata: verify layout is selector + epoch + 12 words + offset + proof; fill adds the intent id', () => {
  const d = calldata('1', it0.fields, it0.proof);
  assert.equal((d.length - 2) / 2, 4 + 32 * (1 + 12 + 1 + 1 + it0.proof.length));
  assert.equal(d.slice(2 + 8 + 64 * 13, 2 + 8 + 64 * 14), (32 * 14).toString(16).padStart(64, '0'), 'offset of the proof array');
  const f = calldata('1', it0.fields, it0.proof, { intentId: '7' });
  assert.equal((f.length - d.length) / 2, 32);
  assert.notEqual(d.slice(0, 10), f.slice(0, 10));
  assert.throws(() => calldata('1', { ...it0.fields, eventIndex: String(2 ** 32) }, it0.proof), /does not fit uint32/);
  const b = proofBundle(epoch, it0, { intentId: '7' });
  assert.match(b.cast, new RegExp(`^cast call 0x0+f10b '${VERIFY_SIG.replace(/[()[\]]/g, '\\$&')}\\(bool\\)' 1 '${settlementTuple(it0.fields).replace(/[()]/g, '\\$&')}'`));
  assert.equal(b.fillCalldata, f);
});

test('verify: every fixture receipt passes leaf, range, proof and quorum; the chain agrees on all 99', async () => {
  for (const it of epoch.items) {
    const s = await verifyReceipt(epoch, it, { chain: chain() });
    assert.deepEqual(verdict(s), { leaf: true, range: true, proof: true, quorum: true, chain: true }, it.leaf);
  }
});

test('verify: each kind of tampering fails at the step that catches it', async () => {
  const bad = async (e, it, opts) => Object.entries(verdict(await verifyReceipt(e, it, opts))).filter(([, ok]) => !ok).map(([k]) => k);
  // A changed field changes the leaf: the stored leaf no longer matches, and the recomputed one is not under the root.
  assert.deepEqual(await bad(epoch, { ...it0, fields: { ...it0.fields, minerPaid: '1' } }), ['leaf', 'proof']);
  assert.deepEqual(await bad(epoch, { ...it0, proof: [...it0.proof].reverse() }), ['proof']);
  assert.deepEqual(await bad({ ...epoch, msg: { ...epoch.msg, fromBlock: String(Number(it0.fields.settledBlock) + 1) } }, it0), ['range', 'quorum'], 'moving the range changes the signed message too');
  assert.deepEqual(await bad({ ...epoch, sigs: epoch.sigs.slice(0, 1) }, it0), ['quorum']);
  assert.deepEqual(await bad({ ...epoch, sigs: [epoch.sigs[0], epoch.sigs[0]] }, it0), ['quorum']);
  assert.deepEqual(await bad(epoch, it0, { attesters: ['0x' + '1'.repeat(40), epoch.attesters[1]] }), ['quorum'], 'pinned set rejects outsiders');
  assert.deepEqual(await bad(epoch, it0, { chainId: 1 }), ['quorum'], 'signatures are bound to chain id and contract');
  assert.deepEqual(await bad(epoch, it0, { chain: chain((f) => ({ ...f, blockHash: '0x' + 'e'.repeat(64) })) }), ['chain']);
  const down = { finalized: async () => { throw new Error('HTTP 503'); }, readFacts: async () => null };
  const s = await verifyReceipt(epoch, it0, { chain: down });
  assert.match(s.at(-1).detail, /could not read the chain: HTTP 503/);
});

test('cli: proof and verify through an npx-style symlink; exit codes; injected chain for --chain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frr-rcpt-'));
  const file = fileURLToPath(new URL('./fixtures/epoch.json', import.meta.url));
  const link = join(dir, 'flop-receipt-root');
  symlinkSync(fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), link);
  const run = (...a) => spawnSync(process.execPath, [link, ...a], { encoding: 'utf8' });
  const p = run('proof', '--epoch-file', file, '--leaf', it0.leaf);
  assert.equal(p.status, 0, p.stderr);
  assert.equal(JSON.parse(p.stdout).verifyCalldata, calldata('1', it0.fields, it0.proof));
  const v = run('verify', '--epoch-file', file, '--leaf', it0.leaf, '--attesters', epoch.attesters.join(','), '--threshold', '2');
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.equal(v.stdout.trim().split('\n').length, 4);
  const tampered = join(dir, 'bad.json');
  writeFileSync(tampered, JSON.stringify({ ...epoch, sigs: epoch.sigs.slice(0, 1) }));
  assert.equal(run('verify', '--epoch-file', tampered, '--leaf', it0.leaf).status, 1);
  assert.equal(run('proof', '--epoch-file', file, '--leaf', '0x' + '0'.repeat(64)).status, 2);
  const lines = [];
  const c = chain();
  assert.equal(await main(['verify', '--epoch-file', file, '--leaf', it0.leaf, '--chain', 'recorded'], { out: (s) => lines.push(JSON.parse(s)), chainImpl: c }), 0);
  assert.equal(lines.at(-1).step, 'chain');
  assert.equal(c.closed, 1);
});

// Byte-for-byte against Foundry's own encoder when it is installed (CI also checks the calldata on a live anvil
// contract in `npm run e2e`).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { FILL_SIG, proofArg } from '../src/receipt.mjs';
const CAST = [join(homedir(), '.foundry', 'bin', 'cast')].find(existsSync) ?? (spawnSync('cast', ['--version']).status === 0 ? 'cast' : null);
test('calldata matches `cast calldata` for verify and fill', { skip: !CAST && 'foundry not installed' }, () => {
  for (const it of epoch.items.slice(0, 5)) {
    const c = spawnSync(CAST, ['calldata', VERIFY_SIG, '1', settlementTuple(it.fields), proofArg(it.proof)], { encoding: 'utf8' }).stdout.trim();
    assert.equal(calldata('1', it.fields, it.proof), c);
    const f = spawnSync(CAST, ['calldata', FILL_SIG, '42', '1', settlementTuple(it.fields), proofArg(it.proof)], { encoding: 'utf8' }).stdout.trim();
    assert.equal(calldata('1', it.fields, it.proof, { intentId: '42' }), f);
  }
});
