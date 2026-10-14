# poc-card-percall からの取り込み記録

記録日: 2026-10-14

## 経緯

実証1 のリポジトリは `kato9292929/poc-card-credits` だけにする。最初の指示書にあった `poc-card-percall` は、`poc-card-credits` と読み替える。

ローカルに作った poc-card-percall（ブランチ `claude/hopeful-dirac-a7ia0c`、先頭 `6c88892`）は GitHub に push していない。下の取り込みの後に削除した。

取り込みの方針（一本化の指示 §1）:

- **percall にあって credits に無いもの**は、credits に移す
- **両方にあって中身が違うもの**は、credits 側を残す

## 対象5項目の突き合わせ

| 対象 | percall | credits | 結果 |
|---|---|---|---|
| payg 試験の経路 | ゲートウェイ経由。Sandbox ではゲートウェイが payg プランを受け付け、`payg:probe` がゲートウェイに1回リクエストする（裏側の x402 購入も1回走る）。プラン登録の拒否も記録 | Nevermined を直接呼ぶ。ゲートウェイも裏側の購入も通さない。プラン登録の拒否も記録 | **credits を残す**（両方にあり中身が違う）。Nevermined の請求の挙動だけを切り出せるので、試験の目的にも合う |
| Blob へのログ | `VercelBlobLogStore`（読む → 1行足す → ETag 条件付きで書き戻す）、`GatewayLogWriter`、`HttpLogReader`、同時書き込みテスト | 同じ部品に加え、追記のみの確認（書き戻す内容が既存の内容＋1行であることの検証）、改行を含む行の拒否、必須項目が欠けた行でも処理を止めない扱い、開発用の `FileLogStore` | **credits を残す**。percall にだけある機能は無い（credits が上位互換） |
| docs/wallet.md | 表の形式は同じ。文言が少し違う | 同上。`wallet:new` は秘密鍵を書かないことをテストで確認済み | **credits を残す** |
| 読み取りトークンの保管方法 | 発行したトークンの SHA-256 だけを `LOG_READ_TOKEN_SHA256` に置き、複数の値を許す（`src/gateway/log-access.ts`）。エンドポイントは `GET /logs`（日付一覧）と `GET /logs/YYYY-MM-DD.jsonl` | 7項目の修正指示 §2 のとおり、値をそのまま `LOG_READ_TOKEN` に持つ（32文字以上、定数時間で比較）。エンドポイントは `GET /logs/:date` | **credits を残す**。`log-access.ts` と日付一覧のエンドポイントは移さない |
| 起動条件 | (a) API キーのプレフィックス（`sandbox:` / `live:`）と `NVM_ENVIRONMENT` が一致しないと起動しない。(b) Blob のトークンが無いと起動しない。(c) Live で payg のプラン ID があると起動しない | (b) は `LOG_SINK=blob` のとき同じ。(a) は無かった。(c) は該当なし（ゲートウェイが payg を受け付けない） | **(a) を credits に移した**（下記）。(b) は credits を残す |

### 移したもの

1. **API キーのプレフィックスと `NVM_ENVIRONMENT` の一致確認**（percall の `nvmEnvironment()`）
   - `src/config.ts` に `nvmEnvironment(...keys)` を追加した。プレフィックスの解釈は SDK の `getEnvironmentFromApiKey` に合わせた
   - 使う場所:
     - ゲートウェイ（`loadGatewayConfig`）
     - `scripts/register-plan.ts` / `order-plan.ts` / `buyer-token.ts`
     - `scripts/payg-probe.ts`（売り手と買い手の両方のキー）
   - Live で `ALLOW_LIVE=true` が無いときの拒否も、この関数にまとめた
   - テスト: `test/logstore.test.ts` の「API key prefix must match NVM_ENVIRONMENT」（percall の `test/config.test.ts` から、該当する部分だけを移した）

### あわせて反映した決定事項（一本化の指示 §4）

- `LOG_SINK=file` は `NODE_ENV=development` のときだけ有効にした。Sandbox の運用でも、ゲートウェイのログは常に Vercel Blob に書く
- 日付の区切りは JST のまま。ログのファイル名、`GET /logs/:date`、1日 $5 の上限がすべて JST

## 対象外とした差分（移していない。判断が要るもの）

一本化の指示 §3 で「指示書の poc-card-percall の記述は poc-card-credits と読み替える」とされたので、percall 向けの指示書の内容も今後は credits に当たる。次の差分は §1 の対象5項目に入っていないため、移していない。percall 向けの指示書が credits に当たる以上、どちらに合わせるかを決める必要がある。

| 項目 | percall（percall 向けの指示書） | credits（credits 向けの指示書） |
|---|---|---|
| プラン | prepaid-100（$1、100 クレジット、30日で失効）と payg | starter（$10、1,000 クレジット、期限なし） |
| エージェント登録の `endpoints` | ゲートウェイの公開パスを登録する | 登録しない（`:ticker` のようなパスパラメータが使えるか未確認のため） |
| 買い手のトークン | 買い手が自分の API キーで委任を用意して発行する（`orderPlan` が使えなければ Stripe Checkout の URL を出す） | 人が `buyer:token` で発行し、エージェントは `NVM_ACCESS_TOKEN` から読む |
| 環境変数の名前 | `NVM_PLAN_ID_PREPAID` / `BUILDER_ADDRESS` / `GATEWAY_WALLET_*` / `PREPAID_BLOCK_TOPUP` | `NVM_PLAN_ID` / `NVM_RECEIVER_ADDRESS` / `GATEWAY_*` / `BLOCK_CARD_TOPUP` |
| 週次レポートの項目 | 決済1件の所要時間（ゲートウェイ経由 / x402 直接）、着金までの日数 | 購入から利用開始までの時間（区間別）、経理上の扱い（自動補充の件数） |
| docs/nevermined.md の記述 | Stripe Connect（日本のアカウントで使えるか、未確認）、委任のエラーコードの表、Crypto Card のコードの参照 | どれも無い |

percall のコードは削除したので、これらを取り込む場合は、この表と、この会話の percall 向け指示書をもとに credits で作り直す。
