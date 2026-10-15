import 'dotenv/config';
import { getEnvironmentFromApiKey } from '@nevermined-io/payments';
import { usdToMicro, type MicroUsd } from './money.ts';

/**
 * 支払い上限（指示書 §3）。コードに固定し、環境変数では「下げる」ことしかできない。
 * 上限を上げるにはこのファイルを変更してレビューを通すこと。
 */
export const HARD_MAX_PER_CALL: MicroUsd = usdToMicro('0.05');
export const HARD_MAX_PER_DAY: MicroUsd = usdToMicro('5');

function lowerOnly(envName: string, hard: MicroUsd): MicroUsd {
  const raw = process.env[envName];
  if (!raw) return hard;
  const v = usdToMicro(raw);
  if (v > hard) {
    throw new Error(`${envName}=${raw} exceeds the hard cap compiled into src/config.ts; refusing to start`);
  }
  return v;
}

export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name} (see .env.example)`);
  return v;
}

export type NvmEnvironment = 'sandbox' | 'live' | 'staging_sandbox' | 'staging_live';

export interface GatewayConfig {
  port: number;
  /** 買い手に見せる自分の公開 URL（Nevermined の paymentRequired.resource.url に入る）。 */
  publicBaseUrl: string;
  nvmApiKey: string;
  nvmEnvironment: NvmEnvironment;
  planId: string;
  agentId: string;
  upstreams: Record<string, string>;
  maxPerCall: MicroUsd;
  maxPerDay: MicroUsd;
  /** true のときテストネットの資産しか払わない（§0：最初はテスト環境だけ）。 */
  testnetOnly: boolean;
  /** 残高不足なら settle せず 402（既定 true）。false で Nevermined の自動補充の挙動を測る */
  blockCardTopUp: boolean;
  /** ゲートウェイのログの保存先。blob（既定）= Vercel Blob、file = ローカル（開発時のみ） */
  logSink: 'blob' | 'file';
  blobReadWriteToken?: string;
  /** 開発時（LOG_SINK=file）の出力先 */
  logDir: string;
  /** 実証2用の読み取り専用トークン（GET /logs/:date）。未設定なら口を閉じる */
  logReadToken?: string;
  logSalt: string;
  evmPrivateKey?: string;
  svmPrivateKey?: string;
}

/**
 * NVM_ENVIRONMENT を読み、渡された API キーのプレフィックス（sandbox: / live: など）と一致するか確かめる
 * （poc-card-percall から移植。docs/merge-from-percall.md）。
 * 食い違うと Nevermined は別のバックエンドに届いて分かりにくい 4xx を返す（5-Minute Setup）ので、起動時に止める。
 * プレフィックスの解釈は SDK の getEnvironmentFromApiKey に合わせる。live は ALLOW_LIVE=true のときだけ許可する。
 */
export function nvmEnvironment(...keys: (string | undefined)[]): NvmEnvironment {
  const env = (process.env.NVM_ENVIRONMENT ?? 'sandbox') as NvmEnvironment;
  if (!['sandbox', 'live', 'staging_sandbox', 'staging_live'].includes(env)) {
    throw new Error(`NVM_ENVIRONMENT must be sandbox or live, got ${env}`);
  }
  if ((env === 'live' || env === 'staging_live') && process.env.ALLOW_LIVE !== 'true') {
    throw new Error('NVM_ENVIRONMENT is live but ALLOW_LIVE!=true. 本番移行は docs/go-live.md の条件を満たしてから。');
  }
  for (const k of keys) {
    if (!k) continue;
    const fromKey = getEnvironmentFromApiKey(k);
    if (fromKey !== env) {
      throw new Error(`NVM API key prefix "${k.split(':')[0]}:" does not match NVM_ENVIRONMENT=${env}`);
    }
  }
  return env;
}

export function loadGatewayConfig(): GatewayConfig {
  const nvmApiKey = required('NVM_API_KEY_SELLER');
  const nvmEnv = nvmEnvironment(nvmApiKey);
  const allowLive = process.env.ALLOW_LIVE === 'true';
  const testnetOnly = process.env.UPSTREAM_TESTNET_ONLY !== 'false';
  if (!testnetOnly && !allowLive) {
    throw new Error('UPSTREAM_TESTNET_ONLY=false requires ALLOW_LIVE=true');
  }
  const cfg: GatewayConfig = {
    port: Number(process.env.PORT ?? 8787),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
    nvmApiKey,
    nvmEnvironment: nvmEnv,
    planId: required('NVM_PLAN_ID'),
    agentId: required('NVM_AGENT_ID'),
    upstreams: {
      osd: required('UPSTREAM_OSD_URL'),
      jin: required('UPSTREAM_JIN_URL'),
    },
    maxPerCall: lowerOnly('MAX_USD_PER_CALL', HARD_MAX_PER_CALL),
    maxPerDay: lowerOnly('MAX_USD_PER_DAY', HARD_MAX_PER_DAY),
    testnetOnly,
    blockCardTopUp: process.env.BLOCK_CARD_TOPUP !== 'false',
    logSink: (process.env.LOG_SINK ?? 'blob') as 'blob' | 'file',
    blobReadWriteToken: process.env.BLOB_READ_WRITE_TOKEN || undefined,
    logDir: process.env.LOG_DIR ?? 'log',
    logReadToken: process.env.LOG_READ_TOKEN || undefined,
    logSalt: required('LOG_SALT'),
    evmPrivateKey: process.env.GATEWAY_EVM_PRIVATE_KEY || undefined,
    svmPrivateKey: process.env.GATEWAY_WALLET_SECRET || undefined,
  };
  if (cfg.logReadToken && cfg.logReadToken.length < 32) {
    throw new Error('LOG_READ_TOKEN must be at least 32 characters (npm run logs:issue-read-token)');
  }
  if (cfg.logSink !== 'blob' && cfg.logSink !== 'file') throw new Error('LOG_SINK must be blob or file');
  if (cfg.logSink === 'blob' && !cfg.blobReadWriteToken) throw new Error('missing BLOB_READ_WRITE_TOKEN (gateway logs go to Vercel Blob)');
  // ローカルファイルへの出力は開発時だけ（NODE_ENV=development）。Sandbox の運用でも常に Vercel Blob に書く
  if (cfg.logSink === 'file' && (process.env.NODE_ENV !== 'development' || allowLive || nvmEnv !== 'sandbox')) {
    throw new Error('LOG_SINK=file is for local development only (NODE_ENV=development, sandbox, ALLOW_LIVE unset)');
  }
  if (!cfg.evmPrivateKey && !cfg.svmPrivateKey) {
    throw new Error('set GATEWAY_WALLET_SECRET (Solana, from npm run wallet:new) and/or GATEWAY_EVM_PRIVATE_KEY (a NEW wallet for this gateway only)');
  }
  return cfg;
}
