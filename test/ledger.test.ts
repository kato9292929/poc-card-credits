import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NeverminedLedger } from '../src/ledger/nevermined.ts';

test('402 requirement uses the card scheme (the SDK default would be nvm:erc4337)', () => {
  const ledger = new NeverminedLedger({ nvmApiKey: 'sandbox:eyJhbGciOiJIUzI1NiJ9.e30.x', environment: 'sandbox', planId: '111', agentId: 'A1' });
  const pr = ledger.paymentRequired('https://gw/jin/series', 'GET') as any;
  assert.deepEqual([pr.accepts[0].scheme, pr.accepts[0].network, pr.accepts[0].planId], ['nvm:card-delegation', 'stripe', '111']);
  assert.equal(pr.accepts[0].extra.agentId, 'A1');
});
