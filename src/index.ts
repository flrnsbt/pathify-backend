import {
  getGoogleAccessToken,
  getPendingTransactions,
  updateTransactionDoc,
  confirmAndCreditAtomically,
  createSupportTicketDoc,
  createTransactionDoc,
  createHistoryDoc,
} from "./services/firestore";
import { verifyCryptoTransaction } from "./services/verifier";
import { handleCryptographicHandshake } from "./services/handshake";
import { sendSupportNotificationEmail } from "./services/email";
import { verifyWorkerSecurity } from "./services/security";
import type { TransactionScheduler } from "./services/scheduler";
import { getChainsConfig, getERC20ContractsForChains, SupportedChainKey, SupportedToken, DEFAULT_TESTNET_CHAIN_IDS } from "./config/chains";
import { getWalletAddresses, findWalletAddress } from "./config/wallets";
import { CREDIT_PACKS, findPackById, getTokenPriceUsd, calculateCryptoAmount } from "./config/packs";
import { GENERATIONS_PER_UNLOCK } from "./config/limits";
import { getOrCreateUserEvmAddress, getUserEvmAddress } from "./services/user-wallet";

export { TransactionScheduler } from "./services/scheduler";

export interface Env {
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  HANDSHAKE_SECRET?: string;
  API_SECRET?: string;
  TESTNET_SECRET?: string;
  WALLET_ENCRYPTION_SECRET?: string;
  SUPPORT_EMAIL?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  TRANSACTION_SCHEDULER?: DurableObjectNamespace<TransactionScheduler>;
}

export const ALLOWED_ORIGINS = [
  "https://vectorizerr.pages.dev",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

// Lazy tracking state: only runs active checks when a transaction has been created
let activeTrackingUntil = 0;

export function activateTransactionTracking(durationMs = 15 * 60 * 1000): void {
  activeTrackingUntil = Math.max(activeTrackingUntil, Date.now() + durationMs);
}

export function deactivateTransactionTracking(): void {
  activeTrackingUntil = 0;
}

export function hasActivePendingTracking(): boolean {
  return Date.now() < activeTrackingUntil;
}

export function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") || "";
  const isAllowed = ALLOWED_ORIGINS.includes(origin);

  return {
    ...(isAllowed ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, x-api-secret, X-Firebase-AppCheck, X-Testnet-Secret",
    Vary: "Origin",
  };
}

/**
 * Iterates through pending transactions, validates them on-chain,
 * updates Firestore documents, and increments user credits upon confirmation.
 */
export async function processPendingTransactions(
  env: Env,
  userIdFilter?: string,
): Promise<{
  processedCount: number;
  confirmedCount: number;
  failedCount: number;
  pendingCount: number;
  confirmed: Array<{ id: string; txHash?: string; credits: number }>;
  failed: Array<{ id: string; reason: string }>;
}> {
  const projectId = env.FIREBASE_PROJECT_ID as string;
  const accessToken = await getGoogleAccessToken(
    env.FIREBASE_CLIENT_EMAIL,
    env.FIREBASE_PRIVATE_KEY,
  );

  const pending = await getPendingTransactions(
    projectId,
    accessToken,
    userIdFilter,
  );

  const confirmed: Array<{ id: string; txHash?: string; credits: number }> = [];
  const failed: Array<{ id: string; reason: string }> = [];

  for (const tx of pending) {
    try {
      console.log(`[PROCESSING] Tx ${tx.id} for user ${tx.userId} on chain ${tx.chainKey} (${tx.cryptoToken})`);
      const verification = await verifyCryptoTransaction(tx, env);
      console.log(
        `[VERIFY-RESULT] Tx ${tx.id} chainKey=${tx.chainKey} chainId=${tx.chainId} ` +
        `confirmed=${verification.isConfirmed} failed=${verification.isFailed} ` +
        `msg="${verification.statusMessage}"`,
      );

      if (verification.isConfirmed) {
        const confirmedAt = Date.now();
        const finalTxHash = verification.actualTxHash || tx.txHash;

        // Atomic commit: mark confirmed AND increment credits in one transaction
        const success = await confirmAndCreditAtomically(
          projectId,
          accessToken,
          tx.id,
          tx.userId,
          tx.credits,
          confirmedAt,
          finalTxHash,
          verification.statusMessage,
        );

        if (success) {
          confirmed.push({
            id: tx.id,
            txHash: finalTxHash,
            credits: tx.credits,
          });

          console.log(
            `[CONFIRMED] Tx ${tx.id} for user ${tx.userId} (+${tx.credits} credits)`,
          );
        } else {
          console.warn(
            `[SKIP] Tx ${tx.id} atomic commit failed (may have been processed by another run)`,
          );
        }
      } else if (verification.isFailed) {
        await updateTransactionDoc(projectId, accessToken, tx.id, {
          status: "failed",
          statusMessage: verification.statusMessage,
          updatedAt: Date.now(),
        });

        failed.push({
          id: tx.id,
          reason: verification.statusMessage,
        });

        console.log(`[FAILED] Tx ${tx.id}: ${verification.statusMessage}`);
      } else {
        // Still pending - optionally update message if informative
        if (
          verification.statusMessage &&
          verification.statusMessage !== tx.statusMessage
        ) {
          await updateTransactionDoc(projectId, accessToken, tx.id, {
            statusMessage: verification.statusMessage,
            updatedAt: Date.now(),
          });
        }
      }
    } catch (err: any) {
      console.error(`Error processing transaction ${tx.id}:`, err);
    }
  }

  const remainingPending = pending.length - confirmed.length - failed.length;

  return {
    processedCount: pending.length,
    confirmedCount: confirmed.length,
    failedCount: failed.length,
    pendingCount: remainingPending,
    confirmed,
    failed,
  };
}

export default {
  /**
   * Cloudflare Cron Trigger (Scheduled event)
   * Operates lazily: if no pending transactions are actively being tracked,
   * it exits immediately in 1ms without querying Firestore or consuming resources.
   */
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Lazy check: skip execution if no transactions are actively pending
    if (!hasActivePendingTracking()) {
      console.log(
        `[CRON] Idle at ${new Date(event.scheduledTime).toISOString()}: No active pending transactions. Skipping execution.`,
      );
      return;
    }

    console.log(
      `[CRON] Active tracking triggered at ${new Date(event.scheduledTime).toISOString()}`,
    );

    ctx.waitUntil(
      processPendingTransactions(env).then((res) => {
        console.log(
          `[CRON] Finished: processed ${res.processedCount}, confirmed ${res.confirmedCount}, failed ${res.failedCount}, pending ${res.pendingCount}`,
        );
        if (res.pendingCount === 0) {
          deactivateTransactionTracking();
          console.log(
            "[CRON] All transactions confirmed or resolved. Scheduler entered dormant state.",
          );
        }
      }),
    );
  },

  /**
   * HTTP Fetch Handler
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = getCorsHeaders(request);

    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        return new Response("CORS origin not allowed", { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const isTestnet : boolean = !!env.TESTNET_SECRET && ((request.headers.get("X-Testnet-Secret") || "") === env.TESTNET_SECRET);

    // App-wide config endpoint: non-crypto parameters (generation limits, etc.)
    if (url.pathname === "/api/app-config") {
      const security = await verifyWorkerSecurity(request, env);
      if (!security.isValid) return security.errorResponse!;

      return new Response(
        JSON.stringify({ limits: { generationsPerUnlock: GENERATIONS_PER_UNLOCK } }),
        { status: 200, headers: { ...security.corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Crypto config endpoint: returns packs, live prices, chains, and wallets
    if (url.pathname === "/api/crypto-config") {
      const security = await verifyWorkerSecurity(request, env);
      if (!security.isValid) return security.errorResponse!;

      const chainsConfig = getChainsConfig(isTestnet);
      const wallets = getWalletAddresses(isTestnet);

      // Build price map for all tokens across all chains
      const tokenSymbols = new Set<SupportedToken>();
      Object.values(chainsConfig).forEach((chain) => chain.tokens.forEach((t) => tokenSymbols.add(t)));
      const prices: Record<string, number | null> = {};
      for (const sym of tokenSymbols) {
        prices[sym] = await getTokenPriceUsd(sym);
      }

      // Build pack info with crypto amounts per chain/token
      const packs = CREDIT_PACKS.map((pack) => {
        const cryptoAmounts: Record<string, string | null> = {};
        for (const sym of tokenSymbols) {
          cryptoAmounts[sym] = calculateCryptoAmount(pack.usdPrice, sym, prices[sym]);
        }
        return { ...pack, cryptoAmounts };
      });

      const erc20Contracts = getERC20ContractsForChains(chainsConfig);
      return new Response(
        JSON.stringify({ packs, prices, chains: chainsConfig, wallets, erc20Contracts, isTestnet }),
        { status: 200, headers: { ...security.corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // User wallet endpoint: returns (or creates on first use) the user's EVM deposit address.
    // Only the public address is ever returned; the private key stays server-side.
    if (url.pathname === "/api/user-wallet") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const security = await verifyWorkerSecurity(request, env, { requireAuth: true });
      if (!security.isValid) return security.errorResponse!;

      const projectId = env.FIREBASE_PROJECT_ID as string;
      const accessToken = await getGoogleAccessToken(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);

      try {
        const address = await getOrCreateUserEvmAddress(
          projectId,
          accessToken,
          security.user!.uid,
          env,
        );
        return new Response(
          JSON.stringify({ success: true, address }),
          { status: 200, headers: { ...security.corsHeaders, "Content-Type": "application/json" } },
        );
      } catch (err) {
        console.error("[user-wallet] Failed to resolve user wallet:", err);
        return new Response(JSON.stringify({ error: "Failed to resolve user wallet" }), {
          status: 500, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Cryptographic Server Handshake
    if (url.pathname === "/api/handshake") {
      return await handleCryptographicHandshake(request, env);
    }

    // Refresh credits endpoint
    if (url.pathname === "/api/refresh-credits") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const security = await verifyWorkerSecurity(request, env, { requireAuth: true });
      if (!security.isValid) return security.errorResponse!;

      activateTransactionTracking();

      if (env.TRANSACTION_SCHEDULER) {
        try {
          const id = env.TRANSACTION_SCHEDULER.idFromName("global_transaction_scheduler");
          const stub = env.TRANSACTION_SCHEDULER.get(id);
          ctx.waitUntil(stub.fetch(new Request("http://internal/trigger")));
        } catch (err) {
          console.warn("[Scheduler] Could not trigger DO alarm:", err);
        }
      }

      const result = await processPendingTransactions(env, security.user!.uid);

      if (result.pendingCount === 0) deactivateTransactionTracking();

      return new Response(
        JSON.stringify({ success: true, timestamp: new Date().toISOString(), ...result }),
        { status: 200, headers: { ...security.corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Create Transaction endpoint - body: { packId, chainKey, txHash }
    if (url.pathname === "/api/create-transaction") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const security = await verifyWorkerSecurity(request, env, { requireAuth: true });
      if (!security.isValid) return security.errorResponse!;

      let body: { packId: string; chainKey: SupportedChainKey; chainId?: number; txHash?: string; cryptoToken?: SupportedToken; paymentMethod?: string; fromAddress?: string; statusMessage?: string } = {} as any;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }

      // txHash is optional: direct/QR payments are created before a hash exists
      if (!body.packId || !body.chainKey) {
        return new Response(JSON.stringify({ error: "Missing packId or chainKey" }), {
          status: 400, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }

      const pack = findPackById(body.packId);
      if (!pack) {
        return new Response(JSON.stringify({ error: "Invalid packId" }), {
          status: 400, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }

      const chainConfig = getChainsConfig(isTestnet)[body.chainKey];
      if (!chainConfig) {
        return new Response(JSON.stringify({ error: "Invalid chainKey" }), {
          status: 400, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Mode consistency checks: the client-supplied chainId must agree with the
      // network mode resolved from the testnet secret, and testnet chainIds are
      // only accepted when the secret is valid.
      const providedChainId = body.chainId != null ? Number(body.chainId) : undefined;
      const isTestnetChainId = providedChainId != null &&
        Object.values(DEFAULT_TESTNET_CHAIN_IDS).includes(providedChainId) &&
        providedChainId !== 0;

      if (isTestnetChainId && !isTestnet) {
        return new Response(
          JSON.stringify({ error: "Testnet transactions require a valid testnet secret." }),
          { status: 403, headers: { ...security.corsHeaders, "Content-Type": "application/json" } },
        );
      }

      if (
        providedChainId != null &&
        chainConfig.chainId != null &&
        providedChainId !== chainConfig.chainId
      ) {
        return new Response(
          JSON.stringify({
            error: `chainId mismatch: client sent ${providedChainId} but mode resolves to ${chainConfig.chainId}.`,
          }),
          { status: 400, headers: { ...security.corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const cryptoToken = (body.cryptoToken || chainConfig.nativeToken) as SupportedToken;
      const tokenPrice = await getTokenPriceUsd(cryptoToken);
      const cryptoAmount = calculateCryptoAmount(pack.usdPrice, cryptoToken, tokenPrice);
      if (!cryptoAmount) {
        return new Response(JSON.stringify({ error: "Unable to calculate crypto amount" }), {
          status: 503, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }

      // wallets.*.json still defines which chain/token combos are enabled;
      // its address is the fallback. For EVM chains we prefer the user's own
      // generated wallet address (same address on every EVM chain).
      const fallbackToAddress =
        findWalletAddress(body.chainKey, cryptoToken, chainConfig.chainId, isTestnet) || "";
      if (!fallbackToAddress) {
        return new Response(JSON.stringify({ error: "No wallet configured for this chain/token" }), {
          status: 503, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }

      const projectId = env.FIREBASE_PROJECT_ID as string;
      const accessToken = await getGoogleAccessToken(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);

      const userAddress = chainConfig.isEvm
        ? await getUserEvmAddress(projectId, accessToken, security.user!.uid)
        : null;
      const toAddress = userAddress || fallbackToAddress;

      const txId = await createTransactionDoc(projectId, accessToken, {
        userId: security.user!.uid,
        packId: pack.id,
        credits: pack.credits,
        usdPrice: pack.usdPrice,
        cryptoAmount,
        cryptoToken,
        chainKey: body.chainKey,
        chainId: chainConfig.chainId,
        toAddress,
        txHash: body.txHash || "",
        paymentMethod: body.paymentMethod === "direct" ? "direct" : "web3",
        fromAddress: body.fromAddress,
        statusMessage: body.statusMessage,
      });

      activateTransactionTracking();
      if (env.TRANSACTION_SCHEDULER) {
        try {
          const id = env.TRANSACTION_SCHEDULER.idFromName("global_transaction_scheduler");
          const stub = env.TRANSACTION_SCHEDULER.get(id);
          ctx.waitUntil(stub.fetch(new Request("http://internal/trigger")));
        } catch (err) {
          console.warn("[Scheduler] DO trigger error:", err);
        }
      }

      return new Response(
        JSON.stringify({ success: true, transactionId: txId, expectedAmount: cryptoAmount, toAddress }),
        { status: 201, headers: { ...security.corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Save History endpoint - body: { imageHash, svg }
    if (url.pathname === "/api/save-history") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const security = await verifyWorkerSecurity(request, env, { requireAuth: true });
      if (!security.isValid) return security.errorResponse!;

      let body: Record<string, any> = {};
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!body.svg || !body.imageHash) {
        return new Response(JSON.stringify({ error: "Missing imageHash or svg" }), {
          status: 400, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }

      const projectId = env.FIREBASE_PROJECT_ID as string;
      const accessToken = await getGoogleAccessToken(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);

      // Strip server-controlled and deprecated fields: userId/createdAt are set
      // server-side; originalBase64 (raw source image) is no longer stored.
      const {
        userId: _ignored,
        createdAt: _ignoredCreatedAt,
        originalBase64: _ignoredImage,
        ...rest
      } = body;
      const historyId = await createHistoryDoc(projectId, accessToken, {
        imageHash: body.imageHash,
        svg: body.svg,
        ...rest,
        userId: security.user!.uid,
      });

      return new Response(
        JSON.stringify({ success: true, historyId }),
        { status: 201, headers: { ...security.corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Support endpoint
    if (url.pathname === "/api/support") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const security = await verifyWorkerSecurity(request, env);
      if (!security.isValid) return security.errorResponse!;

      let body: { email?: string; message?: string; category?: string; subject?: string; name?: string; txHash?: string } = {} as any;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON" }), {
          status: 400, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }

      const userEmail = (body.email || security.user?.email || "").trim();
      const message = (body.message || "").trim();

      if (!userEmail || !userEmail.includes("@")) {
        return new Response(JSON.stringify({ error: "Valid email required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!message || message.length < 5) {
        return new Response(JSON.stringify({ error: "Message too short" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const ticketId = "VZ-" + crypto.randomUUID().slice(0, 6).toUpperCase() + "-" + Date.now().toString(36).slice(-4).toUpperCase();

      const ticketData = {
        id: ticketId,
        userId: security.user?.uid,
        userEmail,
        name: (body.name || "").trim() || undefined,
        category: (body.category || "general").trim(),
        subject: (body.subject || "").trim() || undefined,
        message,
        txHash: (body.txHash || "").trim() || undefined,
        status: "open" as const,
        createdAt: Date.now(),
      };

      const targetSupportEmail = env.SUPPORT_EMAIL as string;
      const meta = {
        ip: request.headers.get("cf-connecting-ip") || undefined,
        country: request.headers.get("cf-ipcountry") || undefined,
        userAgent: request.headers.get("user-agent") || undefined,
      };

      const emailResult = await sendSupportNotificationEmail(targetSupportEmail, ticketData, meta, env);

      if (env.FIREBASE_PROJECT_ID) {
        try {
          const accessToken = await getGoogleAccessToken(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);
          await createSupportTicketDoc(env.FIREBASE_PROJECT_ID, accessToken, {
            ...ticketData,
            emailSent: emailResult.success,
          });
        } catch (dbErr) {
          console.error("[Support] Firestore error:", dbErr);
        }
      }

      return new Response(
        JSON.stringify({ success: true, ticketId }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  },
};
