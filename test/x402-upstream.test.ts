import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { generatePrivateKey } from 'viem/accounts';
import { X402UpstreamBuyer } from '../src/upstream/x402.ts';
import { loadAssets } from '../src/upstream/assets.ts';
import { SpendGuard } from '../src/budget.ts';
import { usdToMicro } from '../src/money.ts';

// ローカルの擬似 x402 サーバー。/price/<atomic>/<network> の価格で 402 を返し、
// payment-signature 付きの再送には 200 と PAYMENT-RESPONSE を返す。
let server: Server;
let base = '';
const paidRequests: string[] = [];
const ASSETS: Record<string, string> = {
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

before(async () => {
  server = createServer((req, res) => {
    const [, , amount, network] = (req.url ?? '').split('/');
    const sig = req.headers['payment-signature'];
    if (sig) {
      paidRequests.push(req.url!);
      res.setHeader('PAYMENT-RESPONSE', b64({ success: true, transaction: '0xfeedbeef', network }));
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
      return;
    }
    res.statusCode = 402;
    res.setHeader(
      'PAYMENT-REQUIRED',
      b64({
        x402Version: 2,
        resource: { url: `${base}${req.url}`, description: 'test', mimeType: 'application/json' },
        accepts: [
          {
            scheme: 'exact',
            network,
            asset: ASSETS[network],
            amount,
            payTo: '0x000000000000000000000000000000000000dEaD',
            maxTimeoutSeconds: 60,
            extra: { name: 'USDC', version: '2' },
          },
        ],
      }),
    );
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
after(() => server.close());

async function buyer(testnetOnly = true) {
  return X402UpstreamBuyer.create({
    evmPrivateKey: generatePrivateKey(),
    assets: loadAssets(),
    testnetOnly,
    maxPerCall: usdToMicro('0.05'),
  });
}

test('pays the expected testnet USDC price and returns the tx', async () => {
  const b = await buyer();
  const guard = new SpendGuard(usdToMicro('0.05'), usdToMicro('5'));
  const r = await b.buy({ url: `${base}/price/10000/eip155:84532`, method: 'GET', expectedPrice: usdToMicro('0.01'), guard });
  assert.equal(r.status, 200, r.error ?? '');
  assert.equal(r.paidMicro, 10_000n);
  assert.equal(r.tx, '0xfeedbeef');
  assert.equal(guard.snapshot().spent, 10_000n);
});

test('above the per-call cap: refused and nothing is signed or sent', async () => {
  const b = await buyer();
  const guard = new SpendGuard(usdToMicro('0.05'), usdToMicro('5'));
  const before = paidRequests.length;
  const r = await b.buy({ url: `${base}/price/60000/eip155:84532`, method: 'GET', expectedPrice: usdToMicro('0.06'), guard });
  assert.equal(r.refused, 'per_call_cap');
  assert.equal(paidRequests.length, before);
  assert.equal(guard.snapshot().spent, 0n);
});

test('above the daily cap: refused and nothing is sent', async () => {
  const b = await buyer();
  const guard = new SpendGuard(usdToMicro('0.05'), usdToMicro('0.015'));
  const url = `${base}/price/10000/eip155:84532`;
  assert.equal((await b.buy({ url, method: 'GET', expectedPrice: usdToMicro('0.01'), guard })).status, 200);
  const before = paidRequests.length;
  const r = await b.buy({ url, method: 'GET', expectedPrice: usdToMicro('0.01'), guard });
  assert.equal(r.refused, 'daily_cap');
  assert.equal(paidRequests.length, before);
});

test('upstream price differs from pricing.json: refused', async () => {
  const b = await buyer();
  const guard = new SpendGuard(usdToMicro('0.05'), usdToMicro('5'));
  const r = await b.buy({ url: `${base}/price/20000/eip155:84532`, method: 'GET', expectedPrice: usdToMicro('0.01'), guard });
  assert.equal(r.refused, 'price_mismatch');
});

test('mainnet asset while testnet-only: refused', async () => {
  const b = await buyer(true);
  const guard = new SpendGuard(usdToMicro('0.05'), usdToMicro('5'));
  const r = await b.buy({ url: `${base}/price/10000/eip155:8453`, method: 'GET', expectedPrice: usdToMicro('0.01'), guard });
  assert.equal(r.refused, 'no_acceptable_requirement');
});
