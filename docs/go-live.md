# 本番に移す条件（指示書 §6）

すべての項目を満たすまで、`ALLOW_LIVE=true` にしない。満たしていない間、ゲートウェイは次の設定では起動しない。

- `NVM_ENVIRONMENT=live`
- `UPSTREAM_TESTNET_ONLY=false`（メインネットの USDC での支払い）

| # | 条件 | 確認方法 | 結果 |
|---|---|---|---|
| 1 | テスト環境で1週間、裏側の購入に失敗したとき利用枠が消費されないこと | 週次レポートの「失敗時に利用枠が消費されたリクエスト: 0 件」と `upstream_failed` の件数が1件以上あること（上流を一時的に止めるなどして発生させる）。ユニットテスト `test/handler.test.ts` の「upstream failure」 | |
| 2 | 支払い上限の強制が効くこと（上限を超えるリクエストで確認） | (a) 1コール上限：`config/pricing.json` に $0.06 のルートを一時的に足すと、起動時の検証で止まる。上流が設定と違う額を要求したときは `price_mismatch`、$0.05 を超える額は `per_call_cap` で、署名せずに拒否する（`test/x402-upstream.test.ts`、`test/pricing.test.ts`）。(b) 1日上限：`MAX_USD_PER_DAY=0.03` で起動し、4回目以降が 503 `gateway_spend_cap` になり、ゲートウェイのウォレットから引かれていないことをエクスプローラで確認 | |
| 3 | Nevermined の対応カードの範囲を公式情報で確認し、`docs/nevermined.md` に記録 | 記録済み（2026-10-13）。法人カードは公式情報では確認できない → 個人カードに限定して実施 | 個人カードに限定 |

本番に切り替えるときの作業:

1. 本番用に、ゲートウェイの **新しい** ウォレットを作る（テスト用のウォレットや AA のウォレットは使わない）。入金は数日分（$5/日 × 日数）だけにする
2. `NVM_ENVIRONMENT=live` で `npm run plan:register` を実行し、本番のプラン ID を取得する
3. `.env` に `ALLOW_LIVE=true`、`UPSTREAM_TESTNET_ONLY=false`、本番の各 ID・キーを設定する
4. `/healthz` で上限（$0.05 / $5）と環境を確認してから、買い手を起動する
