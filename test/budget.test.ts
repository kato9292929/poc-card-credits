import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpendGuard } from '../src/budget.ts';
import { usdToMicro, microToUsd, atomicToMicro } from '../src/money.ts';
import { HARD_MAX_PER_CALL, HARD_MAX_PER_DAY } from '../src/config.ts';

test('hard caps are $0.05 per call and $5 per day', () => {
  assert.equal(HARD_MAX_PER_CALL, 50_000n);
  assert.equal(HARD_MAX_PER_DAY, 5_000_000n);
});

test('money conversions', () => {
  assert.equal(usdToMicro('0.01'), 10_000n);
  assert.equal(usdToMicro('5'), 5_000_000n);
  assert.equal(microToUsd(20_000n), '0.020000');
  assert.throws(() => usdToMicro('0.0000001'));
  assert.throws(() => usdToMicro('-1'));
  assert.equal(atomicToMicro('10000', 6), 10_000n);
  assert.equal(atomicToMicro('1', 18), 1n); // 端数は切り上げ
});

test('per-call cap refuses amounts above $0.05', () => {
  const g = new SpendGuard(usdToMicro('0.05'), usdToMicro('5'));
  const r = g.reserve(usdToMicro('0.06'));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.reason, 'per_call_cap');
  assert.equal(g.reserve(usdToMicro('0.05')).ok, true);
});

test('daily cap counts committed and in-flight spend', () => {
  const g = new SpendGuard(usdToMicro('0.05'), usdToMicro('0.10'));
  const a = g.reserve(usdToMicro('0.05'));
  const b = g.reserve(usdToMicro('0.05'));
  assert.ok(a.ok && b.ok);
  const c = g.reserve(usdToMicro('0.01'));
  assert.equal(!c.ok && c.reason, 'daily_cap');
  // 支払いを送らなかった予約は解放される
  if (b.ok) b.reservation.release();
  const d = g.reserve(usdToMicro('0.01'));
  assert.ok(d.ok);
  if (a.ok) a.reservation.commit();
  if (d.ok) d.reservation.commit();
  assert.equal(g.snapshot().spent, usdToMicro('0.06'));
  assert.equal(g.snapshot().reserved, 0n);
});

test('daily cap restores spend from log and resets on a new JST day (15:00 UTC)', () => {
  let now = new Date('2026-10-13T14:59:00Z'); // JST 10/13 23:59
  const restored: Record<string, bigint> = { '2026-10-13': usdToMicro('4.99') };
  const g = new SpendGuard(usdToMicro('0.05'), usdToMicro('5'), (d) => restored[d] ?? 0n, () => now);
  assert.equal(g.reserve(usdToMicro('0.02')).ok, false);
  now = new Date('2026-10-13T15:00:01Z'); // JST 10/14 00:00
  assert.equal(g.snapshot().day, '2026-10-14');
  assert.equal(g.reserve(usdToMicro('0.02')).ok, true);
});
