# 実証2 への引き継ぎ（2026-10-23 時点）

実証2 が実証1 のゲートウェイのログを読むための情報と、集計するときの前提。数値は 2026-10-23 にゲートウェイのログ（`GET /logs/:date`）とオンチェーンの取引で確かめた。

## 読む口

| 項目 | 値 |
|---|---|
| ゲートウェイの URL | `https://poc-card-credits.vercel.app` |
| ゲートウェイのログ | `GET /logs/:date`（`:date` は JST の日付 `YYYY-MM-DD`）。`Authorization: Bearer <LOG_READ_TOKEN>` |
| 買い手エージェントのログ | `GET /logs/buyer/:date`（同じトークン） |
| `LOG_READ_TOKEN` | Vercel の環境変数と同じ値。リポジトリには書かない |
| 除外するウォレット | `3HG2HYh5EyGR5BnL5UaHeNkz2qA1tdwFizSbGKmkrcgV`（Solana mainnet、docs/wallet.md）。ゲートウェイが JIN・OSD に払う USDC はすべてこのアドレス発 |

## ログ 1 行の項目

どの行にも入る：`time_utc`、`date_jst`、`tokenId`、`planKind`、`verify`、`settle`、`creditsConsumed`、`upstreamTx`、`upstreamNetworkMode`（`mainnet` / `testnet`）、`method`、`path`、`outcome`、`status`、`upstreamCostMicro`、`latencyMs`。

上流に支払いを送った行だけ：`upstreamNetwork`（CAIP-2、例 `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`）、`upstreamAttemptMicro`、`upstreamStatus`、`upstreamLatencyMs`。settle が通った行は `nvmSettleTx`。

`outcome` の値：`ok`（成約）、`settle_failed`（上流に払ったが Nevermined の消費が失敗）、`upstream_failed`（上流が失敗。支払いなし・消費なし）、`gateway_cap_exceeded`（上限で署名前に拒否）、`no_token`（トークンなしの 402）、`no_route` など。

## 集計の前提

1. **カード側は 2 本**：JIN series（`/api/jin/series`、$0.01）と OSD JP catalysts（`/api/alpha/jp/catalysts`、$0.01）を交互に買う。プランが 1 リクエスト 1 クレジット固定なので、JIN movers（$0.02）はカード側に無い。JIN の入口比較は series で揃え、OSD 分は除く（`routeId` が `osd.jp.catalysts`）。
2. **10/21 にゲートウェイのログに残らなかった支払いが 3 回**（Blob の不具合、`d6f036e` で修正）。内訳は **JIN series 2 回・OSD 1 回**。JIN の売り手ログでは、10/21 の series がゲートウェイのログより 2 件多く出る。取引 ID は docs/sandbox-log.md §3-3。
3. **settle 失敗**（上流に払ったがクレジット未消費。ゲートウェイの持ち出し）は 10/23 時点で 2 回：**JIN series 1 回**（2026-10-21T10:43:55Z）、OSD 1 回（2026-10-22T00:29:50Z）。JIN の売り手ログには売上として出るが、ゲートウェイのログでは `settle_failed`。
4. **10/21 は §3 の確認のため手動でも呼んでいる**（09:01〜09:16 UTC）。`gateway_cap_exceeded`（上限確認）と `upstream_failed`（OSD の障害）の行もその日だけの事情。定期実行での運用は 10/22（JST）から。
5. **入金までの日数**：Stripe Connect は Sandbox で接続済み（売り手のアカウントは本人確認済み）。ただし Sandbox はテスト決済で実際の入金が起きないので、この項目は本番（Live）に移るまで出ない。

## 決済 1 件の所要時間

`latencyMs`（ゲートウェイがリクエストを受けてから応答するまで）と `upstreamLatencyMs`（上流への x402 購入の往復）。10/21〜22 の支払いあり 17 回の中央値は、上流 2.36 秒・ゲートウェイ全体 5.5 秒。
