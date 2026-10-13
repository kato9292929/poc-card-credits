import express from 'express';
import { loadGatewayConfig } from '../config.ts';
import { assertRoutesWithinCap, loadPricing } from '../pricing.ts';
import { JsonlLog } from '../log.ts';
import { SpendGuard } from '../budget.ts';
import { NeverminedLedger } from '../ledger/nevermined.ts';
import { X402UpstreamBuyer } from '../upstream/x402.ts';
import { loadAssets } from '../upstream/assets.ts';
import { createHandler } from './handler.ts';
import { microToUsd } from '../money.ts';

const cfg = loadGatewayConfig();
const pricing = loadPricing();
assertRoutesWithinCap(pricing, cfg.maxPerCall);
const log = new JsonlLog(cfg.logDir);

// 再起動しても日次上限がリセットされないよう、当日ログの支払い試行額を合算して復元する
const guard = new SpendGuard(cfg.maxPerCall, cfg.maxPerDay, (day) =>
  log.read(day).reduce((sum, e) => sum + BigInt(e.upstreamAttemptMicro ?? e.upstreamCostMicro ?? '0'), 0n),
);

const handle = createHandler({
  pricing,
  ledger: new NeverminedLedger({
    nvmApiKey: cfg.nvmApiKey,
    environment: cfg.nvmEnvironment,
    planId: cfg.planId,
    agentId: cfg.agentId,
  }),
  upstream: await X402UpstreamBuyer.create({
    evmPrivateKey: cfg.evmPrivateKey,
    svmPrivateKey: cfg.svmPrivateKey,
    assets: loadAssets(),
    testnetOnly: cfg.testnetOnly,
    maxPerCall: cfg.maxPerCall,
  }),
  guard,
  log,
  upstreams: cfg.upstreams,
  publicBaseUrl: cfg.publicBaseUrl,
  logSalt: cfg.logSalt,
});

const app = express();
app.disable('x-powered-by');

app.get('/healthz', (_req, res) => {
  const s = guard.snapshot();
  res.json({
    ok: true,
    nvmEnvironment: cfg.nvmEnvironment,
    upstreamTestnetOnly: cfg.testnetOnly,
    spend: { day: s.day, spentUsd: microToUsd(s.spent), inFlightUsd: microToUsd(s.reserved), maxPerCallUsd: microToUsd(s.maxPerCall), maxPerDayUsd: microToUsd(s.maxPerDay) },
    routes: pricing.routes.map((r) => ({ method: r.method, path: r.path, credits: r.credits })),
  });
});

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
