import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, symlinkSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('package: library entry exports the public API and the leaf matches the fixture', async () => {
  const m = await import('../src/index.mjs');
  for (const k of ['leafHash', 'verifyProof', 'proofPath', 'buildEpoch', 'crossCheck', 'compareFacts', 'signRoot']) assert.ok(k in m, k);
  const e = JSON.parse(readFileSync(new URL('./fixtures/epoch.json', import.meta.url), 'utf8'));
  const it = e.items[0];
  assert.equal(m.hex(m.leafHash(it.fields)), it.leaf);
  assert.ok(m.verifyProof(m.unhex(e.msg.root), m.leafHash(it.fields), it.proof.map(m.unhex)));
  assert.ok(pkg.files.includes('contracts/src') && !pkg.files.includes('test'));
});

test('package: bin runs through an npm-style symlink (npx path), and build needs one range flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frr-bin-'));
  const link = join(dir, 'flop-receipt-root');
  symlinkSync(fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), link);
  assert.match(spawnSync(process.execPath, [link], { encoding: 'utf8' }).stdout, /^flop-receipt-root/);
  const r = spawnSync(process.execPath, [link, 'build', '--network', 'devnet', '--out', join(dir, 'x.json')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /exactly one of --from/);
});
