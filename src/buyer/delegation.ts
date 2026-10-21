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
  /** 委任に使ったカードの登録元。App で登録したカードは 'vgs'（VGS の金庫でトークン化、複数の決済事業者で使える） */
  cardProvider?: string;
}

type DelegationApi = Pick<Payments['delegation'], 'listDelegations' | 'listPaymentMethods' | 'createDelegation'>;

export async function ensureDelegation(
  api: DelegationApi,
  opts: { provider: CardProvider; limitCents: number; durationSecs: number; now?: () => Date },
): Promise<DelegationResult> {
  const now = opts.now ?? (() => new Date());
  // App で登録したカード（vgs）で作った委任も、同じ決済事業者で使えるので再利用の対象にする
  const list = await api.listDelegations({ accessible: true });
  const usable = list.delegations
    .filter(
      (d) =>
        d.status === 'Active' &&
        (d.provider === opts.provider || d.provider === 'vgs') &&
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

  // 決済事業者に直接登録したカードを優先する。無ければ、App の「Add payment method」で登録したカード
  // （provider: 'vgs'。"a card chargeable across payment providers"）を使う
  const active = (m: { status?: string }) => (m.status ?? 'Active') === 'Active';
  const card =
    (await api.listPaymentMethods({ provider: opts.provider })).find((m) => m.provider === opts.provider && active(m)) ??
    (await api.listPaymentMethods()).find((m) => m.provider === 'vgs' && m.type === 'card' && active(m));
  if (!card) throw new Error(`買い手に ${opts.provider} で使えるカードが登録されていない（Nevermined App の Buying → Payment Methods でカードを登録する）`);
  const calledAt = now().toISOString();
  // provider はカードを登録した経路に合わせる（vgs のカードに stripe を指定すると 400 "Requested provider does not match"）
  const r = await api.createDelegation({
    provider: card.provider as CardProvider,
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
    cardProvider: card.provider,
  };
}
