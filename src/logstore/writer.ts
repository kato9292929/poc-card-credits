import { toLogLine, type RequestLogEntry } from '../log.ts';
import type { LogStore } from './types.ts';

/**
 * ゲートウェイのログを保存先に書く（修正指示 §1）。
 * 書き込みの成否はリクエストの処理に影響させない：待たずに書き、失敗は標準エラーに残す
 * （書けなかった行も丸ごと出すので、ホスティングのログから回収できる）。
 * 終了時は flush() で書き込み中のものを待つ。
 */
export class GatewayLogWriter {
  private pending = new Set<Promise<void>>();
  failures = 0;
  /** 最後の書き込み失敗の理由（/healthz に出す。メッセージだけで、行の中身は含めない） */
  lastError?: { at: string; message: string };

  /** 書き込み中の Promise を渡す先（Vercel では waitUntil。応答後も書き込みを最後まで続けさせる） */
  onPending?: (p: Promise<void>) => void;

  constructor(
    private readonly store: LogStore,
    private readonly onError: (e: unknown, line: string) => void = (e, line) =>
      console.error(`[log] append failed: ${(e as Error)?.message ?? e}\n[log-line] ${line}`),
  ) {}

  write(entry: RequestLogEntry): void {
    let line: string;
    try {
      line = toLogLine(entry);
    } catch (e) {
      // 必須項目の欠け（プログラムの誤り）。リクエストは止めず、エラーとして残す
      this.failures++;
      this.onError(e, JSON.stringify(entry));
      return;
    }
    const p = this.store
      .append(entry.date_jst, line)
      .catch((e) => {
        this.failures++;
        this.lastError = { at: new Date().toISOString(), message: String((e as Error)?.message ?? e).slice(0, 300) };
        this.onError(e, line);
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
    this.onPending?.(p);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}
