/**
 * ゲートウェイを Nevermined にエージェントとして登録し、starter プラン（カード払い）を作る。
 * 売り手（ゲートウェイ運営者）の NVM API キーで実行する。sandbox で1回だけ実行し、
 * 出力された NVM_AGENT_ID / NVM_PLAN_ID を .env に書く。
 *
 *   npm run plan:register
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Payments } from '@nevermined-io/payments';
import { required, type NvmEnvironment } from '../src/config.ts';
import { usdToMicro } from '../src/money.ts';

const environment = (process.env.NVM_ENVIRONMENT ?? 'sandbox') as NvmEnvironment;
if (environment !== 'sandbox' && process.env.ALLOW_LIVE !== 'true') {
  throw new Error('plan registration outside sandbox requires ALLOW_LIVE=true (docs/go-live.md)');
}
const payments = Payments.getInstance({ nvmApiKey: required('NVM_API_KEY'), environment });
const receiver = required('NVM_RECEIVER_ADDRESS') as `0x${string}`;
const publicBaseUrl = required('PUBLIC_BASE_URL');

const plan = (JSON.parse(readFileSync('config/plans.json', 'utf8')) as { plans: any[] }).plans.find((p) => p.name === (process.argv[2] ?? 'starter'));
if (!plan) throw new Error('plan not found in config/plans.json');

// 法定通貨の金額は「小数6桁の単位」（セントではない）。$10 = 10_000_000n。最低 $1。
const priceConfig = payments.plans.getFiatPriceConfig(usdToMicro(plan.priceUsd), receiver);
// クレジットの消費量はゲートウェイが settle 時に maxAmount で毎回指定する（1〜2クレジット）。
const creditsConfig = payments.plans.getFixedCreditsConfig(BigInt(plan.credits), 1n);

const { agentId, planId, txHash } = await payments.agents.registerAgentAndPlan(
  {
    name: 'OSD / JIN card-credits gateway (PoC)',
    description: 'カード払いで購入したクレジットで OSD / JIN の x402 エンドポイントを1コールずつ利用するゲートウェイ',
    tags: ['poc', 'x402', 'osd', 'jin'],
  },
  {
    // endpoints（Nevermined 側の追加のURL許可リスト）は登録しない。:ticker のようなパスパラメータの
    // 書式が公式ドキュメントで確認できていないため。ゲートウェイ側でルートを限定している。
    agentDefinitionUrl: `${publicBaseUrl}/healthz`,
  },
  { name: plan.name, description: plan.description, accessLimit: 'credits' },
  priceConfig,
  creditsConfig,
  'credits',
);

console.log(JSON.stringify({ environment, NVM_AGENT_ID: agentId, NVM_PLAN_ID: planId, txHash }, null, 2));
