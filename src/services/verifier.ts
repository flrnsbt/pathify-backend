import {
  CHAIN_ID_CONFIG,
  CHAIN_ID_RPC_URLS,
  ERC20_CONTRACTS,
  SupportedChainKey,
  SupportedToken,
} from "../config/chains";
import { isValidWalletAddress } from "../config/wallets";
import { CryptoTransactionDoc, getGoogleAccessToken } from "./firestore";
import { getUserEvmAddress } from "./user-wallet";
import { parseTokenUnits } from "./amounts";
import type { Env } from "../index";

export interface VerificationResult {
  isConfirmed: boolean;
  isFailed: boolean;
  statusMessage: string;
  actualTxHash?: string;
  blockNumber?: number;
  /** Last block scanned by a direct-payment sweep; persisted on the tx doc. */
  nextScanCursor?: number;
}

/** Structured verification logging so pending/failed txs are diagnosable from worker logs. */
function vlog(txId: string | undefined, step: string, data?: Record<string, unknown>): void {
  const prefix = txId ? `[VERIFY ${txId}]` : "[VERIFY]";
  if (data) {
    console.log(`${prefix} ${step}`, JSON.stringify(data));
  } else {
    console.log(`${prefix} ${step}`);
  }
}

/**
 * Standard JSON-RPC caller with multiple fallback endpoints
 */
async function callEvmRpc(
  chainKey: SupportedChainKey,
  method: string,
  params: any[],
  chainId?: number,
): Promise<any> {
  // Prefer chainId-based lookup, fall back to chainKey-based lookup
  let rpcUrls: string[] | undefined;
  if (chainId != null) {
    const chainConfig = CHAIN_ID_CONFIG[chainId];
    if (chainConfig && chainConfig.isEvm) {
      rpcUrls = chainConfig.rpcUrls;
    }
  }
  if (!rpcUrls) {
    rpcUrls = CHAIN_ID_RPC_URLS[chainId ?? -1];
  }
  if (!rpcUrls) {
    throw new Error(`No RPC endpoints found for chain ${chainKey}${chainId != null ? ` (chainId ${chainId})` : ''}`);
  }
  let lastError: Error | null = null;
  for (const rpcUrl of rpcUrls) {
    try {
      const started = Date.now();
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Math.floor(Math.random() * 100000),
          method,
          params,
        }),
      });

      if (!res.ok) {
        console.warn(`[RPC] ${method} on ${rpcUrl} -> HTTP ${res.status} (${Date.now() - started}ms)`);
        continue;
      }
      const data = (await res.json()) as any;
      if (data.error) {
        lastError = new Error(data.error.message || "RPC Error");
        console.warn(`[RPC] ${method} on ${rpcUrl} -> error: ${lastError.message} (${Date.now() - started}ms)`);
        continue;
      }
      console.log(`[RPC] ${method} on ${rpcUrl} -> ok (${Date.now() - started}ms)`);
      return data.result;
    } catch (err: any) {
      lastError = err;
      console.warn(`[RPC] ${method} on ${rpcUrl} -> threw: ${err?.message}`);
    }
  }

  throw lastError || new Error(`All RPC endpoints failed for ${chainKey}`);
}

/**
 * Batched JSON-RPC caller. Sends all requests in a single POST per endpoint
 * and returns results aligned with the input order. Entries whose RPC call
 * returned an error are returned as undefined.
 */
async function callEvmRpcBatch(
  chainKey: SupportedChainKey,
  calls: Array<{ method: string; params: any[] }>,
  chainId?: number,
): Promise<any[]> {
  if (calls.length === 0) return [];

  let rpcUrls: string[] | undefined;
  if (chainId != null) {
    const chainConfig = CHAIN_ID_CONFIG[chainId];
    if (chainConfig && chainConfig.isEvm) rpcUrls = chainConfig.rpcUrls;
  }
  if (!rpcUrls) rpcUrls = CHAIN_ID_RPC_URLS[chainId ?? -1];
  if (!rpcUrls) {
    throw new Error(`No RPC endpoints found for chain ${chainKey}`);
  }

  let lastError: Error | null = null;
  for (const rpcUrl of rpcUrls) {
    try {
      const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          calls.map((c, i) => ({
            jsonrpc: "2.0",
            id: i + 1,
            method: c.method,
            params: c.params,
          })),
        ),
      });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as any;
      if (!Array.isArray(data)) {
        lastError = new Error("Batch RPC returned non-array response");
        continue;
      }
      const byId = new Map<number, any>();
      for (const item of data) {
        if (item && typeof item.id === "number") byId.set(item.id, item.result);
      }
      return calls.map((_, i) => byId.get(i + 1));
    } catch (err: any) {
      lastError = err;
    }
  }
  throw lastError || new Error(`All RPC endpoints failed for ${chainKey}`);
}

/** Conservative (lower-bound) average block times used to estimate how far
 *  back to scan for a direct payment. Smaller values scan more blocks —
 *  always the safe direction. Keyed by chainId (mainnet + testnet). */
const CHAIN_BLOCK_TIME_MS: Record<number, number> = {
  1: 12000,        // Ethereum
  56: 750,         // BNB Smart Chain
  137: 2000,       // Polygon
  8453: 2000,      // Base
  42161: 250,      // Arbitrum One
  10: 2000,        // Optimism
  43114: 2000,     // Avalanche C-Chain
  9745: 1000,      // Plasma
  11155111: 12000, // Ethereum Sepolia
  97: 1000,        // BNB Smart Chain Testnet
  80002: 2000,     // Polygon Amoy
  84532: 2000,     // Base Sepolia
  421614: 250,     // Arbitrum Sepolia
  11155420: 2000,  // Optimism Sepolia
  43113: 2000,     // Avalanche Fuji
  9746: 1000,      // Plasma Testnet
};

const DEFAULT_BLOCK_TIME_MS = 2000;

/** Max blocks scanned per verification run. Bounds RPC work per sweep; the
 *  persisted scanCursor resumes where the previous run stopped. */
const DIRECT_SCAN_BLOCKS_ERC20 = 5000;
const DIRECT_SCAN_BLOCKS_NATIVE = 400;
const DIRECT_SCAN_BATCH_SIZE = 100;

/** Clock-skew tolerance applied to on-chain timestamps vs doc timestamps. */
const DIRECT_TIME_SKEW_MS = 10 * 60 * 1000;

const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function toHexBlock(n: number): string {
  return "0x" + n.toString(16);
}

/**
 * Normalizes an Ethereum address into 32-byte padded lowercase topic format
 */
function addressToTopic(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  return "0x" + clean.padStart(64, "0");
}

/**
 * Verifies an EVM transaction receipt and transfer contents
 */
async function verifyEvmTransaction(
  chainKey: SupportedChainKey,
  txHash: string,
  expectedRecipient: string,
  expectedAmount: string,
  token: SupportedToken,
  chainId?: number,
  txId?: string,
  userAddress?: string | null,
): Promise<VerificationResult> {
  try {
    vlog(txId, "evm.verify.start", {
      chainKey,
      chainId,
      txHash,
      token,
      expectedRecipient,
      expectedAmount,
    });

    // SECURITY: recipient must be a configured payment wallet OR the tx owner's
    // own generated EVM address (per-user deposit wallets).
    const isUserAddress =
      userAddress != null &&
      expectedRecipient.toLowerCase() === userAddress.toLowerCase();
    if (!isValidWalletAddress(expectedRecipient) && !isUserAddress) {
      vlog(txId, "evm.verify.fail", { reason: "recipient-not-configured", expectedRecipient });
      return {
        isConfirmed: false,
        isFailed: true,
        statusMessage:
          "Invalid recipient address: not a configured payment wallet.",
      };
    }

    // Resolve chain config from chainId (single source of truth)
    const chain = chainId != null ? CHAIN_ID_CONFIG[chainId] : undefined;
    if (!chain) {
      vlog(txId, "evm.verify.fail", { reason: "unknown-chainId", chainId });
      return {
        isConfirmed: false,
        isFailed: true,
        statusMessage: `Unknown chainId: ${chainId}`,
      };
    }
    vlog(txId, "evm.verify.chain-resolved", {
      resolvedKey: chain.key,
      resolvedName: chain.name,
      resolvedChainId: chain.chainId,
      isEvm: chain.isEvm,
      nativeToken: chain.nativeToken,
      rpcCount: chain.rpcUrls.length,
    });

    let receipt = await callEvmRpc(
      chainKey,
      "eth_getTransactionReceipt",
      [txHash],
      chainId,
    );

    // Transaction not yet mined
    if (!receipt) {
      vlog(txId, "evm.verify.pending", { reason: "receipt-not-found", txHash, chainId });
      return {
        isConfirmed: false,
        isFailed: false,
        statusMessage: "Transaction pending inclusion in block.",
      };
    }

    vlog(txId, "evm.verify.receipt", {
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      logCount: (receipt.logs || []).length,
    });

    // Status: 0x0 is reverted/failed, 0x1 is success
    if (receipt.status === "0x0") {
      vlog(txId, "evm.verify.fail", { reason: "tx-reverted", txHash });
      return {
        isConfirmed: false,
        isFailed: true,
        statusMessage: "Transaction reverted on-chain.",
      };
    }

    const isNative = token === chain.nativeToken;
    vlog(txId, "evm.verify.mode", { isNative, token, nativeToken: chain.nativeToken });

    if (isNative) {
      // Verify Native transfer (ETH, BNB, POL, AVAX, XPL)
      const tx = await callEvmRpc(
        chainKey,
        "eth_getTransactionByHash",
        [txHash],
        chainId,
      );
      if (!tx) {
        vlog(txId, "evm.verify.pending", { reason: "tx-body-not-found", txHash });
        return {
          isConfirmed: false,
          isFailed: false,
          statusMessage:
            "Transaction found in receipt but awaiting full block synchronization.",
        };
      }

      const txTo = (tx.to || "").toLowerCase();
      const expectedTo = expectedRecipient.toLowerCase();
      vlog(txId, "evm.verify.native-check", {
        txTo,
        expectedTo,
        txValue: tx.value,
        expectedAmount,
      });

      if (txTo !== expectedTo) {
        vlog(txId, "evm.verify.fail", { reason: "recipient-mismatch", txTo, expectedTo });
        return {
          isConfirmed: false,
          isFailed: true,
          statusMessage: `Recipient mismatch: expected ${expectedRecipient}, received ${tx.to}`,
        };
      }

      const expectedWei = parseTokenUnits(expectedAmount, chain.nativeDecimals || 18);
      const actualWei = BigInt(tx.value || "0x0");

      // Allow 1% tolerance for gas estimation or rounding differences
      const minRequired = (expectedWei * 99n) / 100n;
      if (actualWei < minRequired) {
        vlog(txId, "evm.verify.fail", {
          reason: "amount-insufficient",
          expectedWei: expectedWei.toString(),
          actualWei: actualWei.toString(),
          minRequired: minRequired.toString(),
        });
        return {
          isConfirmed: false,
          isFailed: true,
          statusMessage: `Amount insufficient: expected ${expectedAmount} ${token}`,
        };
      }

      vlog(txId, "evm.verify.confirmed", { path: "native", blockNumber: receipt.blockNumber });
      return {
        isConfirmed: true,
        isFailed: false,
        statusMessage: `Confirmed in block ${parseInt(receipt.blockNumber, 16)}`,
        actualTxHash: txHash,
        blockNumber: parseInt(receipt.blockNumber, 16),
      };
    } else {
      // Verify ERC-20 token transfer (USDT, USDC)
      const effectiveId = chainId || chain.chainId || 1;
      const contractConfig = ERC20_CONTRACTS[effectiveId]?.[token];

      // SECURITY FIX: Reject unconfigured token contracts to prevent log spoofing attacks
      if (!contractConfig?.address) {
        vlog(txId, "evm.verify.fail", {
          reason: "contract-not-configured",
          effectiveId,
          token,
          availableChains: Object.keys(ERC20_CONTRACTS),
        });
        return {
          isConfirmed: false,
          isFailed: true,
          statusMessage: `ERC-20 token ${token} address configuration missing for chain ID ${effectiveId}.`,
        };
      }
      vlog(txId, "evm.verify.contract", {
        effectiveId,
        token,
        contractAddress: contractConfig.address,
        decimals: contractConfig.decimals,
      });

      const decimals =
        contractConfig.decimals ||
        (token === "USDT" || token === "USDC" ? 6 : 18);
      const expectedPaddedRecipient = addressToTopic(expectedRecipient);
      const transferTopic =
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

      let transferFound = false;
      let transferredAmount = 0n;
      const scannedLogs: Array<{ address: string; topic0?: string; matched: boolean }> = [];

      for (const log of receipt.logs || []) {
        if (!log.topics || log.topics.length < 3) continue;
        if (log.topics[0].toLowerCase() !== transferTopic) continue;

        // SECURITY FIX: Strict contract address matching required
        const contractMatch =
          !!log.address &&
          log.address.toLowerCase() === contractConfig.address.toLowerCase();
        scannedLogs.push({ address: log.address, topic0: log.topics[0], matched: contractMatch });
        if (!contractMatch) {
          continue;
        }

        const recipientTopic = log.topics[2].toLowerCase();
        if (recipientTopic === expectedPaddedRecipient) {
          transferFound = true;
          transferredAmount += BigInt(log.data || "0x0");
        }
      }
      vlog(txId, "evm.verify.log-scan", {
        transferLogsFound: scannedLogs.length,
        transferFound,
        transferredAmount: transferredAmount.toString(),
        expectedRecipientTopic: expectedPaddedRecipient,
        scannedLogs: scannedLogs.slice(0, 10),
      });

      if (!transferFound) {
        vlog(txId, "evm.verify.fail", { reason: "no-transfer-event", expectedRecipient });
        return {
          isConfirmed: false,
          isFailed: true,
          statusMessage: `ERC-20 transfer event to ${expectedRecipient} not found in transaction logs.`,
        };
      }

      const expectedUnits = parseTokenUnits(expectedAmount, decimals);
      const minRequired = (expectedUnits * 99n) / 100n;

      if (transferredAmount < minRequired) {
        vlog(txId, "evm.verify.fail", {
          reason: "token-amount-insufficient",
          transferredAmount: transferredAmount.toString(),
          expectedUnits: expectedUnits.toString(),
          minRequired: minRequired.toString(),
          decimals,
        });
        return {
          isConfirmed: false,
          isFailed: true,
          statusMessage: `Token transfer amount insufficient: received ${transferredAmount}, expected ${expectedUnits}`,
        };
      }

      vlog(txId, "evm.verify.confirmed", { path: "erc20", blockNumber: receipt.blockNumber });
      return {
        isConfirmed: true,
        isFailed: false,
        statusMessage: `ERC-20 Transfer confirmed in block ${parseInt(receipt.blockNumber, 16)}`,
        actualTxHash: txHash,
        blockNumber: parseInt(receipt.blockNumber, 16),
      };
    }
  } catch (err: any) {
    vlog(txId, "evm.verify.error", { error: err?.message, stack: err?.stack });
    return {
      isConfirmed: false,
      isFailed: false,
      statusMessage: `RPC verification check error: ${err.message}`,
    };
  }
}

/**
 * Verifies a Bitcoin transaction via Mempool.space public REST API
 */
async function verifyBtcTransaction(
  txHash: string | undefined,
  expectedRecipient: string,
  expectedAmount: string,
  createdAtMs: number,
  txId?: string,
  opts?: { requireExactAmount?: boolean; expiresAtMs?: number },
): Promise<VerificationResult> {
  vlog(txId, "btc.verify.start", { txHash, expectedRecipient, expectedAmount });
  // SECURITY: Validate that recipient is a configured wallet address
  if (!isValidWalletAddress(expectedRecipient)) {
    vlog(txId, "btc.verify.fail", { reason: "recipient-not-configured", expectedRecipient });
    return {
      isConfirmed: false,
      isFailed: true,
      statusMessage:
        "Invalid recipient address: not a configured payment wallet.",
    };
  }
  const isTestnetBtc =
    expectedRecipient.startsWith("tb1") ||
    expectedRecipient.startsWith("m") ||
    expectedRecipient.startsWith("n") ||
    expectedRecipient.startsWith("2");

  const mempoolBase = isTestnetBtc
    ? "https://mempool.space/testnet/api"
    : "https://mempool.space/api";

  const expectedSatoshis = parseTokenUnits(expectedAmount, 8);
  const minSatoshis = (expectedSatoshis * 99n) / 100n;

  // 1. If user supplied txHash, verify it directly
  if (txHash && txHash.trim()) {
    try {
      const res = await fetch(`${mempoolBase}/tx/${txHash.trim()}`);
      if (!res.ok) {
        return {
          isConfirmed: false,
          isFailed: false,
          statusMessage: "Transaction not found in Bitcoin mempool yet.",
        };
      }

      const tx = (await res.json()) as any;
      const isConfirmed = tx.status?.confirmed === true;

      // Look for output to expected address
      let matchedOutputValue = 0n;
      for (const vout of tx.vout || []) {
        if (vout.scriptpubkey_address === expectedRecipient) {
          matchedOutputValue += BigInt(vout.value || 0);
        }
      }

      if (matchedOutputValue < minSatoshis) {
        return {
          isConfirmed: false,
          isFailed: true,
          statusMessage: `Output to ${expectedRecipient} was ${matchedOutputValue} satoshis (expected ${expectedSatoshis}).`,
        };
      }

      if (!isConfirmed) {
        return {
          isConfirmed: false,
          isFailed: false,
          statusMessage:
            "Bitcoin transaction seen in mempool; awaiting block confirmation.",
        };
      }

      return {
        isConfirmed: true,
        isFailed: false,
        statusMessage: `Bitcoin transaction confirmed in block ${tx.status.block_height}`,
        actualTxHash: txHash,
        blockNumber: tx.status.block_height,
      };
    } catch (err: any) {
      return {
        isConfirmed: false,
        isFailed: false,
        statusMessage: `Mempool API check error: ${err.message}`,
      };
    }
  }

  // 2. If no txHash was provided (e.g. user sent via QR code and clicked 'I Have Sent')
  try {
    const res = await fetch(`${mempoolBase}/address/${expectedRecipient}/txs`);
    if (!res.ok) {
      return {
        isConfirmed: false,
        isFailed: false,
        statusMessage: "Awaiting incoming Bitcoin transaction.",
      };
    }

    const txs = (await res.json()) as any[];
    const createdTimestampSec = Math.floor(createdAtMs / 1000) - 3600; // allow 1 hour clock skew
    const expiresTimestampSec = opts?.expiresAtMs
      ? Math.floor(opts.expiresAtMs / 1000) + Math.floor(DIRECT_TIME_SKEW_MS / 1000)
      : undefined;

    for (const tx of txs) {
      const txTime = tx.status?.block_time || Math.floor(Date.now() / 1000);
      if (txTime < createdTimestampSec) continue;
      if (expiresTimestampSec != null && txTime > expiresTimestampSec) continue;

      let matchedSatoshis = 0n;
      for (const vout of tx.vout || []) {
        if (vout.scriptpubkey_address === expectedRecipient) {
          matchedSatoshis += BigInt(vout.value || 0);
        }
      }

      // Direct payments carry a unique amount tag: require an exact match so
      // only the intended transfer can be credited.
      const amountMatches = opts?.requireExactAmount
        ? matchedSatoshis === expectedSatoshis
        : matchedSatoshis >= minSatoshis;

      if (amountMatches) {
        if (tx.status?.confirmed) {
          return {
            isConfirmed: true,
            isFailed: false,
            statusMessage: `Bitcoin transfer detected & confirmed in block ${tx.status.block_height}`,
            actualTxHash: tx.txid,
            blockNumber: tx.status.block_height,
          };
        } else {
          return {
            isConfirmed: false,
            isFailed: false,
            statusMessage: `Bitcoin transaction ${tx.txid.slice(0, 8)}... seen in mempool; awaiting block confirmation.`,
            actualTxHash: tx.txid,
          };
        }
      }
    }

    return {
      isConfirmed: false,
      isFailed: false,
      statusMessage: "No matching transaction detected on Bitcoin network yet.",
    };
  } catch (err: any) {
    return {
      isConfirmed: false,
      isFailed: false,
      statusMessage: `Error scanning address on mempool: ${err.message}`,
    };
  }
}

/** Fetches a block's unix timestamp (seconds); null on error/missing. */
async function getBlockTimestampSec(
  chainKey: SupportedChainKey,
  blockNumber: number,
  chainId?: number,
): Promise<number | null> {
  try {
    const block = await callEvmRpc(
      chainKey,
      "eth_getBlockByNumber",
      [toHexBlock(blockNumber), false],
      chainId,
    );
    if (!block) return null;
    return parseInt(block.timestamp || "0x0", 16);
  } catch {
    return null;
  }
}

/**
 * Verifies a direct (manual/QR) EVM payment by scanning the chain for an
 * incoming transfer of the exact unique amount — no tx hash is accepted.
 * ERC-20 tokens are detected via Transfer event logs; native tokens via
 * block scanning. Progress is tracked by tx.scanCursor so each sweep only
 * scans new blocks.
 */
async function verifyEvmDirectTransaction(
  tx: CryptoTransactionDoc,
): Promise<VerificationResult> {
  const txId = tx.id;
  const chainId = tx.chainId;
  const chain = chainId != null ? CHAIN_ID_CONFIG[chainId] : undefined;
  if (!chain || !chain.isEvm) {
    vlog(txId, "direct.evm.fail", { reason: "unknown-chain", chainId });
    return {
      isConfirmed: false,
      isFailed: true,
      statusMessage: `Unknown chainId: ${chainId}`,
    };
  }

  const isNative = tx.cryptoToken === chain.nativeToken;
  const effectiveId = chainId || chain.chainId || 1;
  let decimals: number;
  let contractAddress: string | null = null;

  if (isNative) {
    decimals = chain.nativeDecimals || 18;
  } else {
    const contractConfig = ERC20_CONTRACTS[effectiveId]?.[tx.cryptoToken];
    if (!contractConfig?.address) {
      vlog(txId, "direct.evm.fail", {
        reason: "contract-not-configured",
        effectiveId,
        token: tx.cryptoToken,
      });
      return {
        isConfirmed: false,
        isFailed: true,
        statusMessage: `ERC-20 token ${tx.cryptoToken} address configuration missing for chain ID ${effectiveId}.`,
      };
    }
    decimals =
      contractConfig.decimals ||
      (tx.cryptoToken === "USDT" || tx.cryptoToken === "USDC" ? 6 : 18);
    contractAddress = contractConfig.address;
  }

  let expectedUnits: bigint;
  try {
    expectedUnits = parseTokenUnits(tx.cryptoAmount, decimals);
  } catch {
    return {
      isConfirmed: false,
      isFailed: true,
      statusMessage: `Invalid expected amount: ${tx.cryptoAmount}`,
    };
  }

  const recipient = tx.toAddress.toLowerCase();

  let latest: number;
  try {
    const res = await callEvmRpc(tx.chainKey, "eth_blockNumber", [], chainId);
    latest = parseInt(res, 16);
  } catch (err: any) {
    return {
      isConfirmed: false,
      isFailed: false,
      statusMessage: `RPC error fetching latest block: ${err?.message}`,
    };
  }

  // Scan window: resume after the persisted cursor, or estimate the block
  // range covering [createdAt, now] on the first run.
  let fromBlock: number;
  if (tx.scanCursor != null && tx.scanCursor >= 0) {
    fromBlock = tx.scanCursor + 1;
  } else {
    const blockTime =
      CHAIN_BLOCK_TIME_MS[chainId ?? -1] ?? DEFAULT_BLOCK_TIME_MS;
    const ageMs = Date.now() - tx.createdAt + DIRECT_TIME_SKEW_MS;
    const estBack = Math.ceil(ageMs / blockTime) + 20;
    fromBlock = Math.max(0, latest - estBack);
  }

  if (fromBlock > latest) {
    return {
      isConfirmed: false,
      isFailed: false,
      statusMessage: "Awaiting incoming transfer on-chain.",
      nextScanCursor: tx.scanCursor,
    };
  }

  const spanLimit = isNative
    ? DIRECT_SCAN_BLOCKS_NATIVE
    : DIRECT_SCAN_BLOCKS_ERC20;
  const toBlock = Math.min(fromBlock + spanLimit - 1, latest);

  vlog(txId, "direct.evm.scan", {
    chainId,
    token: tx.cryptoToken,
    isNative,
    fromBlock,
    toBlock,
    latest,
    expectedUnits: expectedUnits.toString(),
  });

  if (isNative) {
    // Native transfer: scan full blocks for txs sending the exact amount.
    // The cursor only advances past blocks that were fully fetched — a
    // failed block fetch stops the scan so no range is silently skipped.
    const blockNums: number[] = [];
    for (let b = fromBlock; b <= toBlock; b++) blockNums.push(b);
    let cursorSafe = fromBlock - 1;

    for (let i = 0; i < blockNums.length; i += DIRECT_SCAN_BATCH_SIZE) {
      const chunk = blockNums.slice(i, i + DIRECT_SCAN_BATCH_SIZE);
      const chunkStart = chunk[0];
      const chunkEnd = chunk[chunk.length - 1];
      let blocks: any[] | null = null;
      try {
        blocks = await callEvmRpcBatch(
          tx.chainKey,
          chunk.map((n) => ({
            method: "eth_getBlockByNumber",
            params: [toHexBlock(n), true],
          })),
          chainId,
        );
      } catch (batchErr: any) {
        // Some endpoints reject batch requests — fall back to sequential
        // fetches for this chunk.
        vlog(txId, "direct.evm.batch-fallback", { error: batchErr?.message });
      }
      if (blocks == null) {
        blocks = [];
        for (const n of chunk) {
          try {
            blocks.push(
              await callEvmRpc(
                tx.chainKey,
                "eth_getBlockByNumber",
                [toHexBlock(n), true],
                chainId,
              ),
            );
          } catch {
            blocks.push(null);
          }
        }
      }

      // Any missing block means the chunk is incomplete — stop here and let
      // the next sweep rescan from cursorSafe + 1.
      if (blocks.length !== chunk.length || blocks.some((b) => b == null)) {
        vlog(txId, "direct.evm.scan-incomplete", { chunkStart, chunkEnd });
        break;
      }
      cursorSafe = chunkEnd;

      for (let j = 0; j < chunk.length; j++) {
        const block = blocks[j];
        if (!block.transactions) continue;

        const blockTsMs = parseInt(block.timestamp || "0x0", 16) * 1000;
        if (blockTsMs && blockTsMs < tx.createdAt - DIRECT_TIME_SKEW_MS) continue;
        if (tx.expiresAt && blockTsMs > tx.expiresAt + DIRECT_TIME_SKEW_MS) continue;

        const blockNumber = parseInt(block.number || "0x0", 16);
        for (const t of block.transactions) {
          if (!t || !t.to || !t.hash) continue;
          if (t.to.toLowerCase() !== recipient) continue;
          let value: bigint;
          try {
            value = BigInt(t.value || "0x0");
          } catch {
            continue;
          }
          if (value !== expectedUnits) continue;

          // Exact amount + recipient match — confirm the tx actually succeeded.
          try {
            const receipt = await callEvmRpc(
              tx.chainKey,
              "eth_getTransactionReceipt",
              [t.hash],
              chainId,
            );
            if (receipt && receipt.status === "0x1") {
              vlog(txId, "direct.evm.confirmed", {
                path: "native-scan",
                txHash: t.hash,
                blockNumber,
              });
              return {
                isConfirmed: true,
                isFailed: false,
                statusMessage: `Direct transfer confirmed in block ${blockNumber}`,
                actualTxHash: t.hash,
                blockNumber,
              };
            }
          } catch {
            // Receipt lookup failed — keep scanning
          }
        }
      }
    }

    return {
      isConfirmed: false,
      isFailed: false,
      statusMessage: "No matching transfer detected on-chain yet.",
      nextScanCursor: cursorSafe >= fromBlock ? cursorSafe : tx.scanCursor,
    };
  }

  // ERC-20: scan Transfer event logs to the recipient for the exact amount.
  // Chunked into 1000-block ranges — many public RPCs cap eth_getLogs range.
  const expectedTopic = addressToTopic(tx.toAddress);
  const logs: any[] = [];
  let cursorSafe = fromBlock - 1;
  const LOG_CHUNK = 1000;

  for (let b = fromBlock; b <= toBlock; b += LOG_CHUNK) {
    const chunkTo = Math.min(b + LOG_CHUNK - 1, toBlock);
    let result: any;
    try {
      result = await callEvmRpc(
        tx.chainKey,
        "eth_getLogs",
        [
          {
            address: contractAddress,
            topics: [ERC20_TRANSFER_TOPIC, null, expectedTopic],
            fromBlock: toHexBlock(b),
            toBlock: toHexBlock(chunkTo),
          },
        ],
        chainId,
      );
    } catch (err: any) {
      vlog(txId, "direct.evm.logscan-error", {
        fromBlock: b,
        toBlock: chunkTo,
        error: err?.message,
      });
      break;
    }
    if (Array.isArray(result)) logs.push(...result);
    cursorSafe = chunkTo;
  }

  // Sum Transfer amounts per transaction hash — a payment may be split
  // across multiple logs, but the total must equal the unique amount exactly.
  const sums = new Map<string, { sum: bigint; blockNumber: number }>();
  for (const log of logs) {
    if (!log || !log.address || !log.topics || log.topics.length < 3) continue;
    if (log.address.toLowerCase() !== contractAddress!.toLowerCase()) continue;
    if (log.topics[0].toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
    if (log.topics[2].toLowerCase() !== expectedTopic) continue;
    if (!log.transactionHash) continue;
    let data: bigint;
    try {
      data = BigInt(log.data || "0x0");
    } catch {
      continue;
    }
    const entry = sums.get(log.transactionHash) || {
      sum: 0n,
      blockNumber: parseInt(log.blockNumber || "0x0", 16),
    };
    entry.sum += data;
    sums.set(log.transactionHash, entry);
  }

  for (const [txHash, info] of sums) {
    if (info.sum !== expectedUnits) continue;

    const blockTsSec = await getBlockTimestampSec(
      tx.chainKey,
      info.blockNumber,
      chainId,
    );
    if (blockTsSec != null) {
      const tsMs = blockTsSec * 1000;
      if (tsMs < tx.createdAt - DIRECT_TIME_SKEW_MS) continue;
      if (tx.expiresAt && tsMs > tx.expiresAt + DIRECT_TIME_SKEW_MS) continue;
    }

    vlog(txId, "direct.evm.confirmed", {
      path: "erc20-log-scan",
      txHash,
      blockNumber: info.blockNumber,
    });
    return {
      isConfirmed: true,
      isFailed: false,
      statusMessage: `ERC-20 transfer confirmed in block ${info.blockNumber}`,
      actualTxHash: txHash,
      blockNumber: info.blockNumber,
    };
  }

  return {
    isConfirmed: false,
    isFailed: false,
    statusMessage: "No matching transfer detected on-chain yet.",
    nextScanCursor: cursorSafe >= fromBlock ? cursorSafe : tx.scanCursor,
  };
}

/**
 * Verifies a direct (manual/QR) payment. These transactions carry a unique
 * server-generated amount and an expiry — the amount itself is the payment
 * identifier, so no user-supplied tx hash is ever accepted.
 */
async function verifyDirectTransaction(
  tx: CryptoTransactionDoc,
): Promise<VerificationResult> {
  if (tx.expiresAt && Date.now() > tx.expiresAt) {
    return {
      isConfirmed: false,
      isFailed: true,
      statusMessage:
        "Direct payment window expired before the transfer was detected on-chain.",
    };
  }

  if (tx.chainKey === "btc") {
    return verifyBtcTransaction(
      undefined,
      tx.toAddress,
      tx.cryptoAmount,
      tx.createdAt,
      tx.id,
      { requireExactAmount: true, expiresAtMs: tx.expiresAt },
    );
  }

  return verifyEvmDirectTransaction(tx);
}

/**
 * Universal transaction verifier across EVM and Bitcoin networks
 */
export async function verifyCryptoTransaction(
  tx: CryptoTransactionDoc,
  env?: Env,
): Promise<VerificationResult> {
  vlog(tx.id, "tx.verify.dispatch", {
    chainKey: tx.chainKey,
    chainId: tx.chainId,
    cryptoToken: tx.cryptoToken,
    txHash: tx.txHash ? `${tx.txHash.slice(0, 10)}…` : "(none)",
    toAddress: tx.toAddress,
    cryptoAmount: tx.cryptoAmount,
    paymentMethod: (tx as any).paymentMethod,
  });

  // Direct/manual payments are identified by their unique amount and are
  // verified by scanning the chain — a user-supplied tx hash is never used.
  if (tx.paymentMethod === "direct") {
    const result = await verifyDirectTransaction(tx);
    vlog(tx.id, "tx.verify.result", {
      isConfirmed: result.isConfirmed,
      isFailed: result.isFailed,
      statusMessage: result.statusMessage,
    });
    return result;
  }

  if (tx.chainKey === "btc") {
    return await verifyBtcTransaction(
      tx.txHash,
      tx.toAddress,
      tx.cryptoAmount,
      tx.createdAt,
      tx.id,
    );
  }

  if (!tx.txHash || !tx.txHash.startsWith("0x")) {
    vlog(tx.id, "tx.verify.pending", { reason: "no-txhash", chainKey: tx.chainKey });
    return {
      isConfirmed: false,
      isFailed: false,
      statusMessage: "Awaiting transaction hash from user or wallet.",
    };
  }

  // Resolve the tx owner's EVM address so transfers to per-user wallets verify
  let userAddress: string | null = null;
  if (env?.FIREBASE_PROJECT_ID && tx.userId) {
    try {
      const accessToken = await getGoogleAccessToken(
        env.FIREBASE_CLIENT_EMAIL,
        env.FIREBASE_PRIVATE_KEY,
      );
      userAddress = await getUserEvmAddress(
        env.FIREBASE_PROJECT_ID,
        accessToken,
        tx.userId,
      );
    } catch (err) {
      vlog(tx.id, "evm.verify.user-address-error", { error: String(err) });
    }
  }

  const result = await verifyEvmTransaction(
    tx.chainKey,
    tx.txHash,
    tx.toAddress,
    tx.cryptoAmount,
    tx.cryptoToken,
    tx.chainId,
    tx.id,
    userAddress,
  );
  vlog(tx.id, "tx.verify.result", {
    isConfirmed: result.isConfirmed,
    isFailed: result.isFailed,
    statusMessage: result.statusMessage,
  });
  return result;
}