/**
 * 実証2が GET /logs/:date を読むための LOG_READ_TOKEN を生成して表示する（修正指示 §2）。
 *
 *   npm run logs:issue-read-token
 *
 * 表示された値を、ゲートウェイの環境変数 LOG_READ_TOKEN と、実証2の日次ジョブの両方に設定する。
 * どこにも保存しない。コミットしない（.env は .gitignore 済み）。入れ替えるときは再発行して両方を更新する。
 */
import { newReadToken } from '../src/gateway/log-routes.ts';

const token = newReadToken();
console.log(`LOG_READ_TOKEN=${token}

# 読み方（実証2）
#   curl -H "Authorization: Bearer $LOG_READ_TOKEN" "$GATEWAY_URL/logs/2026-10-14"`);
