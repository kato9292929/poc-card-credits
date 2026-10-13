import type { SpendGuard } from '../budget.ts';
import type { MicroUsd } from '../money.ts';

export interface UpstreamPurchase {
  /** 上流の最終HTTPステータス（支払い後の応答。402 以外が最初に返った場合はそれ）。 */
  status: number;
  body: Uint8Array;
  contentType?: string;
  /** 署名して送った支払いの額（送っていなければ 0）。日次上限にはこの額を計上する。 */
  attemptedMicro: MicroUsd;
  /** 上流が決済完了を返した額（PAYMENT-RESPONSE success=true のとき）。 */
  paidMicro: MicroUsd;
  network?: string;
  tx?: string;
  latencyMs: number;
  error?: string;
  /** 上限・価格不一致などで、こちらから支払いを拒否した */
  refused?: 'per_call_cap' | 'daily_cap' | 'price_mismatch' | 'no_acceptable_requirement';
}

export interface UpstreamBuyer {
  buy(args: { url: string; method: string; expectedPrice: MicroUsd; guard: SpendGuard }): Promise<UpstreamPurchase>;
}
