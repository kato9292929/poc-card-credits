import { get, put } from '@vercel/blob';

/** 買い手エージェントの停止状態。Vercel Cron の各回は別プロセスなので、Blob に置いて共有する。 */
export interface BuyerState {
  stopped: boolean;
  since?: string;
  errorKind?: string;
  status?: number;
}

export interface StateStore {
  get(): Promise<BuyerState | null>;
  set(s: BuyerState): Promise<void>;
}

export const STATE_PATH = 'state/buyer.json';

/** 状態は上書きする（ログではないので追記のみの制約は無い）。private。 */
export class BlobStateStore implements StateStore {
  constructor(private readonly token: string) {}
  async get(): Promise<BuyerState | null> {
    const r = await get(STATE_PATH, { access: 'private', useCache: false, token: this.token });
    if (!r || r.statusCode !== 200) return null;
    return JSON.parse(await new Response(r.stream).text()) as BuyerState;
  }
  async set(s: BuyerState): Promise<void> {
    await put(STATE_PATH, JSON.stringify(s), { access: 'private', token: this.token, contentType: 'application/json', addRandomSuffix: false, allowOverwrite: true });
  }
}

export class MemoryStateStore implements StateStore {
  constructor(public value: BuyerState | null = null) {}
  async get() {
    return this.value;
  }
  async set(s: BuyerState) {
    this.value = s;
  }
}
