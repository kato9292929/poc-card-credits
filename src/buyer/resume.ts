import { jstDay } from '../log.ts';
import type { LogStore } from '../logstore/types.ts';
import type { StateStore } from './state.ts';

export type ResumeResult = { resumed: false } | { resumed: true; stoppedSince?: string; stoppedForSec?: number; previousKind?: string };

/**
 * 残高切れ・委任の上限到達で止まった買い手エージェントを再開する。停止〜再開の時間を買い手ログに残す（§5 の「停止・再開の時刻」）。
 * プランの買い直しなど、止まった原因を解消してから呼ぶ。scripts/buyer-resume.ts と POST /buyer/resume から使う。
 */
export async function resumeBuyer(state: StateStore, store: LogStore, now = new Date()): Promise<ResumeResult> {
  const st = await state.get();
  if (!st?.stopped) return { resumed: false };
  const stoppedForSec = st.since ? Math.round((now.getTime() - Date.parse(st.since)) / 1000) : undefined;
  await store.append(
    jstDay(now),
    JSON.stringify({ ts: now.toISOString(), date_jst: jstDay(now), event: 'resumed', stoppedSince: st.since, stoppedForSec, previousKind: st.errorKind }),
  );
  await state.set({ stopped: false });
  return { resumed: true, stoppedSince: st.since, stoppedForSec, previousKind: st.errorKind };
}
