export type SupportedChainKey =
  | "bsc"
  | "eth"
  | "btc"
  | "pol"
  | "base"
  | "arbitrum"
  | "op"
  | "avax"
  | "plasma";

export type SupportedToken =
  | "ETH"
  | "BTC"
  | "USDT"
  | "USDC"
  | "BNB"
  | "POL"
  | "AVAX"
  | "XPL";

export interface ChainConfig {
  key: SupportedChainKey;
  name: string;
  chainId?: number;
  isEvm: boolean;
  rpcUrls: string[];
  nativeToken: SupportedToken;
  nativeDecimals: number;
  tokens: SupportedToken[];
  explorerUrl: string;
}

const MAINNET_CHAINS_CONFIG: Record<SupportedChainKey, ChainConfig> = {
  bsc: {
    key: "bsc",
    name: "BNB Smart Chain",
    chainId: 56,
    isEvm: true,
    rpcUrls: [
      "https://binance.llamarpc.com",
      "https://bsc-dataseed.binance.org",
      "https://bsc-dataseed1.defibit.io",
      "https://bsc-dataseed1.ninicoin.io",
      "https://rpc.ankr.com/bsc",
      "https://1rpc.io/bnb",
    ],
    nativeToken: "BNB",
    nativeDecimals: 18,
    tokens: ["USDT", "USDC", "BNB"],
    explorerUrl: "https://bscscan.com",
  },
  eth: {
    key: "eth",
    name: "Ethereum",
    chainId: 1,
    isEvm: true,
    rpcUrls: [
      "https://eth.llamarpc.com",
      "https://cloudflare-eth.com",
      "https://ethereum.publicnode.com",
      "https://rpc.ankr.com/eth",
      "https://1rpc.io/eth",
      "https://mainnet.gateway.tenderly.co",
    ],
    nativeToken: "ETH",
    nativeDecimals: 18,
    tokens: ["ETH", "USDT", "USDC"],
    explorerUrl: "https://etherscan.io",
  },
  btc: {
    key: "btc",
    name: "Bitcoin Network",
    isEvm: false,
    rpcUrls: ["https://mempool.space/api", "https://blockstream.info/api"],
    nativeToken: "BTC",
    nativeDecimals: 8,
    tokens: ["BTC"],
    explorerUrl: "https://mempool.space",
  },
  pol: {
    key: "pol",
    name: "Polygon",
    chainId: 137,
    isEvm: true,
    rpcUrls: [
      "https://polygon.llamarpc.com",
      "https://polygon-rpc.com",
      "https://rpc.ankr.com/polygon",
      "https://1rpc.io/matic",
      "https://polygon.drpc.org",
    ],
    nativeToken: "POL",
    nativeDecimals: 18,
    tokens: ["USDT", "USDC", "POL"],
    explorerUrl: "https://polygonscan.com",
  },
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    isEvm: true,
    rpcUrls: [
      "https://mainnet.base.org",
      "https://base.llamarpc.com",
      "https://base.meowrpc.com",
      "https://rpc.ankr.com/base",
      "https://1rpc.io/base",
    ],
    nativeToken: "ETH",
    nativeDecimals: 18,
    tokens: ["ETH", "USDC"],
    explorerUrl: "https://basescan.org",
  },
  arbitrum: {
    key: "arbitrum",
    name: "Arbitrum One",
    chainId: 42161,
    isEvm: true,
    rpcUrls: [
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum.llamarpc.com",
      "https://arbitrum-one.publicnode.com",
      "https://rpc.ankr.com/arbitrum",
      "https://1rpc.io/arb",
    ],
    nativeToken: "ETH",
    nativeDecimals: 18,
    tokens: ["ETH", "USDT", "USDC"],
    explorerUrl: "https://arbiscan.io",
  },
  op: {
    key: "op",
    name: "Optimism",
    chainId: 10,
    isEvm: true,
    rpcUrls: [
      "https://mainnet.optimism.io",
      "https://optimism.llamarpc.com",
      "https://optimism-rpc.publicnode.com",
      "https://rpc.ankr.com/optimism",
      "https://1rpc.io/op",
    ],
    nativeToken: "ETH",
    nativeDecimals: 18,
    tokens: ["ETH", "USDT", "USDC"],
    explorerUrl: "https://optimistic.etherscan.io",
  },
  avax: {
    key: "avax",
    name: "Avalanche",
    chainId: 43114,
    isEvm: true,
    rpcUrls: [
      "https://api.avax.network/ext/bc/C/rpc",
      "https://avalanche.drpc.org",
      "https://1rpc.io/avax/c",
      "https://rpc.ankr.com/avalanche-c",
    ],
    nativeToken: "AVAX",
    nativeDecimals: 18,
    tokens: ["AVAX", "USDT", "USDC"],
    explorerUrl: "https://snowtrace.io",
  },
  plasma: {
    key: "plasma",
    name: "Plasma",
    chainId: 9745,
    isEvm: true,
    rpcUrls: ["https://rpc.plasma.to", "https://rpc.plasmachain.net"],
    nativeToken: "XPL",
    nativeDecimals: 18,
    tokens: ["XPL", "USDC"],
    explorerUrl: "https://plasmascan.to",
  },
};

const TESTNET_CHAINS_CONFIG: Record<SupportedChainKey, ChainConfig> = {
  bsc: {
    key: "bsc",
    name: "BNB Smart Chain Testnet",
    chainId: 97,
    isEvm: true,
    rpcUrls: [
      "https://data-seed-prebsc-1-s1.binance.org:8545",
      "https://bsc-testnet.publicnode.com",
      "https://data-seed-prebsc-2-s1.binance.org:8545",
    ],
    nativeToken: "BNB",
    nativeDecimals: 18,
    tokens: ["USDT", "USDC", "BNB"],
    explorerUrl: "https://testnet.bscscan.com",
  },
  eth: {
    key: "eth",
    name: "Ethereum Sepolia",
    chainId: 11155111,
    isEvm: true,
    rpcUrls: [
      "https://ethereum-sepolia.publicnode.com",
      "https://1rpc.io/sepolia",
      "https://gateway.tenderly.co/public/sepolia",
      "https://rpc.ankr.com/eth_sepolia",
    ],
    nativeToken: "ETH",
    nativeDecimals: 18,
    tokens: ["ETH", "USDT", "USDC"],
    explorerUrl: "https://sepolia.etherscan.io",
  },
  btc: {
    key: "btc",
    name: "Bitcoin Testnet",
    isEvm: false,
    rpcUrls: ["https://mempool.space/testnet/api"],
    nativeToken: "BTC",
    nativeDecimals: 8,
    tokens: ["BTC"],
    explorerUrl: "https://mempool.space/testnet",
  },
  pol: {
    key: "pol",
    name: "Polygon Amoy",
    chainId: 80002,
    isEvm: true,
    rpcUrls: [
      "https://polygon-amoy.drpc.org",
      "https://polygon-amoy-bor-rpc.publicnode.com",
      "https://rpc-amoy.polygon.technology",
    ],
    nativeToken: "POL",
    nativeDecimals: 18,
    tokens: ["USDT", "USDC", "POL"],
    explorerUrl: "https://amoy.polygonscan.com",
  },
  base: {
    key: "base",
    name: "Base Sepolia",
    chainId: 84532,
    isEvm: true,
    rpcUrls: [
      "https://sepolia.base.org",
      "https://base-sepolia-rpc.publicnode.com",
      "https://base-sepolia.drpc.org",
    ],
    nativeToken: "ETH",
    nativeDecimals: 18,
    tokens: ["ETH", "USDC"],
    explorerUrl: "https://sepolia.basescan.org",
  },
  arbitrum: {
    key: "arbitrum",
    name: "Arbitrum Sepolia",
    chainId: 421614,
    isEvm: true,
    rpcUrls: [
      "https://sepolia-rollup.arbitrum.io/rpc",
      "https://arbitrum-sepolia.drpc.org",
      "https://arbitrum-sepolia.publicnode.com",
    ],
    nativeToken: "ETH",
    nativeDecimals: 18,
    tokens: ["ETH", "USDT", "USDC"],
    explorerUrl: "https://sepolia.arbiscan.io",
  },
  op: {
    key: "op",
    name: "Optimism Sepolia",
    chainId: 11155420,
    isEvm: true,
    rpcUrls: [
      "https://sepolia.optimism.io",
      "https://optimism-sepolia.drpc.org",
      "https://optimism-sepolia.publicnode.com",
    ],
    nativeToken: "ETH",
    nativeDecimals: 18,
    tokens: ["ETH", "USDC"],
    explorerUrl: "https://optimism-sepolia.blockscout.com",
  },
  avax: {
    key: "avax",
    name: "Avalanche Fuji",
    chainId: 43113,
    isEvm: true,
    rpcUrls: [
      "https://api.avax-test.network/ext/bc/C/rpc",
      "https://avalanche-fuji-c-chain-rpc.publicnode.com",
      "https://1rpc.io/avax/c",
    ],
    nativeToken: "AVAX",
    nativeDecimals: 18,
    tokens: ["AVAX", "USDT", "USDC"],
    explorerUrl: "https://testnet.snowtrace.io",
  },
  plasma: {
    key: "plasma",
    name: "Plasma Testnet",
    chainId: 9746,
    isEvm: true,
    rpcUrls: ["https://testnet-rpc.plasma.to"],
    nativeToken: "XPL",
    nativeDecimals: 18,
    tokens: ["XPL", "USDC"],
    explorerUrl: "https://testnet.plasmascan.to",
  },
};

/**
 * Get chains configuration based on testnet mode
 */
export function getChainsConfig(
  testNetMode: boolean,
): Record<SupportedChainKey, ChainConfig> {
  return testNetMode ? TESTNET_CHAINS_CONFIG : MAINNET_CHAINS_CONFIG;
}

// Export mainnet as default for backward compatibility
export const CHAINS_CONFIG = MAINNET_CHAINS_CONFIG;

/**
 * RPC URLs mapped by specific chainId (supports both mainnets and testnets)
 */
export const CHAIN_ID_RPC_URLS: Record<number, string[]> = {
  // Mainnets
  1: [
    "https://eth.llamarpc.com",
    "https://cloudflare-eth.com",
    "https://ethereum.publicnode.com",
    "https://rpc.ankr.com/eth",
  ],
  56: [
    "https://binance.llamarpc.com",
    "https://bsc-dataseed.binance.org",
    "https://rpc.ankr.com/bsc",
  ],
  137: [
    "https://polygon.llamarpc.com",
    "https://polygon-rpc.com",
    "https://rpc.ankr.com/polygon",
  ],
  8453: [
    "https://mainnet.base.org",
    "https://base.llamarpc.com",
    "https://rpc.ankr.com/base",
  ],
  42161: [
    "https://arb1.arbitrum.io/rpc",
    "https://arbitrum.llamarpc.com",
    "https://rpc.ankr.com/arbitrum",
  ],
  10: [
    "https://mainnet.optimism.io",
    "https://optimism.llamarpc.com",
    "https://rpc.ankr.com/optimism",
  ],
  43114: [
    "https://api.avax.network/ext/bc/C/rpc",
    "https://avalanche.drpc.org",
    "https://rpc.ankr.com/avalanche-c",
  ],
  9745: ["https://rpc.plasma.to", "https://rpc.plasmachain.net"],

  // Testnets
  11155111: [
    "https://ethereum-sepolia.publicnode.com",
    "https://1rpc.io/sepolia",
    "https://gateway.tenderly.co/public/sepolia",
  ],
  97: [
    "https://data-seed-prebsc-1-s1.binance.org:8545",
    "https://bsc-testnet.publicnode.com",
  ],
  80002: [
    "https://polygon-amoy.drpc.org",
    "https://polygon-amoy-bor-rpc.publicnode.com",
  ],
  84532: [
    "https://sepolia.base.org",
    "https://base-sepolia-rpc.publicnode.com",
  ],
  421614: [
    "https://sepolia-rollup.arbitrum.io/rpc",
    "https://arbitrum-sepolia.drpc.org",
  ],
  11155420: [
    "https://sepolia.optimism.io",
    "https://optimism-sepolia.drpc.org",
  ],
  43113: [
    "https://api.avax-test.network/ext/bc/C/rpc",
    "https://avalanche-fuji-c-chain-rpc.publicnode.com",
  ],
  9746: ["https://testnet-rpc.plasma.to"],
};

export const DEFAULT_TESTNET_CHAIN_IDS: Record<SupportedChainKey, number> = {
  bsc: 97,
  eth: 11155111,
  pol: 80002,
  base: 84532,
  arbitrum: 421614,
  op: 11155420,
  avax: 43113,
  plasma: 9746,
  btc: 0,
};

export interface TokenContract {
  address: string;
  decimals: number;
}

export const ERC20_CONTRACTS: Record<
  number,
  Partial<Record<SupportedToken, TokenContract>>
> = {
  1: {
    USDT: {
      address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      decimals: 6,
    },
    USDC: {
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      decimals: 6,
    },
  },
  56: {
    USDT: {
      address: "0x55d398326f99059ff775485246999027b3197955",
      decimals: 18,
    },
    USDC: {
      address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
      decimals: 18,
    },
  },
  137: {
    USDT: {
      address: "0xc2132d05d31c914a87c6611c10748aeb04b58e8f",
      decimals: 6,
    },
    USDC: {
      address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
      decimals: 6,
    },
  },
  8453: {
    USDC: {
      address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      decimals: 6,
    },
  },
  42161: {
    USDT: {
      address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9",
      decimals: 6,
    },
    USDC: {
      address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      decimals: 6,
    },
  },
  10: {
    USDT: {
      address: "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58",
      decimals: 6,
    },
    USDC: {
      address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
      decimals: 6,
    },
  },
  43114: {
    USDT: {
      address: "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7",
      decimals: 6,
    },
    USDC: {
      address: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e",
      decimals: 6,
    },
  },
  9745: {
    USDC: {
      address: "0x2d661c89d812261039af9764eceaaee884f5f67f",
      decimals: 6,
    },
  },
  11155111: {
    USDT: {
      address: "0xab868415803cf3bdd382197159001bc0c0f3b6c2",
      decimals: 18,
    },
    USDC: {
      address: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
      decimals: 6,
    },
  },
  97: {
    USDT: {
      address: "0x337610d27c682e347c9cd60bd4b3b107c9632205",
      decimals: 18,
    },
    USDC: {
      address: "0x365476358d411c625e2e438f27a75f4c72950716",
      decimals: 18,
    },
  },
  80002: {
    USDT: {
      address: "0x056fd409e1d491d221329e89416b166c23615001",
      decimals: 6,
    },
    USDC: {
      address: "0x4129df7f446d49eaaf11e71f2c19d1fb80714c66",
      decimals: 6,
    },
  },
  84532: {
    USDC: {
      address: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      decimals: 6,
    },
  },
  421614: {
    USDT: {
      address: "0x250e7d8c26740fc616921369a0738f7a2ce69f85",
      decimals: 6,
    },
    USDC: {
      address: "0x75faf114edb188e3173481b5cade5cf340a529f3",
      decimals: 6,
    },
  },
  11155420: {
    USDC: {
      address: "0x5fd84259d66cd46123540766be93dfe6d43133df",
      decimals: 6,
    },
  },
  43113: {
    USDT: {
      address: "0x056fd409e1d491d221329e89416b166c23615001",
      decimals: 6,
    },
    USDC: {
      address: "0x5425890298aed601595a70ab815c96711a31bc65",
      decimals: 6,
    },
  },
};