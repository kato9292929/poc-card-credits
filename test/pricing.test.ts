import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentEndpoints, assertRoutesWithinCap, loadPricing, matchRoute, parsePricing } from '../src/pricing.ts';
import { HARD_MAX_PER_CALL } from '../src/config.ts';

test('config/pricing.json is valid and credits match x402 price', () => {
  const p = loadPricing();
  const series = p.routes.find((r) => r.id === 'jin.series')!;
  const movers = p.routes.find((r) => r.id === 'jin.movers')!;
  assert.equal(series.credits, 1);
  assert.equal(movers.credits, 2);
});

test('route matching with params', () => {
  const p = loadPricing();
  const m = matchRoute(p, 'GET', '/osd/catalysts/7203.T');
  assert.equal(m?.route.id, 'osd.catalysts');
  assert.equal(m?.params.ticker, '7203.T');
  assert.equal(m?.upstreamPath, '/osd/catalysts/7203.T');
  assert.equal(matchRoute(p, 'POST', '/jin/series'), undefined);
  assert.equal(matchRoute(p, 'GET', '/jin/unknown'), undefined);
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
  const { pattern, expanded } = agentEndpoints(loadPricing(), 'https://gw.example/', ['/osd/catalysts/AAPL', '/osd/catalysts/7203.T', '/nope']);
  assert.deepEqual(pattern, [
    { GET: 'https://gw.example/jin/series' },
    { GET: 'https://gw.example/jin/movers' },
    { GET: 'https://gw.example/osd/catalysts/:ticker' },
  ]);
  assert.deepEqual(expanded, [
    { GET: 'https://gw.example/jin/series' },
    { GET: 'https://gw.example/jin/movers' },
    { GET: 'https://gw.example/osd/catalysts/AAPL' },
    { GET: 'https://gw.example/osd/catalysts/7203.T' },
  ]);
});
