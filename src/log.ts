import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** UTC の日付で YYYY-MM-DD。日次上限・ログのファイル分割はすべてこれに揃える。 */
export function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * JST（UTC+9、夏時間なし）の日付で YYYY-MM-DD。
 * ゲートウェイのログのファイル分割（log/YYYY-MM-DD.jsonl）、GET /logs/:date、1日の支払い上限はこの日付にそろえる。
 */
export function jstDay(d = new Date()): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

/** トークン・支払元アドレスの匿名化。塩付き SHA-256 の先頭16桁。 */
export function anonymize(value: string, salt: string): string {
  return createHash('sha256').update(salt).update('\0').update(value).digest('hex').slice(0, 16);
}

export type Outcome =
  | 'ok'
  | 'no_route'
  | 'no_token'
  | 'token_invalid'
  | 'insufficient_credits'
  | 'gateway_cap_exceeded'
  | 'upstream_failed'
  | 'settle_failed'
  | 'ledger_error';

/**
 * ゲートウェイのログ1行。実証2が読むので、先頭の8項目は必ず入れる（修正指示 §3）。
 * 値が無い場合も項目は省略せず、'none' / 'skipped' を入れる。
 */
export interface RequestLogEntry {
  /** UTC の時刻（ISO 8601、末尾 Z） */
  time_utc: string;
  /** JST の日付（YYYY-MM-DD）。ファイル名・GET /logs/:date の日付と同じ */
  date_jst: string;
  /** 匿名化したトークン ID（塩付き SHA-256 の先頭16桁）。トークンが無いリクエストは 'none' */
  tokenId: string;
  /** プラン種別。このゲートウェイは前払い（prepaid-100）だけを受け付ける */
  planKind: 'prepaid';
  /** verify の結果：'valid' / 無効理由 / 'skipped'（verify まで進まなかった） */
  verify: string;
  /** settle の結果：'ok' / エラー内容 / 'skipped'（settle を呼ばなかった） */
  settle: string;
  /** 消費クレジット（呼ばなかった・失敗したときは 0） */
  creditsConsumed: number;
  /** 裏側の x402 決済の tx 署名（Solana）/ tx ハッシュ（EVM）。支払っていなければ 'none' */
  upstreamTx: string;

  routeId?: string;
  method: string;
  path: string;
  /** 支払元（Nevermined 上の購入者）の匿名ID */
  payerId?: string;
  outcome: Outcome;
  status: number;
  /** 裏側で払った x402 の額（マイクロUSD、文字列） */
  upstreamCostMicro: string;
  /** 署名して送った支払いの額（決済未確認も含む）。日次上限の復元に使う */
  upstreamAttemptMicro?: string;
  /** 上流の支払いに使うネットワークの種別（全行に入れる）。実証2で、このゲートウェイの mainnet 上の支払いを見分けるため */
  upstreamNetworkMode: 'mainnet' | 'testnet';
  /** 実際に支払ったネットワーク（CAIP-2）。上流に支払いを送ったときだけ */
  upstreamNetwork?: string;
  upstreamStatus?: number;
  nvmSettleTx?: string;
  /** settle 時に Nevermined がカードへ自動補充の請求をした場合の参照（カード明細が1件増える） */
  cardTopUpOrderTx?: string;
  remainingCredits?: string;
  latencyMs: number;
  upstreamLatencyMs?: number;
  error?: string;
}

const REQUIRED_KEYS = ['time_utc', 'date_jst', 'tokenId', 'planKind', 'verify', 'settle', 'creditsConsumed', 'upstreamTx', 'upstreamNetworkMode'] as const;

/** 必須項目がそろっているかを確かめて1行の JSON にする。欠けていれば例外（書き込まない）。 */
export function toLogLine(e: RequestLogEntry): string {
  for (const k of REQUIRED_KEYS) {
    const v = e[k];
    if (v === undefined || v === null || v === '') throw new Error(`log entry missing required field ${k}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(e.time_utc)) throw new Error(`time_utc must be UTC ISO 8601: ${e.time_utc}`);
  if (e.date_jst !== jstDay(new Date(e.time_utc))) throw new Error(`date_jst ${e.date_jst} does not match time_utc ${e.time_utc}`);
  if (!Number.isInteger(e.creditsConsumed) || e.creditsConsumed < 0) throw new Error('creditsConsumed must be a non-negative integer');
  return JSON.stringify(e);
}

/** 買い手エージェント・スクリプト用のローカル JSONL、および開発時のゲートウェイのログ（LOG_SINK=file）。 */
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
