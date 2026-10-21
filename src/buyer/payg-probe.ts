import { setTimeout as sleep } from 'node:timers/promises';
import { Payments, buildPaymentRequired } from '@nevermined-io/payments';
import { usdToMicro } from '../money.ts';
import { ensureDelegation, type CardProvider } from './delegation.ts';

/**
 * payg（都度払い）の試験の本体（修正指示 §4・追加指示 v3 §3-6）。scripts/payg-probe.ts（手元）と、
 * ゲートウェイの POST /buyer/payg-probe（買い手のキーが Vercel にしか無いとき）の両方から呼ぶ。
 *
 *   1. planIdPayg が無ければ、売り手のキーで $0.01 のカード払い都度払いプランの登録を試す（拒否されたら終わり）
 *   2. 買い手のカード委任を用意する（ensureDelegation。有効なものがあれば再利用）。委任のカード請求履歴を控える
 *   3. 買い手のトークン（nvm:card-delegation）で、売り手側の verify → settle を1回だけ呼ぶ
 *   4. 15 秒待ってから委任のカード請求履歴を見直し、増えた請求を返す
 */
export const PAYG_PRICE_USD = '0.01';

export type PaygOutcome = 'plan_rejected' | 'verify_rejected' | 'settle_rejected' | 'charged_exact' | 'charged_other_amount' | 'not_charged_yet' | 'error';
export interface PaygResult {
  outcome: PaygOutcome;
  planId?: string;
  billingModel?: string;
  orderTx?: string;
  charges?: { amountCents: string; status: string; failureReason?: string | null }[];
  spentCents?: string;
  error?: string;
}

const show = (e: unknown) => (e instanceof Error ? `${(e as any).code ? `${(e as any).code}: ` : ''}${e.message}` : String(e));

export async function runPaygProbe(o: {
  sellerKey: string;
  buyerKey: string;
  agentId: string;
  receiver: `0x${string}`;
  publicBaseUrl: string;
  planIdPayg?: string;
  provider?: CardProvider;
}): Promise<PaygResult> {
  const seller = Payments.getInstance({ nvmApiKey: o.sellerKey, environment: 'sandbox' });
  const buyer = Payments.getInstance({ nvmApiKey: o.buyerKey, environment: 'sandbox' });
  const provider = o.provider ?? 'stripe';
  const delegationTransactions = async (delegationId: string) => {
    const r = await fetch(`https://api.sandbox.nevermined.app/api/v1/delegation/${delegationId}/transactions?page=1&offset=50`, {
      headers: { authorization: `Bearer ${o.buyerKey}` },
    });
    if (!r.ok) throw new Error(`delegation transactions HTTP ${r.status}`);
    return ((await r.json()) as { transactions: any[] }).transactions;
  };

  let planId = o.planIdPayg;
  try {
    // 1. プラン。SDK 1.13.0 の getPayAsYouGoPriceConfig は暗号資産専用。カード払いは法定通貨の価格設定に PayAsYouGo テンプレートを指定する
    if (!planId) {
      try {
        const templateAddress = await seller.contracts.getPayAsYouGoTemplateAddress();
        const priceConfig = { ...seller.plans.getFiatPriceConfig(usdToMicro(PAYG_PRICE_USD), o.receiver), templateAddress };
        const r = await seller.plans.registerPlan(
          { name: 'payg-probe', description: `都度払いの試験（1リクエスト $${PAYG_PRICE_USD}、Sandbox のみ）`, accessLimit: 'credits' },
          priceConfig,
          seller.plans.getPayAsYouGoCreditsConfig(),
        );
        await seller.agents.addPlanToAgent(r.planId, o.agentId);
        planId = r.planId;
      } catch (e) {
        return { outcome: 'plan_rejected', error: show(e) };
      }
    }

    // 2. 委任（上限 100¢、1日）
    const { delegationId } = await ensureDelegation(buyer.delegation, { provider, limitCents: 100, durationSecs: 86_400 });
    const before = new Set((await delegationTransactions(delegationId)).map((t) => t.id));

    // 3. トークン → verify → settle（1回だけ）
    const { accessToken } = await buyer.x402.getX402AccessToken(planId, o.agentId, {
      scheme: 'nvm:card-delegation',
      network: provider,
      delegationConfig: { delegationId },
    });
    const paymentRequired = buildPaymentRequired(planId, {
      endpoint: `${o.publicBaseUrl.replace(/\/$/, '')}/payg-probe`,
      agentId: o.agentId,
      httpVerb: 'GET',
      scheme: 'nvm:card-delegation',
      network: provider,
      environment: 'sandbox',
    });
    const v = await seller.facilitator.verifyPermissions({ paymentRequired, x402AccessToken: accessToken, maxAmount: 1n });
    if (!v.isValid) return { outcome: 'verify_rejected', planId, error: v.invalidReason ?? 'invalid' };

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
    const base = { planId, billingModel: s.billingModel, orderTx: s.orderTx || s.transaction || undefined, charges: fresh, spentCents: spentCents === undefined ? undefined : String(spentCents) };

    if (!s.success) return { ...base, outcome: 'settle_rejected', error: s.error ?? s.errorReason ?? 'success=false' };
    if (fresh.length === 0) return { ...base, outcome: 'not_charged_yet', error: 'settle は成功したが委任に請求が出ていない（まとめて請求の可能性。翌日 --force で再確認）' };
    if (fresh.length === 1 && fresh[0].amountCents === '1') return { ...base, outcome: 'charged_exact' };
    return { ...base, outcome: 'charged_other_amount' };
  } catch (e) {
    return { outcome: 'error', planId, error: show(e) };
  }
}
