import { readFileSync, existsSync } from 'node:fs';
import sandboxJson from '../config/sandbox.json' with { type: 'json' };

/**
 * config/sandbox.json の秘密でない設定値を、環境変数が未設定のときだけ process.env に入れる。
 * プラン ID・エージェント ID・公開 URL・上流の URL はコミットしてよい値なので、Vercel の環境変数に
 * 何度も入れ直さなくて済むようにここで持つ。秘密（API キー・鍵・トークン）は対象外。
 */
// MAX_USD_PER_CALL / MAX_USD_PER_DAY は下げることしかできない（src/config.ts）。Sandbox での上限の確認（§3-5）で一時的に下げるのに使う
export const SETTING_KEYS = ['NVM_ENVIRONMENT', 'NVM_PLAN_ID', 'NVM_AGENT_ID', 'PUBLIC_BASE_URL', 'UPSTREAM_JIN_URL', 'UPSTREAM_OSD_URL', 'MAX_USD_PER_CALL', 'MAX_USD_PER_DAY', 'UPSTREAM_MAINNET_PURCHASE', 'NVM_RECEIVER_ADDRESS', 'NVM_PLAN_ID_PAYG'] as const;
/** テスト用に別ファイルを指定できる。未指定ならリポジトリの config/sandbox.json（静的 import で Vercel の関数にも含まれる） */
export const SETTINGS_FILE = process.env.SANDBOX_SETTINGS_FILE;

export function applySettings(file = SETTINGS_FILE): void {
  if (file && !existsSync(file)) return;
  const json = (file ? JSON.parse(readFileSync(file, 'utf8')) : sandboxJson) as Record<string, string>;
  for (const k of SETTING_KEYS) {
    if (!process.env[k] && typeof json[k] === 'string' && json[k] !== '') process.env[k] = json[k];
  }
}

applySettings();

/**
 * Nevermined の API キーを、貼り付けで入りがちな違いを吸収して整える。前後の空白・改行、
 * ゼロ幅文字や BOM、値を囲む引用符を取り除き、日本語入力の全角コロン（：）を半角（:）に直す。キーの中身は変えない
 */
export function normalizeNvmKey(v: string): string {
  return v.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim().replace(/^["'“”‘’](.*)["'“”‘’]$/s, '$1').trim().replace(/^([A-Za-z-]{1,20})\s*[：:]\s*/, '$1:');
}
for (const k of ['NVM_API_KEY_SELLER', 'NVM_API_KEY_BUYER'] as const) {
  const v = process.env[k];
  if (v) process.env[k] = normalizeNvmKey(v);
}
