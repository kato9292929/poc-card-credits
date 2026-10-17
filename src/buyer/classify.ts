/**
 * ゲートウェイの応答から「残高切れ・委任の上限到達」を判定する。該当しなければ undefined。
 * Nevermined のエラーコードは x402 Card Delegation 仕様のもの（docs/nevermined.md）。
 */
export function classifyExhaustion(status: number, body: any): string | undefined {
  const reason = String(body?.reason ?? '');
  if (/DELEGATION_INACTIVE|Exhausted/i.test(reason)) return 'delegation_exhausted';
  if (/Expired/i.test(reason) && !/EXPIRED_TOKEN/i.test(reason)) return 'delegation_expired';
  if (/TRANSACTION_LIMIT_REACHED/i.test(reason)) return 'delegation_tx_limit';
  if (/CARD_DECLINED/i.test(reason)) return 'card_declined';
  if (status === 402 && body?.error === 'insufficient_credits') return 'insufficient_credits';
  return undefined;
}
