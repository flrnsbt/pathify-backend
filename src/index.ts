import {
  getGoogleAccessToken,
  getPendingTransactions,
  updateTransactionDoc,
  confirmAndCreditAtomically,
  createSupportTicketDoc,
  createTransactionDoc,
  saveGenerationDoc,
  grantWelcomeCredits,
  isUserAdmin,
  exportDatabase,
  importDatabase,
  CryptoTransactionDoc,
} from "./services/firestore";
import { verifyCryptoTransaction } from "./services/verifier";
import { handleCryptographicHandshake } from "./services/handshake";
import { sendSupportNotificationEmail } from "./services/email";
import { verifyWorkerSecurity } from "./services/security";
import type { TransactionScheduler } from "./services/scheduler";
import { getChainsConfig, getERC20ContractsForChains, SupportedChainKey, SupportedToken, DEFAULT_TESTNET_CHAIN_IDS, ERC20_CONTRACTS, ChainConfig } from "./config/chains";
import { getWalletAddresses, findWalletAddress } from "./config/wallets";
import { CREDIT_PACKS, findPackById, getTokenPriceUsd, calculateCryptoAmount } from "./config/packs";
import { GENERATIONS_PER_UNLOCK } from "./config/limits";
import { getOrCreateUserEvmAddress, getUserEvmAddress } from "./services/user-wallet";
import { parseTokenUnits, formatTokenUnits, addUniquenessTag } from "./services/amounts";

export { TransactionScheduler } from "./services/scheduler";

export interface Env {
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  HANDSHAKE_SECRET?: string;
  API_SECRET?: string;
  TESTNET_SECRET?: string;
  ENABLE_TESTNETS?: string;
  WALLET_ENCRYPTION_SECRET?: string;
  SUPPORT_EMAIL?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  TRANSACTION_SCHEDULER?: DurableObjectNamespace<TransactionScheduler>;
}

// Transactions pending longer than this are expired: they are marked failed
// so no further verification (periodic or manual) is possible for them.
const MAX_PENDING_MS = 3 * 60 * 60 * 1000;

// Periodic sweeps (cron + scheduler DO alarm) only verify transactions younger
// than this. Older pending transactions are left alone until the user
// manually triggers a refresh via /api/refresh-credits.
const PERIODIC_TTL_MS = 20 * 60 * 1000;

// Direct (manual/QR) payments get a server-generated unique amount and a
// limited validity window. The unique amount is the payment's identifier —
// no transaction hash is accepted from the user.
const DIRECT_PAYMENT_TTL_MS = 60 * 60 * 1000;

/** Decimals used to express a token amount on a given chain. */
function tokenDecimals(
  chainConfig: ChainConfig,
  token: SupportedToken,
): number {
  if (!chainConfig.isEvm) return 8; // BTC
  if (token === chainConfig.nativeToken) return chainConfig.nativeDecimals || 18;
  const contract = chainConfig.chainId != null
    ? ERC20_CONTRACTS[chainConfig.chainId]?.[token]
    : undefined;
  return contract?.decimals ?? (token === "USDT" || token === "USDC" ? 6 : 18);
}

export const ALLOWED_ORIGINS = [
  "https://pathify.art",
  "https://vectorizerr.pages.dev",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

// Transaction verification is driven by the TransactionScheduler Durable
// Object: creating a transaction (or refreshing credits) arms its alarm,
// which checks ALL pending transactions at once and re-arms itself every
// ~20s until none remain, then goes dormant. Periodic sweeps only touch
// transactions younger than PERIODIC_TTL_MS (10 min); older ones wait for a
// manual /api/refresh-credits and expire after MAX_PENDING_MS (2h). The cron
// trigger below is only a 30-minute safety net — it asks the DO whether it is
// already awake before doing any Firestore work, so idle periods cost ~nothing.

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
  opts?: { includeStale?: boolean },
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

  const includeStale = opts?.includeStale === true;
  const confirmed: Array<{ id: string; txHash?: string; credits: number }> = [];
  const failed: Array<{ id: string; reason: string }> = [];
  let skippedStale = 0;

  for (const tx of pending) {
    try {
      // Direct-payment invoices expire on their own schedule (shorter than the
      // generic pending window) — after expiry no transfer can be credited.
      if (tx.expiresAt && Date.now() > tx.expiresAt) {
        const reason = "Payment window expired before the transfer was detected on-chain.";
        await updateTransactionDoc(projectId, accessToken, tx.id, {
          status: "failed",
          statusMessage: reason,
          updatedAt: Date.now(),
        });
        failed.push({ id: tx.id, reason });
        console.log(`[EXPIRED] Tx ${tx.id} for user ${tx.userId}: direct payment window elapsed`);
        continue;
      }

      const age = Date.now() - tx.createdAt;
      if (age > MAX_PENDING_MS) {
        const reason = "Transaction expired: no on-chain confirmation within the pending window.";
        await updateTransactionDoc(projectId, accessToken, tx.id, {
          status: "failed",
          statusMessage: reason,
          updatedAt: Date.now(),
        });
        failed.push({ id: tx.id, reason });
        console.log(`[EXPIRED] Tx ${tx.id} for user ${tx.userId}: pending longer than ${MAX_PENDING_MS}ms`);
        continue;
      }

      // Periodic sweeps skip transactions past the TTL — they can still be
      // verified by a manual refresh, and will expire at MAX_PENDING_MS.
      if (!includeStale && age > PERIODIC_TTL_MS) {
        skippedStale++;
        continue;
      }

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
        // Still pending - persist informative message changes and the EVM
        // direct-scan cursor so the next sweep resumes where this one stopped.
        const patch: Partial<CryptoTransactionDoc> = {};
        if (
          verification.statusMessage &&
          verification.statusMessage !== tx.statusMessage
        ) {
          patch.statusMessage = verification.statusMessage;
        }
        if (
          verification.nextScanCursor != null &&
          verification.nextScanCursor !== tx.scanCursor
        ) {
          patch.scanCursor = verification.nextScanCursor;
        }
        if (Object.keys(patch).length > 0) {
          await updateTransactionDoc(projectId, accessToken, tx.id, {
            ...patch,
            updatedAt: Date.now(),
          });
        }
      }
    } catch (err: any) {
      console.error(`Error processing transaction ${tx.id}:`, err);
    }
  }

  const remainingPending = pending.length - confirmed.length - failed.length - skippedStale;

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
   * Cloudflare Cron Trigger (Scheduled event) — runs every 30 minutes.
   * Safety net for the TransactionScheduler DO: if the DO's alarm is armed it
   * is already checking all pending transactions, so this exits immediately.
   * Otherwise it sweeps pending transactions once; if any remain unresolved
   * (e.g. the DO trigger was missed), it re-arms the DO for fast checks.
   */
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        if (env.TRANSACTION_SCHEDULER) {
          try {
            const id = env.TRANSACTION_SCHEDULER.idFromName("global_transaction_scheduler");
            const stub = env.TRANSACTION_SCHEDULER.get(id);
            const statusRes = await stub.fetch(new Request("http://internal/status"));
            const status = (await statusRes.json()) as { active?: boolean };
            if (status.active) {
              console.log(
                `[CRON] Idle at ${new Date(event.scheduledTime).toISOString()}: scheduler DO is active. Skipping sweep.`,
              );
              return;
            }
          } catch (err) {
            console.warn("[CRON] Could not query scheduler DO status:", err);
          }
        }

        console.log(
          `[CRON] Sweep at ${new Date(event.scheduledTime).toISOString()}: scheduler DO dormant, checking pending transactions.`,
        );

        const result = await processPendingTransactions(env);
        console.log(
          `[CRON] Sweep finished: processed ${result.processedCount}, confirmed ${result.confirmedCount}, failed ${result.failedCount}, pending ${result.pendingCount}`,
        );

        // Pending transactions remain but the DO is dormant — arm it so
        // verification continues at the fast interval until all resolve.
        if (result.pendingCount > 0 && env.TRANSACTION_SCHEDULER) {
          try {
            const id = env.TRANSACTION_SCHEDULER.idFromName("global_transaction_scheduler");
            const stub = env.TRANSACTION_SCHEDULER.get(id);
            await stub.fetch(new Request("http://internal/trigger"));
            console.log(`[CRON] Re-armed scheduler DO for ${result.pendingCount} pending transaction(s).`);
          } catch (err) {
            console.warn("[CRON] Could not trigger scheduler DO:", err);
          }
        }
      })(),
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

    const isTestnet : boolean = env.ENABLE_TESTNETS === "true" && !!env.TESTNET_SECRET && ((request.headers.get("X-Testnet-Secret") || "") === env.TESTNET_SECRET);

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

    // Welcome credits endpoint: one-time grant for newly created accounts.
    // Idempotent server-side — safe for the client to call on every login.
    if (url.pathname === "/api/claim-welcome-credits") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const security = await verifyWorkerSecurity(request, env, { requireAuth: true });
      if (!security.isValid) return security.errorResponse!;

      let body: { fingerprintId?: string } = {};
      try {
        body = await request.json();
      } catch {
        // Empty/invalid body — fingerprintId stays undefined, grant will deny
      }

      const projectId = env.FIREBASE_PROJECT_ID as string;
      const accessToken = await getGoogleAccessToken(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);

      const result = await grantWelcomeCredits(projectId, accessToken, security.user!.uid, body.fingerprintId);

      return new Response(
        JSON.stringify({ success: result !== "error", granted: result === "granted", result }),
        {
          status: result === "error" ? 500 : 200,
          headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Admin: export full database as JSON backup (admin-only)
    if (url.pathname === "/api/admin/export") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const security = await verifyWorkerSecurity(request, env, { requireAuth: true });
      if (!security.isValid) return security.errorResponse!;

      const projectId = env.FIREBASE_PROJECT_ID as string;
      const accessToken = await getGoogleAccessToken(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);

      const admin = await isUserAdmin(projectId, accessToken, security.user!.uid);
      if (!admin) {
        return new Response(JSON.stringify({ error: "Forbidden: admin access required" }), {
          status: 403, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }

      try {
        const backup = await exportDatabase(projectId, accessToken);
        return new Response(JSON.stringify(backup), {
          status: 200,
          headers: {
            ...security.corsHeaders,
            "Content-Type": "application/json",
            "Content-Disposition": `attachment; filename="pathify-backup-${new Date().toISOString().slice(0, 10)}.json"`,
          },
        });
      } catch (err) {
        console.error("[admin/export] Failed:", err);
        return new Response(JSON.stringify({ error: "Export failed" }), {
          status: 500, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Admin: import JSON database backup (admin-only)
    if (url.pathname === "/api/admin/import") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const security = await verifyWorkerSecurity(request, env, { requireAuth: true });
      if (!security.isValid) return security.errorResponse!;

      const projectId = env.FIREBASE_PROJECT_ID as string;
      const accessToken = await getGoogleAccessToken(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);

      const admin = await isUserAdmin(projectId, accessToken, security.user!.uid);
      if (!admin) {
        return new Response(JSON.stringify({ error: "Forbidden: admin access required" }), {
          status: 403, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }

      let body: { documents?: any[] };
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }

      const result = await importDatabase(projectId, accessToken, body.documents || []);
      return new Response(JSON.stringify({ success: result.failed === 0, ...result }), {
        status: 200, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
      });
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

      if (env.TRANSACTION_SCHEDULER) {
        try {
          const id = env.TRANSACTION_SCHEDULER.idFromName("global_transaction_scheduler");
          const stub = env.TRANSACTION_SCHEDULER.get(id);
          ctx.waitUntil(stub.fetch(new Request("http://internal/trigger")));
        } catch (err) {
          console.warn("[Scheduler] Could not trigger DO alarm:", err);
        }
      }

      // Manual "refresh later": includes transactions past the periodic TTL
      // (but not expired ones — those are still marked failed above).
      const result = await processPendingTransactions(env, security.user!.uid, { includeStale: true });

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
      let cryptoAmount = calculateCryptoAmount(pack.usdPrice, cryptoToken, tokenPrice);
      if (!cryptoAmount) {
        return new Response(JSON.stringify({ error: "Unable to calculate crypto amount" }), {
          status: 503, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
        });
      }

      const isDirect = body.paymentMethod === "direct";
      let expiresAt: number | undefined;
      if (isDirect) {
        // SECURITY: manual/direct payments are identified by a unique,
        // server-generated amount — never by a user-supplied tx hash. The
        // tag adds at most ~$0.50 of overpayment so the amount stays unique
        // per transaction while remaining cheap for the payer.
        if (!tokenPrice || tokenPrice <= 0) {
          return new Response(JSON.stringify({ error: "Unable to calculate crypto amount" }), {
            status: 503, headers: { ...security.corsHeaders, "Content-Type": "application/json" },
          });
        }
        const decimals = tokenDecimals(chainConfig, cryptoToken);
        const taggedUnits = addUniquenessTag(
          parseTokenUnits(cryptoAmount, decimals),
          decimals,
          tokenPrice,
        );
        cryptoAmount = formatTokenUnits(taggedUnits, decimals);
        expiresAt = Date.now() + DIRECT_PAYMENT_TTL_MS;
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
        txHash: isDirect ? "" : body.txHash || "",
        paymentMethod: isDirect ? "direct" : "web3",
        expiresAt,
        fromAddress: body.fromAddress,
        statusMessage: body.statusMessage,
      });

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
        JSON.stringify({ success: true, transactionId: txId, expectedAmount: cryptoAmount, toAddress, expiresAt }),
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

      // Strip server-controlled fields: userId/createdAt are set server-side;
      // the raw source image (originalBase64) is no longer stored.
      const {
        userId: _ignored,
        createdAt: _ignoredCreatedAt,
        originalBase64: _ignoredImage,
        ...rest
      } = body;
      try {
        const result = await saveGenerationDoc(projectId, accessToken, {
          imageHash: body.imageHash,
          svg: body.svg,
          ...rest,
          userId: security.user!.uid,
        });

        return new Response(
          JSON.stringify({ success: true, historyId: result.historyId, generationId: result.generationId, deduped: result.deduped }),
          { status: 201, headers: { ...security.corsHeaders, "Content-Type": "application/json" } },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'SVG_TOO_LARGE') {
          return new Response(
            JSON.stringify({ error: "Generated SVG is too large to store in history." }),
            { status: 413, headers: { ...security.corsHeaders, "Content-Type": "application/json" } },
          );
        }
        console.error("[save-history] Failed to save generation:", err);
        return new Response(
          JSON.stringify({ error: "Failed to save history." }),
          { status: 500, headers: { ...security.corsHeaders, "Content-Type": "application/json" } },
        );
      }
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
