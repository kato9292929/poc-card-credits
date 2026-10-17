import { readFileSync } from 'node:fs';
import assetsJson from '../../config/assets.json' with { type: 'json' };

export interface AllowedAsset {
  network: string;
  asset: string;
  symbol: string;
  decimals: number;
  testnet: boolean;
}

export function loadAssets(file?: string): AllowedAsset[] {
  return ((file ? JSON.parse(readFileSync(file, 'utf8')) : assetsJson) as { assets: AllowedAsset[] }).assets;
}

export function findAsset(list: AllowedAsset[], network: string, asset: string): AllowedAsset | undefined {
  // EVM アドレスは大文字小文字を区別しない。Solana の mint は区別する。
  const norm = (n: string, a: string) => (n.startsWith('eip155:') ? a.toLowerCase() : a);
  return list.find((x) => x.network === network && norm(network, x.asset) === norm(network, asset));
}
