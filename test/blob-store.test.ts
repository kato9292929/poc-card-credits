import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlobPreconditionFailedError } from '@vercel/blob';
import { VercelBlobLogStore, type BlobApi } from '../src/logstore/blob.ts';

/** ETag 付きの条件付き書き込みを再現する擬似 Blob。読みと書きの間に遅延を入れて競合を起こしやすくする。 */
function fakeBlob() {
  const files = new Map<string, { body: string; etag: string; access: string }>();
  let n = 0;
  const tick = () => new Promise((r) => setTimeout(r, Math.random() * 5));
  const api = {
    async get(path: string, o: any) {
      await tick();
      const f = files.get(path);
      if (!f) return null;
      assert.equal(o.access, 'private');
      return { statusCode: 200, stream: new Response(f.body).body, headers: new Headers(), blob: { etag: f.etag } };
    },
    async put(path: string, body: string, o: any) {
      await tick();
      assert.equal(o.access, 'private');
      assert.equal(o.addRandomSuffix, false);
      const f = files.get(path);
      if (o.ifMatch !== undefined && f?.etag !== o.ifMatch) throw new BlobPreconditionFailedError();
      if (o.ifMatch === undefined && f && !o.allowOverwrite) throw new Error('Vercel Blob: This blob already exists');
      files.set(path, { body, etag: `e${++n}`, access: o.access });
      return { pathname: path };
    },
    async list() {
      return { blobs: [...files.keys()].map((pathname) => ({ pathname })), hasMore: false };
    },
  } as unknown as BlobApi;
  return { api, files };
}

test('concurrent appends from two gateway processes lose no lines (ETag retry)', async () => {
  const { api, files } = fakeBlob();
  const a = new VercelBlobLogStore({ token: 't', api, maxRetries: 50 });
  const b = new VercelBlobLogStore({ token: 't', api, maxRetries: 50 });
  const writes = [];
  for (let i = 0; i < 20; i++) writes.push((i % 2 ? a : b).append('2026-10-14', JSON.stringify({ i })));
  await Promise.all(writes);
  const lines = files.get('log/2026-10-14.jsonl')!.body.trim().split('\n').map((l) => JSON.parse(l).i);
  assert.deepEqual([...lines].sort((x, y) => x - y), [...Array(20).keys()]);
  assert.deepEqual(await a.days(), ['2026-10-14']);
  assert.equal((await a.read('2026-10-14'))!.split('\n').filter(Boolean).length, 20);
  assert.equal(await a.read('2026-10-15'), null);
});
