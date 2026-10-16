/**
 * 買い手のカード委任を用意する（追加指示 v2 §1）。
 * 有効な委任があれば再利用し、無ければ登録済みのカードから通貨 usd・上限 limitCents で作る。
 *
 * 再利用する条件（すべて満たすもの）:
 *   status が Active、provider が一致、currency が usd、期限切れでない、残りの予算がある、
 *   上限（spendingLimitCents）が limitCents 以下 … 上限 100¢ を超える既存の委任は使わない
 */
import type { Payments } from '@nevermined-io/payments';

export type CardProvider = 'stripe' | 'braintree' | 'visa';

export interface DelegationResult {
  delegationId: string;
  reused: boolean;
  /** 委任の作成時刻（ISO 8601）。新規なら作成直後の API の値、取れなければ作成を呼んだ時刻 */
  createdAt: string;
  spendingLimitCents: number;
  provider: CardProvider;
}

type DelegationApi = Pick<Payments['delegation'], 'listDelegations' | 'listPaymentMethods' | 'createDelegation'>;

export async function ensureDelegation(
  api: DelegationApi,
  opts: { provider: CardProvider; limitCents: number; durationSecs: number; now?: () => Date },
): Promise<DelegationResult> {
  const now = opts.now ?? (() => new Date());
  const list = await api.listDelegations({ accessible: true, provider: opts.provider });
  const usable = list.delegations
    .filter(
      (d) =>
        d.status === 'Active' &&
        d.provider === opts.provider &&
        String(d.currency).toLowerCase() === 'usd' &&
        Number(d.spendingLimitCents) <= opts.limitCents &&
        Number(d.remainingBudgetCents) > 0 &&
        Date.parse(d.expiresAt) > now().getTime(),
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (usable[0]) {
    const d = usable[0];
    return { delegationId: d.delegationId, reused: true, createdAt: d.createdAt, spendingLimitCents: Number(d.spendingLimitCents), provider: opts.provider };
  }

  const methods = await api.listPaymentMethods({ provider: opts.provider });
  const card = methods.find((m) => m.provider === opts.provider && (m.status ?? 'Active') === 'Active');
  if (!card) throw new Error(`買い手に ${opts.provider} のカードが登録されていない（Nevermined App でカードを登録する）`);
  const calledAt = now().toISOString();
  const r = await api.createDelegation({
    provider: opts.provider,
    providerPaymentMethodId: card.id,
    spendingLimitCents: opts.limitCents,
    durationSecs: opts.durationSecs,
    currency: 'usd',
  });
  const created = (await api.listDelegations()).delegations.find((d) => d.delegationId === r.delegationId);
  return {
    delegationId: r.delegationId,
    reused: false,
    createdAt: created?.createdAt ?? calledAt,
    spendingLimitCents: opts.limitCents,
    provider: opts.provider,
  };
}
