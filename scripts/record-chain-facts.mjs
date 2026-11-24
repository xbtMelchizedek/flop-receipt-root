// Re-record test/fixtures/chain_facts.json: the devnet chain's own view of every leaf in epoch.json.
// Read-only public JSON-RPC. Run: node scripts/record-chain-facts.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { connectRpc, readChainFacts, rpcHashAt, rpcFinalized } from '../src/rpc.mjs';

const fx = JSON.parse(readFileSync(new URL('../test/fixtures/epoch.json', import.meta.url), 'utf8'));
const api = await connectRpc('devnet');
try {
  const facts = {};
  for (const it of fx.items) {
    const f = it.fields;
    facts[`${f.channelId}:${f.settledBlock}:${f.eventIndex}`] = await readChainFacts(api, f);
  }
  const toBlock = Number(fx.msg.toBlock);
  const out = {
    recordedAt: new Date().toISOString(),
    rpc: 'https://rpc.devnet.flop.network',
    finalizedAtRecording: (await rpcFinalized(api)).number,
    toBlock: String(toBlock),
    toBlockHash: await rpcHashAt(api, toBlock),
    facts,
  };
  writeFileSync(new URL('../test/fixtures/chain_facts.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({ ok: true, leaves: Object.keys(facts).length, toBlockHash: out.toBlockHash }));
} finally {
  await api.disconnect();
}
