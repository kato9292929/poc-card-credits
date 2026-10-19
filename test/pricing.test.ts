import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentEndpoints, assertRoutesWithinCap, loadPricing, matchRoute, parsePricing } from '../src/pricing.ts';
import { HARD_MAX_PER_CALL } from '../src/config.ts';

test('config/pricing.json is valid and credits match x402 price', () => {
  const p = loadPricing();
  const series = p.routes.find((r) => r.id === 'jin.series')!;
  assert.equal(series.credits, 1);
  // プランは 1 リクエスト 1 クレジット固定なので、すべてのルートが 1 クレジット
  assert.ok(p.routes.every((r) => r.credits === 1));
});

// パラメータ付きのルートの扱いは、テスト用の価格表で確かめる（本番の pricing.json には今パラメータ付きのルートが無い）
const PARAM_PRICING = parsePricing({
  creditUnitUsd: '0.01',
  routes: [
    { id: 'jin.series', method: 'GET', path: '/api/jin/series', upstream: 'jin', upstreamPath: '/api/jin/series', priceUsd: '0.01', credits: 1 },
    { id: 'osd.t', method: 'GET', path: '/osd/catalysts/:ticker', upstream: 'osd', upstreamPath: '/api/catalyst/:ticker', priceUsd: '0.01', credits: 1 },
  ],
});

test('route matching with params', () => {
  const m = matchRoute(PARAM_PRICING, 'GET', '/osd/catalysts/7203.T');
  assert.equal(m?.route.id, 'osd.t');
  assert.equal(m?.params.ticker, '7203.T');
  assert.equal(m?.upstreamPath, '/api/catalyst/7203.T');
  assert.equal(matchRoute(PARAM_PRICING, 'POST', '/api/jin/series'), undefined);
  assert.equal(matchRoute(loadPricing(), 'GET', '/api/alpha/jp/catalysts')?.route.id, 'osd.jp.catalysts');
  assert.equal(matchRoute(loadPricing(), 'GET', '/api/jin/unknown'), undefined);
});

test('rejects credits that do not match the price', () => {
  const route = { id: 'x', method: 'GET', path: '/x', upstream: 'jin', upstreamPath: '/x', priceUsd: '0.02', credits: 1 };
  assert.throws(() => parsePricing({ creditUnitUsd: '0.01', routes: [route] }), /implies 2/);
  assert.throws(() => parsePricing({ creditUnitUsd: '0.01', routes: [{ ...route, priceUsd: '0.015', credits: 1 }] }), /multiple/);
});

test('a route priced above the per-call cap prevents startup', () => {
  assert.doesNotThrow(() => assertRoutesWithinCap(loadPricing(), HARD_MAX_PER_CALL));
  const p = parsePricing({
    creditUnitUsd: '0.01',
    routes: [{ id: 'big', method: 'GET', path: '/big', upstream: 'jin', upstreamPath: '/big', priceUsd: '0.06', credits: 6 }],
  });
  assert.throws(() => assertRoutesWithinCap(p, HARD_MAX_PER_CALL), /big=\$0.06/);
});

test('agent endpoints: pattern form keeps :ticker, expanded form lists the buyer paths', () => {
  const { pattern, expanded } = agentEndpoints(PARAM_PRICING, 'https://gw.example/', ['/osd/catalysts/AAPL', '/osd/catalysts/7203.T', '/nope']);
  assert.deepEqual(pattern, [{ GET: 'https://gw.example/api/jin/series' }, { GET: 'https://gw.example/osd/catalysts/:ticker' }]);
  assert.deepEqual(expanded, [
    { GET: 'https://gw.example/api/jin/series' },
    { GET: 'https://gw.example/osd/catalysts/AAPL' },
    { GET: 'https://gw.example/osd/catalysts/7203.T' },
  ]);
  // 本番の価格表はパラメータ付きのルートが無いので、2つの形は同じになる
  const real = agentEndpoints(loadPricing(), 'https://gw.example', []);
  assert.deepEqual(real.pattern, real.expanded);
});
