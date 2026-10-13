import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X402UpstreamBuyer } from '../src/upstream/x402.ts';
import { loadAssets } from '../src/upstream/assets.ts';
import { usdToMicro } from '../src/money.ts';

test('wallet:new keys load into the gateway and resolve to the printed addresses', async () => {
  const out = execFileSync('npx', ['tsx', 'scripts/new-wallet.ts'], {
    env: { ...process.env, LOG_DIR: mkdtempSync(join(tmpdir(), 'wallet-')) },
    encoding: 'utf8',
  });
  const get = (re: RegExp) => re.exec(out)![1];
  const buyer = await X402UpstreamBuyer.create({
    evmPrivateKey: get(/GATEWAY_EVM_PRIVATE_KEY=(\S+)/),
    svmPrivateKey: get(/GATEWAY_SVM_PRIVATE_KEY=(\S+)/),
    assets: loadAssets(),
    testnetOnly: true,
    maxPerCall: usdToMicro('0.05'),
  });
  assert.equal(buyer.addresses.evm, get(/EVM \(Base Sepolia\): (\S+)/));
  assert.equal(buyer.addresses.svm, get(/Solana \(devnet\):\s+(\S+)/));
});
