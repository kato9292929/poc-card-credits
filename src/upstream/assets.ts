import { readFileSync } from 'node:fs';

export interface AllowedAsset {
  network: string;
  asset: string;
  symbol: string;
  decimals: number;
  testnet: boolean;
}

export function loadAssets(file = 'config/assets.json'): AllowedAsset[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { assets: AllowedAsset[] }).assets;
}

export function findAsset(list: AllowedAsset[], network: string, asset: string): AllowedAsset | undefined {
  // EVM アドレスは大文字小文字を区別しない。Solana の mint は区別する。
  const norm = (n: string, a: string) => (n.startsWith('eip155:') ? a.toLowerCase() : a);
  return list.find((x) => x.network === network && norm(network, x.asset) === norm(network, asset));
}
