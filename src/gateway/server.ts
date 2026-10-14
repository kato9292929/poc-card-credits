import express from 'express';
import { loadGatewayConfig } from '../config.ts';
import { assertRoutesWithinCap, loadPricing } from '../pricing.ts';
import { jstDay } from '../log.ts';
import { VercelBlobLogStore } from '../logstore/blob.ts';
import { FileLogStore } from '../logstore/file.ts';
import { GatewayLogWriter } from '../logstore/writer.ts';
import { parseLines, type LogStore } from '../logstore/types.ts';
import { logRoutes } from './log-routes.ts';
import { SpendGuard } from '../budget.ts';
import { NeverminedLedger } from '../ledger/nevermined.ts';
import { X402UpstreamBuyer } from '../upstream/x402.ts';
import { loadAssets } from '../upstream/assets.ts';
import { createHandler } from './handler.ts';
import { microToUsd } from '../money.ts';

const cfg = loadGatewayConfig();
const pricing = loadPricing();
assertRoutesWithinCap(pricing, cfg.maxPerCall);
// ログの保存先：既定は Vercel Blob。ローカルファイルは開発時だけ（LOG_SINK=file）
const store: LogStore =
  cfg.logSink === 'blob' ? new VercelBlobLogStore({ token: cfg.blobReadWriteToken! }) : new FileLogStore(cfg.logDir);
const log = new GatewayLogWriter(store);

// 再起動しても日次上限がリセットされないよう、当日（JST）のログの支払い試行額を合算して復元する。
// 保存先が読めないときは起動しない（上限を正しく復元できないまま支払いを始めないため）
const spentFromLog = (text: string | null) =>
  parseLines(text).reduce((sum, e) => sum + BigInt(e.upstreamAttemptMicro ?? e.upstreamCostMicro ?? '0'), 0n);
const today = jstDay();
const restored: Record<string, bigint> = { [today]: spentFromLog(await store.read(today)) };
const guard = new SpendGuard(cfg.maxPerCall, cfg.maxPerDay, (day) => restored[day] ?? 0n);

const upstream = await X402UpstreamBuyer.create({
  evmPrivateKey: cfg.evmPrivateKey,
  svmPrivateKey: cfg.svmPrivateKey,
  assets: loadAssets(),
  testnetOnly: cfg.testnetOnly,
  maxPerCall: cfg.maxPerCall,
});

const handle = createHandler({
  pricing,
  ledger: new NeverminedLedger({
    nvmApiKey: cfg.nvmApiKey,
    environment: cfg.nvmEnvironment,
    planId: cfg.planId,
    agentId: cfg.agentId,
  }),
  upstream,
  guard,
  log,
  upstreams: cfg.upstreams,
  publicBaseUrl: cfg.publicBaseUrl,
  logSalt: cfg.logSalt,
  blockCardTopUp: cfg.blockCardTopUp,
});

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  const s = guard.snapshot();
  res.json({
    ok: true,
    nvmEnvironment: cfg.nvmEnvironment,
    upstreamTestnetOnly: cfg.testnetOnly,
    blockCardTopUp: cfg.blockCardTopUp,
    logSink: cfg.logSink,
    logWriteFailures: log.failures,
    logReadEndpoint: !!cfg.logReadToken,
    gatewayWallet: upstream.addresses,
    spend: { day: s.day, spentUsd: microToUsd(s.spent), inFlightUsd: microToUsd(s.reserved), maxPerCallUsd: microToUsd(s.maxPerCall), maxPerDayUsd: microToUsd(s.maxPerDay) },
    routes: pricing.routes.map((r) => ({ method: r.method, path: r.path, credits: r.credits })),
  });
});

// 実証2用：GET /logs/:date（Bearer LOG_READ_TOKEN、読み取り専用）
app.use(logRoutes(store, cfg.logReadToken));

app.use(async (req, res) => {
  try {
    const q = req.originalUrl.indexOf('?');
    const out = await handle({
      method: req.method,
      path: req.path,
      search: q >= 0 ? req.originalUrl.slice(q) : '',
      header: (n) => req.get(n) ?? undefined,
    });
    res.status(out.status).set(out.headers).send(typeof out.body === 'string' ? out.body : Buffer.from(out.body));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'internal' });
  }
});

app.listen(cfg.port, () => {
  console.log(`gateway listening on :${cfg.port} (nevermined=${cfg.nvmEnvironment}, upstream testnet only=${cfg.testnetOnly})`);
});

// 終了時は書き込み中のログを待つ
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    await log.flush();
    process.exit(0);
  });
}
