# Sandbox での確認記録（追加指示 v3 §3）

上から順に実施し、日付（JST）付きで結果を書く。失敗したら、その項目で止めて報告する。

前提：§2 の準備（プランの照合、`endpoints` 付きのエージェント登録、`npm run preflight` の通過）が済んでいること。

## 準備（§2）

| 項目 | 実施日 | 結果 | 記録 |
|---|---|---|---|
| プランの照合とエージェント登録（`plan:register -- --plan-id`）。`endpoints` の形 | 2026-10-19 | 済 | `NVM_PLAN_ID=61852813…774087`（SDK で作成、下の行）を照合（価格の合計 $1・100 クレジット・30 日・1 回 1 クレジット・`nvm:card-delegation`）。`NVM_AGENT_ID=23325210…986618`。`endpoints` は実 URL 2 本（`/api/jin/series`・`/api/alpha/jp/catalysts`）のまま登録できた |
| （App で有効期限が作れなかった場合のみ）`plan:register -- --try-sdk-expiry` | 2026-10-19 | 受け付けられた | App のプラン（`43665550…773315`）は `durationSecs: 0`・期限の欄なし。SDK の `registerPlan` に `durationSecs: 2592000` を渡すと通った（docs/nevermined.md「プランの有効期限」） |
| `npm run preflight` の通過 | 2026-10-20 | デプロイ先は通過 | Vercel の `/healthz` が 200（`logStore: ok`、Sandbox、上流 mainnet、ウォレット `3HG2HY…krcgV` が docs/wallet.md と一致、`missing` なし）。このセッションの `NVM_API_KEY_BUYER` は未設定（§3-1 の購入は App から行う） |

## 確認（§3）

| # | 項目 | 実施日 | 結果 | 記録 |
|---|---|---|---|---|
| 1 | 購入と委任（Checkout をテストカードで支払い → クレジット付与までの時間。`buyer:token` で委任作成〜トークン発行、`log/events.jsonl` に2つの時刻） | 2026-10-21 | OK（付与までの時間は未計測） | 下の「詳細 §3-1」。購入は App の購入ページ（`/checkout/plan/<planId>`）から。委任は Vercel の `/cron/buyer` で作成（`log/buyer/` に `delegation_created` 18:01:37 JST） |
| 2 | 402 の確認（トークンなしで JIN → `PAYMENT-REQUIRED` の `scheme` が `nvm:card-delegation`、`network` が `stripe`） | 2026-10-20 | OK | 下の「詳細 §3-2」。1 の前に実施（1 に依存しないため） |
| 3 | 1コールの通し（JIN series → 上流の tx 署名と `creditsConsumed: 1`、Blob に1行、`GET /logs/:date` で同じ行） | 2026-10-21 | OK | 18:08:53 JST。下の「詳細 §3-3」。それ以前の3回はログの書き込みに失敗（同） |
| 4 | 非消費の確認（上流を止めて1回 → クレジットが減らない） | 2026-10-21 | OK（OSD の実障害で発生） | 18:08:17 JST、OSD が 503 → 支払いなし・`creditsConsumed: 0`・残高 97 のまま。こちらで止めたのではなく、OSD 側が落ちていた（同時刻に支払いなしの GET も 503）。下の「詳細 §3-4」 |
| 5 | 上限の確認（環境変数で上限を $0.001 → 署名前に拒否。確認後に戻す） | 2026-10-21 | OK | `config/sandbox.json` の `MAX_USD_PER_CALL` を `0.001` にしてデプロイ（`fd2e13b`）→ JIN series が `gateway_cap_exceeded`（上流の 402 を見て署名前に拒否、tx なし、消費 0、残高 96 のまま）→ 空に戻した。下の「詳細 §3-5」 |
| 6 | payg 試験（`npm run payg:probe` を1回 → docs/nevermined.md の記録表） | 2026-10-21 | 実施（プラン登録で拒否） | `payg:probe -- --remote`（買い手のキーが Vercel にしか無いため、ゲートウェイの `POST /buyer/payg-probe` で実行）。$0.01 のカード払い都度払いプランは `BCK.PROTOCOL.0047`（法定通貨プランの最低額 $1）で登録できず、請求の試験までは進まなかった |
| 7 | `endpoints` の形を docs/nevermined.md の「使っている API」に書き、「未確認」から外す | 2026-10-21 | 済 | 実 URL 2 本のまま登録できたことを「使っている API」に記録。パスパラメータ（`:ticker`）の可否は、パラメータ付きのルートを使わないので未確認のまま残した |

## 1週間の確認（§4）

| 開始日 | 終了日 | 週次レポート | 裏側の購入失敗で消費された例 |
|---|---|---|---|
| 2026-10-22（JST） | 2026-10-28（JST） | 2026-10-29 に作成予定 | （期間中に記入） |

運用の形：Vercel Cron が `/cron/buyer` を UTC 0〜19 時の毎時（Hobby プランなので、その時間帯のどこか）に呼び、JIN series と OSD の JP catalysts を交互に1回ずつ買う。1日 20 回（JST の日付で数える）。2026-10-21 は §3 の確認で 9 回を手動で呼んだので、その日は残り分だけ動く。

開始時点の状態（2026-10-21 18:20 JST）：買い手の残高 96 クレジット、ゲートウェイのウォレット 0.96 USDC（Solana mainnet）。OSD（`osd.x402jp.com`）は 18:08 以降、支払いなしの GET にも 503 を返している（上流の障害。ゲートウェイは支払わず、クレジットも消費しない）。

## 詳細

（各項目の出力・ヘッダの中身・時刻をここに追記する）

### §3-2 402 の確認（2026-10-20）

`GET https://poc-card-credits.vercel.app/api/jin/series`（トークンなし）→ 402。`PAYMENT-REQUIRED` を base64 デコードした中身：

```json
{
  "x402Version": 2,
  "resource": { "url": "https://poc-card-credits.vercel.app/api/jin/series", "description": "OSD / JIN via card-funded credits", "mimeType": "application/json" },
  "accepts": [
    {
      "scheme": "nvm:card-delegation",
      "network": "stripe",
      "planId": "61852813790907981549543018232399411968336511683982723564743066269725851774087",
      "extra": { "version": "1", "agentId": "2332521029535618459092285951650926563931004600551980132707236962664112986618", "httpVerb": "GET" }
    }
  ],
  "extensions": {}
}
```

### Vercel Blob の認証（2026-10-20）

Blob ストアをプロジェクトにつなぐと、`BLOB_READ_WRITE_TOKEN` ではなく `BLOB_STORE_ID` が入った。`@vercel/blob` はこのとき、リクエストのヘッダーで渡される OIDC トークンで認証するため、起動時（リクエストの外）の読み込みは失敗した。Blob の読み書きをリクエストの中だけで行うように直した（`96cd3bc`）。

### §3-1 購入と委任（2026-10-21）

- 買い手アカウントは売り手とは別（Nevermined 上の保有アドレス `0x0F8e27177b9F929Eb819299ED1ACC7c624Cf1647`）。購入は Nevermined App の購入ページ（`https://nevermined.app/checkout/plan/<planId>`、Stripe のテストカード）。完了画面「Payment of $1.00 received … 100 credits have been added」
- SDK の `orderFiatPlan` は Checkout の URL ではなく、App に埋め込む Stripe の PaymentIntent を返す（`sessionType: 'embedded'`）。そのため買い手に渡すリンクは App の購入ページになる
- **購入から付与までの時間は測れていない。** 最初の Vercel の `NVM_API_KEY_BUYER` が売り手と同じアカウントのキーで、残高を見張っていたのは売り手側だった。`credits_available`（17:49:13 JST）はキーを直して初めて残高 100 を見た時刻で、付与の時刻ではない
- 委任には買い手アカウントに**保存済みのカード**が要る（購入時のカードは保存されない）。App の Buying → Payment Methods → Add payment method で登録したカードは `provider: 'vgs'`（VGS の金庫でトークン化）。Stripe のテストカード `4242…` は VGS では「Card not enrolled」になり、App の「test cards」の番号で登録できた。委任は `provider: 'vgs'` で作る必要がある（`stripe` を指定すると 400 "Requested provider does not match the stored payment method"）。トークンの `network` は `stripe` のまま使えた
- 委任: `delegation_created` 2026-10-21T09:01:37.533Z（上限 100¢）。トークンは同じ `/cron/buyer` の中で発行し、そのまま 1 コール目に使った

### §3-3 1コールの通し（2026-10-21）

`GET /logs/2026-10-21`（Bearer `LOG_READ_TOKEN`）で読んだ行：

```json
{"time_utc":"2026-10-21T09:08:53.907Z","date_jst":"2026-10-21","tokenId":"e4ce7a9f228e20cd","planKind":"prepaid","verify":"valid","settle":"ok","upstreamTx":"2CVfKwzA5HdF7ZzeGzzU94f7YAwyZdRAKvUMtCe12E43STdkqY9gUXe1h9qstsNPaJMwJQpVeVM8Bs4pL26MwyVz","upstreamNetworkMode":"mainnet","method":"GET","path":"/api/jin/series","outcome":"ok","status":200,"creditsConsumed":1,"upstreamCostMicro":"10000","latencyMs":4372,"routeId":"jin.series","payerId":"d0c6c75243d07e82","remainingCredits":"96","upstreamAttemptMicro":"10000","upstreamNetwork":"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp","upstreamStatus":200,"upstreamLatencyMs":1115,"nvmSettleTx":"tid-03f5855f-fe87-44f5-b7d1-29c2d9667fb3"}
```

`upstreamTx` は Solana mainnet 上でゲートウェイのウォレット（`3HG2HY…krcgV`）の取引として確認できた。買い手の残高 97 → 96。

**ログに残らなかった3回（要注意）**: 次の3回は上流への支払い・クレジットの消費とも正常だったが、ゲートウェイのログの行を Blob に書けなかった（"Precondition failed: ETag mismatch"。`get` の ETag が CDN の値で、`put` の `ifMatch` と一致しなかった。`d6f036e` で修正）。証拠は買い手側のログ（`log/buyer/2026-10-21.jsonl`）とオンチェーンの取引：

| 時刻（UTC） | パス | 上流の tx | 買い手の残高 |
|---|---|---|---|
| 09:01:43 | `/api/jin/series` | `2CqaHAyMZWnk6moEvxARAL5D65a9NHJ8ntf2bdVja9UDJFrui5gqEVLxcPXUMpBHSKdjU4KZ1XyPkay92bG68U31` | 99 |
| 09:04:29 | `/api/alpha/jp/catalysts` | `2TJUF7G3axUPPumUzWRSKhcWnBxwqCBbGRbsPnotgRrA5mP23uXsFRCM3YrJZconZagEQjDwmn6C5z7Saihqsncy` | 98 |
| 09:06:49 | `/api/jin/series` | `5TcQZc9Br5SbCzXxLXnKAa275AaT1Py9cjQGqruYB8ePVTWQ5Q83Tyxbn87fWijKGc19qpJ1eNd2acKvWRkQg3bd` | 97 |

ログは追記のみなので、後から行を足して埋めることはしない。この3回分（$0.03）は当日の日次上限の集計（ログから復元）にも入っていない。週次レポートでは、この3回を上の表から別に数える。

### §3-4 非消費の確認（2026-10-21）

```json
{"time_utc":"2026-10-21T09:08:17.952Z","verify":"valid","settle":"skipped","upstreamTx":"none","path":"/api/alpha/jp/catalysts","outcome":"upstream_failed","status":502,"creditsConsumed":0,"upstreamCostMicro":"0","upstreamAttemptMicro":"0","upstreamStatus":503,"remainingCredits":"97","error":"upstream status 503"}
```

（主要項目のみ抜粋。）OSD 側の障害（支払いなしの GET も 503）で起きた。支払いの署名前に上流が 503 を返したので USDC は動かず（0.97 のまま）、買い手の残高も 97 のまま。指示書の手順（上流をこちらで止める）とは違う起こり方なので、§4 の期間中に一度、`UPSTREAM_JIN_URL` を誤らせる方法でも確かめる（docs/go-live.md の条件1）。

### §3-5 上限の確認（2026-10-21）

```json
{"time_utc":"2026-10-21T09:12:08.325Z","verify":"valid","settle":"skipped","upstreamTx":"none","path":"/api/jin/series","outcome":"gateway_cap_exceeded","status":503,"creditsConsumed":0,"upstreamCostMicro":"0","upstreamAttemptMicro":"0","upstreamStatus":402,"remainingCredits":"96","error":"requested $0.010000 > per-call cap $0.001000"}
```

（主要項目のみ抜粋。）ゲートウェイのウォレットの最新の取引は §3-3 の `2CVfKw…` のままで、新しい支払いは無かった。確認後に `MAX_USD_PER_CALL` を空（コードの上限 $0.05）に戻した。

### §4 残高切れ（A'：尽きるまで待って買い直す）（2026-10-27）

尽きる前に買い足さず、残高切れの挙動（§5）と、買い直しでの「購入からクレジット付与まで」を測る方針（A'）。

| 時刻（UTC） | JST | 出来事 |
|---|---|---|
| 2026-10-26T15:42:42Z | 10/27 00:42 | 最後の成約（JIN series、`remainingCredits: 0`） |
| 2026-10-26T16:55:04Z | 10/27 01:55 | ゲートウェイが **402 `insufficient_credits`**（OSD。`verify: valid`、`settle: skipped`、消費 0、上流の購入なし `upstreamTx: none`。残高を見て settle 前に止めたので、カードへの自動補充（`cardTopUpOrderTx`）も起きていない） |
| 2026-10-26T16:55:07Z | 10/27 01:55 | 買い手エージェントが停止（`credits_exhausted`、`errorKind: insufficient_credits`。停止状態 `since: 2026-10-26T16:55:07.389Z`） |
| 17:46 / 18:16 / 19:30Z | 02:46 / 03:16 / 04:30 | 以後の定期実行は `skipped`（`reason: stopped`）。ゲートウェイへの呼び出しも無い |

402 の回数：**1 回**（停止後はゲートウェイを呼ばないので増えない）。
