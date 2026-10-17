/**
 * 残高切れ・委任の上限到達で止まった買い手エージェント（Vercel Cron）を再開する。
 * プランの追加購入などで原因を解消してから実行する。停止〜再開の時間を買い手ログに残す。
 *
 *   npm run buyer:resume
 */
import 'dotenv/config';
import { required } from '../src/config.ts';
import { jstDay } from '../src/log.ts';
import { VercelBlobLogStore } from '../src/logstore/blob.ts';
import { BlobStateStore } from '../src/buyer/state.ts';

const token = required('BLOB_READ_WRITE_TOKEN');
const state = new BlobStateStore(token);
const st = await state.get();
if (!st?.stopped) {
  console.log('買い手エージェントは止まっていない');
  process.exit(0);
}
const now = new Date();
const stoppedForSec = st.since ? Math.round((now.getTime() - Date.parse(st.since)) / 1000) : undefined;
await new VercelBlobLogStore({ token, prefix: 'log/buyer/' }).append(
  jstDay(now),
  JSON.stringify({ ts: now.toISOString(), date_jst: jstDay(now), event: 'resumed', stoppedSince: st.since, stoppedForSec, previousKind: st.errorKind }),
);
await state.set({ stopped: false });
console.log(`再開した（停止 ${stoppedForSec ?? '-'} 秒、原因 ${st.errorKind ?? '-'}）。次の Cron から呼び出しが再開する`);
