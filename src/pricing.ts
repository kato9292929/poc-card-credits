import { readFileSync } from 'node:fs';
// 静的 import にして、Vercel の関数に設定ファイルが含まれるようにする（実行時の readFileSync だけでは含まれない）
import pricingJson from '../config/pricing.json' with { type: 'json' };
import { usdToMicro, type MicroUsd } from './money.ts';

export interface RouteConfig {
  id: string;
  method: string;
  /** ゲートウェイの公開パス（OSD / JIN の公開パスと同じ形）。`:name` はパスパラメータ。 */
  path: string;
  upstream: string;
  upstreamPath: string;
  priceUsd: string;
  credits: number;
}

export interface Route extends RouteConfig {
  price: MicroUsd;
  pattern: RegExp;
  paramNames: string[];
}

export interface Pricing {
  creditUnit: MicroUsd;
  routes: Route[];
}

function compile(path: string): { pattern: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const src = path
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { pattern: new RegExp(`^${src}/?$`), paramNames };
}

export function parsePricing(raw: unknown): Pricing {
  const obj = raw as { creditUnitUsd?: string; routes?: RouteConfig[] };
  if (!obj?.creditUnitUsd || !Array.isArray(obj.routes)) throw new Error('pricing: creditUnitUsd and routes are required');
  const creditUnit = usdToMicro(obj.creditUnitUsd);
  if (creditUnit <= 0n) throw new Error('pricing: creditUnitUsd must be > 0');
  const ids = new Set<string>();
  const routes = obj.routes.map((r) => {
    for (const k of ['id', 'method', 'path', 'upstream', 'upstreamPath', 'priceUsd'] as const) {
      if (typeof r[k] !== 'string' || !r[k]) throw new Error(`pricing: route missing ${k}: ${JSON.stringify(r)}`);
    }
    if (ids.has(r.id)) throw new Error(`pricing: duplicate route id ${r.id}`);
    ids.add(r.id);
    const price = usdToMicro(r.priceUsd);
    // クレジット消費量は裏で払う x402 の価格に合わせる（§2）。割り切れない価格は設定ミスとして拒否。
    if (price % creditUnit !== 0n) throw new Error(`pricing: ${r.id} price ${r.priceUsd} is not a multiple of the credit unit`);
    const expected = Number(price / creditUnit);
    if (!Number.isInteger(r.credits) || r.credits !== expected) {
      throw new Error(`pricing: ${r.id} credits=${r.credits} but price ${r.priceUsd} implies ${expected}`);
    }
    if (r.credits <= 0) throw new Error(`pricing: ${r.id} credits must be > 0`);
    return { ...r, method: r.method.toUpperCase(), price, ...compile(r.path) };
  });
  return { creditUnit, routes };
}

export function loadPricing(file?: string): Pricing {
  return parsePricing(file ? JSON.parse(readFileSync(file, 'utf8')) : pricingJson);
}

export interface MatchedRoute {
  route: Route;
  params: Record<string, string>;
  /** 上流に投げるパス（パラメータ展開済み、URL エンコード済み）。 */
  upstreamPath: string;
}

export function matchRoute(pricing: Pricing, method: string, path: string): MatchedRoute | undefined {
  for (const route of pricing.routes) {
    if (route.method !== method.toUpperCase()) continue;
    const m = route.pattern.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
    const upstreamPath = route.upstreamPath.replace(/:([A-Za-z0-9_]+)/g, (_, n: string) => {
      if (!(n in params)) throw new Error(`pricing: ${route.id} upstreamPath uses unknown param :${n}`);
      return encodeURIComponent(params[n]);
    });
    return { route, params, upstreamPath };
  }
  return undefined;
}

/** どのルートも1コール上限を超えないこと（起動時に検証。超えるルートがあれば起動しない）。 */
export function assertRoutesWithinCap(pricing: Pricing, maxPerCall: bigint): void {
  const over = pricing.routes.filter((r) => r.price > maxPerCall);
  if (over.length) {
    throw new Error(`pricing: routes exceed the per-call cap: ${over.map((r) => `${r.id}=$${r.priceUsd}`).join(', ')}`);
  }
}

/**
 * エージェント登録の endpoints（Nevermined の URL 許可リスト）を作る（追加指示 v2 §2）。
 * - pattern: ルートのパスをそのまま（パラメータは :name のまま）
 * - expanded: パラメータ付きのルートは、買い手エージェントが呼ぶ実パスに展開する
 */
export function agentEndpoints(pricing: Pricing, baseUrl: string, buyerPaths: string[]) {
  const base = baseUrl.replace(/\/$/, '');
  return {
    pattern: pricing.routes.map((r) => ({ [r.method]: `${base}${r.path}` })),
    expanded: pricing.routes.flatMap((r) =>
      r.paramNames.length === 0
        ? [{ [r.method]: `${base}${r.path}` }]
        : buyerPaths.filter((p) => r.pattern.test(p)).map((p) => ({ [r.method]: `${base}${p}` })),
    ),
  };
}
