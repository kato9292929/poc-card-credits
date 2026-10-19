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
| 1 | 購入と委任（Checkout をテストカードで支払い → クレジット付与までの時間。`buyer:token` で委任作成〜トークン発行、`log/events.jsonl` に2つの時刻） | | 未実施 | |
| 2 | 402 の確認（トークンなしで JIN → `PAYMENT-REQUIRED` の `scheme` が `nvm:card-delegation`、`network` が `stripe`） | 2026-10-20 | OK | 下の「詳細 §3-2」。1 の前に実施（1 に依存しないため） |
| 3 | 1コールの通し（JIN series → 上流の tx 署名と `creditsConsumed: 1`、Blob に1行、`GET /logs/:date` で同じ行） | | 未実施 | |
| 4 | 非消費の確認（上流を止めて1回 → クレジットが減らない） | | 未実施 | |
| 5 | 上限の確認（環境変数で上限を $0.001 → 署名前に拒否。確認後に戻す） | | 未実施 | |
| 6 | payg 試験（`npm run payg:probe` を1回 → docs/nevermined.md の記録表） | | 未実施 | |
| 7 | `endpoints` の形を docs/nevermined.md の「使っている API」に書き、「未確認」から外す | | 未実施 | |

## 1週間の確認（§4）

| 開始日 | 終了日 | 週次レポート | 裏側の購入失敗で消費された例 |
|---|---|---|---|
| | | | |

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
