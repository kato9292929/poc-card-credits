/**
 * 検証用の最小の買い手エージェント（指示書 §4）。
 *
 * - アクセストークンは環境変数 NVM_ACCESS_TOKEN から読む（取得は scripts/buyer-token.ts）
 * - JIN と OSD を交互に、1日 BUYER_CALLS_PER_DAY 回（既定20回）呼ぶ。間隔は1日を均等割り
 * - 残高切れ（402 / insufficient_credits）を検知したらログに残し、通知して停止する（既定）
 * - 呼び出しはすべて log/buyer-YYYY-MM-DD.jsonl に追記する。再起動時は当日の回数から再開する
 *
 *   npm run buyer            # 常駐（20回/日）
 *   npm run buyer -- --once  # 1回だけ呼んで終了
 */
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { JsonlLog, anonymize, utcDay } from '../../src/log.ts';
import { required } from '../../src/config.ts';

const GATEWAY_URL = required('GATEWAY_URL').replace(/\/$/, '');
const TOKEN = required('NVM_ACCESS_TOKEN');
const CALLS_PER_DAY = Number(process.env.BUYER_CALLS_PER_DAY ?? 20);
const INTERVAL_MS = Number(process.env.BUYER_INTERVAL_SEC ?? Math.floor(86_400 / CALLS_PER_DAY)) * 1000;
const PATHS = [process.env.BUYER_JIN_PATH ?? '/jin/series', process.env.BUYER_OSD_PATH ?? '/osd/catalysts/AAPL'];
const ON_EXHAUSTED = process.env.BUYER_ON_EXHAUSTED ?? 'stop'; // stop | wait
const NOTIFY_WEBHOOK_URL = process.env.NOTIFY_WEBHOOK_URL;
const once = process.argv.includes('--once');

const log = new JsonlLog(process.env.LOG_DIR ?? 'log', 'buyer-');
const tokenId = anonymize(TOKEN, process.env.LOG_SALT ?? 'buyer');

async function notify(text: string): Promise<void> {
  console.error(`[buyer] ${text}`);
  if (!NOTIFY_WEBHOOK_URL) return;
  try {
    // Slack 互換の Incoming Webhook 形式
    await fetch(NOTIFY_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  } catch (e) {
    console.error(`[buyer] notify failed: ${(e as Error).message}`);
  }
}

function callsToday(): number {
  return log.read(utcDay()).filter((e) => e.event === 'call').length;
}

/** 前回が残高切れで止まっていたら、再開を記録する（停止〜再開の時間を測るため）。 */
function recordResumeIfNeeded(): void {
  for (const day of log.days().reverse()) {
    const last = log.read(day).at(-1);
    if (!last) continue;
    if (last.event === 'credits_exhausted') {
      const stoppedMs = Date.now() - Date.parse(last.ts);
      log.append({ ts: new Date().toISOString(), event: 'resumed', tokenId, stoppedForSec: Math.round(stoppedMs / 1000) });
    }
    return;
  }
}

type CallResult = 'ok' | 'exhausted' | 'error';

async function callOnce(i: number): Promise<CallResult> {
  const path = PATHS[i % PATHS.length];
  const started = Date.now();
  let status = 0;
  let body: any;
  let error: string | undefined;
  try {
    const res = await fetch(`${GATEWAY_URL}${path}`, { headers: { 'payment-signature': TOKEN } });
    status = res.status;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!res.ok) error = body?.error ?? `HTTP ${status}`;
    log.append({
      ts: new Date(started).toISOString(),
      event: 'call',
      tokenId,
      path,
      status,
      latencyMs: Date.now() - started,
      creditsConsumed: Number(res.headers.get('x-credits-consumed') ?? 0),
      creditsRemaining: res.headers.get('x-credits-remaining') ?? undefined,
      error,
      reason: body?.reason,
    });
  } catch (e) {
    error = (e as Error).message;
    log.append({ ts: new Date(started).toISOString(), event: 'call', tokenId, path, status: 0, latencyMs: Date.now() - started, error });
    return 'error';
  }

  const exhausted = status === 402 || error === 'insufficient_credits';
  if (exhausted) {
    log.append({
      ts: new Date().toISOString(),
      event: 'credits_exhausted',
      tokenId,
      path,
      status,
      errorKind: error, // insufficient_credits / token_invalid / payment_required
      reason: body?.reason,
      balance: body?.balance,
      action: ON_EXHAUSTED,
    });
    await notify(
      `利用枠が尽きました (HTTP ${status} ${error ?? ''}${body?.reason ? `: ${body.reason}` : ''})。` +
        (ON_EXHAUSTED === 'stop' ? 'エージェントを停止します。プランを追加購入してから再起動してください。' : '次の間隔で再試行します。'),
    );
    return 'exhausted';
  }
  return status === 200 ? 'ok' : 'error';
}

async function main(): Promise<void> {
  recordResumeIfNeeded();
  if (once) {
    const r = await callOnce(callsToday());
    process.exit(r === 'exhausted' ? 3 : r === 'ok' ? 0 : 1);
  }
  for (;;) {
    const done = callsToday();
    if (done >= CALLS_PER_DAY) {
      const tomorrow = new Date(`${utcDay()}T00:00:00Z`).getTime() + 86_400_000;
      console.log(`[buyer] ${done}/${CALLS_PER_DAY} calls today; sleeping until ${new Date(tomorrow).toISOString()}`);
      await sleep(tomorrow - Date.now() + 1000);
      continue;
    }
    const r = await callOnce(done);
    console.log(`[buyer] call ${done + 1}/${CALLS_PER_DAY}: ${r}`);
    if (r === 'exhausted' && ON_EXHAUSTED === 'stop') process.exit(3);
    await sleep(INTERVAL_MS);
  }
}

await main();
