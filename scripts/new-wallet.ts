/**
 * ゲートウェイ専用のウォレットを新規に作る（AA のウォレットは使わない）。
 * 公開アドレスを docs/wallet.md に追記する（実証2の除外リスト用）。
 *
 *   npm run wallet:new            # Solana
 *   npm run wallet:new -- --evm   # EVM（Base）も作る場合
 *
 * 秘密鍵は標準出力に出すだけ。.env（コミットしない）に貼り、ほかの場所には残さないこと。
 * docs/wallet.md の変更（公開アドレスのみ）はコミットする。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base58 } from '@scure/base';

const environment = process.env.NVM_ENVIRONMENT ?? 'sandbox';
const live = environment === 'live';
// Sandbox でも上流（OSD / JIN）を mainnet で買う設定なら、ウォレットは mainnet 用（src/config.ts の UPSTREAM_MAINNET_PURCHASE）
const mainnet = live || process.env.UPSTREAM_MAINNET_PURCHASE === 'true';
const doc = process.env.WALLET_DOC ?? 'docs/wallet.md';
if (!existsSync(doc) || !readFileSync(doc, 'utf8').includes('| 作成日時（UTC）')) throw new Error(`${doc} の表が見つからない`);

// Solana: 64 バイトの秘密鍵（seed 32 ＋ 公開鍵 32）を base58 で
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
const svmKey = base58.encode(Buffer.concat([seed, pub]));
const svmAddress = base58.encode(pub);
const svmNetwork = mainnet ? 'Solana mainnet' : 'Solana devnet';

const evm = process.argv.includes('--evm')
  ? (() => {
      const key = generatePrivateKey();
      return { key, address: privateKeyToAccount(key).address, network: mainnet ? 'Base' : 'Base Sepolia' };
    })()
  : undefined;

const now = new Date().toISOString();
appendFileSync(doc, `| ${now} | ${environment} | ${svmNetwork} | \`${svmAddress}\` | ゲートウェイ（x402 の支払い元） |\n`);
if (evm) appendFileSync(doc, `| ${now} | ${environment} | ${evm.network} | \`${evm.address}\` | ゲートウェイ（x402 の支払い元） |\n`);

const logDir = process.env.LOG_DIR ?? 'log';
mkdirSync(logDir, { recursive: true });
appendFileSync(`${logDir}/events.jsonl`, JSON.stringify({ ts: now, event: 'gateway_wallet_created', svmAddress, evmAddress: evm?.address }) + '\n');

console.log(`# 新規作成したゲートウェイ専用ウォレット（${now}）。.env に貼る（コミットしない）
GATEWAY_WALLET_SECRET=${svmKey}${evm ? `\nGATEWAY_EVM_PRIVATE_KEY=${evm.key}` : ''}

# 公開アドレス（${doc} に追記済み。コミットする）
#   ${svmNetwork}: ${svmAddress}${evm ? `\n#   ${evm.network}: ${evm.address}` : ''}`);
