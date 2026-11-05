import { SupportedChainKey, SupportedToken } from "./chains";
import walletsMainnet from "./wallets.mainnet.json";
import walletsTestnet from "./wallets.testnet.json";

export interface WalletConfig {
  chainKey: SupportedChainKey;
  chainId?: number;
  token?: SupportedToken;
  address: string;
}

interface WalletsJson {
  wallets: WalletConfig[];
}

/**
 * Get wallet addresses from configuration.
 * Returns testnet wallets when testnet mode is active, mainnet otherwise.
 */
export function getWalletAddresses(testnet = false): WalletConfig[] {
  const source = (testnet ? walletsTestnet : walletsMainnet) as WalletsJson;
  return source.wallets || [];
}

/**
 * Find wallet address for a specific chain/token combination
 */
export function findWalletAddress(
  chainKey: SupportedChainKey,
  token: SupportedToken,
  chainId?: number,
  testnet = false,
): string | null {
  const wallets = getWalletAddresses(testnet);

  if (chainId) {
    const exact = wallets.find(
      (w) =>
        w.chainKey === chainKey && w.chainId === chainId && w.token === token,
    );
    if (exact) return exact.address;
  }

  const chainTokenMatch = wallets.find(
    (w) => w.chainKey === chainKey && w.token === token,
  );
  if (chainTokenMatch) return chainTokenMatch.address;

  const chainOnly = wallets.find((w) => w.chainKey === chainKey && !w.token);
  if (chainOnly) return chainOnly.address;

  return null;
}

/**
 * Validate if an address is a configured wallet address
 */
export function isValidWalletAddress(address: string): boolean {
  const wallets = [
    ...getWalletAddresses(false),
    ...getWalletAddresses(true),
  ];
  const normalized = address.toLowerCase();
  return wallets.some((w) => w.address.toLowerCase() === normalized);
}
