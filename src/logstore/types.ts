/**
 * ゲートウェイのログの保存先。log/YYYY-MM-DD.jsonl（JST の日付）に1行ずつ追記する。
 * 本番は Vercel Blob（blob.ts）。ローカルファイルには書かない（修正指示 §2）。
 */
export interface LogStore {
  /** 1行（改行なしの JSON）を追記する。 */
  append(day: string, line: string): Promise<void>;
  /** その日のファイルの中身。無ければ null。 */
  read(day: string): Promise<string | null>;
  /** ログがある日付の一覧（昇順） */
  days(): Promise<string[]>;
}

/** prefix は 'log/'（ゲートウェイ）または 'log/buyer/'（買い手エージェント） */
export const logPath = (day: string, prefix = 'log/') => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`invalid log day ${day}`);
  return `${prefix}${day}.jsonl`;
};

export function parseLines(text: string | null): any[] {
  if (!text) return [];
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
