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
 *   npm run plan:register -- --plan-id <ID>     # App で作ったプランの中身を確かめ、エージェントを endpoints 付きで登録して紐づける
 *
 * endpoints（追加指示 v2 §2）: JIN は /jin/series・/jin/movers、OSD は /osd/catalysts/:ticker を
 * パターンのまま試す。拒否されたら BUYER_OSD_PATH（カンマ区切り可）の実パスを列挙して登録し直す。
 * どちらで登録できたかを log/events.jsonl（agent_registered）と標準出力に出す。
 *   npm run plan:register -- --try-sdk-expiry   # App で作れなかったときだけ。registerPlan に durationSecs=30日を渡して1回試す（Sandbox のみ）
 *   npm run plan:register -- --plan-id <ID> --confirm  # 中身を自動で確かめきれないとき（目視確認後）
 */
import 'dotenv/config';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Payments } from '@nevermined-io/payments';
import { nvmEnvironment, required } from '../src/config.ts';
import { usdToMicro } from '../src/money.ts';
import { agentEndpoints, loadPricing } from '../src/pricing.ts';

const plan = (JSON.parse(readFileSync('config/plans.json', 'utf8')) as { plans: any[] }).plans.find((p) => p.name === 'prepaid-100');
if (!plan) throw new Error('prepaid-100 not found in config/plans.json');

const argIdx = process.argv.indexOf('--plan-id');
const planId = argIdx > 0 ? process.argv[argIdx + 1] : undefined;

// 追加指示 v2 §4-1 の分岐：App で「クレジット制＋有効期限」が作れなかったときだけ使う。
// registerPlan に durationSecs = 30 日を直接渡して、Sandbox で1回だけ登録を試す（文書に無い使い方）。
// 結果（受け付けられたプラン ID、または拒否のエラー）を log/events.jsonl に残す。
if (process.argv.includes('--try-sdk-expiry')) {
  const apiKey = required('NVM_API_KEY_SELLER');
  const environment = nvmEnvironment(apiKey);
  if (environment !== 'sandbox') throw new Error('--try-sdk-expiry is sandbox-only');
  const payments = Payments.getInstance({ nvmApiKey: apiKey, environment });
  const logDir = process.env.LOG_DIR ?? 'log';
  mkdirSync(logDir, { recursive: true });
  const durationSecs = BigInt(plan.durationDays) * 86_400n;
  const record = (e: object) =>
    appendFileSync(`${logDir}/events.jsonl`, JSON.stringify({ ts: new Date().toISOString(), environment, event: 'sdk_expiry_attempt', durationSecs: String(durationSecs), ...e }) + '\n');
  try {
    const r = await payments.plans.registerPlan(
      { name: plan.name, description: plan.description, accessLimit: 'credits' },
      payments.plans.getFiatPriceConfig(usdToMicro(plan.priceUsd), required('NVM_RECEIVER_ADDRESS') as `0x${string}`),
      // movers は 2 クレジット消費するので、1リクエストあたり最小 1・最大 2 の可変にする
      { ...payments.plans.getDynamicCreditsConfig(BigInt(plan.credits), 1n, 2n), durationSecs },
      undefined,
      'credits',
    );
    record({ accepted: true, planId: r.planId });
    console.log(`受け付けられた: NVM_PLAN_ID=${r.planId}\n次に npm run plan:register -- --plan-id ${r.planId} で中身を照合する。`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    record({ accepted: false, error: msg });
    console.error(`拒否された: ${msg}\n→ 期限なしのクレジット制 100 回で App に作り、この事実とエラー内容を docs/nevermined.md に記録する。`);
    process.exit(1);
  }
  process.exit(0);
}

if (!planId) {
  console.log(`SDK 1.13.0 ではクレジット制のプランに有効期限を指定できないため、プランは Nevermined App（Sandbox）で作る。

  Plans > 新規作成
    名前            ${plan.name}
    説明            ${plan.description}
    種類            Credits（クレジット制）。有効期限 ${plan.durationDays} 日
    価格            Fiat ${plan.priceUsd} USD（Stripe checkout）
    クレジット      ${plan.credits}。1リクエストあたりの消費は可変で 最小 1・最大 2（JIN movers が 2 クレジット）

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
  ['1リクエストあたりの最小クレジット', pick('registry.credits.minAmount', 'credits.minAmount', 'creditsConfig.minAmount'), '1'],
  ['1リクエストあたりの最大クレジット', pick('registry.credits.maxAmount', 'credits.maxAmount', 'creditsConfig.maxAmount'), '2'],
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

// endpoints（追加指示 v2 §2）：ゲートウェイの公開パスを Nevermined の URL 許可リストに登録する。
// まず OSD を :ticker 付きのパターンで試し、拒否されたら買い手エージェントが呼ぶ実パスを列挙して登録し直す。
const base = publicBaseUrl.replace(/\/$/, '');
const buyerPaths = (process.env.BUYER_OSD_PATH ?? '/osd/catalysts/AAPL').split(',').map((x) => x.trim()).filter(Boolean);
const { pattern: patternEndpoints, expanded: expandedEndpoints } = agentEndpoints(loadPricing(), base, buyerPaths);

const agentMetadata = {
  name: 'OSD / JIN card-credits gateway (PoC)',
  description: 'カード払いで購入したクレジットで OSD / JIN の x402 エンドポイントを1コールずつ利用するゲートウェイ',
  tags: ['poc', 'x402', 'osd', 'jin'],
};
const register = (endpoints: Record<string, string>[]) =>
  payments.agents.registerAgent(agentMetadata, { endpoints, agentDefinitionUrl: `${base}/healthz` }, [planId]);
const show = (e: unknown) => (e instanceof Error ? `${(e as any).code ? `${(e as any).code}: ` : ''}${e.message}` : String(e));

const logDir = process.env.LOG_DIR ?? 'log';
mkdirSync(logDir, { recursive: true });
const event = (e: object) => appendFileSync(`${logDir}/events.jsonl`, JSON.stringify({ ts: new Date().toISOString(), environment, planId, ...e }) + '\n');

let agentId: string;
let form: 'pattern' | 'expanded';
let patternError: string | undefined;
try {
  ({ agentId } = await register(patternEndpoints));
  form = 'pattern';
} catch (e) {
  patternError = show(e);
  console.error(`パターン（:ticker）付きの endpoints は拒否された: ${patternError}`);
  console.error(`実パスを列挙して登録し直す: ${expandedEndpoints.map((x) => Object.values(x)[0]).join(', ')}`);
  try {
    ({ agentId } = await register(expandedEndpoints));
    form = 'expanded';
  } catch (e2) {
    event({ event: 'agent_register_failed', patternError, expandedError: show(e2) });
    throw e2;
  }
}
const endpoints = form === 'pattern' ? patternEndpoints : expandedEndpoints;
event({ event: 'agent_registered', agentId, endpointsForm: form, endpoints, patternError });
console.log(JSON.stringify({ environment, NVM_AGENT_ID: agentId, NVM_PLAN_ID: planId, endpointsForm: form, endpoints, patternError }, null, 2));

// プラン ID とエージェント ID は秘密ではないので config/sandbox.json に書く（コミットする。Vercel の環境変数に入れ直さなくて済む）
const settingsFile = 'config/sandbox.json';
const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
settings.NVM_PLAN_ID = planId;
settings.NVM_AGENT_ID = agentId;
writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
console.log(`${settingsFile} に NVM_PLAN_ID と NVM_AGENT_ID を書いた（コミットして push すると Vercel にも反映される）`);
console.log(`\ndocs/nevermined.md の「使っている API」に、endpoints を ${form === 'pattern' ? ':ticker 付きのパターン' : '実パスの列挙'} で登録できたことを書く。`);
