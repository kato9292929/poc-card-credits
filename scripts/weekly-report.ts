/**
 * 週次集計（指示書 §5）を reports/YYYY-Www.md に出す。
 *
 *   npm run report:weekly            # 先週（ISO週）
 *   npm run report:weekly -- 2026-W42
 *
 * 入力:
 *   ゲートウェイのログ            GET $GATEWAY_URL/logs/:date（LOG_READ_TOKEN）。開発時は log/YYYY-MM-DD.jsonl
 *   log/buyer-YYYY-MM-DD.jsonl   買い手エージェント
 *   log/events.jsonl             プラン購入（checkout_created / credits_available）
 *   reports/inputs/card-payments.json  カード手数料（Stripe / Nevermined の管理画面から転記）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import 'dotenv/config';
import { JsonlLog } from '../src/log.ts';
import { HttpLogReader } from '../src/logstore/http-reader.ts';
import { microToUsd, usdToMicro } from '../src/money.ts';

const logDir = process.env.LOG_DIR ?? 'log';
const chainFeeMicroPerTx = usdToMicro(process.env.CHAIN_FEE_USD_PER_TX ?? '0');

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}

function weekDays(week: string): string[] {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) throw new Error(`bad week ${week}`);
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const monday = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86_400_000 + (Number(m[2]) - 1) * 7 * 86_400_000);
  return Array.from({ length: 7 }, (_, i) => new Date(monday.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

const week = process.argv[2] ?? isoWeek(new Date(Date.now() - 7 * 86_400_000));
const days = weekDays(week);
const inWeek = (ts: string) => days.includes(ts.slice(0, 10));

// ゲートウェイのログ：GATEWAY_URL と LOG_READ_TOKEN があれば GET /logs/:date（実証2と同じ読み方）、
// 無ければ開発時のローカルファイル（LOG_SINK=file の出力）を読む。日付は JST
const gw: any[] =
  process.env.GATEWAY_URL && process.env.LOG_READ_TOKEN
    ? (await Promise.all(days.map((d) => new HttpLogReader(process.env.GATEWAY_URL!, process.env.LOG_READ_TOKEN!).readDay(d)))).flat()
    : days.flatMap((d) => new JsonlLog(logDir).read(d));
const buyerLog = new JsonlLog(logDir, 'buyer-');
const buyer = buyerLog.days().filter((d) => days.includes(d)).flatMap((d) => buyerLog.read(d));
const events = existsSync(`${logDir}/events.jsonl`)
  ? readFileSync(`${logDir}/events.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
const cardFile = 'reports/inputs/card-payments.json';
const cards: any[] = existsSync(cardFile) ? JSON.parse(readFileSync(cardFile, 'utf8')).payments ?? [] : [];
const plans = JSON.parse(readFileSync('config/plans.json', 'utf8')).plans as { name: string; priceUsd: string; credits: number }[];

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const usd = (m: bigint) => `$${microToUsd(m)}`;
const pct = (a: bigint, b: bigint) => (b === 0n ? '-' : `${((Number(a) / Number(b)) * 100).toFixed(2)}%`);

// --- リクエストと原価 ---
const byOutcome = new Map<string, number>();
for (const e of gw) byOutcome.set(e.outcome, (byOutcome.get(e.outcome) ?? 0) + 1);
const ok = gw.filter((e) => e.outcome === 'ok');
const creditsConsumed = ok.reduce((a, e) => a + (e.creditsConsumed ?? 0), 0);
const paidTx = gw.filter((e) => e.upstreamTx);
const upstreamCost = sum(gw.map((e) => BigInt(e.upstreamCostMicro ?? '0')));
const chainFees = chainFeeMicroPerTx * BigInt(paidTx.length);
const unrecovered = sum(gw.filter((e) => e.outcome === 'settle_failed').map((e) => BigInt(e.upstreamCostMicro ?? '0')));
const failedButCharged = gw.filter((e) => e.outcome !== 'ok' && (e.creditsConsumed ?? 0) > 0);

// --- 売上（クレジット換算）とカード手数料 ---
const starter = plans.find((p) => p.name === 'starter')!;
const revenuePerCredit = usdToMicro(starter.priceUsd) / BigInt(starter.credits);
const revenue = revenuePerCredit * BigInt(creditsConsumed);
const weekCards = cards.filter((c) => inWeek(`${c.date}T00:00:00Z`));
const allCards = cards;
const gross = sum(allCards.map((c) => usdToMicro(c.grossUsd)));
const fees = sum(allCards.map((c) => usdToMicro(c.stripeFeeUsd) + usdToMicro(c.neverminedFeeUsd)));
const creditsBought = allCards.reduce((a, c) => a + Number(c.creditsPurchased ?? 0), 0);
// 手数料はクレジット1単位あたりに按分（累計の購入額ベース）
const feePerCredit = creditsBought > 0 ? fees / BigInt(creditsBought) : 0n;
const feeAlloc = feePerCredit * BigInt(creditsConsumed);
const perCall = (m: bigint) => (ok.length ? usd(m / BigInt(ok.length)) : '-');
const margin = revenue - upstreamCost - chainFees - feeAlloc;

// --- 購入から利用開始まで ---
// 実際の手順は「カード登録 → 委任作成 → プラン購入 → トークン発行 → 最初のリクエスト」（docs/nevermined.md）。
// 委任作成とトークン発行の時刻は scripts/buyer-token.ts が events.jsonl に残す。
const sec = (a?: string, b?: string) => (a && b ? `${Math.round((Date.parse(b) - Date.parse(a)) / 1000)} 秒` : '-');
const ttfu = events
  .filter((e) => e.event === 'credits_available' && inWeek(e.ts))
  .map((e) => {
    const checkout = events.filter((c) => c.event === 'checkout_created' && c.stripeCheckoutSessionId === e.stripeCheckoutSessionId).at(-1);
    const token = events.filter((t) => t.event === 'token_issued' && t.planId === e.planId && t.ts <= (ok.find((r) => r.time_utc >= e.ts)?.time_utc ?? '9999')).at(-1);
    const first = ok.find((r) => r.time_utc >= e.ts && (!token || r.time_utc >= token.ts));
    return { delegation: token?.delegationCreatedAt, checkout: checkout?.ts, available: e.ts, token: token?.ts, firstOk: first?.time_utc };
  });

// --- カード明細の件数（経理上の扱い）---
// プラン購入（Checkout）1件 ＋ 自動補充（settle 時のカード請求）の件数。補充が起きると「$10 のプラン」が明細で複数件になる
const topUps = gw.filter((e) => e.cardTopUpOrderTx);
const checkoutsInWeek = events.filter((e) => e.event === 'credits_available' && inWeek(e.ts));

// --- 残高切れ ---
const exhausted = buyer.filter((e) => e.event === 'credits_exhausted');
const resumed = buyer.filter((e) => e.event === 'resumed');
const buyerCalls = buyer.filter((e) => e.event === 'call');

const md = `# 週次レポート ${week}

期間: ${days[0]} 〜 ${days[6]}（JST）／ 生成: ${new Date().toISOString()}

## リクエスト

| 結果 | 件数 |
|---|---|
${[...byOutcome.entries()].map(([k, v]) => `| ${k} | ${v} |`).join('\n') || '| (なし) | 0 |'}

- 成功コール: ${ok.length} ／ 消費クレジット: ${creditsConsumed}
- 買い手エージェントの呼び出し: ${buyerCalls.length}（うち 200: ${buyerCalls.filter((e) => e.status === 200).length}）
- **失敗時に利用枠が消費されたリクエスト: ${failedButCharged.length} 件**（0 であること。§6 の移行条件）
- 支払い上限で拒否したリクエスト: ${byOutcome.get('gateway_cap_exceeded') ?? 0} 件

## 1コールあたりの原価・粗利

| 項目 | 合計 | 1コールあたり |
|---|---|---|
| 売上（消費クレジット換算、1クレジット = ${usd(revenuePerCredit)}） | ${usd(revenue)} | ${perCall(revenue)} |
| 裏側の x402 支払い | ${usd(upstreamCost)} | ${perCall(upstreamCost)} |
| チェーン手数料（${usd(chainFeeMicroPerTx)}/tx × ${paidTx.length} tx） | ${usd(chainFees)} | ${perCall(chainFees)} |
| カード手数料の按分（${usd(feePerCredit)}/クレジット） | ${usd(feeAlloc)} | ${perCall(feeAlloc)} |
| **粗利** | **${usd(margin)}** | **${perCall(margin)}** |
| 未回収原価（裏側は支払ったが消費できなかった） | ${usd(unrecovered)} | |

チェーン手数料: x402 の exact スキームではガスはファシリテーター負担で、ゲートウェイのウォレットからは差し引かれない想定。実測で差がある場合は \`CHAIN_FEE_USD_PER_TX\` を設定して再集計する。

## カード手数料（累計、${cardFile}）

| 日付 | 環境 | 売上 | Stripe | Nevermined | 手数料率 | カード | 明細表記 | 領収書の形式 |
|---|---|---|---|---|---|---|---|---|
${allCards.map((c) => `| ${c.date} | ${c.environment ?? ''} | $${c.grossUsd} | $${c.stripeFeeUsd} | $${c.neverminedFeeUsd} | ${pct(usdToMicro(c.stripeFeeUsd) + usdToMicro(c.neverminedFeeUsd), usdToMicro(c.grossUsd))} | ${c.cardBrand ?? ''} ${c.cardType ?? ''} | ${c.statementDescriptor ?? ''} | ${c.receiptFormat ?? ''} |`).join('\n') || '| (未入力) | | | | | | | | |'}

- 累計: 売上 ${usd(gross)}、手数料 ${usd(fees)}（${pct(fees, gross)}）。今週の購入: ${weekCards.length} 件

## 購入から利用開始までの時間

| 委任作成 | Checkout 作成 | クレジット付与 | トークン発行 | 最初の成功 | 委任→付与 | 決済→付与 | 付与→初回利用 |
|---|---|---|---|---|---|---|---|
${ttfu.map((t) => `| ${t.delegation ?? '-'} | ${t.checkout ?? '-'} | ${t.available} | ${t.token ?? '-'} | ${t.firstOk ?? '-'} | ${sec(t.delegation, t.available)} | ${sec(t.checkout, t.available)} | ${sec(t.available, t.firstOk)} |`).join('\n') || '| (今週の購入なし) | | | | | | | |'}

「決済→付与」は Checkout URL の発行から数えるので、カード情報の入力時間を含む。委任を購入の前に作った場合、「委任→付与」はカード登録後の手順全体にかかった時間になる。

## 残高切れの挙動

${exhausted.length === 0 ? '今週の残高切れ: なし' : exhausted.map((e) => `- ${e.ts}: HTTP ${e.status} ${e.errorKind ?? ''} ${e.reason ? `(${e.reason})` : ''} → ${e.action}`).join('\n')}
${resumed.map((e) => `- ${e.ts}: 再開（停止時間 ${e.stoppedForSec} 秒）`).join('\n')}

## 経理上の扱い

- 今週のカード請求: プラン購入 ${checkoutsInWeek.length} 件 ＋ 自動補充 ${topUps.length} 件${topUps.length ? '（**自動補充があったため、プラン1件が明細の複数行になっている**）' : ''}
- 明細の表記・領収書の形式は上のカード手数料表を参照（${cardFile} に転記）
- カード明細1件として処理できたか、経理担当の所見をここに追記する
`;

const out = `reports/${week}.md`;
writeFileSync(out, md);
console.log(`wrote ${out}`);
