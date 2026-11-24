import { Env } from "..";
import { SupportedChainKey, SupportedToken } from "./chains";
import mainnetWallets from "./wallets.mainnet.json";
import testnetWallets from "./wallets.testnet.json";

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
 * Check if testnet mode is enabled via TESTNET_SECRET
 * This secret is set in Cloudflare Worker secrets or local .dev.vars
 */
export function isTestnetMode(env: Env, testnetSecret?: string): boolean {
  if (!testnetSecret) {
    return false;
  }
  return testnetSecret === env.TESTNET_SECRET;
}

/**
 * Get wallet addresses based on mode (mainnet or testnet)
 */
export function getWalletAddresses(testNetMode: boolean): WalletConfig[] {
  if (testNetMode) {
    return (testnetWallets as WalletsJson).wallets || [];
  }
  return (mainnetWallets as WalletsJson).wallets || [];
}

/**
 * Find wallet address for a specific chain/token combination
 */
export function findWalletAddress(
  testNetMode: boolean,
  chainKey: SupportedChainKey,
  token: SupportedToken,
  chainId?: number,
): string | null {
  const wallets = getWalletAddresses(testNetMode);

  // Exact match with chainId and token
  if (chainId) {
    const exact = wallets.find(
      (w) =>
        w.chainKey === chainKey && w.chainId === chainId && w.token === token,
    );
    if (exact) return exact.address;
  }

  // Match by chainKey and token
  const chainTokenMatch = wallets.find(
    (w) => w.chainKey === chainKey && w.token === token,
  );
  if (chainTokenMatch) return chainTokenMatch.address;

  // Match by chainKey only (native token)
  const chainOnly = wallets.find((w) => w.chainKey === chainKey && !w.token);
  if (chainOnly) return chainOnly.address;

  return null;
}

/**
 * Validate if an address is a configured wallet address
 */
export function isValidWalletAddress(
  testNetMode: boolean,

  address: string,
): boolean {
  const wallets = getWalletAddresses(testNetMode);
  const normalized = address.toLowerCase();
  return wallets.some((w) => w.address.toLowerCase() === normalized);
}
