import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jobId, encodeJobId, JOB_ID_TAG, JOB_ID_TAG_STRING, leafHash, hex } from '../src/codec.mjs';

// Vectors come from scripts/gen_jobid_vectors.py (eth_abi + pycryptodome), not from this codec.
const fx = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const v = fx('jobid_vectors.json');
const epoch = fx('epoch.json');

test('jobId: TAG bytes are keccak256("FlopReceiptRoot.jobId.v1")', () => {
  assert.equal(JOB_ID_TAG_STRING, v.tagString);
  assert.equal(hex(JOB_ID_TAG), v.tag);
  assert.equal(v.tag, '0x748fa4722b652359047a16941d7e978a83dcfab3a169bea48a5a663e7d31bd14');
});

test('jobId: every normative vector matches byte for byte (encoding and hash)', () => {
  assert.ok(v.cases.length >= 6); assert.equal(v.count, v.cases.length);
  for (const c of v.cases) {
    const enc = encodeJobId(c);
    assert.equal(enc.length, 160, c.name);
    assert.equal(hex(enc), c.encoded, c.name);
    assert.equal(hex(jobId(c)), c.jobId, c.name);
  }
});

test('jobId: unique across the 99-item fixture epoch and distinct from leafHash', () => {
  const ids = new Set(epoch.items.map((it) => hex(jobId(it.fields))));
  assert.equal(ids.size, epoch.items.length);
  const f = epoch.items[0].fields;
  assert.notEqual(hex(jobId(f)), hex(leafHash(f)));
  // fields outside the event key do not move the id
  assert.equal(hex(jobId({ ...f, minerPaid: '1', settledBlockHash: '0x' + '11'.repeat(32) })), hex(jobId(f)));
});

test('jobId: refuses out-of-width values instead of truncating', () => {
  const f = v.cases[0];
  assert.throws(() => jobId({ ...f, settledBlock: (2n ** 64n).toString() }), /does not fit/);
  assert.throws(() => jobId({ ...f, eventIndex: (2n ** 32n).toString() }), /does not fit/);
  assert.throws(() => jobId({ ...f, channelId: '0x1234' }), /bytes32/);
});
