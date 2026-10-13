/** 利用枠（クレジット）の検証・消費。本番実装は Nevermined、テストは fake。 */
export interface CreditLedger {
  /** 402 応答の PAYMENT-REQUIRED ヘッダに載せる支払い要求（base64 前の JSON）。 */
  paymentRequired(endpoint: string, method: string): unknown;
  verify(args: { token: string; endpoint: string; method: string; credits: number }): Promise<VerifyOutcome>;
  /** 支払元の残高（クレジット）。 */
  balance(payer: string): Promise<bigint>;
  settle(args: {
    token: string;
    endpoint: string;
    method: string;
    credits: number;
    agentRequestId?: string;
  }): Promise<SettleOutcome>;
}

export type VerifyOutcome =
  | { ok: true; payer: string; agentRequestId?: string }
  | { ok: false; reason: string };

export type SettleOutcome =
  | { ok: true; creditsRedeemed: number; remaining?: string; tx?: string; billingModel?: string }
  | { ok: false; error: string };
