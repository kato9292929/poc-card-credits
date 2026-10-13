import { Payments, buildPaymentRequired, type X402PaymentRequired } from '@nevermined-io/payments';
import type { CreditLedger, SettleOutcome, VerifyOutcome } from './types.ts';
import type { NvmEnvironment } from '../config.ts';

/**
 * Nevermined による利用枠の検証・消費（@nevermined-io/payments 1.13.0）。
 * 仕様の確認元は docs/nevermined.md を参照。
 *
 * - verify: payments.facilitator.verifyPermissions（クレジットは消費しない）
 * - settle: payments.facilitator.settlePermissions（maxAmount 分のクレジットを burn）
 * - balance: payments.plans.getPlanBalance(planId, payer)
 */
export class NeverminedLedger implements CreditLedger {
  private readonly payments: Payments;

  constructor(
    private readonly opts: { nvmApiKey: string; environment: NvmEnvironment; planId: string; agentId: string },
  ) {
    this.payments = Payments.getInstance({ nvmApiKey: opts.nvmApiKey, environment: opts.environment });
  }

  paymentRequired(endpoint: string, method: string): X402PaymentRequired {
    // スキーム（nvm:erc4337 / nvm:card-delegation）とネットワークは、指定しなければ
    // SDK がトークンから推定する。買い手のトークンに合わせるため、ここでは固定しない。
    return buildPaymentRequired(this.opts.planId, {
      endpoint,
      agentId: this.opts.agentId,
      httpVerb: method,
      environment: this.opts.environment,
      description: 'OSD / JIN via card-funded credits',
      mimeType: 'application/json',
    });
  }

  async verify(args: { token: string; endpoint: string; method: string; credits: number }): Promise<VerifyOutcome> {
    try {
      const r = await this.payments.facilitator.verifyPermissions({
        paymentRequired: this.paymentRequired(args.endpoint, args.method),
        x402AccessToken: args.token,
        maxAmount: BigInt(args.credits),
      });
      if (!r.isValid) return { ok: false, reason: r.invalidReason ?? 'invalid' };
      if (!r.payer) return { ok: false, reason: 'verify returned no payer' };
      return { ok: true, payer: r.payer, agentRequestId: r.agentRequestId };
    } catch (e) {
      return { ok: false, reason: errMsg(e) };
    }
  }

  async balance(payer: string): Promise<bigint> {
    const b = await this.payments.plans.getPlanBalance(this.opts.planId, payer as `0x${string}`);
    return BigInt(b.balance);
  }

  async settle(args: {
    token: string;
    endpoint: string;
    method: string;
    credits: number;
    agentRequestId?: string;
  }): Promise<SettleOutcome> {
    try {
      const r = await this.payments.facilitator.settlePermissions({
        paymentRequired: this.paymentRequired(args.endpoint, args.method),
        x402AccessToken: args.token,
        maxAmount: BigInt(args.credits),
        agentRequestId: args.agentRequestId,
      });
      // SDK のドキュメント（SettlePermissionsResult）に従い、billingModel を見てから判定する。
      // billingModel が無い（古い API）場合は credits として扱う。
      const billingModel = (r as { billingModel?: string }).billingModel;
      const redeemed = Number(r.creditsRedeemed ?? '0');
      if (!r.success) return { ok: false, error: 'settle returned success=false' };
      if (billingModel === 'pay-as-you-go') {
        // プリペイドのクレジットではなくカードに都度課金された。本PoCでは想定外なので失敗として記録する
        // （データは返さない）。プランが credits 型で登録されているか確認すること。
        return { ok: false, error: `unexpected pay-as-you-go settlement (orderTx=${(r as { orderTx?: string }).orderTx ?? r.transaction})` };
      }
      if (!(redeemed > 0)) return { ok: false, error: `settle redeemed ${r.creditsRedeemed} credits` };
      // credits プランの orderTx は「自動トップアップでカードに請求したとき」だけ付く（x402 Card Delegation 仕様）
      const topUpOrderTx = (r as { orderTx?: string }).orderTx || undefined;
      return { ok: true, creditsRedeemed: redeemed, remaining: r.remainingBalance, tx: r.transaction, billingModel, topUpOrderTx };
    } catch (e) {
      return { ok: false, error: errMsg(e) };
    }
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
