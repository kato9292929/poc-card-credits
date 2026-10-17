import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('unconfigured deployment: /healthz returns 503 with missing variable names only, other routes 503', () => {
  // 親の環境を引き継がず、設定ファイルも空の状態でアプリを組み立てる
  const out = execFileSync(
    'npx',
    ['tsx', 'test/fixtures/app-healthz.ts'],
    { env: { PATH: process.env.PATH!, HOME: process.env.HOME!, SANDBOX_SETTINGS_FILE: '/nonexistent', NVM_API_KEY_SELLER: 'sandbox:secret-value' }, encoding: 'utf8' },
  );
  const r = JSON.parse(out.trim().split('\n').at(-1)!);
  assert.equal(r.h, 503);
  assert.equal(r.j, 503);
  assert.equal(r.body.ok, false);
  assert.ok(r.body.missing.gateway.includes('NVM_PLAN_ID'));
  assert.ok(!r.body.missing.gateway.includes('NVM_API_KEY_SELLER'));
  assert.ok(!JSON.stringify(r.body).includes('secret-value'), 'values must not be exposed');
});
