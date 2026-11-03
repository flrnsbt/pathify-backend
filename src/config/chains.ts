export type SupportedChainKey = 'bsc' | 'eth' | 'btc' | 'pol' | 'base' | 'arbitrum';
export type SupportedToken = 'ETH' | 'BTC' | 'USDT' | 'USDC' | 'BNB' | 'POL';

export interface ChainConfig {
  key: SupportedChainKey;
  name: string;
  chainId?: number;
  isEvm: boolean;
  rpcUrls: string[];
  nativeToken: SupportedToken;
  tokens: SupportedToken[];
  explorerUrl: string;
}

export const CHAINS_CONFIG: Record<SupportedChainKey, ChainConfig> = {
  bsc: {
    key: 'bsc',
    name: 'BNB Smart Chain',
    chainId: 56,
    isEvm: true,
    rpcUrls: [
      'https://binance.llamarpc.com',
      'https://bsc-dataseed.binance.org',
      'https://bsc-dataseed1.defibit.io',
      'https://bsc-dataseed1.ninicoin.io',
    ],
    nativeToken: 'BNB',
    tokens: ['USDT', 'USDC', 'BNB'],
    explorerUrl: 'https://bscscan.com',
  },
  eth: {
    key: 'eth',
    name: 'Ethereum',
    chainId: 1,
    isEvm: true,
    rpcUrls: [
      'https://eth.llamarpc.com',
      'https://cloudflare-eth.com',
      'https://ethereum.publicnode.com',
      'https://rpc.ankr.com/eth',
    ],
    nativeToken: 'ETH',
    tokens: ['ETH', 'USDT', 'USDC'],
    explorerUrl: 'https://etherscan.io',
  },
  btc: {
    key: 'btc',
    name: 'Bitcoin Network',
    isEvm: false,
    rpcUrls: ['https://mempool.space/api'],
    nativeToken: 'BTC',
    tokens: ['BTC'],
    explorerUrl: 'https://mempool.space',
  },
  pol: {
    key: 'pol',
    name: 'Polygon',
    chainId: 137,
    isEvm: true,
    rpcUrls: [
      'https://polygon.llamarpc.com',
      'https://polygon-rpc.com',
      'https://rpc.ankr.com/polygon',
    ],
    nativeToken: 'POL',
    tokens: ['USDT', 'USDC', 'POL'],
    explorerUrl: 'https://polygonscan.com',
  },
  base: {
    key: 'base',
    name: 'Base',
    chainId: 8453,
    isEvm: true,
    rpcUrls: [
      'https://mainnet.base.org',
      'https://base.llamarpc.com',
      'https://base.meowrpc.com',
    ],
    nativeToken: 'ETH',
    tokens: ['ETH', 'USDC'],
    explorerUrl: 'https://basescan.org',
  },
  arbitrum: {
    key: 'arbitrum',
    name: 'Arbitrum One',
    chainId: 42161,
    isEvm: true,
    rpcUrls: [
      'https://arb1.arbitrum.io/rpc',
      'https://arbitrum.llamarpc.com',
      'https://arbitrum-one.publicnode.com',
    ],
    nativeToken: 'ETH',
    tokens: ['ETH', 'USDT', 'USDC'],
    explorerUrl: 'https://arbiscan.io',
  },
};

export interface TokenContract {
  address: string;
  decimals: number;
}

export const ERC20_CONTRACTS: Record<number, Partial<Record<SupportedToken, TokenContract>>> = {
  // Ethereum Mainnet (1)
  1: {
    USDT: { address: '0xdac17f958d2ee523a2206206994597c13d831ec7', decimals: 6 },
    USDC: { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
  },
  // BNB Smart Chain (56)
  56: {
    USDT: { address: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
    USDC: { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', decimals: 18 },
  },
  // Polygon PoS (137)
  137: {
    USDT: { address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', decimals: 6 },
    USDC: { address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6 },
  },
  // Base (8453)
  8453: {
    USDC: { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
  },
  // Arbitrum One (42161)
  42161: {
    USDT: { address: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', decimals: 6 },
    USDC: { address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },
  },
};
