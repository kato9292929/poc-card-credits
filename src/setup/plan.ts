import { get, put } from '@vercel/blob';
import { Payments } from '@nevermined-io/payments';
import plansJson from '../../config/plans.json' with { type: 'json' };
import { usdToMicro } from '../money.ts';
import { agentEndpoints, loadPricing } from '../pricing.ts';

/**
 * prepaid-100 のプラン（$1・100 クレジット・1 リクエスト 1 クレジット・有効期限 30 日、カード払い）を作り、
 * ゲートウェイのエージェントを登録する。App ではクレジット制に有効期限を付けられないので、SDK の registerPlan に
 * durationSecs を渡す（Sandbox で受け付けられた方法、docs/nevermined.md）。
 *
 * 本番の売り手キーは Vercel にしか無く、プラン ID が無いとゲートウェイは起動しないので、未設定の状態のゲートウェイの
 * POST /setup/plan から呼ぶ（docs/live.md）。一度作ったら結果を Blob の state/plan-<env>.json に残し、
 * 2 回目以降は作らずにそれを返す（二重に作らない）。
 */
export interface PlanSetupResult {
  environment: string;
  planId: string;
  agentId: string;
  receiver: string;
  durationSecs: string;
  endpoints: Record<string, string>[];
  createdAt: string;
  reused: boolean;
}

export async function setupPlan(o: { apiKey: string; environment: 'sandbox' | 'live'; publicBaseUrl: string; blobToken?: string }): Promise<PlanSetupResult> {
  const path = `state/plan-${o.environment}.json`;
  const prev = await get(path, { access: 'private', useCache: false, token: o.blobToken });
  if (prev && prev.statusCode === 200) return { ...(JSON.parse(await new Response(prev.stream).text()) as PlanSetupResult), reused: true };

  const plan = (plansJson as { plans: { name: string; description: string; priceUsd: string; credits: number; durationDays: number }[] }).plans.find((p) => p.name === 'prepaid-100')!;
  const payments = Payments.getInstance({ nvmApiKey: o.apiKey, environment: o.environment });
  const receiver = (process.env.NVM_RECEIVER_ADDRESS || payments.getAccountAddress()) as `0x${string}` | undefined;
  if (!receiver) throw new Error('NVM_RECEIVER_ADDRESS is not set and the API key carries no account address');
  const durationSecs = BigInt(plan.durationDays) * 86_400n;

  const { planId } = await payments.plans.registerPlan(
    { name: plan.name, description: plan.description, accessLimit: 'credits' },
    payments.plans.getFiatPriceConfig(usdToMicro(plan.priceUsd), receiver),
    { ...payments.plans.getFixedCreditsConfig(BigInt(plan.credits), 1n), durationSecs },
    undefined,
    'credits',
  );
  const base = o.publicBaseUrl.replace(/\/$/, '');
  const { pattern: endpoints } = agentEndpoints(loadPricing(), base, []);
  const { agentId } = await payments.agents.registerAgent(
    { name: 'OSD / JIN card-credits gateway', description: 'カード払いで購入したクレジットで OSD / JIN の x402 エンドポイントを1コールずつ利用するゲートウェイ', tags: ['x402', 'osd', 'jin'] },
    { endpoints, agentDefinitionUrl: `${base}/healthz` },
    [planId],
  );
  const result: PlanSetupResult = { environment: o.environment, planId, agentId, receiver, durationSecs: String(durationSecs), endpoints, createdAt: new Date().toISOString(), reused: false };
  await put(path, JSON.stringify(result), { access: 'private', token: o.blobToken, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false });
  return result;
}
