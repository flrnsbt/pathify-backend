import {
  CHAIN_ID_RPC_URLS,
  DEFAULT_TESTNET_CHAIN_IDS,
  ERC20_CONTRACTS,
  getChainsConfig,
  SupportedChainKey,
  SupportedToken,
} from "../config/chains";
import { isValidWalletAddress } from "../config/wallets";
import { CryptoTransactionDoc } from "./firestore";

export interface VerificationResult {
  isConfirmed: boolean;
  isFailed: boolean;
  statusMessage: string;
  actualTxHash?: string;
  blockNumber?: number;
}

/**
 * Standard JSON-RPC caller with multiple fallback endpoints
 */
async function callEvmRpc(
  isTestnet: boolean,

  chainKey: SupportedChainKey,
  method: string,
  params: any[],
  chainId?: number,
): Promise<any> {
  const chainsConfig = getChainsConfig(isTestnet);
  const chain = chainsConfig[chainKey];
  if (!chain || !chain.isEvm) {
    throw new Error(`Chain ${chainKey} is not an EVM chain`);
  }

  const rpcUrls = (chainId && CHAIN_ID_RPC_URLS[chainId]) || chain.rpcUrls;
  let lastError: Error | null = null;
  for (const rpcUrl of rpcUrls) {
    try {
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

      if (!res.ok) continue;
      const data = (await res.json()) as any;
      if (data.error) {
        lastError = new Error(data.error.message || "RPC Error");
        continue;
      }
      return data.result;
    } catch (err: any) {
      lastError = err;
    }
  }

  throw lastError || new Error(`All RPC endpoints failed for ${chainKey}`);
}

/**
 * Normalizes an Ethereum address into 32-byte padded lowercase topic format
 */
function addressToTopic(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  return "0x" + clean.padStart(64, "0");
}

/**
 * Parses token amount with decimal places into BigInt
 */
function parseTokenUnits(amountStr: string, decimals: number): bigint {
  const [whole, fraction = ""] = amountStr.trim().split(".");
  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  const combined = `${whole}${paddedFraction}`.replace(/^0+/, "") || "0";
  return BigInt(combined);
}

/**
 * Verifies an EVM transaction receipt and transfer contents
 */
async function verifyEvmTransaction(
  isTestnet: boolean,
  chainKey: SupportedChainKey,
  txHash: string,
  expectedRecipient: string,
  expectedAmount: string,
  token: SupportedToken,
  chainId?: number,
): Promise<VerificationResult> {
  try {
    // SECURITY: Validate that recipient is a configured wallet address
    if (!isValidWalletAddress(expectedRecipient)) {
      return {
        isConfirmed: false,
        isFailed: true,
        statusMessage:
          "Invalid recipient address: not a configured payment wallet.",
      };
    }

    const chainsConfig = getChainsConfig(isTestnet);
    const chain = chainsConfig[chainKey];
    let effectiveChainId = chainId;
    let receipt = await callEvmRpc(
      isTestnet,

      chainKey,
      "eth_getTransactionReceipt",
      [txHash],
      effectiveChainId,
    );

    // If receipt not found and chainId was not specified, try testnet RPC as fallback
    if (!receipt && !chainId && DEFAULT_TESTNET_CHAIN_IDS[chainKey]) {
      try {
        const testnetReceipt = await callEvmRpc(
          isTestnet,

          chainKey,
          "eth_getTransactionReceipt",
          [txHash],
          DEFAULT_TESTNET_CHAIN_IDS[chainKey],
        );
        if (testnetReceipt) {
          receipt = testnetReceipt;
          effectiveChainId = DEFAULT_TESTNET_CHAIN_IDS[chainKey];
        }
      } catch {}
    }

    // Transaction not yet mined
    if (!receipt) {
      return {
        isConfirmed: false,
        isFailed: false,
        statusMessage: "Transaction pending inclusion in block.",
      };
    }

    // Status: 0x0 is reverted/failed, 0x1 is success
    if (receipt.status === "0x0") {
      return {
        isConfirmed: false,
        isFailed: true,
        statusMessage: "Transaction reverted on-chain.",
      };
    }

    const isNative = token === chain.nativeToken;

    if (isNative) {
      // Verify Native transfer (ETH, BNB, POL, AVAX, XPL)
      const tx = await callEvmRpc(
        isTestnet,

        chainKey,
        "eth_getTransactionByHash",
        [txHash],
        effectiveChainId,
      );
      if (!tx) {
        return {
          isConfirmed: false,
          isFailed: false,
          statusMessage:
            "Transaction found in receipt but awaiting full block synchronization.",
        };
      }

      const txTo = (tx.to || "").toLowerCase();
      const expectedTo = expectedRecipient.toLowerCase();

      if (txTo !== expectedTo) {
        return {
          isConfirmed: false,
          isFailed: true,
          statusMessage: `Recipient mismatch: expected ${expectedRecipient}, received ${tx.to}`,
        };
      }

      const expectedWei = parseTokenUnits(expectedAmount, 18);
      const actualWei = BigInt(tx.value || "0x0");

      // Allow 1% tolerance for gas estimation or rounding differences
      const minRequired = (expectedWei * 99n) / 100n;
      if (actualWei < minRequired) {
        return {
          isConfirmed: false,
          isFailed: true,
          statusMessage: `Amount insufficient: expected ${expectedAmount} ${token}`,
        };
      }

      return {
        isConfirmed: true,
        isFailed: false,
        statusMessage: `Confirmed in block ${parseInt(receipt.blockNumber, 16)}`,
        actualTxHash: txHash,
        blockNumber: parseInt(receipt.blockNumber, 16),
      };
    } else {
      // Verify ERC-20 token transfer (USDT, USDC)
      const effectiveId = effectiveChainId || chain.chainId || 1;
      const contractConfig = ERC20_CONTRACTS[effectiveId]?.[token];
      const decimals =
        contractConfig?.decimals ||
        (token === "USDT" || token === "USDC" ? 6 : 18);
      const expectedPaddedRecipient = addressToTopic(expectedRecipient);
      const transferTopic =
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

      let transferFound = false;
      let transferredAmount = 0n;

      for (const log of receipt.logs || []) {
        if (!log.topics || log.topics.length < 3) continue;
        if (log.topics[0].toLowerCase() !== transferTopic) continue;

        // Verify contract address matches configured token contract if known
        if (
          contractConfig?.address &&
          log.address &&
          log.address.toLowerCase() !== contractConfig.address.toLowerCase()
        ) {
          continue;
        }

        const recipientTopic = log.topics[2].toLowerCase();
        if (recipientTopic === expectedPaddedRecipient) {
          transferFound = true;
          transferredAmount += BigInt(log.data || "0x0");
        }
      }

      if (!transferFound) {
        return {
          isConfirmed: false,
          isFailed: true,
          statusMessage: `ERC-20 transfer event to ${expectedRecipient} not found in transaction logs.`,
        };
      }

      const expectedUnits = parseTokenUnits(expectedAmount, decimals);
      const minRequired = (expectedUnits * 99n) / 100n;

      if (transferredAmount < minRequired) {
        return {
          isConfirmed: false,
          isFailed: true,
          statusMessage: `Token transfer amount insufficient: received ${transferredAmount}, expected ${expectedUnits}`,
        };
      }

      return {
        isConfirmed: true,
        isFailed: false,
        statusMessage: `ERC-20 Transfer confirmed in block ${parseInt(receipt.blockNumber, 16)}`,
        actualTxHash: txHash,
        blockNumber: parseInt(receipt.blockNumber, 16),
      };
    }
  } catch (err: any) {
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
  isTestnet: boolean,
): Promise<VerificationResult> {
  // SECURITY: Validate that recipient is a configured wallet address
  if (!isValidWalletAddress(expectedRecipient)) {
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

    for (const tx of txs) {
      const txTime = tx.status?.block_time || Math.floor(Date.now() / 1000);
      if (txTime < createdTimestampSec) continue;

      let matchedSatoshis = 0n;
      for (const vout of tx.vout || []) {
        if (vout.scriptpubkey_address === expectedRecipient) {
          matchedSatoshis += BigInt(vout.value || 0);
        }
      }

      if (matchedSatoshis >= minSatoshis) {
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

/**
 * Universal transaction verifier across EVM and Bitcoin networks
 */
export async function verifyCryptoTransaction(
  tx: CryptoTransactionDoc,
): Promise<VerificationResult> {
  const isTestnet = tx.isTestnet ?? false;

  if (tx.chainKey === "btc") {
    return await verifyBtcTransaction(
      tx.txHash,
      tx.toAddress,
      tx.cryptoAmount,
      tx.createdAt,
      isTestnet,
    );
  }

  if (!tx.txHash || !tx.txHash.startsWith("0x")) {
    return {
      isConfirmed: false,
      isFailed: false,
      statusMessage: "Awaiting transaction hash from user or wallet.",
    };
  }

  return await verifyEvmTransaction(
    isTestnet,
    tx.chainKey,
    tx.txHash,
    tx.toAddress,
    tx.cryptoAmount,
    tx.cryptoToken,
    tx.chainId,
  );
}
