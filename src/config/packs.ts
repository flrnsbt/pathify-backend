export interface CreditPack {
  id: string;
  credits: number;
  usdPrice: number;
  popular?: boolean;
}

export const CREDIT_PACKS: CreditPack[] = [
  {
    id: 'pack-25',
    credits: 25,
    usdPrice: 5,
  },
  {
    id: 'pack-100',
    credits: 100,
    usdPrice: 15,
    popular: true,
  },
  {
    id: 'pack-500',
    credits: 500,
    usdPrice: 50,
  },
];

/**
 * Find a pack by ID. Returns null if not found.
 */
export function findPackById(packId: string): CreditPack | null {
  return CREDIT_PACKS.find((pack) => pack.id === packId) || null;
}

/**
 * Fetches live token price in USD from CoinGecko API.
 * Cached for 60 seconds to avoid rate limits.
 */
let cachedPrices: Record<string, number> = {};
let pricesExpiresAt = 0;

export async function getTokenPriceUsd(tokenSymbol: string): Promise<number | null> {
  const now = Date.now();
  if (cachedPrices[tokenSymbol.toLowerCase()] && now < pricesExpiresAt) {
    return cachedPrices[tokenSymbol.toLowerCase()];
  }

  // Stablecoins are pegged to $1
  if (tokenSymbol.toUpperCase() === 'USDT' || tokenSymbol.toUpperCase() === 'USDC') {
    return 1;
  }

  const coinIdMap: Record<string, string> = {
    ETH: 'ethereum',
    BTC: 'bitcoin',
    BNB: 'binancecoin',
    POL: 'polygon-ecosystem-token',
    AVAX: 'avalanche-2',
    XPL: 'plasma-2',
  };

  const coinId = coinIdMap[tokenSymbol.toUpperCase()];
  if (!coinId) return null;

  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`
    );
    if (!res.ok) return null;

    const data = (await res.json()) as Record<string, { usd: number }>;
    const price = data[coinId]?.usd;
    if (!price || price <= 0) return null;

    cachedPrices[tokenSymbol.toLowerCase()] = price;
    pricesExpiresAt = now + 60000;
    return price;
  } catch {
    return null;
  }
}

/**
 * Calculates the crypto amount needed for a USD price.
 * For stablecoins (USDT/USDC), the amount equals the USD price.
 * For native tokens, converts using live price.
 */
export function calculateCryptoAmount(
  usdPrice: number,
  tokenSymbol: string,
  tokenPriceUsd?: number | null
): string | null {
  const upper = tokenSymbol.toUpperCase();
  if (upper === 'USDT' || upper === 'USDC') {
    return usdPrice.toFixed(2);
  }

  const price = tokenPriceUsd || cachedPrices[tokenSymbol.toLowerCase()];
  if (!price || price <= 0) return null;

  const amount = usdPrice / price;
  return amount.toFixed(6);
}
