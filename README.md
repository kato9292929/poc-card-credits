# poc-card-credits — 実証1：カード払いの利用枠をエージェントが per-call で消費する

法人の担当者がカードで利用枠（クレジット）を買い、買い手エージェントがそれを1コールずつ消費して OSD / JIN を使う構成の PoC。

```
人（法人の担当者）
   │ カードでプランを購入（starter: $10 = 1,000 クレジット）     scripts/order-plan.ts
   ▼
Nevermined（利用枠の管理・カード決済 / Stripe）
   │ アクセストークン                                          scripts/buyer-token.ts
   ▼
買い手エージェント ──GET /jin/series（payment-signature: <token>）──▶ ゲートウェイ
agents/buyer                                                      src/gateway
                                                  1. verify ＋ 残高確認（Nevermined）
                                                  2. OSD / JIN の x402 をゲートウェイのウォレットで購入
                                                     （$0.05/コール・$5/日 を署名前に強制）
                                                  3. 200 のときだけ settle（クレジット消費）
                                                  4. 失敗したら消費しない
```

OSD・JIN のリポジトリと Autonomous Agent のウォレットには触れない。Nevermined の実際の仕様（SDK の版、URL、指示書の想定との違い）は [docs/nevermined.md](docs/nevermined.md) にまとめた。

## 構成

| パス | 内容 |
|---|---|
| `src/gateway/handler.ts` | 1リクエストの処理順序（§3） |
| `src/gateway/server.ts` | HTTP サーバー（Express）、`/healthz` |
| `src/ledger/nevermined.ts` | Nevermined の verify / settle / 残高 |
| `src/upstream/x402.ts` | 裏側の x402 購入（402 を検査 → 上限を予約 → 署名して再送） |
| `src/budget.ts` | 支払い上限（1コール・1日、UTC）。再起動時は当日のログから復元する |
| `src/config.ts` | 上限の値（`HARD_MAX_PER_CALL` / `HARD_MAX_PER_DAY`）。環境変数では下げることしかできない |
| `config/pricing.json` | ルートと価格・クレジットの対応表（§2）。起動時に整合性を検証する |
| `config/assets.json` | 支払ってよい資産（Base / Solana の USDC）。テストネットとメインネットを区別している |
| `config/plans.json` | プランの定義（starter） |
| `agents/buyer/` | 検証用の買い手（§4） |
| `scripts/` | プラン登録・購入・トークン発行・週次集計 |
| `log/` | `YYYY-MM-DD.jsonl`（ゲートウェイ）、`buyer-YYYY-MM-DD.jsonl`、`events.jsonl`。コミットしない |
| `reports/` | 週次レポート `YYYY-Www.md`（§5） |
| `docs/go-live.md` | 本番に移す条件（§6） |

## セットアップ（テスト環境）

前提: Node.js 22 以上。

```bash
npm install
cp .env.example .env
```

1. **ゲートウェイのウォレットを新しく作る。** Base Sepolia（EVM）または Solana devnet の鍵を新規に作り、テストネットの USDC を入れる。鍵は `.env` にだけ書く
2. **Nevermined（sandbox）でプランを登録する。** 売り手のキーで実行し、出力された ID を `.env` の `NVM_AGENT_ID` / `NVM_PLAN_ID` に書く

   ```bash
   npm run plan:register
   ```

3. **ゲートウェイを起動する。** 上限と環境は `/healthz` で確認できる

   ```bash
   npm run gateway
   curl localhost:8787/healthz
   ```

4. **買い手側の準備**（法人の担当者の役。買い手の NVM API キーで実行）
   1. Nevermined App（sandbox）でカードを登録し、**小さい上限**で委任を作る（理由は docs/nevermined.md の「自動トップアップ」）
   2. 次のコマンドを実行し、表示された Stripe Checkout でテストカードを使って支払う。クレジットが付与されるまで待ち、時刻を記録する

      ```bash
      npm run plan:order
      ```

   3. アクセストークンを発行し、`.env` の `NVM_ACCESS_TOKEN` に書く

      ```bash
      NVM_DELEGATION_ID=... npm run buyer:token
      ```

5. **買い手エージェントを起動する。** 動作確認だけなら `npm run buyer -- --once`

   ```bash
   npm run buyer
   ```

## ゲートウェイの応答

| 状況 | HTTP | 本文の `error` | クレジット消費 |
|---|---|---|---|
| 成功 | 200（上流の本文をそのまま返す。`x-credits-consumed` / `x-credits-remaining` ヘッダを付ける） | - | する |
| トークンなし | 402（`payment-required` ヘッダあり） | `payment_required` | しない |
| トークンが無効 | 402 | `token_invalid` | しない |
| 残高不足 | 402 | `insufficient_credits` | しない |
| ゲートウェイの支払い上限に到達 | 503 | `gateway_spend_cap` | しない |
| 上流の購入に失敗（価格不一致・未許可の資産を含む） | 502 | `upstream_failed` | しない |
| 上流は成功したが消費（settle）に失敗 | 502（データは返さない。原価は未回収として記録） | `settle_failed` | しない |

## ログ

`log/YYYY-MM-DD.jsonl` には、1リクエストにつき1行を追記する。主な項目は次のとおり。

| 項目 | 内容 |
|---|---|
| `tokenId` / `payerId` | トークン・支払元を塩付き SHA-256 で匿名化した値 |
| `creditsConsumed` | 消費したクレジット |
| `upstreamCostMicro` | 裏側で払った額（マイクロUSD） |
| `upstreamTx` | 裏側の x402 の tx 署名 |
| `nvmSettleTx` | Nevermined の消費 tx |
| `latencyMs` / `upstreamLatencyMs` | 応答時間 |
| `outcome` / `error` | 結果とエラー内容 |

トークンそのものは記録しない。

## 測定と週次レポート（§5）

```bash
cp reports/inputs/card-payments.example.json reports/inputs/card-payments.json   # Stripe / Nevermined の管理画面から転記
npm run report:weekly            # 先週分
npm run report:weekly -- 2026-W42
```

レポートの項目は次のとおり。

- カード手数料と売上に対する割合
- 1コールあたりの原価・粗利
- 購入から利用開始までの時間
- 残高切れの挙動（エラーの種類、停止・再開）
- 明細・領収書の形式

初期値（1クレジット = $0.01、starter = $10 / 1,000 クレジット、JIN series = $0.01）では、売上換算と裏側の原価が同額になる。粗利はカード手数料（Nevermined 2% ＋ Stripe）の分だけマイナスになる見込み。価格を見直すときの基準として測定する（§2）。

## テスト

```bash
npm run typecheck
npm test
```

テストは次の3つ。ネットワークや Nevermined にはつながない。

| ファイル | 内容 |
|---|---|
| `test/handler.test.ts` | 処理順序。上流の失敗時と上限到達時に消費しないこと、同時リクエストで残高を超えないこと |
| `test/x402-upstream.test.ts` | ローカルの擬似 x402 サーバーに本物の x402 クライアントで支払う。上限・価格不一致・メインネットの資産の場合に、署名もせず送信もしないこと |
| `test/budget.test.ts` / `test/pricing.test.ts` | 上限の値、日付の切り替わり、価格とクレジットの整合 |
