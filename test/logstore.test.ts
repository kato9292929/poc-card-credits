import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { jstDay, toLogLine, type RequestLogEntry } from '../src/log.ts';
import { MemoryLogStore } from '../src/logstore/memory.ts';
import { FileLogStore } from '../src/logstore/file.ts';
import { GatewayLogWriter } from '../src/logstore/writer.ts';
import type { LogStore } from '../src/logstore/types.ts';
import { logRoutes, newReadToken } from '../src/gateway/log-routes.ts';

const entry = (time_utc: string, patch: Partial<RequestLogEntry> = {}): RequestLogEntry => ({
  time_utc,
  date_jst: jstDay(new Date(time_utc)),
  tokenId: 'abcd',
  planKind: 'prepaid',
  verify: 'valid',
  settle: 'ok',
  creditsConsumed: 1,
  upstreamTx: 'sig',
  upstreamNetworkMode: 'mainnet',
  method: 'GET',
  path: '/api/jin/series',
  outcome: 'ok',
  status: 200,
  upstreamCostMicro: '10000',
  latencyMs: 10,
  ...patch,
});

test('jstDay is UTC+9', () => {
  assert.equal(jstDay(new Date('2026-10-13T14:59:59Z')), '2026-10-13');
  assert.equal(jstDay(new Date('2026-10-13T15:00:00Z')), '2026-10-14');
});

test('toLogLine requires the fields and a consistent date_jst', () => {
  assert.doesNotThrow(() => toLogLine(entry('2026-10-13T01:00:00.000Z')));
  assert.throws(() => toLogLine({ ...entry('2026-10-13T01:00:00.000Z'), upstreamTx: '' }), /upstreamTx/);
  assert.throws(() => toLogLine({ ...entry('2026-10-13T01:00:00.000Z'), date_jst: '2026-10-12' }), /date_jst/);
  assert.throws(() => toLogLine(entry('2026-10-13T10:00:00+09:00')), /UTC/);
});

test('writer files lines by JST date', async () => {
  const store = new MemoryLogStore();
  const w = new GatewayLogWriter(store);
  w.write(entry('2026-10-13T14:00:00.000Z'));
  w.write(entry('2026-10-13T16:00:00.000Z'));
  await w.flush();
  assert.deepEqual(await store.days(), ['2026-10-13', '2026-10-14']);
});

test('a failing store never throws into the request path; failures are reported', async () => {
  const broken: LogStore = {
    append: async () => {
      throw new Error('blob down');
    },
    read: async () => null,
    days: async () => [],
  };
  const errors: string[] = [];
  const w = new GatewayLogWriter(broken, (e) => errors.push((e as Error).message));
  assert.doesNotThrow(() => w.write(entry('2026-10-13T01:00:00.000Z')));
  assert.doesNotThrow(() => w.write({ ...entry('2026-10-13T01:00:00.000Z'), tokenId: '' })); // 必須項目の欠けも止めない
  await w.flush();
  assert.equal(w.failures, 2);
  assert.ok(errors.includes('blob down'));
});

test('file store (development) appends lines', async () => {
  const s = new FileLogStore(mkdtempSync(join(tmpdir(), 'gwlog-')));
  await s.append('2026-10-14', '{"a":1}');
  await s.append('2026-10-14', '{"a":2}');
  assert.equal(await s.read('2026-10-14'), '{"a":1}\n{"a":2}\n');
  assert.deepEqual(await s.days(), ['2026-10-14']);
});

async function serve(store: LogStore, token: string | undefined) {
  const server = express().use(logRoutes(store, token)).listen(0);
  return { server, base: `http://127.0.0.1:${(server.address() as any).port}` };
}

test('GET /logs/:date: Bearer LOG_READ_TOKEN required, read only', async () => {
  const store = new MemoryLogStore();
  await store.append('2026-10-14', toLogLine(entry('2026-10-13T16:00:00.000Z')));
  const token = newReadToken();
  const { server, base } = await serve(store, token);
  const auth = { authorization: `Bearer ${token}` };
  try {
    assert.equal((await fetch(`${base}/logs/2026-10-14`)).status, 401);
    assert.equal((await fetch(`${base}/logs/2026-10-14`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) {
      assert.equal((await fetch(`${base}/logs/2026-10-14`, { method, headers: auth, body: method === 'DELETE' ? undefined : 'x' })).status, 405, method);
    }
    const r = await fetch(`${base}/logs/2026-10-14`, { headers: auth });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /ndjson/);
    assert.equal(JSON.parse((await r.text()).trim()).date_jst, '2026-10-14');
    assert.equal((await fetch(`${base}/logs/2026-10-14.jsonl`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${base}/logs/2026-10-15`, { headers: auth })).status, 404);
    assert.equal((await fetch(`${base}/logs/20261014`, { headers: auth })).status, 400);
    // 書き込まれていないこと
    assert.equal((await store.read('2026-10-14'))!.split('\n').filter(Boolean).length, 1);
  } finally {
    server.close();
  }
});

test('GET /logs is closed when LOG_READ_TOKEN is unset or too short', async () => {
  for (const t of [undefined, 'short']) {
    const { server, base } = await serve(new MemoryLogStore(), t);
    try {
      assert.equal((await fetch(`${base}/logs/2026-10-14`, { headers: { authorization: `Bearer ${t}` } })).status, 404);
    } finally {
      server.close();
    }
  }
});

test('config: LOG_SINK=file only with NODE_ENV=development; blob needs its token; short LOG_READ_TOKEN refused', async () => {
  const { loadGatewayConfig } = await import('../src/config.ts');
  const run = (env: Record<string, string>) => withEnv(env, () => loadGatewayConfig());
  assert.equal(run(BASE).logSink, 'blob');
  assert.throws(() => run({ ...BASE, BLOB_READ_WRITE_TOKEN: '' }), /BLOB_READ_WRITE_TOKEN/);
  // Vercel 上では BLOB_STORE_ID（OIDC で認証）だけで足りる
  assert.equal(run({ ...BASE, BLOB_READ_WRITE_TOKEN: '', BLOB_STORE_ID: 'store_x' }).blobReadWriteToken, undefined);
  assert.equal(run({ ...BASE, BLOB_READ_WRITE_TOKEN: '', LOG_SINK: 'file', NODE_ENV: 'development' }).logSink, 'file');
  assert.throws(() => run({ ...BASE, LOG_SINK: 'file' }), /development only/); // Sandbox の運用でも file は不可
  assert.throws(() => run({ ...BASE, LOG_SINK: 'file', NODE_ENV: 'production' }), /development only/);
  assert.throws(() => run({ ...BASE, LOG_SINK: 'file', NODE_ENV: 'development', ALLOW_LIVE: 'true' }), /development only/);
  assert.throws(() => run({ ...BASE, LOG_READ_TOKEN: 'short' }), /32/);
});

test('config: API key prefix must match NVM_ENVIRONMENT; live needs ALLOW_LIVE (moved from percall)', async () => {
  const { loadGatewayConfig, nvmEnvironment } = await import('../src/config.ts');
  assert.throws(() => withEnv({ ...BASE, NVM_API_KEY_SELLER: 'live:k' }, () => loadGatewayConfig()), /does not match/);
  // 接頭辞の無いキーは NVM_ENVIRONMENT（sandbox）に従う
  assert.equal(withEnv({ ...BASE, NVM_API_KEY_SELLER: 'k' }, () => loadGatewayConfig()).nvmEnvironment, 'sandbox');
  assert.throws(() => withEnv({ NVM_ENVIRONMENT: 'live' }, () => nvmEnvironment('live:k')), /ALLOW_LIVE/);
  assert.equal(withEnv({ NVM_ENVIRONMENT: 'live', ALLOW_LIVE: 'true' }, () => nvmEnvironment('live:k')), 'live');
  assert.throws(() => withEnv({ NVM_ENVIRONMENT: 'sandbox' }, () => nvmEnvironment('sandbox:a', 'live:b')), /does not match/);
  // プレフィックスの無いキーでも、エラーにキーの中身を出さない
  const bare = 'eyJhbGciOiJFUzI1NksifQ.secretpayload.signature';
  // 接頭辞の無いキー（新しい App が発行する JWT だけの形）は NVM_ENVIRONMENT に従う
  assert.equal(withEnv({ NVM_ENVIRONMENT: 'sandbox' }, () => nvmEnvironment(bare)), 'sandbox');
  // 認識できない接頭辞でも、エラーにキーの中身を出さない
  assert.throws(
    () => withEnv({ NVM_ENVIRONMENT: 'sandbox' }, () => nvmEnvironment(`${bare}:x`)),
    (e: Error) => /no environment prefix/.test(e.message) && !e.message.includes('secretpayload'),
  );
});

test('config: UPSTREAM_MAINNET_PURCHASE opens mainnet upstream in Sandbox only, separate from ALLOW_LIVE', async () => {
  const { loadGatewayConfig } = await import('../src/config.ts');
  const run = (env: Record<string, string>) => withEnv(env, () => loadGatewayConfig());
  assert.equal(run(BASE).testnetOnly, true);
  const on = run({ ...BASE, UPSTREAM_MAINNET_PURCHASE: 'true' });
  assert.equal(on.testnetOnly, false);
  assert.equal(on.upstreamMainnetPurchase, true);
  // Nevermined が live なら、ALLOW_LIVE=true があっても拒否する
  assert.throws(
    () => run({ ...BASE, NVM_API_KEY_SELLER: 'live:k', NVM_ENVIRONMENT: 'live', ALLOW_LIVE: 'true', UPSTREAM_MAINNET_PURCHASE: 'true' }),
    /Sandbox phase only/,
  );
  // 従来の UPSTREAM_TESTNET_ONLY=false は今までどおり ALLOW_LIVE が要る
  assert.throws(() => run({ ...BASE, UPSTREAM_TESTNET_ONLY: 'false' }), /ALLOW_LIVE/);
});

test('normalizeNvmKey absorbs paste artifacts without touching the key', async () => {
  const { normalizeNvmKey } = await import('../src/settings.ts');
  for (const v of ['sandbox：eyJabc', ' sandbox:eyJabc\n', '\uFEFFsandbox:eyJabc', '"sandbox:eyJabc"', 'sandbox : eyJabc', 'sandbox:\u200BeyJabc']) {
    assert.equal(normalizeNvmKey(v), 'sandbox:eyJabc', JSON.stringify(v));
  }
  assert.equal(normalizeNvmKey('eyJabc'), 'eyJabc');
});

const BASE = {
  NVM_API_KEY_SELLER: 'sandbox:k', NVM_PLAN_ID: 'p', NVM_AGENT_ID: 'a', UPSTREAM_OSD_URL: 'https://o', UPSTREAM_JIN_URL: 'https://j',
  LOG_SALT: 's', GATEWAY_WALLET_SECRET: 'x', NVM_ENVIRONMENT: 'sandbox', BLOB_READ_WRITE_TOKEN: 't',
};

function withEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved = { ...process.env };
  for (const k of ['LOG_SINK', 'ALLOW_LIVE', 'LOG_READ_TOKEN', 'UPSTREAM_TESTNET_ONLY', 'UPSTREAM_MAINNET_PURCHASE', 'BLOB_STORE_ID', 'GATEWAY_EVM_PRIVATE_KEY', 'NODE_ENV', 'NVM_ENVIRONMENT']) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}
