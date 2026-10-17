# Sandbox での確認記録（追加指示 v3 §3）

上から順に実施し、日付（JST）付きで結果を書く。失敗したら、その項目で止めて報告する。

前提：§2 の準備（プランの照合、`endpoints` 付きのエージェント登録、`npm run preflight` の通過）が済んでいること。

## 準備（§2）

| 項目 | 実施日 | 結果 | 記録 |
|---|---|---|---|
| プランの照合とエージェント登録（`plan:register -- --plan-id`）。`endpoints` の形 | | 未実施 | |
| （App で有効期限が作れなかった場合のみ）`plan:register -- --try-sdk-expiry` | | 未実施 | |
| `npm run preflight` の通過 | | 未実施 | |

## 確認（§3）

| # | 項目 | 実施日 | 結果 | 記録 |
|---|---|---|---|---|
| 1 | 購入と委任（Checkout をテストカードで支払い → クレジット付与までの時間。`buyer:token` で委任作成〜トークン発行、`log/events.jsonl` に2つの時刻） | | 未実施 | |
| 2 | 402 の確認（トークンなしで JIN → `PAYMENT-REQUIRED` の `scheme` が `nvm:card-delegation`、`network` が `stripe`） | | 未実施 | |
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
