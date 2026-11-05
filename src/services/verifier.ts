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
import type { Env } from "../index";

export interface VerificationResult {
  isConfirmed: boolean;
  isFailed: boolean;
  statusMessage: string;
  actualTxHash?: string;
  blockNumber?: number;
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
 * Normalizes an Ethereum address into 32-byte padded lowercase topic format
 */
function addressToTopic(address: string): string {
  const clean = address.toLowerCase().replace(/^0x/, "");
  return "0x" + clean.padStart(64, "0");
}

/**
 * Safely parses token amount with decimal places into BigInt without floating point errors or zero-stripping bugs
 */
function parseTokenUnits(amountStr: string, decimals: number): bigint {
  const trimmed = amountStr.trim();
  if (!trimmed || isNaN(Number(trimmed))) {
    throw new Error(`Invalid amount string: "${amountStr}"`);
  }

  const parts = trimmed.split(".");
  const wholePart = parts[0] || "0";
  let fractionPart = parts[1] || "";

  if (fractionPart.length > decimals) {
    fractionPart = fractionPart.slice(0, decimals);
  } else {
    fractionPart = fractionPart.padEnd(decimals, "0");
  }

  return BigInt(wholePart) * BigInt(10) ** BigInt(decimals) + BigInt(fractionPart);
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