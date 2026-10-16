import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(setup: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'report-'));
  setup(dir);
  execFileSync('npx', ['tsx', 'scripts/weekly-report.ts', '2026-W42'], {
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, LOG_DIR: dir, REPORT_DIR: dir, CARD_PAYMENTS_FILE: join(dir, 'none.json') },
    encoding: 'utf8',
  });
  return readFileSync(join(dir, '2026-W42.md'), 'utf8');
}

const line = (o: object) => JSON.stringify(o) + '\n';
const gw = (patch: object) =>
  line({ time_utc: '2026-10-14T01:00:00.000Z', date_jst: '2026-10-14', tokenId: 't', planKind: 'prepaid', verify: 'valid', settle: 'ok', creditsConsumed: 1, upstreamTx: 'sig1', method: 'GET', path: '/jin/series', outcome: 'ok', status: 200, upstreamCostMicro: '10000', latencyMs: 900, ...patch });

test('empty week: every item that cannot be measured says 未計測 with a reason; 経理 has only blank fields', () => {
  const md = run(() => {});
  for (const h of ['## 1. カード手数料', '## 2. 1コールあたりの原価', '## 3. 1コールあたりの粗利', '## 4. 購入から利用開始までの時間', '## 5. 残高切れの挙動', '## 6. 経理上の扱い']) {
    assert.ok(md.includes(h), h);
  }
  assert.match(md, /## 1\. カード手数料\n\n未計測（/);
  assert.match(md, /## 2\. 1コールあたりの原価\n\n未計測（今週の成功コールが 0 件）/);
  assert.match(md, /## 4\. 購入から利用開始までの時間\n\n未計測（/);
  assert.match(md, /\| Stripe のレシートの形式（メール \/ PDF、発行者名） \| \|/);
});

test('populated week: cost from upstreamTx, 402 count, and the four timestamps of purchase-to-first-use', () => {
  const md = run((dir) => {
    writeFileSync(
      join(dir, '2026-10-14.jsonl'),
      gw({}) +
        gw({ time_utc: '2026-10-14T01:10:00.000Z', outcome: 'insufficient_credits', status: 402, settle: 'skipped', creditsConsumed: 0, upstreamTx: 'none', upstreamCostMicro: '0' }) +
        gw({ time_utc: '2026-10-14T01:20:00.000Z', outcome: 'no_token', status: 402, verify: 'skipped', settle: 'skipped', creditsConsumed: 0, upstreamTx: 'none', upstreamCostMicro: '0', tokenId: 'none' }),
    );
    writeFileSync(
      join(dir, 'events.jsonl'),
      line({ ts: '2026-10-14T00:50:00.000Z', event: 'credits_available' }) +
        line({ ts: '2026-10-14T00:52:00.000Z', event: 'delegation_created', delegationCreatedAt: '2026-10-14T00:52:00.000Z' }) +
        line({ ts: '2026-10-14T00:53:00.000Z', event: 'token_issued' }),
    );
    writeFileSync(join(dir, 'buyer-2026-10-14.jsonl'), line({ ts: '2026-10-14T01:10:01.000Z', event: 'credits_exhausted', status: 402, errorKind: 'insufficient_credits', action: 'stop' }));
  });
  assert.match(md, /裏側の x402 支払い（upstreamTx のある 1 件） \| \$0\.010000 \| \$0\.010000/);
  assert.match(md, /402 の回数: 2 回（insufficient_credits 1、no_token 1）/);
  assert.match(md, /\| 2026-10-14T00:50:00\.000Z \| 2026-10-14T00:52:00\.000Z \| 2026-10-14T00:53:00\.000Z \| 2026-10-14T01:00:00\.000Z \| 120 秒 \| 60 秒 \| 420 秒 \|/);
  assert.match(md, /買い手の停止: 2026-10-14T01:10:01\.000Z/);
  assert.match(md, /## 1\. カード手数料\n\n未計測（/); // カード明細が未入力
});
