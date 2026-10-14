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
  method: 'GET',
  path: '/jin/series',
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

test('config: LOG_SINK=file is refused with live settings; blob needs its token; short LOG_READ_TOKEN refused', async () => {
  const { loadGatewayConfig } = await import('../src/config.ts');
  const base = {
    NVM_API_KEY: 'k', NVM_PLAN_ID: 'p', NVM_AGENT_ID: 'a', OSD_BASE_URL: 'https://o', JIN_BASE_URL: 'https://j',
    LOG_SALT: 's', GATEWAY_SVM_PRIVATE_KEY: 'x', NVM_ENVIRONMENT: 'sandbox', BLOB_READ_WRITE_TOKEN: 't',
  };
  const run = (env: Record<string, string>) => {
    const saved = { ...process.env };
    for (const k of ['LOG_SINK', 'ALLOW_LIVE', 'LOG_READ_TOKEN', 'UPSTREAM_TESTNET_ONLY', 'GATEWAY_EVM_PRIVATE_KEY']) delete process.env[k];
    Object.assign(process.env, env);
    try {
      return loadGatewayConfig();
    } finally {
      process.env = saved;
    }
  };
  assert.equal(run(base).logSink, 'blob');
  assert.throws(() => run({ ...base, BLOB_READ_WRITE_TOKEN: '' }), /BLOB_READ_WRITE_TOKEN/);
  assert.equal(run({ ...base, BLOB_READ_WRITE_TOKEN: '', LOG_SINK: 'file' }).logSink, 'file');
  assert.throws(() => run({ ...base, LOG_SINK: 'file', ALLOW_LIVE: 'true' }), /development only/);
  assert.throws(() => run({ ...base, LOG_READ_TOKEN: 'short' }), /32/);
});
