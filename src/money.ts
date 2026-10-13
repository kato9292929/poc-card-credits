/**
 * 金額はすべて「マイクロUSD」（1 USD = 1_000_000）の bigint で扱う。
 * USDC は小数6桁なので、USDC の atomic 単位とマイクロUSDは一致する。
 * 浮動小数点で上限判定をしないための型。
 */
export type MicroUsd = bigint;

export const MICRO_PER_USD = 1_000_000n;

/** "0.01" や "5" のような10進文字列をマイクロUSDに変換する。小数7桁以上は拒否する。 */
export function usdToMicro(usd: string): MicroUsd {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usd.trim());
  if (!m) throw new Error(`invalid USD amount: "${usd}"`);
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? '').padEnd(6, '0'));
  return whole * MICRO_PER_USD + frac;
}

export function microToUsd(micro: MicroUsd): string {
  const neg = micro < 0n;
  const abs = neg ? -micro : micro;
  const whole = abs / MICRO_PER_USD;
  const frac = (abs % MICRO_PER_USD).toString().padStart(6, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** 任意の小数桁の atomic 量をマイクロUSDに換算する（USDC 以外の6桁でない資産用。端数は切り上げ＝保守的）。 */
export function atomicToMicro(amount: string, decimals: number): MicroUsd {
  if (!/^\d+$/.test(amount)) throw new Error(`invalid atomic amount: "${amount}"`);
  const a = BigInt(amount);
  if (decimals === 6) return a;
  if (decimals < 6) return a * 10n ** BigInt(6 - decimals);
  const div = 10n ** BigInt(decimals - 6);
  return (a + div - 1n) / div;
}
