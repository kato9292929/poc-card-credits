/**
 * ゲートウェイ専用のウォレットを新規に作る（指示書 §3：AA のウォレットは使わない）。
 * 秘密鍵は標準出力にだけ出す。.env に貼り、ファイルやチャットには残さないこと。
 * アドレス（公開情報）だけを log/events.jsonl に記録し、/healthz の表示と照合できるようにする。
 *
 *   npm run wallet:new
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base58 } from '@scure/base';

const evmKey = generatePrivateKey();
const evmAddress = privateKeyToAccount(evmKey).address;

// Solana: 64 バイトの秘密鍵（seed 32 ＋ 公開鍵 32）を base58 で
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
const svmKey = base58.encode(Buffer.concat([seed, pub]));
const svmAddress = base58.encode(pub);

const logDir = process.env.LOG_DIR ?? 'log';
mkdirSync(logDir, { recursive: true });
appendFileSync(`${logDir}/events.jsonl`, JSON.stringify({ ts: new Date().toISOString(), event: 'gateway_wallet_created', evmAddress, svmAddress }) + '\n');

console.log(`# 新規作成したゲートウェイ専用ウォレット（${new Date().toISOString()}）。.env に貼る
GATEWAY_EVM_PRIVATE_KEY=${evmKey}
GATEWAY_SVM_PRIVATE_KEY=${svmKey}
# アドレス（テストネットの USDC はここに入れる）
#   EVM (Base Sepolia): ${evmAddress}
#   Solana (devnet):    ${svmAddress}`);
