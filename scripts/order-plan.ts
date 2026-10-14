/**
 * 買い手（法人の担当者）がプランをカードで購入する。Stripe Checkout の URL を出し、
 * 決済完了でクレジットが付与されるまで残高をポーリングして、時刻を log/events.jsonl に記録する。
 * 「購入から利用開始までの時間」（§5）の起点になる。
 *
 *   NVM_API_KEY=<買い手のキー> npm run plan:order
 */
import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { Payments } from '@nevermined-io/payments';
import { nvmEnvironment, required } from '../src/config.ts';
import { appendFileSync, mkdirSync } from 'node:fs';

// キーのプレフィックスと NVM_ENVIRONMENT の一致を確かめる（live は ALLOW_LIVE=true が必要）
const environment = nvmEnvironment(required('NVM_API_KEY'));
const payments = Payments.getInstance({ nvmApiKey: required('NVM_API_KEY'), environment });
const planId = required('NVM_PLAN_ID');
const logDir = process.env.LOG_DIR ?? 'log';
mkdirSync(logDir, { recursive: true });
const event = (e: object) => appendFileSync(`${logDir}/events.jsonl`, JSON.stringify({ ts: new Date().toISOString(), ...e }) + '\n');

const before = await payments.plans.getPlanBalance(planId);
const startBalance = BigInt(before.balance);

const { result } = await payments.plans.orderFiatPlan(planId);
event({ event: 'checkout_created', environment, planId, stripeCheckoutSessionId: result.stripeCheckoutSessionId, startBalance: startBalance.toString() });
console.log(`カード決済ページ（Stripe Checkout）:\n  ${result.checkoutLink}\n`);
if (environment === 'sandbox') console.log('sandbox では Stripe のテストカード（例 4242 4242 4242 4242）を使う。');
console.log('決済完了後、クレジットの付与を待っています… (Ctrl-C で中断)');

const deadline = Date.now() + 30 * 60_000;
while (Date.now() < deadline) {
  await sleep(5000);
  const b = await payments.plans.getPlanBalance(planId);
  if (BigInt(b.balance) > startBalance) {
    event({ event: 'credits_available', environment, planId, holder: b.holderAddress, balance: String(b.balance), stripeCheckoutSessionId: result.stripeCheckoutSessionId });
    console.log(`クレジット付与を確認: 残高 ${b.balance}`);
    process.exit(0);
  }
}
console.error('30分以内にクレジットが付与されませんでした');
process.exit(1);
