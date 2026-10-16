# Sandbox での確認記録（追加指示 v2 §4）

上から順に実施し、日付（JST）付きで結果を書く。失敗したら、その項目で止めて報告する。

前提：§3 の環境変数が `.env` に揃い、`npm run preflight` が通っていること。

| # | 項目 | 実施日 | 結果 | 記録 |
|---|---|---|---|---|
| 1 | プランの作成（App で「クレジット制 100 回・有効期限 30 日」→ `plan:register -- --plan-id` で照合。作れなければ `plan:register -- --try-sdk-expiry` を1回） | | 未実施 | |
| 2 | 購入と委任（`plan:order` で Stripe Checkout をテストカードで通す → `buyer:token` で委任作成〜トークン発行。`log/events.jsonl` に2つの時刻） | | 未実施 | |
| 3 | 402 の確認（トークンなしで JIN → `PAYMENT-REQUIRED` の `scheme` が `nvm:card-delegation`、`network` が `stripe`） | | 未実施 | |
| 4 | 1コールの通し（JIN series → 上流の tx 署名と `creditsConsumed: 1`、Blob に1行、`GET /logs/:date` で同じ行） | | 未実施 | |
| 5 | 非消費の確認（上流を止めて1回 → クレジットが減らない） | | 未実施 | |
| 6 | 上限の確認（上限を一時的に $0.001 に下げる → 署名前に拒否。確認後に戻す） | | 未実施 | |
| 7 | payg 試験（`npm run payg:probe` を1回 → docs/nevermined.md の記録表） | | 未実施 | |

## 詳細

（各項目の出力・ヘッダの中身・時刻をここに追記する）
