import { parseLines } from './types.ts';

/**
 * ゲートウェイの読み取り専用の口（GET /logs/:date）からログを読む。
 * 週次レポートと、実証2の日次ジョブの読み方の見本。
 */
export class HttpLogReader {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  /** kind = 'gateway'（GET /logs/:date）または 'buyer'（GET /logs/buyer/:date） */
  async readDay(day: string, kind: 'gateway' | 'buyer' = 'gateway'): Promise<any[]> {
    const r = await fetch(`${this.baseUrl.replace(/\/$/, '')}/logs/${kind === 'buyer' ? 'buyer/' : ''}${day}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`GET /logs/${kind === 'buyer' ? 'buyer/' : ''}${day} → HTTP ${r.status}`);
    return parseLines(await r.text());
  }
}
