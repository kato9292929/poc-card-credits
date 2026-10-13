# Nevermined 仕様の確認記録

確認日: 2026-10-13（作業開始時）。指示書の Nevermined の機能名は想定であり、以下で確認した実際の仕様を優先している。

## 確認した版

| 対象 | 版 | 確認方法 |
|---|---|---|
| TypeScript SDK `@nevermined-io/payments` | **1.13.0**（npm latest、2026-09-09 公開） | npm から取得した型定義 `dist/**/*.d.ts` と実装を直接読んだ。`package.json` でこの版に固定 |
| x402 クライアント `@x402/core` `@x402/fetch` `@x402/evm` `@x402/svm` | **2.28.0** | 同上。固定 |
| 公式ドキュメント | 2026-10-13 時点の公開版（版番号の表示なし） | 下記 URL |

SDK を上げるときは、この表と下の「使っている API」を見直すこと。

## 参照した公式ドキュメント

- 目次: https://nevermined.ai/docs/llms.txt
- TypeScript SDK（x402 / verify / settle）: https://nevermined.ai/docs/api-reference/typescript/x402.md
- TypeScript SDK（プラン）: https://nevermined.ai/docs/api-reference/typescript/payment-plans.md
- 買い手の流れ: https://nevermined.ai/docs/getting-started/ai-agent-purchase.md
- 法定通貨（カード）決済: https://nevermined.ai/docs/integrate/patterns/fiat-payments.md
- 料金モデル: https://nevermined.ai/docs/integrate/patterns/payment-models.md
- 自動トップアップ: https://nevermined.ai/docs/integrate/patterns/top-up.md
- リクエスト検証: https://nevermined.ai/docs/integrate/patterns/validate-requests.md
- カード登録: https://nevermined.ai/docs/products/payments/card-enrollment.md
- 委任（Delegations）: https://nevermined.ai/docs/products/payments/mandates.md
- FAQ: https://nevermined.ai/docs/products/payments/faq.md

## 指示書の想定と実際の仕様の対応

| 指示書の想定 | 実際（SDK 1.13.0） | 本リポジトリでの使用箇所 |
|---|---|---|
| プラン（利用枠）の作成 | `payments.agents.registerAgentAndPlan(agentMeta, agentApi, planMeta, priceConfig, creditsConfig, 'credits')`。価格は `plans.getFiatPriceConfig(amount, receiver)`、**金額は小数6桁単位**（$10 = `10_000_000n`、セントではない）。最低 $1（下回ると `BCK.PROTOCOL.0047`）。クレジットは `plans.getFixedCreditsConfig(1000n, 1n)` | `scripts/register-plan.ts` |
| カード決済 | `payments.plans.orderFiatPlan(planId)` が Stripe Checkout の URL（`result.checkoutLink`）を返す。決済後、Stripe の webhook でクレジットが付与される。Braintree のプランは SDK では買えない（App から） | `scripts/order-plan.ts` |
| 残高の確認 | `payments.plans.getPlanBalance(planId, holderAddress?)` → `{ balance: bigint, ... }` | `src/ledger/nevermined.ts` |
| 買い手のトークン | `payments.x402.getX402AccessToken(planId, agentId, { scheme, delegationConfig: { delegationId } })`。**`delegationConfig` は必須**（無いと SDK が例外）。カード払いのプランは `scheme: 'nvm:card-delegation'`、ネットワークは `stripe` | `scripts/buyer-token.ts` |
| トークンの受け渡し | リクエストヘッダ `payment-signature: <token>`。402 応答は `PAYMENT-REQUIRED` ヘッダ（base64 JSON） | `src/gateway/handler.ts` |
| 残高の検証 | `payments.facilitator.verifyPermissions({ paymentRequired, x402AccessToken, maxAmount })` → `{ isValid, invalidReason, payer, agentRequestId }`。クレジットは消費しない | `src/ledger/nevermined.ts` |
| 残高の消費 | `payments.facilitator.settlePermissions({ paymentRequired, x402AccessToken, maxAmount, agentRequestId })` → `{ success, creditsRedeemed, remainingBalance, transaction, billingModel? }`。**`billingModel` を見てから判定する**（`credits` なら `creditsRedeemed > 0`、`pay-as-you-go` なら都度課金） | 同上 |
| 残高不足エラー | 専用のエラーコードは文書化されていない。verify の `isValid=false` と `invalidReason`、validate-requests のページには `INSUFFICIENT_BALANCE` / `insufficient_credits` の例がある | ゲートウェイは自前で残高を確認して 402 `insufficient_credits` を返す |
| テスト環境 | `environment: 'sandbox'`（API キーの接頭辞 `sandbox:`）。API は `https://api.sandbox.nevermined.app/api/v1`。sandbox のカード決済は Stripe のテストカードで、実際の請求は発生しない | `.env.example` |

## 注意点（設計に影響したもの）

### 自動トップアップ

top-up のページによると、カード委任付きのトークンでクレジットが足りなくなると、settle 時に **ファシリテーターが登録カードに追加課金してクレジットを補充する**（「追加のパラメータは不要」で、無効化する設定は文書化されていない）。上限は委任の `spendingLimitCents` で、カードの上限（パイロット期間の既定 $10）の範囲内。

本 PoC の §4 は「残高が尽きたら停止して通知」が既定なので、ゲートウェイは次のように動く。

1. verify の後、`getPlanBalance` で残高を確認する。同じ支払元からの同時リクエストで処理中の分も差し引いて、足りなければ **settle を呼ばずに** 402 `insufficient_credits` を返す
2. settle の結果が `billingModel: 'pay-as-you-go'` だったら、想定外として失敗扱いにし、データは返さずログに残す

この防止は `BLOCK_CARD_TOPUP=true`（既定）のときだけ働く。この設定で §5 の「残高切れの挙動」として測れるのは、ゲートウェイが返す 402 であり、Nevermined 自身の挙動ではない。Nevermined の挙動を測る週は `BLOCK_CARD_TOPUP=false` にする。そうすると自動補充がログの `cardTopUpOrderTx` に残り、カード明細の件数（§5「経理上の扱い」）が週次レポートに出る。

あわせて、買い手の委任は `spendingLimitCents` を小さく（例 100 = $1）作ること。それでも残高確認と settle の間に別経路で消費されると、トップアップが走る可能性は残る。トップアップを無効にできるかは Nevermined に問い合わせ中とし、結果をここに追記する。

### 委任（delegation）の必要性

SDK 1.13.0 では、どのスキームでもトークン発行に `delegationConfig` が必須。プリペイドのクレジットだけを使う場合に委任なしでトークンを出す方法は、公式ドキュメントでは確認できなかった。したがって買い手（法人の担当者）は次の手順を踏む。

1. Nevermined App でカードを登録する
2. 小さい上限で委任を作る
3. Stripe Checkout でプランを購入する
4. トークンを発行する

指示書 §1 の「カードでプラン購入 → トークン」より手順が多い。§5「購入から利用開始までの時間」は、委任の作成からを含めて測る。委任の作成とトークンの発行の時刻は `scripts/buyer-token.ts` が `log/events.jsonl` に記録し、週次レポートに区間ごとに出る。

### SDK の資料と実装の差

- payment-models のページの `getFiatPriceConfig({ amount: 1000, currency: 'USD' })` は古い書式。1.13.0 の実装は `getFiatPriceConfig(amount: bigint, receiver, currency?)` で、金額は小数6桁単位。実装に合わせた
- `resolveScheme` は、`isCrypto === false` のプランを `nvm:card-delegation` と判定する（`dist/x402/facilitator-api.js`）

## 対応カードの範囲（§6 の確認事項）

| 項目 | 公式情報 | 出典 |
|---|---|---|
| ブランド | Visa / Mastercard / Amex / Discover（Visa・Stripe・Braintree 経由）。Stripe はクレジット・デビットとも対応 | FAQ |
| 国 | **記載なし**。Visa Agentic Token のパイロットは米国の発行会社が中心、という記述のみ | FAQ |
| 法人カード | **記載なし** | FAQ、card-enrollment |
| プリペイドカード・3DS | 記載なし | card-enrollment |
| 通貨 | USD / EUR | fiat-payments |
| 手数料 | Nevermined 2% ＋ Stripe の手数料（通貨・地域で変わる）。どちらも Stripe Connect への入金時に自動で差し引かれる | fiat-payments、FAQ |
| カード1枚あたりの上限 | 有効な委任の合計で既定 $10（パイロット期間）。引き上げは Nevermined に相談 | card-enrollment、mandates |

**結論（2026-10-13 時点）**: 法人カードと対応国は公式情報で確認できない。§6 に従い、Nevermined から法人カード（日本発行を含む）に対応しているという回答が得られるまでは、**本番の利用者を個人カードに限定する**。問い合わせの結果はこの表に追記する。

## 未確認・要問い合わせ

- [ ] 自動トップアップを無効にできるか
- [ ] 委任なしで、プリペイドのクレジットだけを使うトークンを発行できるか
- [ ] 対応国（日本発行カード）、法人カード
- [ ] sandbox の Stripe Checkout で使えるテストカード（Stripe 標準の `4242…` で動くか）
- [ ] カード決済の領収書・請求書の形式（Stripe のレシートか、Nevermined の発行か）
- [ ] エージェント登録の `endpoints` 許可リストで `:ticker` のようなパスパラメータが書けるか（現在は未登録）
