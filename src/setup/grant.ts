import { get, put } from '@vercel/blob';
import { Payments, type EnvironmentName } from '@nevermined-io/payments';

/**
 * 支払い済みなのにクレジットが付かなかった注文 1 件分を、プランの持ち主（売り手）の権限で買い手に付ける。
 * 本番の購入画面で ¥155 を払ったのに、Nevermined が買い手に注文を記録しなかった件（docs/live.md）の手当て。
 *
 * - 付ける量はプランと同じ（100 クレジット・30 日）。受け取り手は買い手キーのアドレスに固定し、外からは変えられない
 * - 環境ごとに 1 回だけ。結果を Blob の state/grant-<env>.json に残し、2 回目以降は付けずにそれを返す
 */
export interface GrantResult {
  environment: string;
  planId: string;
  receiver: string;
  credits: string;
  durationSecs: string;
  paymentRef: string;
  response: unknown;
  grantedAt: string;
  reused: boolean;
}

export async function grantPaidOrder(o: {
  sellerKey: string;
  buyerKey: string;
  environment: EnvironmentName;
  planId: string;
  paymentRef: string;
  blobToken?: string;
}): Promise<GrantResult> {
  const path = `state/grant-${o.environment}.json`;
  const prev = await get(path, { access: 'private', useCache: false, token: o.blobToken });
  if (prev && prev.statusCode === 200) return { ...(JSON.parse(await new Response(prev.stream).text()) as GrantResult), reused: true };

  const receiver = Payments.getInstance({ nvmApiKey: o.buyerKey, environment: o.environment }).getAccountAddress() as `0x${string}` | undefined;
  if (!receiver) throw new Error('the buyer key carries no account address');
  const seller = Payments.getInstance({ nvmApiKey: o.sellerKey, environment: o.environment });
  const credits = 100n;
  const durationSecs = 30n * 86_400n;
  const response = await seller.plans.mintPlanExpirable(o.planId, credits, receiver, durationSecs);
  const result: GrantResult = {
    environment: o.environment,
    planId: o.planId,
    receiver,
    credits: String(credits),
    durationSecs: String(durationSecs),
    paymentRef: o.paymentRef,
    response,
    grantedAt: new Date().toISOString(),
    reused: false,
  };
  await put(path, JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? String(v) : v)), {
    access: 'private',
    token: o.blobToken,
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: false,
  });
  return result;
}
