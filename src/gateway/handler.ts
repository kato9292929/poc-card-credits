import { matchRoute, type Pricing } from '../pricing.ts';
import { anonymize, type JsonlLog, type RequestLogEntry } from '../log.ts';
import type { SpendGuard } from '../budget.ts';
import type { CreditLedger } from '../ledger/types.ts';
import type { UpstreamBuyer } from '../upstream/types.ts';

export interface GatewayRequest {
  method: string;
  path: string;
  /** "?a=b" を含む生のクエリ文字列（無ければ空文字） */
  search: string;
  header(name: string): string | undefined;
}

export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array | string;
}

export interface GatewayDeps {
  pricing: Pricing;
  ledger: CreditLedger;
  upstream: UpstreamBuyer;
  guard: SpendGuard;
  log: Pick<JsonlLog, 'append'>;
  upstreams: Record<string, string>;
  publicBaseUrl: string;
  logSalt: string;
  now?: () => number;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const json = (status: number, body: unknown, headers: Record<string, string> = {}): GatewayResponse => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

/**
 * 1リクエストの処理（指示書 §3 の順序）。
 *   1. 買い手トークンを Nevermined で検証し、残高を確認する
 *   2. 裏側の x402 エンドポイントを購入する（上限は SpendGuard が強制）
 *   3. 200 が返ったら Nevermined で利用枠を消費し、データを返す
 *   4. 裏側の購入が失敗したら、利用枠は消費しない
 */
export function createHandler(deps: GatewayDeps) {
  const now = deps.now ?? Date.now;
  // 支払元ごとの「検証済み・未消費」クレジット。同時リクエストで残高を超えて消費すると
  // Nevermined の自動トップアップ（カードへの追加課金）が走るため、それを防ぐ。
  const inFlight = new Map<string, number>();

  return async function handle(req: GatewayRequest): Promise<GatewayResponse> {
    const started = now();
    const entry: RequestLogEntry = {
      ts: new Date(started).toISOString(),
      method: req.method,
      path: req.path,
      outcome: 'ok',
      status: 200,
      creditsConsumed: 0,
      upstreamCostMicro: '0',
      latencyMs: 0,
    };
    const finish = (res: GatewayResponse, patch: Partial<RequestLogEntry>): GatewayResponse => {
      Object.assign(entry, patch, { status: res.status, latencyMs: now() - started });
      deps.log.append(entry);
      return res;
    };

    const matched = matchRoute(deps.pricing, req.method, req.path);
    if (!matched) return finish(json(404, { error: 'not_found' }), { outcome: 'no_route' });
    const { route } = matched;
    entry.routeId = route.id;
    const endpoint = `${deps.publicBaseUrl}${route.path}`;
    const paymentRequiredHeader = () => ({ 'payment-required': b64(deps.ledger.paymentRequired(endpoint, route.method)) });

    const token = req.header('payment-signature');
    if (!token) {
      return finish(json(402, { error: 'payment_required', credits: route.credits }, paymentRequiredHeader()), { outcome: 'no_token' });
    }
    entry.tokenId = anonymize(token, deps.logSalt);

    // 1. 検証
    const v = await deps.ledger.verify({ token, endpoint, method: route.method, credits: route.credits });
    if (!v.ok) {
      const insufficient = /insufficient|balance/i.test(v.reason);
      return finish(
        json(402, { error: insufficient ? 'insufficient_credits' : 'token_invalid', reason: v.reason }, paymentRequiredHeader()),
        { outcome: insufficient ? 'insufficient_credits' : 'token_invalid', error: v.reason },
      );
    }
    entry.payerId = anonymize(v.payer, deps.logSalt);

    const pending = inFlight.get(v.payer) ?? 0;
    inFlight.set(v.payer, pending + route.credits);
    try {
      let balance: bigint;
      try {
        balance = await deps.ledger.balance(v.payer);
      } catch (e) {
        return finish(json(502, { error: 'balance_unavailable' }), { outcome: 'ledger_error', error: (e as Error).message });
      }
      entry.remainingCredits = balance.toString();
      if (balance < BigInt(pending + route.credits)) {
        return finish(
          json(402, { error: 'insufficient_credits', balance: balance.toString(), required: route.credits }, paymentRequiredHeader()),
          { outcome: 'insufficient_credits' },
        );
      }

      // 2. 裏側の購入
      const base = deps.upstreams[route.upstream];
      if (!base) throw new Error(`no base URL for upstream ${route.upstream}`);
      const url = `${base.replace(/\/$/, '')}${matched.upstreamPath}${req.search}`;
      const up = await deps.upstream.buy({ url, method: route.method, expectedPrice: route.price, guard: deps.guard });
      Object.assign(entry, {
        upstreamCostMicro: up.paidMicro.toString(),
        upstreamAttemptMicro: up.attemptedMicro.toString(),
        upstreamNetwork: up.network,
        upstreamTx: up.tx,
        upstreamStatus: up.status,
        upstreamLatencyMs: up.latencyMs,
      });

      if (up.refused === 'per_call_cap' || up.refused === 'daily_cap') {
        // 4. 失敗時は消費しない
        return finish(json(503, { error: 'gateway_spend_cap', reason: up.error }, { 'retry-after': '3600' }), {
          outcome: 'gateway_cap_exceeded',
          error: up.error,
        });
      }
      if (up.status !== 200) {
        return finish(json(502, { error: 'upstream_failed', upstreamStatus: up.status, reason: up.error }), {
          outcome: 'upstream_failed',
          error: up.error ?? `upstream status ${up.status}`,
        });
      }

      // 3. 利用枠の消費
      const s = await deps.ledger.settle({
        token,
        endpoint,
        method: route.method,
        credits: route.credits,
        agentRequestId: v.agentRequestId,
      });
      if (!s.ok) {
        // 裏側は支払い済みだが消費できなかった。データは返さず、原価を未回収として記録する。
        return finish(json(502, { error: 'settle_failed', reason: s.error }), { outcome: 'settle_failed', error: s.error });
      }
      return finish(
        {
          status: 200,
          headers: {
            'content-type': up.contentType ?? 'application/json',
            'x-credits-consumed': String(s.creditsRedeemed),
            ...(s.remaining !== undefined ? { 'x-credits-remaining': s.remaining } : {}),
          },
          body: up.body,
        },
        { outcome: 'ok', creditsConsumed: s.creditsRedeemed, nvmSettleTx: s.tx, remainingCredits: s.remaining },
      );
    } finally {
      const left = (inFlight.get(v.payer) ?? route.credits) - route.credits;
      if (left > 0) inFlight.set(v.payer, left);
      else inFlight.delete(v.payer);
    }
  };
}
