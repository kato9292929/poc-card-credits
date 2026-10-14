import { parseLines } from './types.ts';

/**
 * ゲートウェイの読み取り専用の口（GET /logs/:date）からログを読む。
 * 週次レポートと、実証2の日次ジョブの読み方の見本。
 */
export class HttpLogReader {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async readDay(day: string): Promise<any[]> {
    const r = await fetch(`${this.baseUrl.replace(/\/$/, '')}/logs/${day}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`GET /logs/${day} → HTTP ${r.status}`);
    return parseLines(await r.text());
  }
}
