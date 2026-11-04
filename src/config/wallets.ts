import { SupportedChainKey, SupportedToken } from "./chains";
import wallets from "./wallets.mainnet.json";

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
 * Get wallet addresses from configuration
 */
export function getWalletAddresses(): WalletConfig[] {
  return (wallets as WalletsJson).wallets || [];
}

/**
 * Find wallet address for a specific chain/token combination
 */
export function findWalletAddress(
  chainKey: SupportedChainKey,
  token: SupportedToken,
  chainId?: number,
): string | null {
  const wallets = getWalletAddresses();

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
  const wallets = getWalletAddresses();
  const normalized = address.toLowerCase();
  return wallets.some((w) => w.address.toLowerCase() === normalized);
}
