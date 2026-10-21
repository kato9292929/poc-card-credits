import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureDelegation } from '../src/buyer/delegation.ts';
import { delegationLimitCents, HARD_MAX_DELEGATION_CENTS } from '../src/config.ts';

const NOW = new Date('2026-10-16T00:00:00Z');
const d = (patch: Record<string, unknown>) => ({
  delegationId: 'existing-1',
  provider: 'stripe',
  providerPaymentMethodId: 'pm_1',
  status: 'Active',
  spendingLimitCents: '100',
  amountSpentCents: '0',
  remainingBudgetCents: '100',
  currency: 'usd',
  transactionCount: 0,
  expiresAt: '2026-11-01T00:00:00Z',
  createdAt: '2026-10-10T00:00:00Z',
  apiKeyId: null,
  ...patch,
});

function fakeApi(delegations: any[], methods: any[] = [{ id: 'pm_1', provider: 'stripe', status: 'Active', type: 'card', brand: 'visa', last4: '4242' }]) {
  const created: any[] = [];
  return {
    created,
    api: {
      async listDelegations() {
        return { delegations: [...delegations, ...created.map((c) => d({ delegationId: c.id, spendingLimitCents: String(c.spendingLimitCents), createdAt: '2026-10-16T00:00:01Z' }))], totalResults: 0, page: 1 };
      },
      async listPaymentMethods(f?: { provider?: string }) {
        return methods.filter((m) => !f?.provider || m.provider === f.provider);
      },
      async createDelegation(p: any) {
        created.push({ id: 'new-1', ...p });
        return { delegationId: 'new-1' };
      },
    } as any,
  };
}

const opts = { provider: 'stripe' as const, limitCents: 100, durationSecs: 86_400, now: () => NOW };

test('reuses an active usd delegation within the 100¢ cap', async () => {
  const { api, created } = fakeApi([d({})]);
  const r = await ensureDelegation(api, opts);
  assert.equal(r.reused, true);
  assert.equal(r.delegationId, 'existing-1');
  assert.equal(r.createdAt, '2026-10-10T00:00:00Z');
  assert.equal(created.length, 0);
});

test('does not reuse delegations over the cap, expired, exhausted or non-usd; creates a new one at 100¢ usd', async () => {
  const { api, created } = fakeApi([
    d({ delegationId: 'too-big', spendingLimitCents: '1000' }),
    d({ delegationId: 'expired', expiresAt: '2026-10-01T00:00:00Z' }),
    d({ delegationId: 'spent', remainingBudgetCents: '0' }),
    d({ delegationId: 'eur', currency: 'eur' }),
    d({ delegationId: 'revoked', status: 'Revoked' }),
  ]);
  const r = await ensureDelegation(api, opts);
  assert.equal(r.reused, false);
  assert.equal(r.delegationId, 'new-1');
  assert.equal(created[0].spendingLimitCents, 100);
  assert.equal(created[0].currency, 'usd');
  assert.equal(created[0].providerPaymentMethodId, 'pm_1');
  assert.equal(r.createdAt, '2026-10-16T00:00:01Z');
});

test('delegation cap is 100¢ and can only be lowered (not below the $0.50 minimum)', () => {
  const run = (v?: string) => {
    const saved = process.env.BUYER_DELEGATION_LIMIT_CENTS;
    if (v === undefined) delete process.env.BUYER_DELEGATION_LIMIT_CENTS;
    else process.env.BUYER_DELEGATION_LIMIT_CENTS = v;
    try {
      return delegationLimitCents();
    } finally {
      if (saved === undefined) delete process.env.BUYER_DELEGATION_LIMIT_CENTS;
      else process.env.BUYER_DELEGATION_LIMIT_CENTS = saved;
    }
  };
  assert.equal(HARD_MAX_DELEGATION_CENTS, 100);
  assert.equal(run(), 100);
  assert.equal(run('60'), 60);
  assert.throws(() => run('101'), /hard cap/);
  assert.throws(() => run('10'), /minimum/);
});

test('falls back to a card enrolled in the App (provider vgs) when no stripe card exists', async () => {
  const { api, created } = fakeApi([], [
    { id: '0xdF89', provider: 'erc4337', status: 'Active', type: 'crypto_wallet', brand: 'ethereum', last4: 'Cc11' },
    { id: 'vgs_tok_1', provider: 'vgs', status: 'Active', type: 'card', brand: 'visa', last4: '1387' },
  ]);
  const r = await ensureDelegation(api, opts);
  assert.equal(created[0].providerPaymentMethodId, 'vgs_tok_1');
  assert.equal(created[0].provider, 'stripe');
  assert.equal(r.cardProvider, 'vgs');
});

test('no usable card: clear error', async () => {
  const { api } = fakeApi([], [{ id: '0xdF89', provider: 'erc4337', status: 'Active', type: 'crypto_wallet', brand: 'ethereum', last4: 'Cc11' }]);
  await assert.rejects(ensureDelegation(api, opts), /使えるカードが登録されていない/);
});
