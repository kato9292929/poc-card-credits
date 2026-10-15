/**
 * prepaid-100（$1・100 クレジット・30日有効、カード払い）とゲートウェイのエージェントを Nevermined に登録する。
 * 売り手のキー（NVM_API_KEY_SELLER）で Sandbox で1回だけ実行し、出力された ID を .env に書く。
 *
 * 有効期限について（docs/nevermined.md「使っている API」）:
 *   SDK 1.13.0 には「クレジット制のプランに有効期限を付ける」正式な指定が無い。
 *   creditsConfig.durationSecs という欄はあるが、
 *     - registerCreditsPlan は durationSecs ≠ 0 を拒否する（"must be 0 for credits plans (non-expirable)"）
 *     - registerPlan / registerAgentAndPlan は値をそのまま送るだけで、クレジット制＋有効期限の組み合わせは文書化されていない
 *   そこで、有効期限のあるプランは SDK では登録せず、Nevermined App で作る（追加指示 §1）。
 *
 *   npm run plan:register                       # プランを App で作る手順を表示して終わる（登録はしない）
 *   npm run plan:register -- --plan-id <ID>     # App で作ったプランの中身を確かめ、エージェントを登録して紐づける
 *   npm run plan:register -- --plan-id <ID> --confirm  # 中身を自動で確かめきれないとき（目視確認後）
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Payments } from '@nevermined-io/payments';
import { nvmEnvironment, required } from '../src/config.ts';
import { usdToMicro } from '../src/money.ts';

const plan = (JSON.parse(readFileSync('config/plans.json', 'utf8')) as { plans: any[] }).plans.find((p) => p.name === 'prepaid-100');
if (!plan) throw new Error('prepaid-100 not found in config/plans.json');

const argIdx = process.argv.indexOf('--plan-id');
const planId = argIdx > 0 ? process.argv[argIdx + 1] : undefined;

if (!planId) {
  console.log(`SDK 1.13.0 ではクレジット制のプランに有効期限を指定できないため、プランは Nevermined App（Sandbox）で作る。

  Plans > 新規作成
    名前            ${plan.name}
    説明            ${plan.description}
    種類            Credits（クレジット制）。有効期限 ${plan.durationDays} 日
    価格            Fiat ${plan.priceUsd} USD（Stripe checkout）
    クレジット      ${plan.credits}（1リクエストあたり 1。ゲートウェイが settle 時に 1〜2 を指定する）

作成後に、表示されたプラン ID を使って次を実行する（エージェントを登録して紐づける）:
  npm run plan:register -- --plan-id <PLAN_ID>

App で「クレジット制＋有効期限」が設定できなかった場合は、その結果を docs/nevermined.md に記録して止める。`);
  process.exit(2);
}

// キーのプレフィックスと NVM_ENVIRONMENT の一致を確かめる（live は ALLOW_LIVE=true が必要）
const apiKey = required('NVM_API_KEY_SELLER');
const environment = nvmEnvironment(apiKey);
const payments = Payments.getInstance({ nvmApiKey: apiKey, environment });
const publicBaseUrl = required('PUBLIC_BASE_URL');

// App で作ったプランが公表値どおりかを確かめる（違えば登録しない）。
// getPlan の戻り値は SDK の型が any で、項目の場所が文書化されていない。そこで候補の場所を順に探し、
// 見つからない項目は「不明」として表示する。不明が残るときは、目で確かめたうえで --confirm を付けて再実行する。
const p = await payments.plans.getPlan(planId);
const pick = (...paths: string[]) => {
  for (const path of paths) {
    const v = path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), p);
    if (v !== undefined && v !== null) return String(v);
  }
  return undefined;
};
const checks: [string, string | undefined, string][] = [
  ['法定通貨（isCrypto=false）', pick('registry.price.isCrypto', 'price.isCrypto'), 'false'],
  ['価格（小数6桁単位）', pick('registry.price.amounts.0', 'price.amounts.0'), String(usdToMicro(plan.priceUsd))],
  ['クレジット数', pick('registry.credits.amount', 'credits.amount', 'creditsConfig.amount'), String(plan.credits)],
  ['有効期限（秒）', pick('registry.credits.durationSecs', 'credits.durationSecs', 'creditsConfig.durationSecs'), String(plan.durationDays * 86_400)],
];
let mismatch = false;
let unknown = false;
for (const [label, got, want] of checks) {
  if (got === undefined) unknown = true;
  else if (got !== want) mismatch = true;
  console.log(`${got === undefined ? '不明' : got === want ? 'OK  ' : 'NG  '} ${label}: ${got ?? '-'}（期待 ${want}）`);
}
if (mismatch || (unknown && !process.argv.includes('--confirm'))) {
  console.error(JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.error(
    mismatch
      ? 'プランの中身が公表値と違うため、エージェントは登録しない。App の設定を見直すか、差を docs/nevermined.md に記録する。'
      : '確認できない項目がある。上の getPlan の結果を目で確かめ、公表値どおりなら --confirm を付けて再実行する。',
  );
  process.exit(1);
}

const { agentId } = await payments.agents.registerAgent(
  {
    name: 'OSD / JIN card-credits gateway (PoC)',
    description: 'カード払いで購入したクレジットで OSD / JIN の x402 エンドポイントを1コールずつ利用するゲートウェイ',
    tags: ['poc', 'x402', 'osd', 'jin'],
  },
  {
    // endpoints（Nevermined 側の追加の URL 許可リスト）は登録しない（判断待ち。:ticker のような
    // パスパラメータを書けるかが未確認）。ゲートウェイ側でルートを限定している。
    agentDefinitionUrl: `${publicBaseUrl}/healthz`,
  },
  [planId],
);

console.log(JSON.stringify({ environment, NVM_AGENT_ID: agentId, NVM_PLAN_ID: planId }, null, 2));
