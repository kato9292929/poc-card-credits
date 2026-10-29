import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buyerCronAllowed, runBuyerCron, type BuyerCronDeps } from '../src/buyer/cron.ts';
import { MemoryLogStore } from '../src/logstore/memory.ts';
import { MemoryStateStore } from '../src/buyer/state.ts';
import { parseLines } from '../src/logstore/types.ts';
import { resumeBuyer } from '../src/buyer/resume.ts';

function deps(reply: (path: string) => { status: number; body: unknown; headers?: Record<string, string> }, patch: Partial<BuyerCronDeps> = {}) {
  const store = new MemoryLogStore();
  const state = new MemoryStateStore();
  const called: string[] = [];
  const notes: string[] = [];
  let reused = false;
  const d: BuyerCronDeps = {
    store,
    state,
    mintToken: async () => {
      const r = { token: 'tok-secret', delegation: { delegationId: 'deleg-123456', reused, createdAt: '2026-10-14T00:00:00Z', spendingLimitCents: 100, provider: 'stripe' as const } };
      reused = true;
      return r;
    },
    gatewayUrl: 'https://gw.example/',
    paths: ['/api/jin/series', '/api/alpha/jp/catalysts'],
    callsPerDay: 3,
    salt: 's',
    now: () => new Date('2026-10-14T01:00:00Z'),
    fetch: (async (url: string) => {
      const path = new URL(url).pathname;
      called.push(path);
      const r = reply(path);
      return new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers });
    }) as any,
    notify: async (t) => void notes.push(t),
    ...patch,
  };
  return { d, store, state, called, notes };
}

test('alternates JIN and OSD, stops at the daily quota, logs delegation creation once', async () => {
  const { d, store, called } = deps(() => ({ status: 200, body: { ok: 1 }, headers: { 'x-credits-consumed': '1' } }));
  for (let i = 0; i < 4; i++) await runBuyerCron(d);
  assert.deepEqual(called, ['/api/jin/series', '/api/alpha/jp/catalysts', '/api/jin/series']);
  const lines = parseLines(await store.read('2026-10-14'));
  assert.equal(lines.filter((e) => e.event === 'call').length, 3);
  assert.equal(lines.filter((e) => e.event === 'delegation_created').length, 1);
  assert.ok(lines.every((e) => e.date_jst === '2026-10-14' && e.ts.endsWith('Z')));
  assert.ok(!JSON.stringify(lines).includes('tok-secret'), 'raw token must not be logged');
});

test('insufficient credits: records, stops and notifies; later runs skip until resumed', async () => {
  const { d, store, state, called, notes } = deps(() => ({ status: 402, body: { error: 'insufficient_credits', balance: '0' } }));
  const r = await runBuyerCron(d);
  assert.deepEqual(r, { action: 'called', status: 402, path: '/api/jin/series', exhausted: true });
  assert.equal(state.value?.stopped, true);
  assert.equal(notes.length, 1);
  const again = await runBuyerCron(d);
  assert.deepEqual(again, { action: 'skipped', reason: 'stopped' });
  assert.equal(called.length, 1);
  const kinds = parseLines(await store.read('2026-10-14')).map((e) => e.event);
  assert.deepEqual(kinds, ['delegation_created', 'call', 'credits_exhausted', 'skipped']);
});

test('delegation limit reached is classified and stops the agent', async () => {
  const { d, state } = deps(() => ({ status: 402, body: { error: 'insufficient_credits', reason: 'DELEGATION_INACTIVE: Delegation status is Exhausted' } }));
  await runBuyerCron(d);
  assert.equal(state.value?.errorKind, 'delegation_exhausted');
});

test('a gateway 502 (upstream failure) is logged but does not stop the agent', async () => {
  const { d, state } = deps(() => ({ status: 502, body: { error: 'upstream_failed' } }));
  const r = await runBuyerCron(d);
  assert.equal(r.action === 'called' && r.exhausted, false);
  assert.equal(state.value, null);
});

test('resumeBuyer clears the stop state and logs how long the buyer was stopped', async () => {
  const state = new MemoryStateStore({ stopped: true, since: '2026-10-26T01:00:00.000Z', errorKind: 'insufficient_credits', status: 402 });
  const store = new MemoryLogStore();
  const r = await resumeBuyer(state, store, new Date('2026-10-26T03:30:00.000Z'));
  assert.deepEqual(r, { resumed: true, stoppedSince: '2026-10-26T01:00:00.000Z', stoppedForSec: 9000, previousKind: 'insufficient_credits' });
  assert.equal(state.value?.stopped, false);
  const line = JSON.parse((await store.read('2026-10-26'))!.trim());
  assert.equal(line.event, 'resumed');
  assert.equal(line.stoppedForSec, 9000);
  assert.deepEqual(await resumeBuyer(state, store), { resumed: false });
});

test('buyerCronAllowed: 本番（live）では定期購入を止める。BUYER_CRON_IN_LIVE=true のときだけ動かす', () => {
  assert.deepEqual(buyerCronAllowed({}), { ok: true });
  assert.deepEqual(buyerCronAllowed({ NVM_ENVIRONMENT: 'sandbox' }), { ok: true });
  assert.deepEqual(buyerCronAllowed({ NVM_ENVIRONMENT: 'live' }), { ok: false, reason: 'live_environment' });
  assert.deepEqual(buyerCronAllowed({ NVM_ENVIRONMENT: 'staging_live' }), { ok: false, reason: 'live_environment' });
  assert.deepEqual(buyerCronAllowed({ NVM_ENVIRONMENT: 'live', BUYER_CRON_IN_LIVE: 'true' }), { ok: true });
});
