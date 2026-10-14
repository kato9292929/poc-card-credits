# 本番に移す条件（指示書 §6）

すべての項目を満たすまで、`ALLOW_LIVE=true` にしない。満たしていない間、ゲートウェイは次の設定では起動しない。

- `NVM_ENVIRONMENT=live`
- `UPSTREAM_TESTNET_ONLY=false`（メインネットの USDC での支払い）

| # | 条件 | 確認方法 | 結果 |
|---|---|---|---|
| 1 | テスト環境で1週間、裏側の購入に失敗したとき利用枠が消費されないこと | 週次レポートの「失敗時に利用枠が消費されたリクエスト: 0 件」と `upstream_failed` の件数が1件以上あること（上流を一時的に止めるなどして発生させる）。ユニットテスト `test/handler.test.ts` の「upstream failure」 | |
| 2 | 支払い上限の強制が効くこと（上限を超えるリクエストで確認） | (a) 1コール上限：`config/pricing.json` に $0.06 のルートを一時的に足すと、起動時の検証で止まる。上流が設定と違う額を要求したときは `price_mismatch`、$0.05 を超える額は `per_call_cap` で、署名せずに拒否する（`test/x402-upstream.test.ts`、`test/pricing.test.ts`）。(b) 1日上限：`MAX_USD_PER_DAY=0.03` で起動し、4回目以降が 503 `gateway_spend_cap` になり、ゲートウェイのウォレットから引かれていないことをエクスプローラで確認 | |
| 3 | Nevermined の対応カードの範囲を公式情報で確認し、`docs/nevermined.md` に記録 | 記録済み（2026-10-13）。法人カードは公式情報では確認できない → 個人カードに限定して実施 | 個人カードに限定 |

Sandbox での1週間の進め方（条件1・2）:

1. `npm run wallet:new` でウォレットを作り、テストネットの USDC を入れる。プランを登録し、Stripe のテストカードで購入する（README）
2. ゲートウェイと買い手（20回/日）を7日間動かす
3. 期間中に1回、上流の URL をわざと誤らせて（例 `JIN_BASE_URL` を存在しないホストに）ゲートウェイを再起動し、`upstream_failed` を発生させる。ログで消費クレジットが 0 であることを確かめてから元に戻す
4. 期間中に1回、`MAX_USD_PER_DAY=0.03` で再起動し、4回目以降が 503 になることを確かめてから元に戻す
5. `npm run report:weekly` の結果を、この表の「結果」欄に転記する

本番に切り替えるときの作業:

1. 本番用に、ゲートウェイの **新しい** ウォレットを `NVM_ENVIRONMENT=live npm run wallet:new` で作る（テスト用のウォレットや AA のウォレットは使わない）。公開アドレスは docs/wallet.md に追記されるのでコミットする。入金は数日分（$5/日 × 日数）だけにする
2. `NVM_ENVIRONMENT=live` で `npm run plan:register` を実行し、本番のプラン ID を取得する
3. `.env` に次を設定する
   - `ALLOW_LIVE=true`
   - `UPSTREAM_TESTNET_ONLY=false`
   - 本番の各 ID・キー
   - `LOG_SINK=blob`（`file` は `NODE_ENV=development` のときだけ有効で、Live では起動しない）
   - `BLOB_READ_WRITE_TOKEN`
   - `LOG_READ_TOKEN`
   - payg は本番の比較対象外なので、`NVM_PLAN_ID_PAYG` はゲートウェイに設定しない
4. `/healthz` で上限（$0.05 / $5）と環境を確認してから、買い手を起動する
