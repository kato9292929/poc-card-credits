import { x402Client, x402HTTPClient } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { base58 } from '@scure/base';
import { atomicToMicro, microToUsd, type MicroUsd } from '../money.ts';
import { findAsset, type AllowedAsset } from './assets.ts';
import type { UpstreamBuyer, UpstreamPurchase } from './types.ts';
import type { SpendGuard } from '../budget.ts';

type PaymentRequired = Awaited<ReturnType<x402HTTPClient['getPaymentRequiredResponse']>>;
type Requirement = PaymentRequired['accepts'][number];

export interface X402BuyerOptions {
  evmPrivateKey?: string;
  svmPrivateKey?: string;
  assets: AllowedAsset[];
  testnetOnly: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 既存の x402 エンドポイント（OSD / JIN）を、ゲートウェイ専用ウォレットで1コールずつ購入する。
 *
 * @x402/fetch の wrapFetchWithPayment は 402 を受けると自動で署名・支払いまで進むため使わない。
 * 代わりに「402 を受ける → 要求を自前で検査 → SpendGuard で予約 → 署名して再送」を明示的に行い、
 * 上限（1コール / 1日）・価格不一致・未許可資産のいずれかに当たれば署名せずに止める。
 */
export class X402UpstreamBuyer implements UpstreamBuyer {
  private constructor(
    private readonly client: x402Client,
    private readonly http: x402HTTPClient,
    private readonly networks: { evm: boolean; svm: boolean },
    private readonly opts: X402BuyerOptions,
    /** 支払いに使うウォレットのアドレス（/healthz で表示し、新規ウォレットであることを照合する） */
    readonly addresses: { evm?: string; svm?: string },
  ) {}

  static async create(opts: X402BuyerOptions & { maxPerCall: MicroUsd }): Promise<X402UpstreamBuyer> {
    const client = new x402Client();
    const networks = { evm: false, svm: false };
    const addresses: { evm?: string; svm?: string } = {};
    if (opts.evmPrivateKey) {
      const account = privateKeyToAccount(opts.evmPrivateKey as `0x${string}`);
      client.register('eip155:*', new ExactEvmScheme(account));
      networks.evm = true;
      addresses.evm = account.address;
    }
    if (opts.svmPrivateKey) {
      const signer = await createKeyPairSignerFromBytes(base58.decode(opts.svmPrivateKey));
      client.register('solana:*', new ExactSvmScheme(signer));
      networks.svm = true;
      addresses.svm = signer.address;
    }
    // 二重の安全装置：SDK 側の spend control にも同じ1コール上限を入れる。
    client.setSpendControls({ maxAmountPerPayment: `$${microToUsd(opts.maxPerCall)}` });
    return new X402UpstreamBuyer(client, new x402HTTPClient(client), networks, opts, addresses);
  }

  /** 自前で選んだ要求のうち、許可済み USDC・登録済みネットワーク・exact スキームのものだけを残す。 */
  private acceptable(reqs: Requirement[]): { req: Requirement; micro: MicroUsd }[] {
    const out: { req: Requirement; micro: MicroUsd }[] = [];
    for (const req of reqs) {
      if (req.scheme !== 'exact') continue;
      const isEvm = req.network.startsWith('eip155:');
      const isSvm = req.network.startsWith('solana:');
      if ((isEvm && !this.networks.evm) || (isSvm && !this.networks.svm) || (!isEvm && !isSvm)) continue;
      const asset = findAsset(this.opts.assets, req.network, req.asset);
      if (!asset) continue;
      if (this.opts.testnetOnly && !asset.testnet) continue;
      const amount = (req as { amount?: string }).amount;
      if (!amount) continue; // x402 v1（maxAmountRequired）は対象外
      out.push({ req, micro: atomicToMicro(amount, asset.decimals) });
    }
    return out.sort((a, b) => (a.micro < b.micro ? -1 : a.micro > b.micro ? 1 : 0));
  }

  async buy(args: { url: string; method: string; expectedPrice: MicroUsd; guard: SpendGuard }): Promise<UpstreamPurchase> {
    const f = this.opts.fetch ?? fetch;
    const started = Date.now();
    const base = { attemptedMicro: 0n, paidMicro: 0n } as const;
    const timeout = () => AbortSignal.timeout(this.opts.timeoutMs ?? 30_000);
    const done = async (res: Response, extra: Partial<UpstreamPurchase> = {}): Promise<UpstreamPurchase> => ({
      ...base,
      status: res.status,
      body: new Uint8Array(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? undefined,
      latencyMs: Date.now() - started,
      ...extra,
    });
    const fail = (status: number, error: string, extra: Partial<UpstreamPurchase> = {}): UpstreamPurchase => ({
      ...base,
      status,
      body: new Uint8Array(),
      latencyMs: Date.now() - started,
      error,
      ...extra,
    });

    let first: Response;
    try {
      first = await f(args.url, { method: args.method, signal: timeout() });
    } catch (e) {
      return fail(0, `upstream unreachable: ${(e as Error).message}`);
    }
    if (first.status !== 402) return done(first);

    let paymentRequired: PaymentRequired;
    try {
      const text = await first.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        /* ヘッダのみの 402 */
      }
      paymentRequired = this.http.getPaymentRequiredResponse((n) => first.headers.get(n), body);
    } catch (e) {
      return fail(402, `cannot parse upstream 402: ${(e as Error).message}`);
    }

    const candidates = this.acceptable(paymentRequired.accepts);
    if (candidates.length === 0) {
      return fail(402, 'no acceptable payment requirement (USDC on an allowed network)', { refused: 'no_acceptable_requirement' });
    }
    const chosen = candidates.find((c) => c.micro === args.expectedPrice);
    if (!chosen) {
      const offered = candidates.map((c) => `$${microToUsd(c.micro)}@${c.req.network}`).join(', ');
      return fail(402, `upstream price ${offered} != configured $${microToUsd(args.expectedPrice)}`, { refused: 'price_mismatch' });
    }

    const reserved = args.guard.reserve(chosen.micro);
    if (!reserved.ok) return fail(402, reserved.detail, { refused: reserved.reason });
    const reservation = reserved.reservation;

    let sent = false;
    try {
      const payload = await this.client.createPaymentPayload({ ...paymentRequired, accepts: [chosen.req] });
      const headers = new Headers(this.http.encodePaymentSignatureHeader(payload));
      sent = true; // ここから先は上流が決済した可能性があるので、日次上限に計上する
      const second = await f(args.url, { method: args.method, headers, signal: timeout() });
      let settled: { success: boolean; transaction?: string; network?: string; errorReason?: string } | undefined;
      try {
        settled = this.http.getPaymentSettleResponse((n) => second.headers.get(n));
      } catch {
        settled = undefined;
      }
      const paid = second.ok && settled?.success ? chosen.micro : 0n;
      return done(second, {
        attemptedMicro: chosen.micro,
        paidMicro: paid,
        network: chosen.req.network,
        tx: settled?.transaction || undefined,
        error: second.ok ? undefined : `upstream ${second.status} after payment${settled?.errorReason ? `: ${settled.errorReason}` : ''}`,
      });
    } catch (e) {
      return fail(0, `upstream payment failed: ${(e as Error).message}`, {
        attemptedMicro: sent ? chosen.micro : 0n,
        network: chosen.req.network,
      });
    } finally {
      if (sent) reservation.commit();
      else reservation.release();
    }
  }
}
