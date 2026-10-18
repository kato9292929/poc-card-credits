import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, type GatewayRequest } from '../src/gateway/handler.ts';
import { loadPricing } from '../src/pricing.ts';
import { SpendGuard } from '../src/budget.ts';
import { usdToMicro } from '../src/money.ts';
import { toLogLine } from '../src/log.ts';
import type { CreditLedger, SettleOutcome } from '../src/ledger/types.ts';
import type { UpstreamBuyer, UpstreamPurchase } from '../src/upstream/types.ts';

class FakeLedger implements CreditLedger {
  balanceOf = 100n;
  settled: number[] = [];
  verifyOk = true;
  settleResult: SettleOutcome | undefined;
  paymentRequired() {
    return { x402Version: 2, accepts: [] };
  }
  endpoints: string[] = [];
  async verify(a: { endpoint: string }) {
    this.endpoints.push(a.endpoint);
    return this.verifyOk ? ({ ok: true, payer: '0xabc' } as const) : ({ ok: false, reason: 'Insufficient balance' } as const);
  }
  async balance() {
    return this.balanceOf;
  }
  async settle(a: { credits: number }): Promise<SettleOutcome> {
    if (this.settleResult) return this.settleResult;
    this.settled.push(a.credits);
    this.balanceOf -= BigInt(a.credits);
    return { ok: true, creditsRedeemed: a.credits, remaining: this.balanceOf.toString(), tx: '0xsettle' };
  }
}

class FakeUpstream implements UpstreamBuyer {
  calls: { url: string; expectedPrice: bigint }[] = [];
  constructor(private readonly reply: (price: bigint, guard: SpendGuard) => UpstreamPurchase) {}
  async buy(a: { url: string; expectedPrice: bigint; guard: SpendGuard }) {
    this.calls.push(a);
    return this.reply(a.expectedPrice, a.guard);
  }
}

const ok = (price: bigint, guard: SpendGuard): UpstreamPurchase => {
  const r = guard.reserve(price);
  if (!r.ok) return { status: 402, body: new Uint8Array(), attemptedMicro: 0n, paidMicro: 0n, latencyMs: 1, refused: r.reason, error: r.detail };
  r.reservation.commit();
  return { status: 200, body: new TextEncoder().encode('{"data":1}'), contentType: 'application/json', attemptedMicro: price, paidMicro: price, network: 'solana:devnet', tx: 'sig123', latencyMs: 5 };
};

function setup(reply = ok, guard = new SpendGuard(usdToMicro('0.05'), usdToMicro('5')), blockCardTopUp = true) {
  const ledger = new FakeLedger();
  const upstream = new FakeUpstream(reply);
  const logs: any[] = [];
  const handle = createHandler({
    pricing: loadPricing(),
    ledger,
    upstream,
    guard,
    // 全行が必須項目の検証（toLogLine）を通ることも確かめる
    log: { write: (e) => logs.push(JSON.parse(toLogLine(e))) },
    upstreams: { jin: 'https://jin.example', osd: 'https://osd.example' },
    publicBaseUrl: 'https://gw.example',
    logSalt: 'salt',
    blockCardTopUp,
  });
  return { ledger, upstream, logs, handle, guard };
}

const req = (path: string, token = 'tok', search = ''): GatewayRequest => ({
  method: 'GET',
  path,
  search,
  header: (n) => (n === 'payment-signature' && token ? token : undefined),
});

test('success: buys upstream, then consumes credits matching the price', async () => {
  const { handle, ledger, upstream, logs } = setup();
  const res = await handle(req('/api/jin/movers', 'tok', '?d=1'));
  assert.equal(res.status, 200);
  assert.equal(upstream.calls[0].url, 'https://jin.example/api/jin/movers?d=1');
  assert.deepEqual(ledger.settled, [2]);
  assert.equal(logs[0].outcome, 'ok');
  assert.equal(logs[0].creditsConsumed, 2);
  assert.equal(logs[0].upstreamTx, 'sig123');
  assert.equal(logs[0].upstreamCostMicro, '20000');
  assert.notEqual(logs[0].tokenId, 'tok');
  assert.equal(JSON.stringify(logs[0]).includes('"tok"'), false, 'raw token must not be logged');
});

test('upstream failure: credits are NOT consumed', async () => {
  const { handle, ledger, logs } = setup(() => ({ status: 500, body: new Uint8Array(), attemptedMicro: 10_000n, paidMicro: 0n, latencyMs: 1, error: 'boom' }));
  const res = await handle(req('/api/jin/series'));
  assert.equal(res.status, 502);
  assert.deepEqual(ledger.settled, []);
  assert.equal(logs[0].outcome, 'upstream_failed');
  assert.equal(logs[0].creditsConsumed, 0);
});

test('missing token: 402 with payment-required header, no upstream call', async () => {
  const { handle, upstream } = setup();
  const res = await handle(req('/api/jin/series', ''));
  assert.equal(res.status, 402);
  assert.ok(res.headers['payment-required']);
  assert.equal(upstream.calls.length, 0);
});

test('insufficient balance: 402 before any upstream purchase (avoids card top-up)', async () => {
  const { handle, ledger, upstream, logs } = setup();
  ledger.balanceOf = 1n;
  const res = await handle(req('/api/jin/movers'));
  assert.equal(res.status, 402);
  assert.equal(JSON.parse(res.body as string).error, 'insufficient_credits');
  assert.equal(upstream.calls.length, 0);
  assert.equal(logs[0].outcome, 'insufficient_credits');
});

test('verify says insufficient: 402 insufficient_credits', async () => {
  const { handle, ledger } = setup();
  ledger.verifyOk = false;
  const res = await handle(req('/api/jin/series'));
  assert.equal(res.status, 402);
  assert.equal(JSON.parse(res.body as string).error, 'insufficient_credits');
});

test('daily cap: requests beyond the cap are refused and consume nothing', async () => {
  const guard = new SpendGuard(usdToMicro('0.05'), usdToMicro('0.03'));
  const { handle, ledger, logs } = setup(ok, guard);
  assert.equal((await handle(req('/api/jin/movers'))).status, 200); // $0.02
  assert.equal((await handle(req('/api/jin/series'))).status, 200); // $0.03 total
  const res = await handle(req('/api/jin/series'));
  assert.equal(res.status, 503);
  assert.deepEqual(ledger.settled, [2, 1]);
  assert.equal(logs[2].outcome, 'gateway_cap_exceeded');
});

test('settle failure: data is withheld and logged as unrecovered cost', async () => {
  const { handle, ledger, logs } = setup();
  ledger.settleResult = { ok: false, error: 'nvm down' };
  const res = await handle(req('/api/alpha/jp/catalysts'));
  assert.equal(res.status, 502);
  assert.equal(logs[0].outcome, 'settle_failed');
  assert.equal(logs[0].upstreamCostMicro, '10000');
});

test('concurrent requests cannot overdraw the prepaid balance', async () => {
  const { handle, ledger, upstream } = setup();
  ledger.balanceOf = 2n;
  const results = await Promise.all([handle(req('/api/jin/movers')), handle(req('/api/jin/movers'))]);
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 402]);
  assert.equal(upstream.calls.length, 1);
});

test('unknown route: 404', async () => {
  const { handle } = setup();
  assert.equal((await handle(req('/nope'))).status, 404);
});

test('BLOCK_CARD_TOPUP=false: no gateway pre-check, Nevermined top-up is recorded', async () => {
  const guard = new SpendGuard(usdToMicro('0.05'), usdToMicro('5'));
  const { handle, ledger, upstream, logs } = setup(ok, guard, false);
  ledger.balanceOf = 0n;
  ledger.settleResult = { ok: true, creditsRedeemed: 1, remaining: '999', tx: '0xs', topUpOrderTx: 'pi_topup' };
  const res = await handle(req('/api/jin/series'));
  assert.equal(res.status, 200);
  assert.equal(upstream.calls.length, 1);
  assert.equal(logs[0].cardTopUpOrderTx, 'pi_topup');
});

test('every log line has the required fields, including requests rejected early', async () => {
  const { handle, logs } = setup();
  await handle(req('/nope'));
  await handle(req('/api/jin/series', ''));
  await handle(req('/api/jin/series'));
  for (const e of logs) {
    for (const k of ['time_utc', 'date_jst', 'tokenId', 'planKind', 'verify', 'settle', 'creditsConsumed', 'upstreamTx']) {
      assert.ok(k in e, `${k} missing (${e.outcome})`);
    }
  }
  assert.deepEqual(
    logs.map((e) => [e.tokenId === 'none', e.verify, e.settle, e.upstreamTx]),
    [
      [true, 'skipped', 'skipped', 'none'],
      [true, 'skipped', 'skipped', 'none'],
      [false, 'valid', 'ok', 'sig123'],
    ],
  );
});

test('the endpoint sent to Nevermined is the actual requested URL (ticker expanded)', async () => {
  const { handle, ledger } = setup();
  await handle(req('/api/alpha/jp/catalysts'));
  assert.deepEqual(ledger.endpoints, ['https://gw.example/api/alpha/jp/catalysts']);
});

test('per-call cap lowered to $0.001: the request is refused before signing and nothing is settled', async () => {
  const guard = new SpendGuard(usdToMicro('0.001'), usdToMicro('5'));
  const { handle, ledger, logs } = setup(ok, guard);
  const res = await handle(req('/api/jin/series'));
  assert.equal(res.status, 503);
  assert.deepEqual(ledger.settled, []);
  assert.equal(logs[0].outcome, 'gateway_cap_exceeded');
  assert.equal(logs[0].upstreamTx, 'none');
  assert.equal(guard.snapshot().spent, 0n);
});
