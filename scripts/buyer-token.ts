/**
 * 買い手（利用者）のカード委任を用意し、x402 アクセストークンを発行して表示する（追加指示 v2 §1）。
 * 買い手の sandbox: キー（NVM_API_KEY_BUYER）で実行する。出力を agents/buyer の NVM_ACCESS_TOKEN に入れる。
 *
 * 1. 委任：有効なものがあれば再利用し、無ければ登録済みのカードから通貨 usd・上限 100¢ で作る
 *    （上限はコードに固定。BUYER_DELEGATION_LIMIT_CENTS で下げることだけできる）
 * 2. トークン：その委任 ID で、scheme 'nvm:card-delegation' のトークンを発行する
 * 3. 委任の作成時刻とトークンの発行時刻を log/events.jsonl に残す（週次レポートの区間計測に使う）
 *
 * 委任の上限は、クレジットが尽きたときのカードへの自動補充の上限にもなる（docs/nevermined.md「自動トップアップ」）。
 *
 *   npm run buyer:token
 */
import 'dotenv/config';
import { Payments } from '@nevermined-io/payments';
import { appendFileSync, mkdirSync } from 'node:fs';
import { delegationLimitCents, nvmEnvironment, required } from '../src/config.ts';
import { anonymize } from '../src/log.ts';
import { ensureDelegation, type CardProvider } from '../src/buyer/delegation.ts';

// キーのプレフィックスと NVM_ENVIRONMENT の一致を確かめる（live は ALLOW_LIVE=true が必要）
const apiKey = required('NVM_API_KEY_BUYER');
const environment = nvmEnvironment(apiKey);
const payments = Payments.getInstance({ nvmApiKey: apiKey, environment });
const planId = required('NVM_PLAN_ID');
const agentId = required('NVM_AGENT_ID');
const provider = (process.env.BUYER_CARD_PROVIDER ?? 'stripe') as CardProvider;
const limitCents = delegationLimitCents();

const logDir = process.env.LOG_DIR ?? 'log';
mkdirSync(logDir, { recursive: true });
const event = (e: object) => appendFileSync(`${logDir}/events.jsonl`, JSON.stringify({ environment, planId, ...e }) + '\n');

const d = await ensureDelegation(payments.delegation, { provider, limitCents, durationSecs: 30 * 86_400 });
event({
  ts: d.createdAt,
  event: d.reused ? 'delegation_reused' : 'delegation_created',
  delegationId: d.delegationId.slice(0, 8),
  delegationCreatedAt: d.createdAt,
  spendingLimitCents: d.spendingLimitCents,
  provider,
  ...(d.reused ? { reusedAt: new Date().toISOString() } : {}),
});
console.error(`${d.reused ? '既存の委任を再利用' : '委任を作成'}: ${d.delegationId.slice(0, 8)}…（上限 ${d.spendingLimitCents}¢、${provider}、作成 ${d.createdAt}）`);

const { accessToken, tokenVersion } = await payments.x402.getX402AccessToken(planId, agentId, {
  scheme: 'nvm:card-delegation',
  network: provider,
  delegationConfig: { delegationId: d.delegationId },
});
event({
  ts: new Date().toISOString(),
  event: 'token_issued',
  scheme: 'nvm:card-delegation',
  tokenVersion,
  tokenId: anonymize(accessToken, process.env.LOG_SALT ?? 'buyer'),
  delegationId: d.delegationId.slice(0, 8),
  delegationCreatedAt: d.createdAt,
});
console.error(`tokenVersion=${tokenVersion}`);
if (tokenVersion === 3) console.error('注意: v3 トークンは1回限り。買い手エージェントは再利用できる v2 トークンを前提にしている。');
console.log(accessToken);
