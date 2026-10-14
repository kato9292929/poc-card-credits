import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X402UpstreamBuyer } from '../src/upstream/x402.ts';
import { loadAssets } from '../src/upstream/assets.ts';
import { usdToMicro } from '../src/money.ts';

test('wallet:new keys load into the gateway, and only public addresses go to docs/wallet.md', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wallet-'));
  const doc = join(dir, 'wallet.md');
  copyFileSync('docs/wallet.md', doc);
  const out = execFileSync('npx', ['tsx', 'scripts/new-wallet.ts', '--evm'], {
    env: { ...process.env, LOG_DIR: dir, WALLET_DOC: doc, NVM_ENVIRONMENT: 'sandbox' },
    encoding: 'utf8',
  });
  const get = (re: RegExp) => re.exec(out)![1];
  const svmKey = get(/GATEWAY_SVM_PRIVATE_KEY=(\S+)/);
  const evmKey = get(/GATEWAY_EVM_PRIVATE_KEY=(\S+)/);
  const buyer = await X402UpstreamBuyer.create({ evmPrivateKey: evmKey, svmPrivateKey: svmKey, assets: loadAssets(), testnetOnly: true, maxPerCall: usdToMicro('0.05') });
  const md = readFileSync(doc, 'utf8');
  assert.ok(md.includes(`\`${buyer.addresses.svm}\``));
  assert.ok(md.includes(`\`${buyer.addresses.evm}\``));
  assert.ok(md.includes('Solana devnet'));
  assert.ok(!md.includes(svmKey) && !md.includes(evmKey), 'private keys must not be written to docs');
});
