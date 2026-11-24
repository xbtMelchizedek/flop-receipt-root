import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareFacts, crossCheck } from '../src/rpc.mjs';
import { main } from '../src/cli.mjs';

const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const epoch = fx('epoch.json');
const cf = fx('chain_facts.json'); // recorded from https://rpc.devnet.flop.network by scripts/record-chain-facts.mjs
const key = (f) => `${f.channelId}:${f.settledBlock}:${f.eventIndex}`;

/** A fake chain built from recorded facts; `edit` lets a test corrupt one source. */
function chainFrom(facts = cf.facts, { finalized = Number(cf.finalizedAtRecording), toBlockHash = cf.toBlockHash } = {}) {
  return {
    finalized: async () => ({ number: finalized, hash: '0x' + '0'.repeat(64) }),
    hashAt: async (n) => (String(n) === cf.toBlock ? toBlockHash : '0x' + 'f'.repeat(64)),
    readFacts: async (f) => structuredClone(facts[key(f)] ?? null),
    closed: 0,
    async close() { this.closed++; },
  };
}

test('rpc: all 99 recorded devnet leaves agree with the chain, field by field', async () => {
  for (const it of epoch.items) assert.deepEqual(compareFacts(it.fields, cf.facts[key(it.fields)]), [], key(it.fields));
  const r = await crossCheck(epoch, chainFrom());
  assert.equal(r.checked, 99);
});

test('rpc: every leaf field the explorer could get wrong is caught by name', () => {
  const f = epoch.items[7].fields;
  const facts = cf.facts[key(f)];
  const bump = (x) => String(BigInt(x) + 1n);
  const cases = [
    ['minerPaid', { ...f, minerPaid: bump(f.minerPaid) }],
    ['burned', { ...f, burned: bump(f.burned) }],
    ['aggregateGn', { ...f, aggregateGn: bump(f.aggregateGn) }],
    ['escrow', { ...f, escrow: bump(f.escrow) }],
    ['agent', { ...f, agent: f.miner }],
    ['miner', { ...f, miner: f.agent }],
    ['modelHash', { ...f, modelHash: '0x' + '1'.repeat(64) }],
    ['settledBlockHash', { ...f, settledBlockHash: '0x' + '2'.repeat(64) }],
    ['Settled event', { ...f, eventIndex: String(Number(f.eventIndex) + 1) }],
    ['Settled event', { ...f, channelId: '0x' + '3'.repeat(64) }],
  ];
  for (const [field, g] of cases) {
    const got = compareFacts(g, facts).map((p) => p.field);
    assert.ok(got.includes(field), `${field}: got ${got}`);
  }
  assert.deepEqual(compareFacts(f, null).map((p) => p.field), ['facts']);
  assert.ok(compareFacts(f, { ...facts, channel: null }).some((p) => p.field === 'channel'));
  // Two Settled events for one channel at one index is ambiguous, so it is refused too.
  const dup = structuredClone(facts);
  dup.settled.push({ ...dup.settled.find((e) => e.channelId === f.channelId) });
  assert.ok(compareFacts(f, dup).some((p) => p.field === 'Settled event'));
});

test('rpc: cross-check refuses on a wrong boundary hash, an unfinalized boundary or one bad leaf', async () => {
  await assert.rejects(crossCheck(epoch, chainFrom(cf.facts, { toBlockHash: '0x' + 'a'.repeat(64) })), (e) => e.problems.some((p) => p.field === 'toBlockHash'));
  await assert.rejects(crossCheck(epoch, chainFrom(cf.facts, { finalized: Number(cf.toBlock) - 1 })), (e) => e.problems.some((p) => p.field === 'toBlock'));
  const facts = structuredClone(cf.facts);
  const k = key(epoch.items[42].fields);
  facts[k].settled = facts[k].settled.map((e) => ({ ...e, minerPaid: '1' }));
  await assert.rejects(crossCheck(epoch, chainFrom(facts)), (e) => e.problems.length === 1 && e.problems[0].field === 'minerPaid');
});

const fetchFrom = (rows, health) => async (url) => {
  const u = new URL(url);
  if (u.pathname === '/api/health') return new Response(JSON.stringify(health));
  if (u.pathname === '/api/settlement-prices') return new Response(JSON.stringify({ data: rows, pagination: { hasMore: false } }));
  return new Response('no', { status: 404 });
};

test('cli build: writes the root only when the chain agrees; disagreement writes nothing', async () => {
  // Rebuild the fixture epoch from the explorer rows it came from.
  const rows = fx('devnet_settlements.json').data.filter((r) => Number(r.settledBlock) <= Number(epoch.msg.toBlock));
  const health = fx('devnet_health.json');
  const dir = mkdtempSync(join(tmpdir(), 'frr-rpc-'));
  const out = join(dir, 'e.json');
  const lines = [];
  const chain = chainFrom();
  const args = ['build', '--network', 'devnet', '--from', epoch.msg.fromBlock, '--out', out];
  assert.equal(await main(args, { fetchImpl: fetchFrom(rows, health), chainImpl: chain, out: (s) => lines.push(s) }), 0);
  const built = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(built.msg.root, epoch.msg.root);
  assert.equal(built.sources.rpcChecked, 99);
  assert.equal(chain.closed, 1);

  const bad = structuredClone(cf.facts);
  const k = key(epoch.items[3].fields);
  bad[k].channel.modelHash = '0x' + '9'.repeat(64);
  const out2 = join(dir, 'e2.json');
  const chain2 = chainFrom(bad);
  await assert.rejects(main(['build', '--network', 'devnet', '--from', epoch.msg.fromBlock, '--out', out2], { fetchImpl: fetchFrom(rows, health), chainImpl: chain2, out: (s) => lines.push(s) }), /refusing to build a root/);
  assert.equal(existsSync(out2), false);
  assert.equal(chain2.closed, 1);
  assert.match(lines.at(-1), /"field":"modelHash"/);

  // check: re-verifies an existing epoch file; exit 1 with the problems on disagreement.
  writeFileSync(join(dir, 'fx.json'), JSON.stringify(epoch));
  assert.equal(await main(['check', '--epoch-file', join(dir, 'fx.json')], { chainImpl: chainFrom(), out: () => {} }), 0);
  assert.equal(await main(['check', '--epoch-file', join(dir, 'fx.json')], { chainImpl: chainFrom(bad), out: () => {} }), 1);
});

test('rpc: testnet RPC is the published host with the genesis pinned; plain http is refused off localhost', async () => {
  const { connectRpc } = await import('../src/rpc.mjs');
  const { NETWORKS } = await import('../src/epoch.mjs');
  assert.equal(NETWORKS.testnet.rpc, 'https://testnet.flop.network');
  assert.equal(NETWORKS.testnet.genesis, '0x918abd58fb16306b30ef3886514cfaebffecb4de43e82b6f8ec4795c43cfd800');
  await assert.rejects(connectRpc('testnet', 'http://testnet.flop.network'), /must be https/);
  await assert.rejects(connectRpc('devnet', 'http://rpc.example.com'), /must be https/);
  await assert.rejects(connectRpc('mainnet'), /unknown network/);
});

test('demo units: USD quote to USDC units rounds up, never to zero, refuses junk', async () => {
  const { usdToUnits } = await import('../scripts/lib/units.mjs');
  assert.equal(usdToUnits('0.0010806'), 1081n);
  assert.equal(usdToUnits('0.000001'), 1n);
  assert.equal(usdToUnits('0.000000001'), 1n);
  assert.equal(usdToUnits('0'), 1n);
  assert.equal(usdToUnits('12.5'), 12_500_000n);
  for (const bad of ['-1', '1e-3', '0.0000000001', '', 1]) assert.throws(() => usdToUnits(bad), /bad USD/);
});
