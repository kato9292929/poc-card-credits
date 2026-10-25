/**
 * 残高切れ・委任の上限到達で止まった買い手エージェント（Vercel Cron）を再開する。
 * プランの追加購入などで原因を解消してから実行する。停止〜再開の時間を買い手ログに残す。
 *
 *   npm run buyer:resume            # 手元に BLOB_READ_WRITE_TOKEN があるとき
 *   npm run buyer:resume -- --remote  # Blob が Vercel 上でしか読み書きできないとき（BLOB_STORE_ID ＋ OIDC）。
 *                                     # ゲートウェイの POST /buyer/resume（Bearer CRON_SECRET）を呼ぶ
 */
import 'dotenv/config';
import { required } from '../src/config.ts';
import { VercelBlobLogStore } from '../src/logstore/blob.ts';
import { BlobStateStore } from '../src/buyer/state.ts';
import { resumeBuyer, type ResumeResult } from '../src/buyer/resume.ts';

let r: ResumeResult;
if (process.argv.includes('--remote')) {
  const res = await fetch(`${required('PUBLIC_BASE_URL').replace(/\/$/, '')}/buyer/resume`, {
    method: 'POST',
    headers: { authorization: `Bearer ${required('CRON_SECRET')}` },
  });
  if (!res.ok) throw new Error(`POST /buyer/resume → HTTP ${res.status}`);
  r = (await res.json()) as ResumeResult;
} else {
  const token = required('BLOB_READ_WRITE_TOKEN');
  r = await resumeBuyer(new BlobStateStore(token), new VercelBlobLogStore({ token, prefix: 'log/buyer/' }));
}
console.log(r.resumed ? `再開した（停止 ${r.stoppedForSec ?? '-'} 秒、原因 ${r.previousKind ?? '-'}）。次の Cron から呼び出しが再開する` : '買い手エージェントは止まっていない');
