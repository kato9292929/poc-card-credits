# poc-card-credits — 実証1：カード払いの利用枠をエージェントが per-call で消費する

利用者がカードで利用枠（クレジット）を買い、買い手エージェントがそれを1コールずつ消費して OSD / JIN を使う構成の PoC。

```
人（利用者）
   │ カードでプランを購入（prepaid-100: $1 = 100 クレジット、30日有効）  scripts/order-plan.ts
   ▼
Nevermined（利用枠の管理・カード決済 / Stripe）
   │ アクセストークン                                          scripts/buyer-token.ts
   ▼
買い手エージェント ──GET /api/jin/series（payment-signature: <token>）──▶ ゲートウェイ
agents/buyer                                                      src/gateway
                                                  1. verify ＋ 残高確認（Nevermined）
                                                  2. OSD / JIN の x402 をゲートウェイのウォレットで購入
                                                     （$0.05/コール・$5/日 を署名前に強制）
                                                  3. 200 のときだけ settle（クレジット消費）
                                                  4. 失敗したら消費しない
                                                  5. 全リクエストを Vercel Blob の log/YYYY-MM-DD.jsonl に追記
                                                     （実証2は GET /logs/:date で読む）
```

他のリポジトリと Autonomous Agent のウォレットには触れない。秘密鍵・API キー・`LOG_READ_TOKEN` はコミットしない（`.env` のみ）。

関連ドキュメント:

- [docs/nevermined.md](docs/nevermined.md): Nevermined の実際の仕様（SDK の版、URL、指示書の想定との違い）と、payg の試験記録
- [docs/wallet.md](docs/wallet.md): ゲートウェイのウォレットの公開アドレス

payg（都度払い）は本番の比較対象から外した（Stripe の USD の最低請求額が $0.50 のため）。Sandbox で1回だけ試す（`npm run payg:probe`）。

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
| `config/plans.json` | プランの定義（prepaid-100） |
| `agents/buyer/` | 検証用の買い手（§4） |
| `scripts/` | プラン登録・購入・トークン発行・週次集計 |
| `log/` | `YYYY-MM-DD.jsonl`（ゲートウェイ）、`buyer-YYYY-MM-DD.jsonl`、`events.jsonl`。コミットしない |
| `reports/` | 週次レポート `YYYY-Www.md`（§5） |
| `docs/go-live.md` | 本番に移す条件（§6） |

## デプロイ（Vercel）

ゲートウェイと買い手エージェントは Vercel に置く（追加指示 v3 の判断）。

| 項目 | 内容 |
|---|---|
| ゲートウェイ | Express のゼロ設定デプロイ（`src/index.ts` の default export）。1つの関数として動く。`PUBLIC_BASE_URL` は Vercel のプロダクションの URL |
| 買い手エージェント | Vercel Cron が `GET /cron/buyer`（`Authorization: Bearer $CRON_SECRET`）を1日20回呼ぶ。1回で1コール、JIN と OSD を交互に呼ぶ |
| クーロンの登録 | Hobby プランは「1件1日1回」までなので、時刻をずらした20件を `vercel.json` に登録している（UTC 0〜19 時の 7 分＝JST 9:07〜翌 4:07。Hobby では最大 ±59 分ずれる） |
| 買い手のトークン | 各回に買い手のキーで発行する。委任は有効なものを再利用する |
| 買い手のログ | Blob の `log/buyer/YYYY-MM-DD.jsonl` |
| 残高切れ | 停止状態を Blob の `state/buyer.json` に書いて止まる。再開は `npm run buyer:resume` |
| 日次上限 | 支払いの直前に当日のログを読み直して、ほかのインスタンスの支払いも数える |
| ログが読めないとき | 起動時に当日のログを読めない場合は、支払いを受け付けない |
| 設定が足りないとき | 関数は落ちずに、`/healthz` が 503 で足りない環境変数の名前だけを返す（値は返さない） |

秘密でない設定値は `config/sandbox.json`（コミットする）に置く。

- `NVM_PLAN_ID`
- `NVM_AGENT_ID`
- `PUBLIC_BASE_URL`
- `UPSTREAM_JIN_URL` / `UPSTREAM_OSD_URL`

環境変数が設定されていれば、そちらが優先される。`plan:register -- --plan-id` は `NVM_PLAN_ID` と `NVM_AGENT_ID` をここに書き込む。

秘密は、次の2か所に置く。リポジトリにもチャットにも出さない。

| 置き場所 | 変数 |
|---|---|
| Vercel のプロジェクトの環境変数 | `NVM_API_KEY_SELLER`、`NVM_API_KEY_BUYER`、`BLOB_READ_WRITE_TOKEN`（Blob ストアをプロジェクトにつなぐと自動で入る）、`GATEWAY_WALLET_SECRET`、`LOG_SALT`、`LOG_READ_TOKEN`、`CRON_SECRET` |
| このリポジトリで作業する Claude Code の環境変数 | `NVM_API_KEY_SELLER`、`NVM_API_KEY_BUYER`、`BLOB_READ_WRITE_TOKEN`、`LOG_READ_TOKEN`、`CRON_SECRET`（ウォレットの秘密鍵と `LOG_SALT` は置かない） |

ローカルでの確認では `npx vercel build` が通り、出力した関数が単体で起動することを確かめた。確かめた内容は次の3つ。

- `/healthz` が 200 を返す
- `/cron/buyer` は認証が無いと 401
- `/api/jin/series` は `nvm:card-delegation` の 402

## 起動前チェック（追加指示 v2 §3）

`npm run preflight` は、Sandbox での確認に進む条件を確かめる。値は表示しない。通れば終了コード 0。確かめるのは次の2つ。

1. このセッションの環境変数と `config/sandbox.json`
2. デプロイ先の `/healthz`。Vercel 側に足りない環境変数があれば、その名前が出る

| 用途 | コマンド |
|---|---|
| コマンドごとの一覧すべて | `npm run preflight -- --all` |
| 1つのコマンドだけ | `npm run preflight -- gateway` など |


コマンドごとに要求するものは次のとおり。

| コマンド | 必須（未設定・形式違いなら起動しない） | 任意 |
|---|---|---|
| `npm run gateway` | `NVM_API_KEY_SELLER`（接頭辞が `NVM_ENVIRONMENT` と一致）、`NVM_PLAN_ID`、`NVM_AGENT_ID`、`UPSTREAM_JIN_URL`、`UPSTREAM_OSD_URL`、`GATEWAY_WALLET_SECRET`（または `GATEWAY_EVM_PRIVATE_KEY`）、`BLOB_READ_WRITE_TOKEN`、`LOG_SALT` | `PUBLIC_BASE_URL`（既定 `http://localhost:8787`）、`LOG_READ_TOKEN`（32文字以上。未設定なら `GET /logs` を閉じる） |
| `npm run plan:register -- --plan-id <ID>` | `NVM_API_KEY_SELLER`、`PUBLIC_BASE_URL` | `BUYER_OSD_PATH`（`:ticker` 付きの endpoints が拒否されたときに列挙する実パス。カンマ区切り可。今の価格表にはパラメータ付きのルートが無いので使わない） |
| `npm run plan:register -- --try-sdk-expiry` | `NVM_API_KEY_SELLER`、`NVM_RECEIVER_ADDRESS`（Sandbox のみ） | |
| `npm run plan:order` | `NVM_API_KEY_BUYER`、`NVM_PLAN_ID` | |
| `npm run buyer:token` | `NVM_API_KEY_BUYER`、`NVM_PLAN_ID`、`NVM_AGENT_ID` | `BUYER_DELEGATION_LIMIT_CENTS`（50〜100。下げるときだけ）、`BUYER_CARD_PROVIDER`（既定 `stripe`） |
| `npm run buyer` | `GATEWAY_URL`、`NVM_ACCESS_TOKEN` | |
| `npm run payg:probe` | `NVM_API_KEY_SELLER`、`NVM_API_KEY_BUYER`、`NVM_AGENT_ID`、`PUBLIC_BASE_URL`、`NVM_RECEIVER_ADDRESS`（`NVM_PLAN_ID_PAYG` があれば不要） | |
| `npm run report:weekly` | | `GATEWAY_URL` ＋ `LOG_READ_TOKEN`（無ければ開発用のローカルログを読む） |

`NVM_ACCESS_TOKEN` と `GATEWAY_URL` は、買い手側の手順で順に作る値。`ALLOW_LIVE=true` は設定しない。

## セットアップ（テスト環境）

前提: Node.js 22 以上。

```bash
npm install
cp .env.example .env
```

1. **ゲートウェイのウォレットを新しく作る。** Autonomous Agent のウォレット・鍵は使わない

   ```bash
   npm run wallet:new
   ```

   出力された鍵を `.env` にだけ書き、表示されたアドレスに Solana devnet の USDC を入れる。公開アドレスは `docs/wallet.md` に追記されるので、コミットする（実証2の除外リスト用）。起動後に `/healthz` の `gatewayWallet` と一致することを確かめる。EVM（Base）も使うなら `npm run wallet:new -- --evm`
2. **ログの保存先を用意する。**
   1. Vercel の Storage > Blob でストアを作り、読み書きトークンを `BLOB_READ_WRITE_TOKEN` に入れる
   2. 次のコマンドで実証2用の読み取りトークンを作り、ゲートウェイの `LOG_READ_TOKEN` と実証2の両方に設定する

      ```bash
      npm run logs:issue-read-token
      ```

   ローカルで開発するときだけ、`NODE_ENV=development LOG_SINK=file` でファイルに出せる
3. **プランとエージェントを登録する。**
   1. prepaid-100（$1・100 クレジット・30日有効）は有効期限が要る。SDK 1.13.0 ではクレジット制のプランに有効期限を指定できないので、Nevermined App（Sandbox）で作る。次のコマンドは、App で入力する値を表示するだけで、登録はしない

      ```bash
      npm run plan:register
      ```

   2. App で作ったプランの ID を `NVM_PLAN_ID` に書き、次を実行する。プランの中身（価格・クレジット数・有効期限）を確かめてから、エージェントを `endpoints` 付きで登録する。出力された `NVM_AGENT_ID` を `.env` に書く

      ```bash
      npm run plan:register -- --plan-id <ID>
      ```

      `endpoints` は、ゲートウェイの公開パス（`/api/jin/series`、`/api/alpha/jp/catalysts`）を登録する。パラメータ付きのルートを足したときは、まずパターンのまま試し、拒否されたら `BUYER_OSD_PATH` の実パスを列挙して登録し直す。どちらで登録できたかは出力と `log/events.jsonl` に出る
   3. App で「クレジット制＋有効期限」が作れなかったときだけ、`npm run plan:register -- --try-sdk-expiry` を1回実行する。`registerPlan` に有効期限 30 日を直接渡して、受け付けられるかを試す

4. **ゲートウェイを起動する。** `/healthz` で次を確認できる
   - 上限
   - 環境
   - ログの保存先と、書き込みの失敗件数
   - ウォレットのアドレス

   ```bash
   npm run gateway
   curl localhost:8787/healthz
   ```

5. **買い手側の準備**（利用者の役。`NVM_API_KEY_BUYER` で実行）
   1. Nevermined App（sandbox）でカードを登録する。委任は次の 3 で `buyer:token` が作る
   2. 次のコマンドを実行し、表示された Stripe Checkout で支払う。Nevermined の sandbox は Stripe のテストモードにつながっているので、Stripe のテストカード（`4242 4242 4242 4242`、有効期限は未来の任意の日付）を使う。実際の請求は発生しない。クレジットが付与されるまで待ち、時刻を記録する

      ```bash
      npm run plan:order
      ```

   3. 委任を用意してアクセストークンを発行し、出力を `.env` の `NVM_ACCESS_TOKEN` に書く
      - 委任は、有効なもの（通貨 usd、上限 100¢ 以下、期限内、残りの予算あり）があれば再利用し、無ければ登録済みのカードから通貨 usd・上限 100¢ で作る
      - 上限 100¢ はコードに固定で、`BUYER_DELEGATION_LIMIT_CENTS` では下げることしかできない（理由は docs/nevermined.md の「自動トップアップ」）
      - 委任の作成時刻とトークンの発行時刻は `log/events.jsonl` に記録される

      ```bash
      npm run buyer:token
      ```

6. **買い手エージェントを起動する。** 動作確認だけなら `npm run buyer -- --once`

   ```bash
   npm run buyer
   ```

## 残高切れの扱い（`BLOCK_CARD_TOPUP`）

Nevermined のカード払いのトークンでは、クレジットが足りないと settle 時にカードへプラン価格が自動で請求され、クレジットが補充される（docs/nevermined.md「自動トップアップ」）。

| 設定 | 動き | §5 で測れるもの |
|---|---|---|
| `true`（既定） | 残高が足りなければ、ゲートウェイが settle せずに 402 `insufficient_credits` を返す。指示書 §4 の「残高が尽きたら停止」を再現する | ゲートウェイが返す 402 と、エージェントの停止・再開。Nevermined 自身の挙動ではない |
| `false` | 残高を見ずに settle する | Nevermined の挙動。自動補充（ログの `cardTopUpOrderTx`）と、委任の上限に達したときのエラー |

自動補充が起きると、$1 のプランがカード明細の複数行になる。週次レポートの「経理上の扱い」に件数を出す。両方の挙動を測るなら、週を分けて設定を切り替える。

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

### 保存先

| 項目 | 内容 |
|---|---|
| 場所 | Vercel Blob の `log/YYYY-MM-DD.jsonl`（private）。日付は **JST**。1日 $5 の上限の区切りも JST にそろえた |
| 書き方 | **追記のみ**（既存の行は書き換えず、削除もしない） |
| 書き込みの失敗 | リクエストの処理は止めない。失敗はエラーログ（標準エラー）に、書けなかった行ごと残す |
| ローカルファイル | 開発時だけ。`NODE_ENV=development` かつ `LOG_SINK=file` のときに限る。Sandbox の運用でも Live でも使えない |

Vercel Blob には追記の API が無い。そのため「読む → 末尾に1行足す → ETag が一致するときだけ書き戻す」で追記し、競合したらやり直す。書き戻す内容は常に「読んだ内容そのまま＋新しい行」で、これを書き込み前に確かめる。複数台で動かしても行は失われない（`test/blob-store.test.ts`）。

### 実証2の読み方

```bash
curl -H "Authorization: Bearer $LOG_READ_TOKEN" "$GATEWAY_URL/logs/2026-10-14"
```

- `:date` は JST の `YYYY-MM-DD` で、その日の jsonl を返す
- `LOG_READ_TOKEN` でできるのは、この GET だけ。GET 以外は 405 を返し、書き込み・削除の口は無い
- Blob の読み書きトークンはゲートウェイの外に出さない

### 各行の項目

次の8項目は、どの行にも必ず入る。欠けた行は書かず、エラーとして残す。

| 項目 | 内容 |
|---|---|
| `time_utc` | UTC の時刻（ISO 8601） |
| `date_jst` | JST の日付（ファイル名と同じ） |
| `tokenId` | 匿名化したトークン ID（塩付き SHA-256）。トークンなしは `none` |
| `planKind` | プラン種別（`prepaid`） |
| `verify` | `valid` / 無効理由 / `skipped` |
| `settle` | `ok` / エラー内容 / `skipped` |
| `creditsConsumed` | 消費クレジット |
| `upstreamTx` | 裏側の x402 の tx 署名。支払っていなければ `none` |

ほかに次も記録する。

- 結果（`outcome`）と HTTP ステータス
- 支払元の匿名 ID
- 裏側の額
- Nevermined の settle tx
- カードの自動補充の参照
- 応答時間

トークンそのものは記録しない。

## 測定と週次レポート（§5）

```bash
cp reports/inputs/card-payments.example.json reports/inputs/card-payments.json   # Stripe / Nevermined の管理画面から転記
npm run report:weekly            # 先週分（GATEWAY_URL と LOG_READ_TOKEN があれば GET /logs/:date から読む）
npm run report:weekly -- 2026-W42
```

レポートの項目は次の6つ（追加指示 v2 §5）。出せない項目は「未計測（理由）」と書く。

| 項目 | 出し方 |
|---|---|
| カード手数料 | `reports/inputs/card-payments.json`（Stripe の明細から転記。Nevermined 2% ＋ Stripe の手数料）と、売上に対する割合 |
| 1コールあたりの原価 | ログの `upstreamTx` がある行の x402 の額 ＋ チェーン手数料 |
| 1コールあたりの粗利 | クレジット換算の売上 − 原価 − カード手数料の按分 |
| 購入から利用開始までの時間 | 決済完了 → 委任作成 → トークン発行 → 最初の 200 の各区間（`log/events.jsonl` とゲートウェイのログ） |
| 残高切れの挙動 | 402 の回数（結果別）、買い手の停止・再開の時刻 |
| 経理上の扱い | 記入欄だけ置く（人が記録する） |

公表値（1クレジット = $0.01、prepaid-100 = $1 / 100 クレジット、JIN series = $0.01）では、売上換算と裏側の原価が同額になる。粗利はカード手数料（Nevermined 2% ＋ Stripe）の分だけマイナスになる見込み。価格を見直すときの基準として測定する（§2）。

## テスト

```bash
npm run typecheck
npm test
```

ネットワークや Nevermined にはつながない。

| ファイル | 内容 |
|---|---|
| `test/handler.test.ts` | 処理順序。上流の失敗時と上限到達時に消費しないこと、同時リクエストで残高を超えないこと |
| `test/logstore.test.ts` | JST の日付でファイルを分けること、必須項目、書き込みに失敗しても止めないこと、`GET /logs/:date`（トークン必須、GET のみ、未設定なら閉じる） |
| `test/blob-store.test.ts` | 2プロセスから同時に追記しても行が失われないこと |
| `test/new-wallet.test.ts` | 作った鍵でゲートウェイが動き、`docs/wallet.md` には公開アドレスだけが書かれること |
| `test/x402-upstream.test.ts` | ローカルの擬似 x402 サーバーに本物の x402 クライアントで支払う。上限・価格不一致・メインネットの資産の場合に、署名もせず送信もしないこと |
| `test/budget.test.ts` / `test/pricing.test.ts` | 上限の値、日付の切り替わり、価格とクレジットの整合 |
