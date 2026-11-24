// Browser verifier. Uses the repo's own codec and Merkle code (copied in at build), so the page, the CLI and the
// Solidity contract all compute the same leaf: keccak(keccak(abi.encode(LEAF_TYPEHASH, ...fields))).
import { leafHash, hex, unhex } from './lib/codec.mjs';
import { proofPath } from './lib/merkle.mjs';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const short = (h) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const flop = (planck) => {
  const p = BigInt(planck);
  const w = p / 10n ** 18n, f = (p % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : String(w);
};

const EPOCHS = [
  { id: 'latest', file: 'data/latest.json', label: 'Latest devnet epoch (rebuilt by CI, unsigned)' },
  { id: 'test', file: 'data/epoch.json', label: 'Signed test epoch (99 devnet settlements, throwaway attesters)' },
];
let epoch = null, current = null;

async function load(id) {
  const e = EPOCHS.find((x) => x.id === id);
  const r = await fetch(e.file, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${e.file}: HTTP ${r.status}`);
  epoch = await r.json();
  const m = epoch.msg;
  const src = epoch.sources ? ` · every leaf re-checked on chain over RPC (${esc(epoch.sources.rpcChecked)} of ${esc(m.count)})` : '';
  $('meta').innerHTML = `<p>Root <code>${esc(m.root)}</code></p><p>${esc(m.count)} settlements, Flop blocks ${esc(m.fromBlock)} to ${esc(m.toBlock)} (finalized, hash <code>${esc(short(m.toBlockHash))}</code>), genesis <code>${esc(short(m.genesis))}</code>${src}.` +
    (epoch.builtAt ? ` Built ${esc(new Date(epoch.builtAt).toLocaleString())}.` : '') +
    (epoch.sigs?.length ? ` Signed by ${epoch.sigs.length} attesters.` : ' Not signed (signing needs keys; CI holds none).') + '</p>';
  $('rows').innerHTML = '<table><tr><th>Block</th><th>Channel</th><th>Model</th><th>G_n</th><th>Miner paid (FLOP)</th><th></th></tr>' +
    epoch.items.map((it, i) => `<tr><td class="num">${esc(it.fields.settledBlock)}</td><td><code>${esc(short(it.fields.channelId))}</code></td><td><code>${esc(short(it.fields.modelHash))}</code></td><td class="num">${esc(it.fields.aggregateGn)}</td><td class="num">${esc(flop(it.fields.minerPaid))}</td><td><button type="button" data-i="${i}" class="secondary">Check</button></td></tr>`).join('') +
    '</table>';
  $('check').hidden = true;
}

function check(fields, proof) {
  const leaf = leafHash(fields);
  const path = proofPath(leaf, proof.map(unhex));
  const ok = hex(path.at(-1)) === epoch.msg.root.toLowerCase();
  $('verdict').innerHTML = ok
    ? `<p class="ok"><strong>Verified.</strong> This settlement is in the root. A contract holding this root would accept it.</p>`
    : `<p class="bad"><strong>Rejected.</strong> The recomputed path ends at <code>${esc(short(hex(path.at(-1))))}</code>, not the root. A contract would refuse to pay.</p>`;
  $('steps').innerHTML = '<table><tr><th>Step</th><th>Hash</th></tr>' +
    path.map((h, i) => `<tr><td>${i === 0 ? 'leaf' : `hash with sibling ${i}`}</td><td><code>${esc(hex(h))}</code></td></tr>`).join('') +
    `<tr><td>root</td><td><code>${esc(epoch.msg.root)}</code></td></tr></table>`;
}

$('rows').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-i]');
  if (!b) return;
  current = structuredClone(epoch.items[Number(b.dataset.i)]);
  $('check').hidden = false;
  check(current.fields, current.proof);
  $('check').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('tamper').addEventListener('click', () => {
  if (!current) return;
  current.fields.minerPaid = String(BigInt(current.fields.minerPaid) + 1n);
  check(current.fields, current.proof);
});
$('reset').addEventListener('click', () => {
  const i = epoch.items.findIndex((x) => x.leaf === current?.leaf);
  if (i < 0) return;
  current = structuredClone(epoch.items[i]);
  check(current.fields, current.proof);
});
$('pick').addEventListener('change', () => load($('pick').value).catch((e) => ($('meta').textContent = e.message)));

// Show the latest epoch if CI managed to build one; otherwise the signed test epoch.
const avail = [];
for (const e of EPOCHS) if ((await fetch(e.file, { method: 'HEAD', cache: 'no-store' })).ok) avail.push(e);
$('pick').innerHTML = avail.map((e) => `<option value="${e.id}">${esc(e.label)}</option>`).join('');
await load(avail[0].id).catch((e) => ($('meta').textContent = e.message));
