/**
 * 起動前チェック（追加指示 §3）。コマンドごとに、必要な環境変数が .env に揃っているかを一覧で出す。
 * 値そのものは表示しない（設定済みかどうかと、形式の確認結果だけ）。
 *
 *   npm run preflight            # 全コマンド
 *   npm run preflight -- gateway # 1つだけ
 */
import 'dotenv/config';
import { getEnvironmentFromApiKey } from '@nevermined-io/payments';

type Check = { name: string; why: string; optional?: boolean; validate?: (v: string) => string | undefined };

const env = process.env.NVM_ENVIRONMENT ?? 'sandbox';
const nvmKey = (role: string): Check['validate'] => (v) =>
  getEnvironmentFromApiKey(v) === env ? undefined : `${role}のキーの接頭辞（${v.split(':')[0]}:）が NVM_ENVIRONMENT=${env} と一致しない`;
const url: Check['validate'] = (v) => (/^https?:\/\//.test(v) ? undefined : 'URL（http(s)://...）ではない');

const SELLER: Check = { name: 'NVM_API_KEY_SELLER', why: '売り手の Nevermined API キー（sandbox:）', validate: nvmKey('売り手') };
const BUYER: Check = { name: 'NVM_API_KEY_BUYER', why: '買い手の Nevermined API キー（sandbox:）', validate: nvmKey('買い手') };
const AGENT: Check = { name: 'NVM_AGENT_ID', why: 'エージェント登録後の ID（npm run plan:register -- --plan-id）' };
const PLAN: Check = { name: 'NVM_PLAN_ID', why: 'App で作った prepaid-100 のプラン ID' };

export const COMMANDS: Record<string, { what: string; checks: Check[] }> = {
  gateway: {
    what: 'npm run gateway',
    checks: [
      SELLER,
      PLAN,
      AGENT,
      { name: 'UPSTREAM_JIN_URL', why: 'JIN のテスト用 URL', validate: url },
      { name: 'UPSTREAM_OSD_URL', why: 'OSD のテスト用 URL', validate: url },
      {
        name: 'GATEWAY_WALLET_SECRET',
        why: 'npm run wallet:new で作った Solana の秘密鍵（devnet USDC 入金済み）',
        validate: (v) => (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(v) ? undefined : 'base58 の 64 バイト秘密鍵に見えない'),
      },
      { name: 'BLOB_READ_WRITE_TOKEN', why: 'Vercel Blob のストアの読み書きトークン（ログの保存先）' },
      { name: 'LOG_SALT', why: 'ログのトークン ID 匿名化の塩（任意のランダム文字列）' },
      { name: 'PUBLIC_BASE_URL', why: '買い手から見たゲートウェイの URL（未設定なら http://localhost:PORT）', optional: true, validate: url },
      {
        name: 'LOG_READ_TOKEN',
        why: '実証2 用 GET /logs/:date の Bearer（未設定なら口を閉じる）',
        optional: true,
        validate: (v) => (v.length >= 32 ? undefined : '32 文字未満'),
      },
    ],
  },
  'plan:register': {
    what: 'npm run plan:register -- --plan-id <ID>（プランは App で作る）',
    checks: [SELLER, { name: 'PUBLIC_BASE_URL', why: 'エージェント登録に載せるゲートウェイの URL', validate: url }],
  },
  'plan:order': { what: 'npm run plan:order', checks: [BUYER, PLAN] },
  'buyer:token': {
    what: 'npm run buyer:token',
    checks: [BUYER, PLAN, AGENT, { name: 'NVM_DELEGATION_ID', why: '買い手の委任 ID（App で作成、上限 100¢）' }],
  },
  buyer: {
    what: 'npm run buyer',
    checks: [
      { name: 'GATEWAY_URL', why: 'ゲートウェイの URL', validate: url },
      { name: 'NVM_ACCESS_TOKEN', why: 'npm run buyer:token で発行したトークン' },
    ],
  },
  'payg:probe': {
    what: 'npm run payg:probe（Sandbox で1回だけ）',
    checks: [
      SELLER,
      BUYER,
      AGENT,
      { name: 'PUBLIC_BASE_URL', why: '試験の paymentRequired に載せる URL', validate: url },
      { name: 'NVM_RECEIVER_ADDRESS', why: 'payg プランを登録するときの受取アドレス（NVM_PLAN_ID_PAYG があれば不要）', optional: !!process.env.NVM_PLAN_ID_PAYG },
    ],
  },
  'report:weekly': {
    what: 'npm run report:weekly',
    checks: [
      { name: 'GATEWAY_URL', why: 'GET /logs/:date で読む先（未設定なら開発用のローカルログ）', optional: true, validate: url },
      { name: 'LOG_READ_TOKEN', why: '同上の Bearer', optional: true },
    ],
  },
};

const only = process.argv[2];
let missing = 0;
console.log(`NVM_ENVIRONMENT=${env}${env !== 'sandbox' ? '（Sandbox 以外。ALLOW_LIVE を設定しないこと）' : ''}\n`);
for (const [key, cmd] of Object.entries(COMMANDS)) {
  if (only && only !== key) continue;
  console.log(`■ ${cmd.what}`);
  for (const c of cmd.checks) {
    const v = process.env[c.name];
    const problem = v ? c.validate?.(v) : undefined;
    const mark = !v ? (c.optional ? '－' : '✗') : problem ? '✗' : '✓';
    if (mark === '✗') missing++;
    console.log(`  ${mark} ${c.name.padEnd(24)} ${!v ? (c.optional ? '未設定（任意）' : '未設定') : problem ?? '設定済み'} … ${c.why}`);
  }
  console.log('');
}
if (process.env.ALLOW_LIVE === 'true') {
  console.log('✗ ALLOW_LIVE=true が設定されている（追加指示で禁止）');
  missing++;
}
process.exit(missing ? 1 : 0);
