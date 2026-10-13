import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** UTC の日付で YYYY-MM-DD。日次上限・ログのファイル分割はすべてこれに揃える。 */
export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** トークン・支払元アドレスの匿名化。塩付き SHA-256 の先頭16桁。 */
export function anonymize(value: string, salt: string): string {
  return createHash('sha256').update(salt).update('\0').update(value).digest('hex').slice(0, 16);
}

export interface RequestLogEntry {
  ts: string;
  routeId?: string;
  method: string;
  path: string;
  /** 買い手トークンの匿名ID */
  tokenId?: string;
  /** 支払元（Nevermined 上の購入者）の匿名ID */
  payerId?: string;
  outcome:
    | 'ok'
    | 'no_route'
    | 'no_token'
    | 'token_invalid'
    | 'insufficient_credits'
    | 'gateway_cap_exceeded'
    | 'upstream_failed'
    | 'settle_failed'
    | 'ledger_error';
  status: number;
  creditsConsumed: number;
  /** 裏側で払った x402 の額（マイクロUSD、文字列） */
  upstreamCostMicro: string;
  /** 署名して送った支払いの額（決済未確認も含む）。日次上限の復元に使う */
  upstreamAttemptMicro?: string;
  upstreamNetwork?: string;
  /** 裏側の x402 決済の tx 署名（Solana）/ tx ハッシュ（EVM） */
  upstreamTx?: string;
  upstreamStatus?: number;
  nvmSettleTx?: string;
  /** settle 時に Nevermined がカードへ自動補充の請求をした場合の参照（カード明細が1件増える） */
  cardTopUpOrderTx?: string;
  remainingCredits?: string;
  latencyMs: number;
  upstreamLatencyMs?: number;
  error?: string;
}

export class JsonlLog {
  constructor(private readonly dir: string, private readonly prefix = '') {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  file(day = utcDay()): string {
    return join(this.dir, `${this.prefix}${day}.jsonl`);
  }

  append(entry: object): void {
    appendFileSync(this.file(), JSON.stringify(entry) + '\n');
  }

  read(day: string): any[] {
    const f = this.file(day);
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  days(): string[] {
    const re = new RegExp(`^${this.prefix}(\\d{4}-\\d{2}-\\d{2})\\.jsonl$`);
    return readdirSync(this.dir)
      .map((f) => re.exec(f)?.[1])
      .filter((d): d is string => !!d)
      .sort();
  }
}
