/**
 * 起動前チェック（追加指示 v2 §3）。必要な環境変数が .env に揃っているかを一覧で出す。
 * 値そのものは表示しない（設定済みかどうかと、形式の確認結果だけ）。
 *
 *   npm run preflight              # Sandbox での確認に進む条件（追加指示 v3 §2-3）。通れば終了コード 0
 *                                  #  ① このセッションの環境変数と config/sandbox.json
 *                                  #  ② デプロイ先（Vercel）の /healthz：ゲートウェイが設定済みで動いているか
 *                                  #     （GATEWAY_WALLET_SECRET と LOG_SALT は Vercel にだけ置くので、ここで確かめる）
 *   npm run preflight -- --all     # コマンドごとの一覧すべて
 *   npm run preflight -- gateway   # 1つのコマンドだけ
 */
import 'dotenv/config';
import '../src/settings.ts';
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
const WALLET: Check = {
  name: 'GATEWAY_WALLET_SECRET',
  why: 'npm run wallet:new で作った Solana の秘密鍵（UPSTREAM_MAINNET_PURCHASE=true なら mainnet USDC を入金済み）',
  validate: (v) => (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(v) ? undefined : 'base58 の 64 バイト秘密鍵に見えない'),
};
const BLOB: Check = { name: 'BLOB_READ_WRITE_TOKEN', why: 'Vercel Blob のストアの読み書きトークン（ログの保存先）' };
const SALT: Check = { name: 'LOG_SALT', why: 'ログのトークン ID 匿名化の塩（任意のランダム文字列）' };
const PUBLIC_URL: Check = { name: 'PUBLIC_BASE_URL', why: 'ゲートウェイの公開 URL（エージェント登録・payg 試験で使う）', validate: url };
const JIN: Check = { name: 'UPSTREAM_JIN_URL', why: 'JIN の URL', validate: url };
const OSD: Check = { name: 'UPSTREAM_OSD_URL', why: 'OSD の URL', validate: url };
const DELEGATION_LIMIT: Check = {
  name: 'BUYER_DELEGATION_LIMIT_CENTS',
  why: '委任の上限（セント）。既定 100 で、下げることだけできる（50 以上）',
  optional: true,
  validate: (v) => (/^\d+$/.test(v) && Number(v) >= 50 && Number(v) <= 100 ? undefined : '50〜100 の整数ではない'),
};

export const COMMANDS: Record<string, { what: string; checks: Check[] }> = {
  sandbox: {
    what: '① このセッション（Claude Code の環境変数と config/sandbox.json）',
    checks: [
      SELLER,
      BUYER,
      PLAN,
      AGENT,
      { ...BLOB, why: 'Vercel Blob の読み書きトークン（buyer:resume で使う）' },
      { name: 'LOG_READ_TOKEN', why: 'GET /logs/:date の Bearer（Sandbox での確認と週次レポートで使う）', validate: (v) => (v.length >= 32 ? undefined : '32 文字未満') },
      { name: 'CRON_SECRET', why: 'Vercel Cron の Bearer（買い手の1回分を手動で起動するときに使う）', validate: (v) => (v.length >= 16 ? undefined : '16 文字未満') },
      JIN,
      OSD,
      PUBLIC_URL,
    ],
  },
  gateway: {
    what: 'npm run gateway',
    checks: [
      SELLER,
      PLAN,
      AGENT,
      JIN,
      OSD,
      WALLET,
      BLOB,
      SALT,
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
    checks: [SELLER, PUBLIC_URL],
  },
  'plan:order': { what: 'npm run plan:order', checks: [BUYER, PLAN] },
  'buyer:token': {
    what: 'npm run buyer:token',
    checks: [BUYER, PLAN, AGENT, DELEGATION_LIMIT],
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

const arg = process.argv[2];
const only = arg === '--all' ? undefined : arg ?? 'sandbox';
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
// ② デプロイ先の /healthz
if (only === 'sandbox' || only === undefined) {
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '');
  console.log('■ ② デプロイ先（Vercel）の /healthz');
  if (!base) {
    console.log('  ✗ PUBLIC_BASE_URL が無いので確かめられない\n');
    missing++;
  } else {
    try {
      const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(15_000) });
      const j: any = await r.json().catch(() => ({}));
      const lack = [...(j?.missing?.gateway ?? []), ...(j?.missing?.buyerCron ?? []), ...(j?.missing?.logRead ?? [])];
      if (r.status === 200 && j?.ok && lack.length === 0) {
        console.log(`  ✓ 設定済みで動いている（環境 ${j.nvmEnvironment}、上流 ${j.upstreamTestnetOnly ? 'testnet' : 'mainnet'}、ログ ${j.logSink}、ウォレット ${j.gatewayWallet?.svm ?? j.gatewayWallet?.evm ?? '-'}）`);
        if (j.nvmEnvironment !== 'sandbox') {
          console.log('  ✗ Sandbox ではない');
          missing++;
        }
      } else {
        console.log(`  ✗ HTTP ${r.status}${j?.reason ? `：${j.reason}` : ''}${lack.length ? `。Vercel に足りない環境変数: ${lack.join(', ')}` : ''}`);
        missing++;
      }
    } catch (e) {
      console.log(`  ✗ ${base}/healthz に届かない（${(e as Error).message}）`);
      missing++;
    }
    console.log('');
  }
}

if (process.env.ALLOW_LIVE === 'true') {
  console.log('✗ ALLOW_LIVE=true が設定されている（追加指示で禁止）');
  missing++;
}
process.exit(missing ? 1 : 0);
