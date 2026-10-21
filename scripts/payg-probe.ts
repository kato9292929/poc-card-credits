/**
 * payg（都度払い）を Sandbox で1回だけ試し、結果を docs/nevermined.md に記録する（修正指示 §4・追加指示 v3 §3-6）。
 *
 * payg は本番の比較対象から外した（Stripe の USD の最低請求額が $0.50 のため）。ゲートウェイは payg を受け付けない。
 * この試験は、ゲートウェイも裏側の x402 購入も通さず、Nevermined に直接 $0.01 を1回だけ請求させ、
 * 「拒否されたか / まとめて請求されたか（別の額か）/ どんなエラーが返ったか」を確かめる。手順は src/buyer/payg-probe.ts。
 *
 *   npm run payg:probe                         # 手元で1回だけ（記録済みなら止まる）
 *   npm run payg:probe -- --force              # 再確認（例：まとめて請求を翌日に確かめる）。記録は追記
 *   npm run payg:probe -- --remote             # 買い手のキーが Vercel にしか無いとき。ゲートウェイの
 *                                              # POST /buyer/payg-probe（Bearer CRON_SECRET）で動かし、返った結果を記録する
 *
 * 手元で動かすときの環境変数: NVM_API_KEY_SELLER, NVM_API_KEY_BUYER（カード登録済み）, NVM_AGENT_ID, NVM_RECEIVER_ADDRESS,
 *   PUBLIC_BASE_URL（任意 NVM_PLAN_ID_PAYG, BUYER_CARD_PROVIDER）。--remote のとき: PUBLIC_BASE_URL, CRON_SECRET
 */
import 'dotenv/config';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { nvmEnvironment, required } from '../src/config.ts';
import { PAYG_PRICE_USD, runPaygProbe, type PaygResult } from '../src/buyer/payg-probe.ts';

const DOC = 'docs/nevermined.md';
const MARK = '<!-- payg-probe-results -->';
const doc = readFileSync(DOC, 'utf8');
if (!doc.includes(MARK)) throw new Error(`${DOC} に ${MARK} が無い`);
const alreadyRecorded = doc.slice(doc.indexOf('### payg の試験記録'), doc.indexOf(MARK)).split('\n').filter((l) => /^\| \d{4}-/.test(l)).length > 0;
if (alreadyRecorded && !process.argv.includes('--force')) {
  console.error('payg の試験は記録済み（1回だけの指示）。再確認するときは --force');
  process.exit(1);
}

function record(r: PaygResult, where: string): never {
  const now = new Date().toISOString();
  const cell = (s: string | undefined) => (s ?? '-').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 300) || '-';
  const row = `| ${now} | ${r.outcome} | ${cell(r.billingModel)} | ${
    r.charges?.length ? r.charges.map((c) => `${c.amountCents}¢ ${c.status}${c.failureReason ? ` (${c.failureReason})` : ''}`).join(', ') : 'なし'
  } | ${cell(r.spentCents)} | ${cell(r.orderTx)} | ${cell(r.error)} |`;
  writeFileSync(DOC, readFileSync(DOC, 'utf8').replace(MARK, `${row}\n${MARK}`));
  const logDir = process.env.LOG_DIR ?? 'log';
  mkdirSync(logDir, { recursive: true });
  appendFileSync(`${logDir}/events.jsonl`, JSON.stringify({ ts: now, event: 'payg_probe', where, priceUsd: PAYG_PRICE_USD, ...r }) + '\n');
  console.log(row);
  if (r.planId) console.log(`NVM_PLAN_ID_PAYG=${r.planId}`);
  process.exit(r.outcome === 'error' ? 1 : 0);
}

if (process.argv.includes('--remote')) {
  const base = required('PUBLIC_BASE_URL').replace(/\/$/, '');
  const res = await fetch(`${base}/buyer/payg-probe`, { method: 'POST', headers: { authorization: `Bearer ${required('CRON_SECRET')}` } });
  const body = (await res.json()) as PaygResult & { error?: string };
  if (!res.ok && !body.outcome) {
    console.error(`POST /buyer/payg-probe → HTTP ${res.status}: ${body.error ?? ''}`);
    process.exit(1);
  }
  record(body, 'vercel');
}

const sellerKey = required('NVM_API_KEY_SELLER');
const buyerKey = required('NVM_API_KEY_BUYER');
if (nvmEnvironment(sellerKey, buyerKey) !== 'sandbox') throw new Error('payg probe is sandbox-only (NVM_ENVIRONMENT=sandbox and sandbox keys)');
record(
  await runPaygProbe({
    sellerKey,
    buyerKey,
    agentId: required('NVM_AGENT_ID'),
    receiver: required('NVM_RECEIVER_ADDRESS') as `0x${string}`,
    publicBaseUrl: required('PUBLIC_BASE_URL'),
    planIdPayg: process.env.NVM_PLAN_ID_PAYG || undefined,
    provider: (process.env.BUYER_CARD_PROVIDER ?? 'stripe') as 'stripe',
  }),
  'local',
);
