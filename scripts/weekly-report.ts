/**
 * 週次集計（追加指示 v2 §5）を reports/YYYY-Www.md に出す。出せない項目は「未計測（理由）」と書く。
 *
 *   npm run report:weekly            # 先週（ISO週）
 *   npm run report:weekly -- 2026-W42
 *
 * 入力:
 *   ゲートウェイのログ            GET $GATEWAY_URL/logs/:date（LOG_READ_TOKEN）。開発時は log/YYYY-MM-DD.jsonl
 *   log/buyer-YYYY-MM-DD.jsonl   買い手エージェント
 *   log/events.jsonl             プラン購入（credits_available）、委任作成（delegation_created / delegation_reused）、トークン発行（token_issued）
 *   reports/inputs/card-payments.json  カード手数料（Stripe / Nevermined の管理画面から転記）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import 'dotenv/config';
import '../src/settings.ts';
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
// デプロイ先（GATEWAY_URL または PUBLIC_BASE_URL）と LOG_READ_TOKEN があれば、ゲートウェイと買い手（Vercel Cron）の
// ログを GET /logs/:date・/logs/buyer/:date から読む。無ければ開発用のローカルファイルを読む
const remoteBase = process.env.GATEWAY_URL ?? process.env.PUBLIC_BASE_URL;
const reader = remoteBase && process.env.LOG_READ_TOKEN ? new HttpLogReader(remoteBase, process.env.LOG_READ_TOKEN) : undefined;
const gw: any[] = reader ? (await Promise.all(days.map((d) => reader.readDay(d)))).flat() : days.flatMap((d) => new JsonlLog(logDir).read(d));
const buyerLog = new JsonlLog(logDir, 'buyer-');
const buyer: any[] = reader
  ? (await Promise.all(days.map((d) => reader.readDay(d, 'buyer')))).flat()
  : buyerLog.days().filter((d) => days.includes(d)).flatMap((d) => buyerLog.read(d));
const events = existsSync(`${logDir}/events.jsonl`)
  ? readFileSync(`${logDir}/events.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
const cardFile = process.env.CARD_PAYMENTS_FILE ?? 'reports/inputs/card-payments.json';
const cards: any[] = existsSync(cardFile) ? JSON.parse(readFileSync(cardFile, 'utf8')).payments ?? [] : [];
const plans = JSON.parse(readFileSync('config/plans.json', 'utf8')).plans as { name: string; priceUsd: string; credits: number }[];

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const usd = (m: bigint) => `$${microToUsd(m)}`;
const pct = (a: bigint, b: bigint) => (b === 0n ? '-' : `${((Number(a) / Number(b)) * 100).toFixed(2)}%`);

// --- リクエスト ---
const byOutcome = new Map<string, number>();
for (const e of gw) byOutcome.set(e.outcome, (byOutcome.get(e.outcome) ?? 0) + 1);
const ok = gw.filter((e) => e.outcome === 'ok');
const creditsConsumed = ok.reduce((a, e) => a + (e.creditsConsumed ?? 0), 0);
const failedButCharged = gw.filter((e) => e.outcome !== 'ok' && (e.creditsConsumed ?? 0) > 0);

// --- 1コールあたりの原価：裏側の x402 支払い（upstreamTx があるもの）＋ チェーン手数料 ---
const paid = gw.filter((e) => e.upstreamTx && e.upstreamTx !== 'none');
const upstreamCost = sum(paid.map((e) => BigInt(e.upstreamCostMicro ?? '0')));
const chainFees = chainFeeMicroPerTx * BigInt(paid.length);
const unrecovered = sum(gw.filter((e) => e.outcome === 'settle_failed').map((e) => BigInt(e.upstreamCostMicro ?? '0')));

// --- 売上（クレジット換算）とカード手数料 ---
const prepaid = plans.find((p) => p.name === 'prepaid-100')!;
const revenuePerCredit = usdToMicro(prepaid.priceUsd) / BigInt(prepaid.credits);
const revenue = revenuePerCredit * BigInt(creditsConsumed);
const weekCards = cards.filter((c) => inWeek(`${c.date}T00:00:00Z`));
const gross = sum(cards.map((c) => usdToMicro(c.grossUsd)));
const nvmFees = sum(cards.map((c) => usdToMicro(c.neverminedFeeUsd)));
const stripeFees = sum(cards.map((c) => usdToMicro(c.stripeFeeUsd)));
const fees = nvmFees + stripeFees;
const creditsBought = cards.reduce((a, c) => a + Number(c.creditsPurchased ?? 0), 0);
// 手数料はクレジット1単位あたりに按分（累計の購入ベース）
const feePerCredit = creditsBought > 0 ? fees / BigInt(creditsBought) : 0n;
const feeAlloc = feePerCredit * BigInt(creditsConsumed);
const perCall = (m: bigint) => usd(m / BigInt(ok.length));
const margin = revenue - upstreamCost - chainFees - feeAlloc;
const topUps = gw.filter((e) => e.cardTopUpOrderTx);

// --- 購入から利用開始まで：決済完了 → 委任作成 → トークン発行 → 最初の 200 ---
// 決済完了 = order-plan のクレジット付与の確認（credits_available）。委任作成とトークン発行は buyer:token が残す
const sec = (a?: string, b?: string) => {
  if (!a || !b) return '-';
  const s = Math.round((Date.parse(b) - Date.parse(a)) / 1000);
  return s < 0 ? `${s} 秒（前後が逆）` : `${s} 秒`;
};
const ttfu = events
  .filter((e) => e.event === 'credits_available' && inWeek(e.ts))
  .map((paidEv) => {
    const token = events.find((t) => t.event === 'token_issued' && t.ts >= paidEv.ts);
    const delegation = token
      ? events.filter((x) => (x.event === 'delegation_created' || x.event === 'delegation_reused') && x.ts <= token.ts).at(-1)
      : undefined;
    const first = token ? ok.find((r) => r.time_utc >= token.ts) : undefined;
    return {
      paid: paidEv.ts,
      delegation: delegation?.delegationCreatedAt as string | undefined,
      reused: delegation?.event === 'delegation_reused',
      token: token?.ts as string | undefined,
      firstOk: first?.time_utc as string | undefined,
    };
  });

// --- 残高切れ ---
const status402 = gw.filter((e) => e.status === 402);
const by402 = new Map<string, number>();
for (const e of status402) by402.set(e.outcome, (by402.get(e.outcome) ?? 0) + 1);
const exhausted = buyer.filter((e) => e.event === 'credits_exhausted');
const resumed = buyer.filter((e) => e.event === 'resumed');
const buyerCalls = buyer.filter((e) => e.event === 'call');

const notMeasured = (reason: string) => `未計測（${reason}）`;
const noCalls = ok.length === 0;
const noCards = cards.length === 0;

const md = `# 週次レポート ${week}

期間: ${days[0]} 〜 ${days[6]}（JST）／ 生成: ${new Date().toISOString()}

## 1. カード手数料

${
  noCards
    ? notMeasured(`${cardFile} が未入力。Stripe の明細から転記する`)
    : `| 日付 | 環境 | 売上 | Stripe 手数料 | Nevermined 手数料（2%） | 手数料率 | カード |
|---|---|---|---|---|---|---|
${cards.map((c) => `| ${c.date} | ${c.environment ?? ''} | $${c.grossUsd} | $${c.stripeFeeUsd} | $${c.neverminedFeeUsd} | ${pct(usdToMicro(c.stripeFeeUsd) + usdToMicro(c.neverminedFeeUsd), usdToMicro(c.grossUsd))} | ${[c.cardBrand, c.cardType].filter(Boolean).join(' ')} |`).join('\n')}

- 累計: 売上 ${usd(gross)}、手数料 ${usd(fees)}（Stripe ${usd(stripeFees)} ＋ Nevermined ${usd(nvmFees)}）、売上に対する割合 ${pct(fees, gross)}
- 今週の購入: ${weekCards.length} 件`
}
- settle 時のカードへの自動補充: ${topUps.length} 件${topUps.length ? '（プラン1件が明細の複数行になっている。BLOCK_CARD_TOPUP=false の週だけ起きうる）' : ''}

## 2. 1コールあたりの原価

${
  noCalls
    ? notMeasured('今週の成功コールが 0 件')
    : `| 項目 | 合計 | 1コールあたり（成功 ${ok.length} 件） |
|---|---|---|
| 裏側の x402 支払い（upstreamTx のある ${paid.length} 件） | ${usd(upstreamCost)} | ${perCall(upstreamCost)} |
| チェーン手数料（${usd(chainFeeMicroPerTx)}/tx） | ${usd(chainFees)} | ${perCall(chainFees)} |
| **原価** | **${usd(upstreamCost + chainFees)}** | **${perCall(upstreamCost + chainFees)}** |
| 参考：未回収原価（裏側は支払ったが消費できなかった） | ${usd(unrecovered)} | |

チェーン手数料は、x402 の exact スキームではファシリテーターの負担になる想定で、既定は $0。実測で差があれば \`CHAIN_FEE_USD_PER_TX\` を設定して再集計する。`
}

## 3. 1コールあたりの粗利

${
  noCalls
    ? notMeasured('今週の成功コールが 0 件')
    : `| 項目 | 合計 | 1コールあたり |
|---|---|---|
| 売上（消費 ${creditsConsumed} クレジット × ${usd(revenuePerCredit)}） | ${usd(revenue)} | ${perCall(revenue)} |
| − 原価 | ${usd(upstreamCost + chainFees)} | ${perCall(upstreamCost + chainFees)} |
| − カード手数料の按分（${noCards ? '未計測：カード明細が未入力' : `${usd(feePerCredit)}/クレジット`}） | ${usd(feeAlloc)} | ${perCall(feeAlloc)} |
| **粗利** | **${usd(margin)}** | **${perCall(margin)}** |${noCards ? '\n\nカード手数料が未入力のため、粗利は手数料を差し引く前の値。' : ''}`
}

## 4. 購入から利用開始までの時間

${
  ttfu.length === 0
    ? notMeasured('今週の購入（credits_available）が無い。npm run plan:order の記録が要る')
    : `| 決済完了 | 委任作成 | トークン発行 | 最初の 200 | 決済→委任 | 委任→トークン | トークン→最初の 200 |
|---|---|---|---|---|---|---|
${ttfu.map((t) => `| ${t.paid} | ${t.delegation ?? '-'}${t.reused ? '（再利用）' : ''} | ${t.token ?? '-'} | ${t.firstOk ?? '-'} | ${t.reused ? '再利用（決済前に作成済み）' : sec(t.paid, t.delegation)} | ${sec(t.delegation, t.token)} | ${sec(t.token, t.firstOk)} |`).join('\n')}

決済完了は、Checkout 後にクレジットの付与を確認した時刻（order-plan が5秒おきに確認）。委任を再利用したときは、決済→委任の区間は測れない。`
}

## 5. 残高切れの挙動

- 402 の回数: ${status402.length} 回${status402.length ? `（${[...by402.entries()].map(([k, v]) => `${k} ${v}`).join('、')}）` : ''}
- 買い手の停止: ${exhausted.length === 0 ? 'なし' : exhausted.map((e) => `${e.ts}（HTTP ${e.status} ${e.errorKind ?? ''}${e.reason ? `: ${e.reason}` : ''} → ${e.action}）`).join('、')}
- 買い手の再開: ${resumed.length === 0 ? 'なし' : resumed.map((e) => `${e.ts}（停止 ${e.stoppedForSec} 秒）`).join('、')}

## 6. 経理上の扱い（人が記録する）

| 項目 | 記入 |
|---|---|
| Stripe のレシートの形式（メール / PDF、発行者名） | |
| 請求書（インボイス）の有無と形式 | |
| カード明細の表記（1件にまとまったか） | |
| 経理処理上の所見 | |

## 参考：リクエストの内訳

| 結果 | 件数 |
|---|---|
${[...byOutcome.entries()].map(([k, v]) => `| ${k} | ${v} |`).join('\n') || '| (なし) | 0 |'}

- 買い手エージェントの呼び出し: ${buyerCalls.length}（うち 200: ${buyerCalls.filter((e) => e.status === 200).length}）
- **失敗時に利用枠が消費されたリクエスト: ${failedButCharged.length} 件**（0 であること。本番移行の条件）
- 支払い上限で拒否したリクエスト: ${byOutcome.get('gateway_cap_exceeded') ?? 0} 件
`;

const out = `${process.env.REPORT_DIR ?? 'reports'}/${week}.md`;
writeFileSync(out, md);
console.log(`wrote ${out}`);
