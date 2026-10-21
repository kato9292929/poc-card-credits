import { get, head, list, put, BlobNotFoundError, BlobPreconditionFailedError } from '@vercel/blob';
import { logPath, type LogStore } from './types.ts';

/**
 * Vercel Blob（@vercel/blob 2.8.1）にログを置く。パスは log/YYYY-MM-DD.jsonl（JST の日付）。
 *
 * - Blob は private（読むには認証が要る）。Vercel 上では BLOB_STORE_ID ＋ 実行時の OIDC トークン、ローカルでは BLOB_READ_WRITE_TOKEN で認証する。
 *   どちらもゲートウェイだけが持つ
 * - **追記のみ。** 既存の行を書き換える・消す処理は無い（del() は呼ばない）。
 *   ただし Blob には追記の API が無いので、物理的には「読む → 末尾に1行足す → ETag が一致するときだけ書き戻す（ifMatch）」で
 *   オブジェクトを置き換える。書き戻す内容は必ず「読んだ内容そのまま＋新しい行」で、既存部分が変わらないことを
 *   書き込み前に確かめる。別のプロセスと競合したら（BlobPreconditionFailedError）読み直してやり直すので、
 *   複数台で動かしても行は失われない
 * - 同じプロセス内の追記は1本のキューで順に処理する（競合を減らすため）
 */
export interface BlobApi {
  get: typeof get;
  head: typeof head;
  put: typeof put;
  list: typeof list;
}

export class VercelBlobLogStore implements LogStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: { token?: string; maxRetries?: number; api?: BlobApi; prefix?: string }) {}

  private get prefix(): string {
    return this.opts.prefix ?? 'log/';
  }

  private get api(): BlobApi {
    return this.opts.api ?? { get, head, put, list };
  }

  /**
   * 中身と、書き戻しの条件（ifMatch）に使う ETag を読む。
   * get の ETag は配信側（CDN）の値で、put の ifMatch が照合する値と一致しないことがある（Sandbox で
   * "Precondition failed: ETag mismatch" が再試行しても続いた）。そこで ETag は head（API）から取り、
   * get の前後で head が同じ ETag を返し、かつ読んだ中身の大きさが head の size と一致するときだけ使う
   * （追記のみなので、古い中身を読めば必ず小さい）。合わなければ読み直す。
   */
  private async load(day: string): Promise<{ text: string; etag?: string } | null> {
    const path = logPath(day, this.prefix);
    const headOf = async () => {
      try {
        return await this.api.head(path, { token: this.opts.token });
      } catch (e) {
        if (e instanceof BlobNotFoundError) return null;
        throw e;
      }
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await headOf();
      if (!before) return null;
      const r = await this.api.get(path, { access: 'private', useCache: false, token: this.opts.token });
      if (!r || r.statusCode !== 200) continue;
      const bytes = new Uint8Array(await new Response(r.stream).arrayBuffer());
      const after = await headOf();
      if (after && after.etag === before.etag && bytes.byteLength === after.size) {
        return { text: new TextDecoder().decode(bytes), etag: after.etag };
      }
      await new Promise((res) => setTimeout(res, 100 * 2 ** attempt));
    }
    throw new Error(`could not read a consistent snapshot of ${path}`);
  }

  async read(day: string): Promise<string | null> {
    return (await this.load(day))?.text ?? null;
  }

  append(day: string, line: string): Promise<void> {
    const run = this.queue.then(() => this.appendNow(day, line));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async appendNow(day: string, line: string): Promise<void> {
    const max = this.opts.maxRetries ?? 8;
    for (let attempt = 0; ; attempt++) {
      if (line.includes('\n')) throw new Error('a log line must not contain a newline');
      const cur = await this.load(day);
      const existing = cur?.text ?? '';
      const body = existing + line + '\n';
      // 追記のみ：既存の内容が先頭にそのまま残ることを確かめてから書く
      if (!body.startsWith(existing) || body.length <= existing.length) throw new Error('append-only invariant violated');
      try {
        await this.api.put(logPath(day, this.prefix), body, {
          access: 'private',
          token: this.opts.token,
          contentType: 'application/x-ndjson',
          addRandomSuffix: false,
          // 既存なら ETag が一致するときだけ上書き。新規なら上書きを許さない（同時に作られたら失敗→やり直し）
          ...(cur?.etag ? { ifMatch: cur.etag } : { allowOverwrite: false }),
        });
        return;
      } catch (e) {
        const conflict = e instanceof BlobPreconditionFailedError || /already exists/i.test(String((e as Error).message));
        if (!conflict || attempt >= max) throw e;
        await new Promise((r) => setTimeout(r, 50 * 2 ** attempt + Math.random() * 50));
      }
    }
  }

  async days(): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.api.list({ prefix: this.prefix, cursor, token: this.opts.token });
      for (const b of r.blobs) {
        const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(b.pathname.slice(this.prefix.length));
        if (m) out.push(m[1]);
      }
      cursor = r.hasMore ? r.cursor : undefined;
    } while (cursor);
    return out.sort();
  }
}
