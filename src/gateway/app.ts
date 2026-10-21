/**
 * ゲートウェイの Express アプリを組み立てる。Vercel（src/index.ts の default export）と
 * ローカル（src/gateway/server.ts の listen）の両方から使う。
 *
 * 設定が足りないときは起動を止めず、/healthz が 503 で「足りない環境変数の名前」だけを返す
 * （値は出さない）。デプロイ先の設定を npm run preflight -- --remote で確かめるため。
 */
import express from 'express';
import { timingSafeEqual, createHash } from 'node:crypto';
import { Payments } from '@nevermined-io/payments';
import { waitUntil } from '@vercel/functions';
import { HARD_MAX_PER_CALL, delegationLimitCents, loadGatewayConfig, nvmEnvironment } from '../config.ts';
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
import { runBuyerCron } from '../buyer/cron.ts';
import { BlobStateStore } from '../buyer/state.ts';
import { ensureDelegation, type CardProvider } from '../buyer/delegation.ts';

/** デプロイ先（Vercel）に必要な環境変数。名前だけを /healthz に出す */
export const REMOTE_REQUIRED = {
  gateway: ['NVM_API_KEY_SELLER', 'NVM_PLAN_ID', 'NVM_AGENT_ID', 'UPSTREAM_JIN_URL', 'UPSTREAM_OSD_URL', 'GATEWAY_WALLET_SECRET', 'BLOB_STORE_ID', 'LOG_SALT', 'PUBLIC_BASE_URL'],
  buyerCron: ['NVM_API_KEY_BUYER', 'CRON_SECRET'],
  logRead: ['LOG_READ_TOKEN'],
} as const;

// 代わりの値があれば足りているとみなす（EVM の鍵、Blob の読み書きトークン）
const ALTERNATIVES: Record<string, string> = { GATEWAY_WALLET_SECRET: 'GATEWAY_EVM_PRIVATE_KEY', BLOB_STORE_ID: 'BLOB_READ_WRITE_TOKEN' };
const missing = (names: readonly string[]) => names.filter((n) => !process.env[n] && !(ALTERNATIVES[n] && process.env[ALTERNATIVES[n]]));

function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || secret.length < 16) return false;
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  if (!m) return false;
  const d = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(d(m[1]), d(secret));
}

export async function createGatewayApp(): Promise<{ app: express.Express; flush: () => Promise<void> }> {
  const app = express();
  app.disable('x-powered-by');
  try {
    return await buildApp(app);
  } catch (e) {
    // 起動時の例外（不正な API キーなど）で関数ごと落ちないよう、理由だけを返す状態にする（値は出さない）
    const reason = `startup failed: ${(e as Error).message}`;
    console.error(`[startup] ${reason}`);
    const fallback = express();
    fallback.disable('x-powered-by');
    fallback.get('/healthz', (_req, res) => void res.status(503).json({ ok: false, reason }));
    fallback.use((_req, res) => void res.status(503).json({ error: 'gateway_not_configured' }));
    return { app: fallback, flush: async () => {} };
  }
}

async function buildApp(app: express.Express): Promise<{ app: express.Express; flush: () => Promise<void> }> {
  let cfg: ReturnType<typeof loadGatewayConfig>;
  try {
    cfg = loadGatewayConfig();
  } catch (e) {
    // 設定不足：理由と足りない名前だけを返す（値は返さない）
    const reason = (e as Error).message;
    console.error(`[config] ${reason}`);
    app.get('/healthz', (_req, res) => {
      res.status(503).json({
        ok: false,
        reason,
        missing: { gateway: missing(REMOTE_REQUIRED.gateway), buyerCron: missing(REMOTE_REQUIRED.buyerCron), logRead: missing(REMOTE_REQUIRED.logRead) },
      });
    });
    app.use((_req, res) => void res.status(503).json({ error: 'gateway_not_configured' }));
    return { app, flush: async () => {} };
  }

  const pricing = loadPricing();
  // コードに固定した上限（$0.05）を超えるルートがあれば起動しない
  assertRoutesWithinCap(pricing, HARD_MAX_PER_CALL);
  // 環境変数で上限を下げた結果、超えるルートがある場合は起動はする（そのルートは署名前に拒否される）
  const overLowered = pricing.routes.filter((r) => r.price > cfg.maxPerCall);
  if (overLowered.length) {
    console.warn(`[cap] MAX_USD_PER_CALL=$${microToUsd(cfg.maxPerCall)} より高いルートは署名前に拒否される: ${overLowered.map((r) => `${r.id}=$${r.priceUsd}`).join(', ')}`);
  }

  // ログの保存先：既定は Vercel Blob。ローカルファイルは開発時だけ（NODE_ENV=development かつ LOG_SINK=file）
  const store: LogStore = cfg.logSink === 'blob' ? new VercelBlobLogStore({ token: cfg.blobReadWriteToken }) : new FileLogStore(cfg.logDir);
  const buyerStore: LogStore =
    cfg.logSink === 'blob' ? new VercelBlobLogStore({ token: cfg.blobReadWriteToken, prefix: 'log/buyer/' }) : new FileLogStore(`${cfg.logDir}/buyer`);
  const log = new GatewayLogWriter(store);
  // Vercel では応答のあと関数が止まりうるので、ログの書き込みが終わるまで延ばす
  if (process.env.VERCEL) log.onPending = (p) => waitUntil(p);

  // 日次上限：当日（JST）のログの支払い試行額を合算して取り込む。起動時に加え、支払いの直前にも読み直す
  // （Vercel では複数のインスタンスが並ぶので、ほかのインスタンスの支払いも数えるため）
  const spentFromLog = (text: string | null) =>
    parseLines(text).reduce((sum, e) => sum + BigInt(e.upstreamAttemptMicro ?? e.upstreamCostMicro ?? '0'), 0n);
  // Vercel の Blob（BLOB_STORE_ID ＋ OIDC）は、リクエストの中でしか認証できない（OIDC トークンはリクエストのヘッダーで渡される）。
  // そのため Blob のときは起動時に読まず、支払いの直前の syncSpend だけで当日の額を取り込む（読めなければ支払わない）。
  const today = jstDay();
  let initial = 0n;
  if (cfg.logSink !== 'blob') {
    try {
      initial = spentFromLog(await store.read(today));
    } catch (e) {
      // 当日の支払い額を読めないと日次上限を守れないので、支払いを受け付けない状態で起動する
      const reason = `log store unavailable: ${(e as Error).message}`;
      console.error(`[startup] ${reason}`);
      app.get('/healthz', (_req, res) => void res.status(503).json({ ok: false, reason }));
      app.use((_req, res) => void res.status(503).json({ error: 'log_store_unavailable' }));
      return { app, flush: async () => {} };
    }
  }
  const guard = new SpendGuard(cfg.maxPerCall, cfg.maxPerDay, (day) => (day === today ? initial : 0n));
  const syncSpend = async () => {
    const day = jstDay();
    guard.observe(day, spentFromLog(await store.read(day)));
  };

  const upstream = await X402UpstreamBuyer.create({
    evmPrivateKey: cfg.evmPrivateKey,
    svmPrivateKey: cfg.svmPrivateKey,
    assets: loadAssets(),
    testnetOnly: cfg.testnetOnly,
    maxPerCall: cfg.maxPerCall,
  });

  const handle = createHandler({
    pricing,
    ledger: new NeverminedLedger({ nvmApiKey: cfg.nvmApiKey, environment: cfg.nvmEnvironment, planId: cfg.planId, agentId: cfg.agentId }),
    upstream,
    guard,
    log,
    upstreams: cfg.upstreams,
    publicBaseUrl: cfg.publicBaseUrl,
    logSalt: cfg.logSalt,
    blockCardTopUp: cfg.blockCardTopUp,
    upstreamNetworkMode: cfg.testnetOnly ? 'testnet' : 'mainnet',
    syncSpend: cfg.logSink === 'blob' ? syncSpend : undefined,
  });

  app.get('/healthz', async (_req, res) => {
    // ログの保存先を、このリクエストの中で読めるか確かめる（読めなければ支払いも止まるので 503）
    let logStore: string;
    try {
      if (cfg.logSink === 'blob') await syncSpend();
      logStore = 'ok';
    } catch (e) {
      logStore = `unavailable: ${(e as Error).message}`;
    }
    const s = guard.snapshot();
    res.status(logStore === 'ok' ? 200 : 503).json({
      ok: logStore === 'ok',
      logStore,
      nvmEnvironment: cfg.nvmEnvironment,
      upstreamTestnetOnly: cfg.testnetOnly,
      upstreamMainnetPurchase: cfg.upstreamMainnetPurchase,
      blockCardTopUp: cfg.blockCardTopUp,
      logSink: cfg.logSink,
      logWriteFailures: log.failures,
      logReadEndpoint: !!cfg.logReadToken,
      buyerCron: missing(REMOTE_REQUIRED.buyerCron).length === 0,
      missing: { buyerCron: missing(REMOTE_REQUIRED.buyerCron), logRead: missing(REMOTE_REQUIRED.logRead) },
      gatewayWallet: upstream.addresses,
      spend: { day: s.day, spentUsd: microToUsd(s.spent), inFlightUsd: microToUsd(s.reserved), maxPerCallUsd: microToUsd(s.maxPerCall), maxPerDayUsd: microToUsd(s.maxPerDay) },
      routes: pricing.routes.map((r) => ({ method: r.method, path: r.path, credits: r.credits })),
    });
  });

  // 実証2用：GET /logs/:date（Bearer LOG_READ_TOKEN、読み取り専用）。週次レポート用に GET /logs/buyer/:date も
  app.use(logRoutes(store, cfg.logReadToken, buyerStore));

  // §3-1 の購入（買い手の API キーは Vercel にだけある）：Bearer $CRON_SECRET のときだけ、買い手として
  // Stripe Checkout のリンクを作る（checkout）／プランの残高を返す（balance）。時刻は log/buyer/ に残し、
  // 「購入から利用開始までの時間」（§5）の起点と終点にする
  const buyerPayments = () => {
    const key = process.env.NVM_API_KEY_BUYER!;
    return Payments.getInstance({ nvmApiKey: key, environment: nvmEnvironment(key) });
  };
  const buyerEvent = (e: object) => {
    const t = new Date();
    return buyerStore.append(jstDay(t), JSON.stringify({ ts: t.toISOString(), date_jst: jstDay(t), planId: cfg.planId, ...e }));
  };
  app.post('/buyer/checkout', async (req, res) => {
    if (!bearerMatches(req.get('authorization'), process.env.CRON_SECRET)) return void res.status(401).json({ error: 'unauthorized' });
    if (missing(REMOTE_REQUIRED.buyerCron).length) return void res.status(503).json({ error: 'buyer_not_configured' });
    try {
      const payments = buyerPayments();
      const before = await payments.plans.getPlanBalance(cfg.planId);
      const raw: any = await payments.plans.orderFiatPlan(cfg.planId);
      // 戻り値の形が SDK の型（{ result: { checkoutLink, ... } }）と違うことがあるので、URL を探して返す
      const r = raw?.result ?? raw;
      const link: string | undefined = r?.checkoutLink ?? r?.url ?? r?.checkoutUrl;
      if (!link) {
        const shape = Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, typeof v === 'string' && /^https?:/.test(v) ? v : typeof v]));
        return void res.status(502).json({ error: 'no_checkout_link', shape });
      }
      await buyerEvent({ event: 'checkout_created', stripeCheckoutSessionId: r.stripeCheckoutSessionId ?? r.sessionId, startBalance: String(before.balance) });
      res.json({ checkoutLink: link, startBalance: String(before.balance) });
    } catch (e) {
      res.status(500).json({ error: 'checkout_failed', reason: (e as Error).message });
    }
  });
  app.get('/buyer/balance', async (req, res) => {
    if (!bearerMatches(req.get('authorization'), process.env.CRON_SECRET)) return void res.status(401).json({ error: 'unauthorized' });
    if (missing(REMOTE_REQUIRED.buyerCron).length) return void res.status(503).json({ error: 'buyer_not_configured' });
    try {
      const b = await buyerPayments().plans.getPlanBalance(cfg.planId);
      // 残高が初めて付いたことの記録は呼び出し側が ?record=credits_available で頼む（ポーリングのたびに行を増やさない）
      if (req.query.record === 'credits_available') await buyerEvent({ event: 'credits_available', balance: String(b.balance) });
      res.json({ balance: String(b.balance), isSubscriber: (b as any).isSubscriber, holderAddress: (b as any).holderAddress });
    } catch (e) {
      res.status(500).json({ error: 'balance_failed', reason: (e as Error).message });
    }
  });

  // 買い手エージェント（Vercel Cron）：Authorization: Bearer $CRON_SECRET のときだけ1回分を実行する
  app.get('/cron/buyer', async (req, res) => {
    if (!bearerMatches(req.get('authorization'), process.env.CRON_SECRET)) return void res.status(401).json({ error: 'unauthorized' });
    const lack = missing(REMOTE_REQUIRED.buyerCron);
    if (lack.length) return void res.status(503).json({ error: 'buyer_not_configured', missing: lack });
    try {
      const buyerKey = process.env.NVM_API_KEY_BUYER!;
      const environment = nvmEnvironment(buyerKey);
      const payments = Payments.getInstance({ nvmApiKey: buyerKey, environment });
      const provider = (process.env.BUYER_CARD_PROVIDER ?? 'stripe') as CardProvider;
      const webhook = process.env.NOTIFY_WEBHOOK_URL;
      const r = await runBuyerCron({
        store: buyerStore,
        state: new BlobStateStore(cfg.blobReadWriteToken),
        mintToken: async () => {
          const delegation = await ensureDelegation(payments.delegation, { provider, limitCents: delegationLimitCents(), durationSecs: 30 * 86_400 });
          const { accessToken } = await payments.x402.getX402AccessToken(cfg.planId, cfg.agentId, {
            scheme: 'nvm:card-delegation',
            network: provider,
            delegationConfig: { delegationId: delegation.delegationId },
          });
          return { token: accessToken, delegation };
        },
        gatewayUrl: cfg.publicBaseUrl,
        paths: [process.env.BUYER_JIN_PATH ?? '/api/jin/series', process.env.BUYER_OSD_PATH?.split(',')[0] ?? '/api/alpha/jp/catalysts'],
        callsPerDay: Number(process.env.BUYER_CALLS_PER_DAY ?? 20),
        salt: cfg.logSalt,
        notify: webhook
          ? async (text) => {
              await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }).catch(() => undefined);
            }
          : async (text) => console.error(text),
      });
      res.json(r);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'buyer_cron_failed', reason: (e as Error).message });
    }
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

  return { app, flush: () => log.flush() };
}
