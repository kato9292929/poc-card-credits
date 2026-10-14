import 'dotenv/config';
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

export function loadGatewayConfig(): GatewayConfig {
  const nvmEnvironment = (process.env.NVM_ENVIRONMENT ?? 'sandbox') as NvmEnvironment;
  const allowLive = process.env.ALLOW_LIVE === 'true';
  if ((nvmEnvironment === 'live' || nvmEnvironment === 'staging_live') && !allowLive) {
    throw new Error('NVM_ENVIRONMENT is live but ALLOW_LIVE!=true. 本番移行は docs/go-live.md の条件を満たしてから。');
  }
  const testnetOnly = process.env.UPSTREAM_TESTNET_ONLY !== 'false';
  if (!testnetOnly && !allowLive) {
    throw new Error('UPSTREAM_TESTNET_ONLY=false requires ALLOW_LIVE=true');
  }
  const cfg: GatewayConfig = {
    port: Number(process.env.PORT ?? 8787),
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
    nvmApiKey: required('NVM_API_KEY'),
    nvmEnvironment,
    planId: required('NVM_PLAN_ID'),
    agentId: required('NVM_AGENT_ID'),
    upstreams: {
      osd: required('OSD_BASE_URL'),
      jin: required('JIN_BASE_URL'),
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
    svmPrivateKey: process.env.GATEWAY_SVM_PRIVATE_KEY || undefined,
  };
  if (cfg.logReadToken && cfg.logReadToken.length < 32) {
    throw new Error('LOG_READ_TOKEN must be at least 32 characters (npm run logs:issue-read-token)');
  }
  if (cfg.logSink !== 'blob' && cfg.logSink !== 'file') throw new Error('LOG_SINK must be blob or file');
  if (cfg.logSink === 'blob' && !cfg.blobReadWriteToken) throw new Error('missing BLOB_READ_WRITE_TOKEN (gateway logs go to Vercel Blob)');
  if (cfg.logSink === 'file' && (allowLive || nvmEnvironment !== 'sandbox')) {
    throw new Error('LOG_SINK=file is for local development only; it cannot be used with live settings');
  }
  if (!cfg.evmPrivateKey && !cfg.svmPrivateKey) {
    throw new Error('set GATEWAY_EVM_PRIVATE_KEY and/or GATEWAY_SVM_PRIVATE_KEY (a NEW wallet for this gateway only)');
  }
  return cfg;
}
