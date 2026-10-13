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
  logDir: string;
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
    logDir: process.env.LOG_DIR ?? 'log',
    logSalt: required('LOG_SALT'),
    evmPrivateKey: process.env.GATEWAY_EVM_PRIVATE_KEY || undefined,
    svmPrivateKey: process.env.GATEWAY_SVM_PRIVATE_KEY || undefined,
  };
  if (!cfg.evmPrivateKey && !cfg.svmPrivateKey) {
    throw new Error('set GATEWAY_EVM_PRIVATE_KEY and/or GATEWAY_SVM_PRIVATE_KEY (a NEW wallet for this gateway only)');
  }
  return cfg;
}
