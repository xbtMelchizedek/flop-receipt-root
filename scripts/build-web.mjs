// Assemble the static verifier page into _site/: web/, the repo's own codec and Merkle code, vendored
// @noble/hashes (MIT) and the epochs to show. No CDN, no build step, no keys.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

rmSync('_site', { recursive: true, force: true });
mkdirSync('_site/lib', { recursive: true });
mkdirSync('_site/data', { recursive: true });
cpSync('web', '_site', { recursive: true });
cpSync('src/codec.mjs', '_site/lib/codec.mjs');
cpSync('src/merkle.mjs', '_site/lib/merkle.mjs');
cpSync('node_modules/@noble/hashes/esm', '_site/vendor/noble-hashes', { recursive: true, filter: (p) => !p.endsWith('.map') && !p.endsWith('.d.ts') });
cpSync('node_modules/@noble/hashes/LICENSE', '_site/vendor/noble-hashes/LICENSE');
cpSync('test/fixtures/epoch.json', '_site/data/epoch.json');
if (existsSync('web-data/latest.json')) cpSync('web-data/latest.json', '_site/data/latest.json');
console.log('built _site/');
