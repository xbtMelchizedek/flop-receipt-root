#!/usr/bin/env node
// One local walk through the whole loop an agent would use:
//   1. justweight's infer tool quotes a job (quote mode: spends nothing, holds no keys)
//   2. the agent posts an intent for that price in mock USDC on a throwaway anvil chain
//   3. a bonded solver claims it and fills it with a finalized Flop settlement
//   4. the settlement is checked against the Flop chain over RPC, and against the signed receipt root on anvil
// Nothing touches a real EVM network; anvil's unlocked dev accounts send every transaction.
//
// Honest gap: Flop testnet has no models listed yet, so no one can buy this exact job on Flop today. The
// settlement used is a real finalized devnet settlement from the bundled epoch, standing in for the job.
//
// Usage: npm run demo [-- --offline] [-- --snapshot <justweight snapshot.json>]
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAnvil, msgTuple, settlementTuple, proofArg, ROOT_MSG, VERIFY, FILL, POST } from './lib/anvil.mjs';
import { compareFacts, connectRpc, readChainFacts } from '../src/rpc.mjs';
import { usdToUnits } from './lib/units.mjs';

const argv = process.argv.slice(2);
const offline = argv.includes('--offline');
const snapArg = argv.indexOf('--snapshot') >= 0 ? argv[argv.indexOf('--snapshot') + 1] : null;
const SNAPSHOT_URL = 'https://xbtmelchizedek.github.io/justweight/data/snapshot.json';
const fixture = (f) => JSON.parse(readFileSync(new URL(`../test/fixtures/${f}`, import.meta.url), 'utf8'));
const say = (step, o) => console.log(`\n[${step}] ${JSON.stringify(o, null, 1)}`);


const work = mkdtempSync(join(tmpdir(), 'frr-demo-'));
process.env.FRR_KEY_DIR = join(work, 'keys');

// 1. Quote.
const { infer } = await import(process.env.JUSTWEIGHT_INFER ?? 'justweight/src/infer.mjs');
const load = async () => {
  if (snapArg) return JSON.parse(readFileSync(snapArg, 'utf8'));
  if (offline) throw new Error('--offline needs --snapshot <file> for the quote');
  const r = await fetch(SNAPSHOT_URL, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`snapshot HTTP ${r.status}`);
  return r.json();
};
const q = await infer({ tier: 'mid', prompt: 'Summarize the attached diff in three bullets.', budget: 800, max_usd: '0.01', privacy: 'no-retention', mode: 'quote' }, { load, ledgerDir: join(work, 'justweight') });
if (!q.ok) throw new Error(`no quote: ${q.receipt.reason}`);
const quoted = q.receipt.cost.quotedUsd;
const amount = usdToUnits(quoted);
say('1 quote', { venue: q.receipt.route.provider, model: q.receipt.route.model, quotedUsd: quoted, charged: q.receipt.cost.chargedUsd, receiptId: q.receipt.id, snapshotAt: q.receipt.snapshot.generatedAt });

// The settlement that will fill the intent, and its own check against the Flop chain.
const fx = fixture('epoch.json');
const item = fx.items[5];
const f = item.fields;
let chainCheck;
if (offline) {
  const facts = fixture('chain_facts.json').facts[`${f.channelId}:${f.settledBlock}:${f.eventIndex}`];
  chainCheck = { source: 'recorded devnet facts (offline)', disagreements: compareFacts(f, facts) };
} else {
  const api = await connectRpc('devnet');
  try { chainCheck = { source: 'https://rpc.devnet.flop.network', disagreements: compareFacts(f, await readChainFacts(api, f)) }; } finally { await api.disconnect(); }
}
if (chainCheck.disagreements.length) throw new Error(`settlement disagrees with the chain: ${JSON.stringify(chainCheck.disagreements)}`);
say('2 flop settlement checked on chain', { ...chainCheck, channel: f.channelId, block: f.settledBlock, modelHash: f.modelHash, aggregateGn: f.aggregateGn });

const c = await startAnvil();
try {
  const [agent, solver, deployer] = c.accounts;
  // Receipt root: throwaway attesters sign the bundled epoch; it is submitted to the local contract.
  const { main } = await import('../src/cli.mjs');
  let keys;
  await main(['keygen', '--n', '3'], { out: (s) => (keys = JSON.parse(s)) });
  const m = fx.msg;
  const roots = c.create(deployer, 'contracts/src/FlopReceiptRoot.sol:FlopReceiptRoot', [m.genesis, m.fromBlock, `[${keys.attesters.join(',')}]`, '2']);
  const ef = join(work, 'epoch.json');
  writeFileSync(ef, JSON.stringify({ msg: m, items: fx.items, sigs: [] }));
  await main(['sign', '--epoch-file', ef, '--chain-id', '31337', '--contract', roots, '--keys', '1,2'], { out: () => {} });
  c.send(deployer, roots, `submit(${ROOT_MSG},bytes[])`, msgTuple(m), `[${JSON.parse(readFileSync(ef, 'utf8')).sigs.join(',')}]`);
  const usdc = c.create(deployer, 'contracts/test/mocks/MockUSDC.sol:MockUSDC');
  const esc = c.create(deployer, 'contracts/src/IntentEscrow.sol:IntentEscrow', [usdc, roots, '1000000000', '2000', '3600']);
  for (const w of [agent, solver]) {
    c.send(w, usdc, 'mint(address,uint256)', w, '1000000');
    c.send(w, usdc, 'approve(address,uint256)', esc, '1000000');
  }

  // 3. Intent for the quoted price.
  c.send(agent, esc, POST, String(amount), String(c.now() + 86400), f.settledBlock, f.agent, f.modelHash, f.aggregateGn);
  say('3 intent posted', { escrow: esc, amountMockUsdcUnits: String(amount), fromQuoteUsd: quoted, terms: { flopAgent: f.agent, modelHash: f.modelHash, minGn: f.aggregateGn } });

  // 4. Solver bonds, claims, fills.
  const bond = c.call(esc, 'bondFor(uint96)(uint96)', String(amount)).split(' ')[0];
  c.send(solver, esc, 'deposit(uint256)', bond);
  c.send(solver, esc, 'claim(uint256)', '1');
  const before = c.balance(usdc, solver);
  const fill = c.send(solver, esc, FILL, '1', '1', settlementTuple(f), proofArg(item.proof));
  const paid = c.balance(usdc, solver) - before;
  const rootSays = c.call(roots, VERIFY, '1', settlementTuple(f), proofArg(item.proof));
  say('4 filled', { fillGas: Number(fill.gasUsed), solverPaidUnits: String(paid), bondReturnedUnits: bond, rootVerify: rootSays, root: m.root });

  const ok = paid === amount && rootSays === 'true';
  const summary = { ok, quoteReceipt: q.receipt.id, quotedUsd: quoted, intent: 1, settlementLeaf: item.leaf, root: m.root, fillTx: fill.transactionHash, chain: 'anvil 31337 @127.0.0.1 (throwaway)' };
  writeFileSync(join(work, 'demo-receipt.json'), JSON.stringify(summary, null, 1));
  say('done', { ...summary, written: join(work, 'demo-receipt.json') });
  if (!ok) process.exitCode = 1;
} finally {
  c.stop();
}
