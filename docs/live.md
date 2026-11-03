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

## 1〜5. 移行の手順（2026-11-01 版）

前提 A〜C は済んでいる（Stripe の本人確認は提出済み、Nevermined の Live に x402 Inc. の Stripe（日本、Standard）を個人（User Profile）側で接続済み）。Stripe の一時停止が解けていなければ、7 の購入で請求が失敗する。

決めたこと：

- **プランは個人の下に作る**。SDK でプランを作ると、キーの持ち主の下に入る（Sandbox で作ったプランは `orgId: null`＝個人）。本番の売り手キーを Organization ではなく **Personal** で作れば、個人側の Stripe Connect がそのまま使われ、Organization 側の接続は要らない。作った後に `orgId` を確かめる
- **ゲートウェイのウォレットは今のものを使い続ける**（`3HG2HYh5EyGR5BnL5UaHeNkz2qA1tdwFizSbGKmkrcgV`）。Sandbox の間も上流は Solana mainnet の USDC で買っていて、このウォレットは本実証専用なので、作り直す理由が無い
- **自動補充あり**：本番でも `BLOCK_CARD_TOPUP=false`。残高が尽きると、買い手が委任したカードに $1（委任の上限 100¢ の範囲）が自動で請求される
- **受取アドレス**（`NVM_RECEIVER_ADDRESS`）は入れない。売り手キーの持ち主のアドレスになる（Sandbox で App のプランと同じアドレスになることを確かめた）

| # | 誰 | どこで | やること |
|---|---|---|---|
| 1 | 本人 | Nevermined App を **Live** にして、**売り手**アカウント（hello@x402jp.com）→ Account → API Keys | キーを作る。Organization は **Personal**。Vercel の `NVM_API_KEY_SELLER` をこの値に**差し替える** |
| 2 | 本人 | Nevermined App（Live）、**買い手**アカウント（you.betsu.kato.m@…）→ Buying → Payment Methods | 自分のカードを登録する（本物のカード。委任に使う） |
| 3 | 本人 | 同じ買い手アカウント → API Keys | キーを作る（Personal）。Vercel の `NVM_API_KEY_BUYER` をこの値に差し替える |
| 4 | 本人 | Vercel → Environment Variables（Production） | 次を足す：`NVM_ENVIRONMENT=live`、`ALLOW_LIVE=true`、`UPSTREAM_TESTNET_ONLY=false`、`BLOCK_CARD_TOPUP=false`、`PUBLIC_BASE_URL=https://poc-card-credits.vercel.app`、`UPSTREAM_JIN_URL=https://jin.x402jp.com`、`UPSTREAM_OSD_URL=https://osd.x402jp.com`。ほか（`GATEWAY_WALLET_SECRET`・`LOG_SALT`・`LOG_READ_TOKEN`・`CRON_SECRET`・`BLOB_STORE_ID`）はそのまま。**Redeploy** |
| 5 | CC | `POST /setup/plan`（Bearer `CRON_SECRET`） | 4 の後、ゲートウェイはプラン ID が無いので未設定の状態で起動する。この状態でプラン（$1・100・30 日・1 回 1 クレジット）とエージェントを作り、ID を返す。2 回呼んでも作り直さない（Blob の `state/plan-live.json`）。`orgId` と中身を照合する |
| 6 | 本人 | Vercel → Environment Variables | CC が示す `NVM_PLAN_ID`・`NVM_AGENT_ID` を入れて **Redeploy**（秘密ではない） |
| 7 | 本人 | 購入ページ `https://nevermined.app/checkout/plan/<プラン ID>`（買い手アカウント、Live） | **カード番号を直接入れて** 1 回だけ買う（$1 の実費）。支払った時刻を CC に伝える。失敗したら、その画面とエラーをそのまま CC に渡す |
| 8 | CC | `GET /buyer/balance`、`POST /buyer/once?path=/api/jin/series` | 100 クレジットが付いたこと、ゲートウェイ経由で JIN series を 1 回買えること（ゲートウェイのログに `outcome: ok`、`nvmEnvironment: live`）を確かめ、sandbox-log に記録する |
| 9 | CC → 実証2 | — | プラン ID・購入 URL・移行日を渡す。7・8 の自社の購入は `payerId` で自社に分類する |

4 で Vercel を切り替えた時点で、Sandbox での運用（定期購入・自動補充）は止まる。同じデプロイを本番に切り替えるためで、Sandbox の数字はその日で終わる。ゲートウェイのログの各行には `nvmEnvironment`（sandbox / live）が入るので、実証2 は移行日の前後をこれで分けられる。

## 6. 買い手エージェントの定期購入は止める

本番では、買い手エージェントの定期購入が自社のカードに実費で請求される。`/cron/buyer` は `NVM_ENVIRONMENT=live` のとき何もしない（`{ "skipped": "live_environment" }` を返す。`src/buyer/cron.ts` の `buyerCronAllowed`）。本番での動作確認は、上の 8 のとおり `POST /buyer/once` で手で 1 回だけ行う（停止状態や 1 日の回数に関係なく、指定したパスを 1 回買う）。どうしても定期で動かすときだけ `BUYER_CRON_IN_LIVE=true` を入れる。

## 参照

- Nevermined の環境（SDK）：<https://raw.githubusercontent.com/nevermined-io/payments/main/src/environments.ts>
- API キー：<https://nevermined.ai/docs/agents-guide/get-api-key.md>
- Stripe Connect の接続・手数料：<https://nevermined.ai/docs/products/payments/faq.md>、<https://nevermined.ai/docs/integrate/patterns/fiat-payments.md>
- 国をまたぐ入金：<https://docs.stripe.com/connect/cross-border-payouts>
- 制限付きキー：<https://docs.stripe.com/keys/restricted-api-keys.md>

## 移行の記録

| 日時（UTC） | 出来事 |
|---|---|
| 2026-11-02 10:52 | Vercel の環境変数を本番に切り替えて Redeploy。ゲートウェイは `NVM_PLAN_ID` 待ちの状態で起動 |
| 2026-11-02 10:52:39 | `POST /setup/plan` で本番のプランとエージェントを作成。プラン `109390300569784239149001680992260682156573712120263169260609849660793213537158`、エージェント `40597898777609448364666718252952480148470005949452368282165923844683523900188`。照合：個人の下（`orgId: null`）、`nvm:card-delegation`、価格合計 $1（売り手 0.98 ＋ 手数料 0.02）、100 クレジット、1 回 1 クレジット固定、期限 2,592,000 秒（30 日）、Base mainnet（8453）、受取 `0xc2A2…40FA` |

購入 URL：`https://nevermined.app/checkout/plan/109390300569784239149001680992260682156573712120263169260609849660793213537158`
| 2026-11-02（12:17 UTC までに） | 本番で初めての購入。購入画面は「Order complete … 100 credits」。保存済みカード（`**** 6013`）で支払い（Sandbox で通らなかった経路が本番では通った）。Stripe から x402 宛てに「Payment of ¥155」（`py_1UXKAj3vSEcfGG4QlbPiJL5K`）の通知。$1 の請求が日本円 ¥155 に換算されて x402 の Stripe 残高に入る（手数料はこの後差し引かれる） |
| 2026-11-02 12:17〜12:31 UTC | ゲートウェイの買い手キーのアドレス（`0x0F8e…1647`）の残高は 0 のまま。売り手アカウントのアドレスも 0。どのアカウントにクレジットが付いたかを確認中 |
| 2026-11-02 13:00 UTC ごろ | 買い手アカウント（you.betsu…、Live）の Purchases は 0 件（10/03〜11/02）。支払いに使ったカード `**** 6013` はこのアカウントに登録済み。Stripe には ¥155 が入ったが、Nevermined 側で購入が記録されずクレジットも付いていない（付与の失敗または保留）。Nevermined に問い合わせる |

本番での確認の整理（2026-11-02）：

- **通ったもの**：カード決済そのもの（Stripe で $1、¥155 を受け取り、`py_1UXKAj3vSEcfGG4QlbPiJL5K`）。保存済みカード（`**** 6013`）での購入（Sandbox では「Error creating Stripe payment intent」で通らなかった経路）
- **通らなかったもの**：クレジットの付与。12:34 UTC 時点で、ゲートウェイの買い手アドレス（`0x0F8e…1647`）・売り手のアドレス（`0xc2A2…40FA`、`0x6d56…3Ed5`）のどれにも 100 クレジットは無く、買い手アカウントの Purchases も 0 件
- **購入したアカウント**：支払いに使ったカード `**** 6013` は買い手アカウント（you.betsu…）の Payment Methods にある。売り手アカウントのアドレスの残高も 0 なので、「別のアカウントに付いた」可能性は低い（売り手アカウントに同じカードが登録されていたかは未確認）
- このあと（2 時間と 11/03 朝）に付与されれば JIN の 1 回まで確かめて追記する。付かなければ「本番では付与されなかった」で締める。Nevermined への問い合わせはしない（単なる検証のため）

調査（2026-11-02 12:45 UTC、`GET /diag/nvm` で本番のキーから Nevermined の API を直接読んだ）：

| 見たもの | 売り手キー（`0xc2A2…40FA`） | 買い手キー（`0x0F8e…1647`、user `us-dda0de86…`） |
|---|---|---|
| Stripe Connect の状態 | 接続済み・検証済み（`acct_1U0L1S3vSEcfGG4Q`、standard） | 接続なし（買い手なので正しい） |
| Stripe の残高 | **JPY 99** | — |
| 購入履歴（plans-purchased-detailed） | 0 件 | **0 件** |
| 所属 Organization | なし | なし |

- 支払い `py_1UXKAj3vSEcfGG4Q…` の末尾は売り手の接続アカウント `acct_1U0L1S3vSEcfGG4Q` と一致する。$1 は ¥155 として売り手の Stripe に入り、手数料を引いた **¥99** が残高に出ている（差し引き ¥56 ≒ 36%。Stripe と Nevermined の手数料・通貨換算の内訳は Stripe の明細で確かめる）
- 一方、買い手の購入履歴は API でも 0 件で、クレジットも 0。**お金は売り手に届いたが、Nevermined 側で注文が買い手に記録されていない**。Sandbox では同じ SDK のプランが購入画面でも自動補充でも付与されたので、違いは本番（日本の Standard アカウント・円での受け取り）か、Nevermined の本番側の処理にある

**解決（2026-11-03 00:01 UTC に確認）**：クレジットは遅れて付いていた。

- 買い手（`0x0F8e…1647`）の購入履歴に 1 件、残高 100。Nevermined が注文を記録した時刻は **2026-11-02 17:19:33 UTC**（`txType: Purchase`、`reconciliationStatus: Settled`、`reconcileAttempts: 1`）で、支払い（12:17 UTC までに）から **約 5 時間遅れ**。購入画面の「Order complete」の時点ではまだ付いていない。期限はこの記録時刻から 30 日（2026-12-02 17:19 UTC ごろ）
- 内訳（Nevermined の記録、USD 換算、為替 1.54781）：価格 $1.00 のうち売り手 `ownerMargin` **$0.65**、Nevermined `nvmMargin` $0.02、Stripe の実際の手数料 $0.039（¥6）。売り手の取り分は、Stripe 手数料の見積もり `estimatedStripeFeeMicro` **$0.33** を先に引いて決まっている（実際の手数料は $0.039）。¥155 のうち売り手残高 ¥99 はこの $0.65 に当たる
- 付与を待つ間に、売り手の権限でクレジットを付ける口（`POST /setup/grant`）を用意したが、実行前に付与が確認できたので使わずに外した

| 日時（UTC） | 出来事 |
|---|---|
| 2026-11-03 00:01:53 | ゲートウェイの `POST /buyer/once?path=/api/jin/series` で JIN を 1 回購入。カードの委任を作成（`1fdf2492`、上限 100 セント） |
| 2026-11-03 00:01:56 | ゲートウェイのログ：`nvmEnvironment: live`、`verify: valid`、`settle: ok`（`tid-e355bfd0…`）、`outcome: ok`、`status: 200`、`creditsConsumed: 1`、残り 99。上流は Solana mainnet で $0.01（`4sQkEy4r…pj94Q`）。`payerId: d0c6c75243d07e82`（Sandbox と同じ買い手アドレスなので同じ値） |

これで「本番でカード購入 → 100 クレジット → ゲートウェイ経由で JIN 1 回」まで通った。買い手の定期購入は本番では止めたまま（`BUYER_CRON_IN_LIVE` は未設定）。
