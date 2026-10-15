import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { base58 } from '@scure/base';

const svm = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  return base58.encode(Buffer.concat([seed, pub]));
})();

// §3 の環境変数（＋ゲートウェイに必須の NVM_PLAN_ID / LOG_SALT）が揃った状態
const FULL = {
  NVM_ENVIRONMENT: 'sandbox',
  NVM_API_KEY_SELLER: 'sandbox:seller',
  NVM_PLAN_ID: 'p',
  NVM_AGENT_ID: 'a',
  UPSTREAM_JIN_URL: 'https://jin.test',
  UPSTREAM_OSD_URL: 'https://osd.test',
  GATEWAY_WALLET_SECRET: svm,
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x',
  LOG_SALT: 's',
};

function preflight(env: Record<string, string>): { code: number; out: string } {
  try {
    // 値はすべて env で渡す（親プロセスの環境は引き継がない）
    const out = execFileSync('npx', ['tsx', 'scripts/preflight.ts', 'gateway'], { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env }, encoding: 'utf8' });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status, out: String(e.stdout) };
  }
}

test('preflight(gateway) passes exactly when the gateway config loads', async () => {
  const { loadGatewayConfig } = await import('../src/config.ts');
  const withEnv = <T>(env: Record<string, string>, fn: () => T) => {
    const saved = { ...process.env };
    for (const k of Object.keys(process.env)) if (/^(NVM_|UPSTREAM_|GATEWAY_|BLOB_|LOG_|ALLOW_|NODE_ENV)/.test(k)) delete process.env[k];
    Object.assign(process.env, env);
    try {
      return fn();
    } finally {
      process.env = saved;
    }
  };
  assert.equal(preflight(FULL).code, 0);
  assert.doesNotThrow(() => withEnv(FULL, () => loadGatewayConfig()));
  for (const k of Object.keys(FULL).filter((k) => k !== 'NVM_ENVIRONMENT')) {
    const env = { ...FULL } as Record<string, string>;
    delete env[k];
    const r = preflight(env);
    assert.equal(r.code, 1, `${k} missing should fail preflight`);
    assert.match(r.out, new RegExp(`✗ ${k}`));
    assert.throws(() => withEnv(env, () => loadGatewayConfig()), Error, `${k} missing should fail the gateway too`);
  }
  // 接頭辞の食い違い
  assert.equal(preflight({ ...FULL, NVM_API_KEY_SELLER: 'live:x' }).code, 1);
  // 値は表示しない
  assert.ok(!preflight(FULL).out.includes(svm));
});
