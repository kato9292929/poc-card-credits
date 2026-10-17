import { Router } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { LogStore } from '../logstore/types.ts';

/** LOG_READ_TOKEN の最低長。短いトークンでは口を開けない */
export const MIN_READ_TOKEN_LENGTH = 32;

export function newReadToken(): string {
  return randomBytes(32).toString('base64url');
}

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * 実証2が読むための読み取り専用の口（修正指示 §2）。
 *
 *   GET /logs/:date         date は JST の YYYY-MM-DD（末尾の .jsonl は省略可）→ その日のゲートウェイの jsonl
 *   GET /logs/buyer/:date   同じ日付の買い手エージェントの jsonl（週次レポート用）
 *
 * - 認証は Authorization: Bearer <LOG_READ_TOKEN>。比較は定数時間
 * - このトークンでできるのは上の GET だけ。書き込み・削除の口は無く、GET 以外は 405。
 *   ログの保存先（Vercel Blob）の読み書きトークンはゲートウェイの中だけで使い、外には出さない
 * - LOG_READ_TOKEN が未設定（または短すぎる）なら口ごと閉じる（404）
 */
export function logRoutes(store: LogStore, readToken: string | undefined, buyerStore?: LogStore): Router {
  const r = Router();
  const enabled = !!readToken && readToken.length >= MIN_READ_TOKEN_LENGTH;
  const expected = enabled ? digest(readToken!) : undefined;

  r.use('/logs', (req, res, next) => {
    if (!expected) return void res.status(404).json({ error: 'not_found' });
    if (req.method !== 'GET') return void res.status(405).set('allow', 'GET').json({ error: 'read_only' });
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
    if (!m || !timingSafeEqual(digest(m[1]), expected)) {
      return void res.status(401).set('www-authenticate', 'Bearer').json({ error: 'unauthorized' });
    }
    next();
  });

  const serve = (st: LogStore) => async (req: import('express').Request, res: import('express').Response) => {
    const m = /^(\d{4}-\d{2}-\d{2})(?:\.jsonl)?$/.exec(String(req.params.date));
    if (!m || Number.isNaN(Date.parse(`${m[1]}T00:00:00Z`))) {
      return void res.status(400).json({ error: 'date must be JST YYYY-MM-DD' });
    }
    try {
      const text = await st.read(m[1]);
      if (text === null) return void res.status(404).json({ error: 'no_log', date: m[1] });
      res.type('application/x-ndjson').set('cache-control', 'no-store').send(text);
    } catch (e) {
      console.error(e);
      res.status(502).json({ error: 'log_store_unavailable' });
    }
  };
  if (buyerStore) r.get('/logs/buyer/:date', serve(buyerStore));
  r.get('/logs/:date', serve(store));
  return r;
}
