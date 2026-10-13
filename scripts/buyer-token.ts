/**
 * 買い手エージェント用の x402 アクセストークンを発行して表示する（買い手の NVM API キーで実行）。
 * 出力を agents/buyer の NVM_ACCESS_TOKEN に入れる。
 *
 * @nevermined-io/payments 1.13.0 では、トークン発行に delegationConfig.delegationId が必須。
 * カード払いのプランは scheme 'nvm:card-delegation' を使い、委任（delegation）は
 * Nevermined App でカードを登録して作成しておく（docs/nevermined.md 参照）。
 * 委任には支出上限（spendingLimitCents）があり、クレジットが尽きたときの自動トップアップも
 * この上限の範囲で行われる。PoC では上限を小さくしておくこと（docs/nevermined.md「自動トップアップ」）。
 *
 *   NVM_API_KEY=<買い手のキー> NVM_DELEGATION_ID=<uuid> npm run buyer:token
 */
import 'dotenv/config';
import { Payments } from '@nevermined-io/payments';
import { appendFileSync, mkdirSync } from 'node:fs';
import { required, type NvmEnvironment } from '../src/config.ts';
import { anonymize } from '../src/log.ts';

const environment = (process.env.NVM_ENVIRONMENT ?? 'sandbox') as NvmEnvironment;
const payments = Payments.getInstance({ nvmApiKey: required('NVM_API_KEY'), environment });
const planId = required('NVM_PLAN_ID');
const agentId = required('NVM_AGENT_ID');
const delegationId = process.env.NVM_DELEGATION_ID;

if (!delegationId) {
  const ds = await payments.delegation.listDelegations({ accessible: true });
  console.error('NVM_DELEGATION_ID が未設定です。使える委任:');
  console.error(JSON.stringify(ds, null, 2));
  process.exit(1);
}

const scheme = (process.env.NVM_TOKEN_SCHEME ?? 'nvm:card-delegation') as 'nvm:card-delegation' | 'nvm:erc4337';
const { accessToken, tokenVersion } = await payments.x402.getX402AccessToken(planId, agentId, {
  scheme,
  delegationConfig: { delegationId },
});
// 「購入から利用開始まで」（§5）の区間に、委任の作成とトークン発行も入るので時刻を残す
const delegation = (await payments.delegation.listDelegations()).delegations.find((d) => d.delegationId === delegationId);
const logDir = process.env.LOG_DIR ?? 'log';
mkdirSync(logDir, { recursive: true });
appendFileSync(
  `${logDir}/events.jsonl`,
  JSON.stringify({
    ts: new Date().toISOString(),
    event: 'token_issued',
    environment,
    planId,
    scheme,
    tokenVersion,
    tokenId: anonymize(accessToken, process.env.LOG_SALT ?? 'buyer'),
    delegationId: delegationId.slice(0, 8),
    delegationCreatedAt: delegation?.createdAt,
    delegationLimitCents: delegation?.spendingLimitCents,
  }) + '\n',
);
console.error(`tokenVersion=${tokenVersion} scheme=${scheme}`);
if (tokenVersion === 3) console.error('注意: v3 トークンは1回限り。買い手エージェントは再利用できる v2 トークンを前提にしている。');
console.log(accessToken);
