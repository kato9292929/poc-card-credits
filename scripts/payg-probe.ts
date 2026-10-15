/**
 * payg（都度払い）を Sandbox で1回だけ試し、結果を docs/nevermined.md に記録する（修正指示 §4）。
 *
 * payg は本番の比較対象から外した（Stripe の USD の最低請求額が $0.50 のため）。ゲートウェイは payg を受け付けない。
 * この試験は、ゲートウェイも裏側の x402 購入も通さず、Nevermined に直接 $0.01 を1回だけ請求させ、
 * 「拒否されたか / まとめて請求されたか（別の額か）/ どんなエラーが返ったか」を確かめる。
 *
 * 手順:
 *   1. NVM_PLAN_ID_PAYG が無ければ、売り手のキーで $0.01 のカード払い都度払いプランの登録を試す
 *      （拒否されたら、その結果を記録して終わる）
 *   2. 買い手のキーで、カード委任を用意する（有効なものがあれば再利用）。委任のカード請求履歴を控える
 *   3. 買い手のトークン（nvm:card-delegation）で、売り手側の verify → settle を1回だけ呼ぶ
 *   4. 15 秒待ってから委任のカード請求履歴を見直し、増えた請求を記録する
 *
 *   npm run payg:probe            # 1回だけ（記録済みなら止まる）
 *   npm run payg:probe -- --force # 再確認（例：まとめて請求を翌日に確かめる）。記録は追記
 *
 * 必要な環境変数: NVM_ENVIRONMENT=sandbox, NVM_API_KEY_SELLER（売り手）, NVM_API_KEY_BUYER（買い手、Stripe のテストカード登録済み）,
 *   NVM_AGENT_ID, NVM_RECEIVER_ADDRESS, PUBLIC_BASE_URL（任意 NVM_PLAN_ID_PAYG, BUYER_CARD_PROVIDER）
 */
import 'dotenv/config';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { Payments, buildPaymentRequired } from '@nevermined-io/payments';
import { nvmEnvironment, required } from '../src/config.ts';
import { usdToMicro } from '../src/money.ts';

const sellerKey = required('NVM_API_KEY_SELLER');
const buyerKey = required('NVM_API_KEY_BUYER');
const env = nvmEnvironment(sellerKey, buyerKey);
if (env !== 'sandbox') {
  throw new Error('payg probe is sandbox-only (NVM_ENVIRONMENT=sandbox and sandbox: keys)');
}
const DOC = 'docs/nevermined.md';
const MARK = '<!-- payg-probe-results -->';
const doc = readFileSync(DOC, 'utf8');
if (!doc.includes(MARK)) throw new Error(`${DOC} に ${MARK} が無い`);
const alreadyRecorded = doc.slice(doc.indexOf('### payg の試験記録'), doc.indexOf(MARK)).split('\n').filter((l) => /^\| \d{4}-/.test(l)).length > 0;
if (alreadyRecorded && !process.argv.includes('--force')) {
  console.error('payg の試験は記録済み（1回だけの指示）。再確認するときは --force');
  process.exit(1);
}

const seller = Payments.getInstance({ nvmApiKey: sellerKey, environment: 'sandbox' });
const buyer = Payments.getInstance({ nvmApiKey: buyerKey, environment: 'sandbox' });
const agentId = required('NVM_AGENT_ID');
const provider = (process.env.BUYER_CARD_PROVIDER ?? 'stripe') as 'stripe' | 'braintree' | 'visa';
const PRICE_USD = '0.01';

type Outcome = 'plan_rejected' | 'verify_rejected' | 'settle_rejected' | 'charged_exact' | 'charged_other_amount' | 'not_charged_yet' | 'error';
interface Result {
  outcome: Outcome;
  billingModel?: string;
  orderTx?: string;
  charges?: { amountCents: string; status: string; failureReason?: string | null }[];
  spentCents?: string;
  error?: string;
}

const show = (e: unknown) => (e instanceof Error ? `${(e as any).code ? `${(e as any).code}: ` : ''}${e.message}` : String(e));

function record(r: Result): never {
  const now = new Date().toISOString();
  const cell = (s: string | undefined) => (s ?? '-').replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 300) || '-';
  const row = `| ${now} | ${r.outcome} | ${cell(r.billingModel)} | ${
    r.charges?.length ? r.charges.map((c) => `${c.amountCents}¢ ${c.status}${c.failureReason ? ` (${c.failureReason})` : ''}`).join(', ') : 'なし'
  } | ${cell(r.spentCents)} | ${cell(r.orderTx)} | ${cell(r.error)} |`;
  writeFileSync(DOC, readFileSync(DOC, 'utf8').replace(MARK, `${row}\n${MARK}`));
  const logDir = process.env.LOG_DIR ?? 'log';
  mkdirSync(logDir, { recursive: true });
  appendFileSync(`${logDir}/events.jsonl`, JSON.stringify({ ts: now, event: 'payg_probe', priceUsd: PRICE_USD, ...r }) + '\n');
  console.log(row);
  process.exit(r.outcome === 'error' ? 1 : 0);
}

async function delegationTransactions(delegationId: string) {
  const r = await fetch(`https://api.sandbox.nevermined.app/api/v1/delegation/${delegationId}/transactions?page=1&offset=50`, {
    headers: { authorization: `Bearer ${buyerKey}` },
  });
  if (!r.ok) throw new Error(`delegation transactions HTTP ${r.status}`);
  return ((await r.json()) as { transactions: any[] }).transactions;
}

try {
  // 1. プラン
  let planId = process.env.NVM_PLAN_ID_PAYG;
  if (!planId) {
    try {
      // SDK 1.13.0 の getPayAsYouGoPriceConfig は暗号資産専用。カード払いは法定通貨の価格設定に PayAsYouGo テンプレートを指定する
      const templateAddress = await seller.contracts.getPayAsYouGoTemplateAddress();
      const priceConfig = { ...seller.plans.getFiatPriceConfig(usdToMicro(PRICE_USD), required('NVM_RECEIVER_ADDRESS') as `0x${string}`), templateAddress };
      const r = await seller.plans.registerPlan(
        { name: 'payg-probe', description: `都度払いの試験（1リクエスト $${PRICE_USD}、Sandbox のみ）`, accessLimit: 'credits' },
        priceConfig,
        seller.plans.getPayAsYouGoCreditsConfig(),
      );
      await seller.agents.addPlanToAgent(r.planId, agentId);
      planId = r.planId;
      console.error(`payg プランを登録: NVM_PLAN_ID_PAYG=${planId}`);
    } catch (e) {
      record({ outcome: 'plan_rejected', error: show(e) });
    }
  }

  // 2. 委任（有効なものを再利用。無ければ登録済みカードから $1 上限で作る）
  const list = await buyer.delegation.listDelegations({ accessible: true, provider });
  let delegationId = list.delegations.filter((d) => d.status === 'Active' && d.provider === provider).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]?.delegationId;
  if (!delegationId) {
    const card = (await buyer.delegation.listPaymentMethods({ provider })).find((m) => m.provider === provider);
    if (!card) throw new Error(`買い手に ${provider} のカードが登録されていない`);
    delegationId = (
      await buyer.delegation.createDelegation({ provider, providerPaymentMethodId: card.id, spendingLimitCents: 100, durationSecs: 86_400, currency: 'usd' })
    ).delegationId;
  }
  const before = new Set((await delegationTransactions(delegationId)).map((t) => t.id));

  // 3. トークン → verify → settle（1回だけ）
  const { accessToken } = await buyer.x402.getX402AccessToken(planId!, agentId, {
    scheme: 'nvm:card-delegation',
    network: provider,
    delegationConfig: { delegationId },
  });
  const paymentRequired = buildPaymentRequired(planId!, {
    endpoint: `${required('PUBLIC_BASE_URL').replace(/\/$/, '')}/payg-probe`,
    agentId,
    httpVerb: 'GET',
    scheme: 'nvm:card-delegation',
    network: provider,
    environment: 'sandbox',
  });
  const v = await seller.facilitator.verifyPermissions({ paymentRequired, x402AccessToken: accessToken, maxAmount: 1n });
  if (!v.isValid) record({ outcome: 'verify_rejected', error: v.invalidReason ?? 'invalid' });

  let s: any;
  try {
    s = await seller.facilitator.settlePermissions({ paymentRequired, x402AccessToken: accessToken, maxAmount: 1n, agentRequestId: v.agentRequestId });
  } catch (e) {
    s = { success: false, error: show(e) };
  }

  // 4. 委任のカード請求履歴を見直す
  await sleep(15_000);
  const fresh = (await delegationTransactions(delegationId))
    .filter((t) => !before.has(t.id))
    .map((t) => ({ amountCents: String(t.amountCents), status: String(t.status), failureReason: t.failureReason }));
  const spentCents = (await buyer.delegation.listDelegations()).delegations.find((d) => d.delegationId === delegationId)?.amountSpentCents;
  const base = { billingModel: s.billingModel, orderTx: s.orderTx || s.transaction || undefined, charges: fresh, spentCents };

  if (!s.success) record({ ...base, outcome: 'settle_rejected', error: s.error ?? s.errorReason ?? 'success=false' });
  if (fresh.length === 0) record({ ...base, outcome: 'not_charged_yet', error: 'settle は成功したが委任に請求が出ていない（まとめて請求の可能性。翌日 --force で再確認）' });
  if (fresh.length === 1 && fresh[0].amountCents === '1') record({ ...base, outcome: 'charged_exact' });
  record({ ...base, outcome: 'charged_other_amount' });
} catch (e) {
  record({ outcome: 'error', error: show(e) });
}
