/**
 * 買い手エージェントの1回分（Vercel Cron から呼ぶ。追加指示 v3 §4）。
 *
 * - 1日 callsPerDay 回（既定 20）。JIN と OSD を交互に呼ぶ。回数は当日（JST）の買い手ログから数える
 * - トークンは毎回、買い手のキーで発行する（委任は有効なものを再利用。無ければ上限 100¢ で作る）
 * - 残高切れ・委任の上限到達を検知したら、停止状態を Blob に書き、通知する。以後の回は何もしない
 *   再開は npm run buyer:resume（停止〜再開の時間を記録する）
 * - ログは Blob の log/buyer/YYYY-MM-DD.jsonl（JST）に追記する
 */
import { anonymize, jstDay } from '../log.ts';
import { parseLines, type LogStore } from '../logstore/types.ts';
import type { StateStore } from './state.ts';
import type { DelegationResult } from './delegation.ts';
import { classifyExhaustion } from './classify.ts';

/**
 * 定期購入を動かしてよいか。本番（live）では自社のカードに実費がかかるので止める。
 * 本番での動作確認は手で1回だけ行う（docs/live.md）。どうしても定期で動かすときだけ BUYER_CRON_IN_LIVE=true。
 */
export function buyerCronAllowed(env: Record<string, string | undefined>): { ok: true } | { ok: false; reason: string } {
  const nvm = env.NVM_ENVIRONMENT ?? 'sandbox';
  if ((nvm === 'live' || nvm === 'staging_live') && env.BUYER_CRON_IN_LIVE !== 'true') return { ok: false, reason: 'live_environment' };
  return { ok: true };
}

export interface BuyerCronDeps {
  store: LogStore;
  state: StateStore;
  mintToken: () => Promise<{ token: string; delegation: DelegationResult }>;
  gatewayUrl: string;
  paths: [string, string];
  callsPerDay: number;
  salt: string;
  now?: () => Date;
  fetch?: typeof fetch;
  notify?: (text: string) => Promise<void>;
}

export type CronResult =
  | { action: 'skipped'; reason: 'stopped' | 'daily_quota_reached' }
  | { action: 'called'; status: number; path: string; exhausted: boolean };

export async function runBuyerCron(d: BuyerCronDeps): Promise<CronResult> {
  const now = d.now ?? (() => new Date());
  const f = d.fetch ?? fetch;
  const day = jstDay(now());
  const append = (e: object) => {
    const t = now();
    return d.store.append(jstDay(t), JSON.stringify({ ts: t.toISOString(), date_jst: jstDay(t), ...e }));
  };

  const st = await d.state.get();
  if (st?.stopped) {
    await append({ event: 'skipped', reason: 'stopped', stoppedSince: st.since });
    return { action: 'skipped', reason: 'stopped' };
  }
  const calls = parseLines(await d.store.read(day)).filter((e) => e.event === 'call').length;
  if (calls >= d.callsPerDay) return { action: 'skipped', reason: 'daily_quota_reached' };

  const path = d.paths[calls % 2];
  const { token, delegation } = await d.mintToken();
  if (!delegation.reused) {
    await append({ event: 'delegation_created', delegationId: delegation.delegationId.slice(0, 8), delegationCreatedAt: delegation.createdAt, spendingLimitCents: delegation.spendingLimitCents });
  }
  const tokenId = anonymize(token, d.salt);

  const started = Date.now();
  let status = 0;
  let body: any;
  let headers: Headers | undefined;
  let error: string | undefined;
  try {
    const res = await f(`${d.gatewayUrl.replace(/\/$/, '')}${path}`, { headers: { 'payment-signature': token } });
    status = res.status;
    headers = res.headers;
    const text = await res.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!res.ok) error = body?.error ?? `HTTP ${status}`;
  } catch (e) {
    error = (e as Error).message;
  }
  await append({
    event: 'call',
    tokenId,
    path,
    status,
    latencyMs: Date.now() - started,
    creditsConsumed: Number(headers?.get('x-credits-consumed') ?? 0),
    creditsRemaining: headers?.get('x-credits-remaining') ?? undefined,
    error,
    reason: body?.reason,
  });

  const kind = classifyExhaustion(status, body);
  if (kind) {
    const since = now().toISOString();
    await d.state.set({ stopped: true, since, errorKind: kind, status });
    await append({ event: 'credits_exhausted', tokenId, path, status, errorKind: kind, reason: body?.reason, balance: body?.balance, action: 'stop' });
    await d.notify?.(`[poc-card-credits] ${kind}（HTTP ${status}${body?.reason ? `: ${body.reason}` : ''}）。買い手エージェントを停止した。再開は npm run buyer:resume`);
  }
  return { action: 'called', status, path, exhausted: !!kind };
}
