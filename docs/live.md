# 本番（Live）への移行手順

`docs/go-live.md` は「移行してよい条件」。このファイルは「移行の作業そのもの」と、その前に確かめる前提をまとめる。2026-10-29 に、Nevermined と Stripe の公開ドキュメント、SDK のソース（`@nevermined-io/payments` の `src/environments.ts`）で確かめた。ドキュメントに書かれていない点は「未確認」と明記する。

## 0. 先に確かめる前提（ここが通らなければ移行しない）

| # | 前提 | 分かっていること | 確かめ方 |
|---|---|---|---|
| A | x402 Inc. の Stripe アカウントが本番で有効 | 本人確認・口座登録が済んでいるかは、こちらからは見えない | Stripe ダッシュボード（本番モード）で：ホームに「アカウントを有効化」等の案内が出ていないこと。**設定 → 入金設定（Bank accounts and currencies）** <https://dashboard.stripe.com/settings/money-management> に日本の銀行口座が登録されていること。**入金** <https://dashboard.stripe.com/payouts> が開けること |
| B | 日本のアカウントで Nevermined の Stripe Connect が使えるか | Nevermined は請求を `on_behalf_of`（売り手の接続アカウントを加盟店にする）で作り、「売り手の国・通貨で精算し、通貨の換算は Stripe Connect が行う」と書いている（<https://nevermined.ai/docs/solutions/api-providers>）。一方、Stripe の国をまたぐ入金のページは、自分で設定できる国をまたぐ入金を米国・英国・EEA・カナダ・スイスの間に限っている（<https://docs.stripe.com/connect/cross-border-payouts>）。Nevermined のプラットフォームがどの国か、日本の売り手に対応しているかは**ドキュメントに無い（未確認）** | ① Nevermined App（本番）の **Settings → Stripe Connect** で接続を始め、日本を選べるか、途中で国の制限で止まらないかを見る。② 止まったら Nevermined のサポートに「日本法人の売り手が fiat プランを本番で売れるか」を問い合わせる |
| C | 接続したアカウントが Nevermined とつながっている | — | Stripe ダッシュボード **設定 → 承認済みアプリケーション（Authorized applications）** に Nevermined が出ていること |
| D | 本番でカード払いが通る範囲 | Nevermined の fiat の請求は USD / EUR。カード登録の上限はパイロット中 $10 / 枚（<https://nevermined.ai/docs/products/payments/card-enrollment.md>）。Visa のエージェント向け経路は米国の発行会社が中心 | 本番で1回、自分のカードで購入画面から買う（下の 5） |

B が通らない場合、カードの入口は本番に移せない。そのときは実証2のカード側の外部の利用を「0（本番未移行のため）」として扱う（実証2の `docs/launch.md`）。

## 1. 本番の API キー

- Nevermined App（<https://nevermined.app>。Sandbox と同じ URL で、環境を切り替えて使う）の **Settings → Global NVM API Keys** で、環境に live を選んでキーを作る。接頭辞は `live:`。
- 売り手用（`NVM_API_KEY_SELLER`）と買い手用（`NVM_API_KEY_BUYER`）を別に作る。`sandbox:` のキーは本番では使えない（違う環境のキーは 4xx になる）。
- API は `https://api.live.nevermined.app/`（SDK に `environment: 'live'` を渡せば自動で切り替わる）。

## 2. Stripe Connect の接続（本番）

- Nevermined App（本番）の **Settings → Stripe Connect** で、x402 Inc. の Stripe アカウントを接続する（Stripe のアカウントが無ければ、流れの中で作られる）。
- 手数料は Nevermined 2% ＋ Stripe の決済手数料。入金の前に自動で差し引かれる。入金は Stripe の通常の入金サイクル。
- 接続アカウントを後から替えると、未入金の分は前のアカウントに入る。

## 3. プランの作り直し

本番は Sandbox と別の環境なので、プランとエージェントは作り直す（Sandbox の ID は本番では使えない、と考える。ドキュメントには明記が無い）。設定は Sandbox と同じにする。

- $1 で 100 クレジット、有効 30 日、1 リクエスト 1 クレジット（`config/plans.json` の `prepaid-100`）
- カード払い（`nvm:card-delegation`）、自動補充あり
- エンドポイントは `/api/jin/series` と `/api/alpha/jp/catalysts`

```sh
NVM_ENVIRONMENT=live ALLOW_LIVE=true npm run plan:register
```

出てきたプラン ID とエージェント ID を控える。購入 URL は `https://nevermined.app/checkout/plan/<プラン ID>`。

## 4. ゲートウェイの環境変数の切り替え（Vercel）

`docs/go-live.md` の手順に加えて、次のとおりにする。

| 変数 | 本番での値 |
|---|---|
| `NVM_ENVIRONMENT` | `live` |
| `ALLOW_LIVE` | `true` |
| `NVM_API_KEY_SELLER` / `NVM_API_KEY_BUYER` | 1 で作った `live:` のキー |
| `NVM_PLAN_ID` / `NVM_AGENT_ID` | 3 で作った ID |
| `UPSTREAM_MAINNET_PURCHASE` | **消す**（Sandbox 専用。live では起動を拒否する） |
| `NVM_PLAN_ID_PAYG` | 設定しない |
| ゲートウェイのウォレット | `docs/go-live.md` のとおり新しく作る（`docs/wallet.md` に追記） |
| `BUYER_CRON_IN_LIVE` | 設定しない（下の 6） |

変えたら Redeploy する（Vercel の環境変数は新しいデプロイにだけ効く）。

## 5. 本番での動作確認（1回だけ）

1. 購入画面 `https://nevermined.app/checkout/plan/<プラン ID>` で、**カード番号を直接入れて**買う。保存済みカードを選ぶ経路は Sandbox で通らなかった（docs/nevermined.md）ので使わない
2. 買い手のトークンでゲートウェイの `/api/jin/series` を1回呼び、200 が返ること、ゲートウェイのログに `outcome: ok` の行が1つ増えることを確かめる
3. Stripe ダッシュボード（本番）の **支払い** に $1 の取引が出ること、Nevermined の手数料（2%）が差し引かれていることを確かめる
4. 実証2に、プラン ID・購入 URL・移行した日付を伝える（実証2の `config/site.json` の `card.nvm_plan_id` に入り、販売ページのカードの「準備中」が外れる）

## 6. 買い手エージェントの定期購入は止める

本番では、買い手エージェントの定期購入が自社のカードに実費で請求される。`/cron/buyer` は `NVM_ENVIRONMENT=live` のとき何もしない（`{ "skipped": "live_environment" }` を返す。`src/buyer/cron.ts` の `buyerCronAllowed`）。本番での動作確認は 5 の手順で手で1回だけ行う。どうしても定期で動かすときだけ `BUYER_CRON_IN_LIVE=true` を入れる。

## 参照

- Nevermined の環境（SDK）：<https://raw.githubusercontent.com/nevermined-io/payments/main/src/environments.ts>
- API キー：<https://nevermined.ai/docs/agents-guide/get-api-key.md>
- Stripe Connect の接続・手数料：<https://nevermined.ai/docs/products/payments/faq.md>、<https://nevermined.ai/docs/integrate/patterns/fiat-payments.md>
- 国をまたぐ入金：<https://docs.stripe.com/connect/cross-border-payouts>
- 制限付きキー：<https://docs.stripe.com/keys/restricted-api-keys.md>
