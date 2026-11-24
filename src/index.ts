import {
  getGoogleAccessToken,
  getPendingTransactions,
  updateTransactionDoc,
  incrementUserCredits,
  createSupportTicketDoc,
  createTransactionDoc,
  createHistoryDoc,
} from "./services/firestore";
import { verifyCryptoTransaction } from "./services/verifier";
import { handleCryptographicHandshake } from "./services/handshake";
import { sendSupportNotificationEmail } from "./services/email";
import { verifyWorkerSecurity } from "./services/security";
import type { TransactionScheduler } from "./services/scheduler";
import { getChainsConfig } from "./config/chains";
import { getWalletAddresses, isTestnetMode } from "./config/wallets";

export { TransactionScheduler } from "./services/scheduler";

export interface Env {
  ENVIRONMENT?: string;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  API_SECRET?: string;
  SUPPORT_EMAIL?: string;
  TESTNET_SECRET?: string;
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
      "Content-Type, Authorization, x-api-secret, X-Firebase-AppCheck, x-testnet-secret",
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
      // Use per-transaction isTestnet flag for verification
      const verification = await verifyCryptoTransaction(tx, Boolean(tx.isTestnet));

      if (verification.isConfirmed) {
        const confirmedAt = Date.now();
        const finalTxHash = verification.actualTxHash || tx.txHash;

        // 1. Mark transaction confirmed in Firestore
        await updateTransactionDoc(projectId, accessToken, tx.id, {
          status: "confirmed",
          confirmedAt,
          txHash: finalTxHash,
          statusMessage: verification.statusMessage,
          updatedAt: confirmedAt,
        });

        // 2. Increment user credits in Firestore
        await incrementUserCredits(
          projectId,
          accessToken,
          tx.userId,
          tx.credits,
        );

        confirmed.push({
          id: tx.id,
          txHash: finalTxHash,
          credits: tx.credits,
        });

        console.log(
          `[CONFIRMED] Tx ${tx.id} for user ${tx.userId} (+${tx.credits} credits)`,
        );
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
   * Responds to client queries, on-demand refresh triggers, and health checks
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    const corsHeaders = getCorsHeaders(request);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        return new Response("CORS origin not allowed", { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Health check endpoint
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "online",
          service: "vectorizerr-backend-worker",
          engine: "Cloudflare Workers (Edge)",
          cronSchedule: "* * * * *",
          timestamp: new Date().toISOString(),
          projectId: env.FIREBASE_PROJECT_ID || "vectorizerr",
          authConfigured: Boolean(
            env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY,
          ),
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const requestTestnetSecret = url.searchParams.get("x-testnet-secret") || "";
    const isTestnet = isTestnetMode(env, requestTestnetSecret);

    // Helper for later endpoints that need testnet validation from header
    const headerTestnetSecret = request.headers.get("x-testnet-secret") || "";
    const isTestnetFromHeader = isTestnetMode(env, headerTestnetSecret);
    if (url.pathname === "/api/config") {
      const chainsConfig = getChainsConfig(isTestnet);
      const wallets = getWalletAddresses(isTestnet);

      return new Response(
        JSON.stringify({
          chains: chainsConfig,
          wallets,
          isTestnet: isTestnet,
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Cryptographic Server Handshake endpoint (protects vectorizing authorization)
    if (
      url.pathname === "/api/handshake" ||
      url.pathname === "/api/handshake/authorize"
    ) {
      return await handleCryptographicHandshake(request, env);
    }

    // On-demand refresh endpoint
    if (
      url.pathname === "/api/refresh-credits" ||
      url.pathname === "/api/check-transactions"
    ) {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Centralized security validation (API secret, App Check, optional Auth token)
      const security = await verifyWorkerSecurity(request, env, {
        requireAuth: false,
      });
      if (!security.isValid) {
        return security.errorResponse!;
      }

      let userIdFilter: string | undefined;
      try {
        const body = (await request.json().catch(() => ({}))) as {
          userId?: string;
        };
        userIdFilter = body.userId;
      } catch {}

      // If user is authenticated, ensure they cannot query another user's balance
      if (security.user) {
        if (userIdFilter && userIdFilter !== security.user.uid) {
          return new Response(
            JSON.stringify({
              error: "Forbidden: Cannot refresh credits for another user",
            }),
            {
              status: 403,
              headers: {
                ...security.corsHeaders,
                "Content-Type": "application/json",
              },
            },
          );
        }
        userIdFilter = security.user.uid;
      }

      // 1. Activate lazy tracking window
      activateTransactionTracking();

      // 2. Arm Durable Object alarm scheduler if bound
      if (env.TRANSACTION_SCHEDULER) {
        try {
          const id = env.TRANSACTION_SCHEDULER.idFromName(
            "global_transaction_scheduler",
          );
          const stub = env.TRANSACTION_SCHEDULER.get(id);
          ctx.waitUntil(stub.fetch(new Request("http://internal/trigger")));
        } catch (err) {
          console.warn("[Scheduler] Could not trigger DO alarm:", err);
        }
      }

      const result = await processPendingTransactions(env, userIdFilter);

      // If all transactions are resolved, deactivate lazy tracking immediately
      if (result.pendingCount === 0) {
        deactivateTransactionTracking();
      }

      return new Response(
        JSON.stringify({
          success: true,
          timestamp: new Date().toISOString(),
          ...result,
        }),
        {
          status: 200,
          headers: {
            ...security.corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Lazy Transaction Tracking trigger endpoint (called when a new tx is written)
    if (
      url.pathname === "/api/track-transaction" ||
      url.pathname === "/api/schedule-check"
    ) {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const security = await verifyWorkerSecurity(request, env, {
        requireAuth: false,
      });
      if (!security.isValid) {
        return security.errorResponse!;
      }

      // Activate tracking window
      activateTransactionTracking();

      // If Durable Object is bound, arm alarm for 15s
      let doStatus = "unbound";
      if (env.TRANSACTION_SCHEDULER) {
        try {
          const id = env.TRANSACTION_SCHEDULER.idFromName(
            "global_transaction_scheduler",
          );
          const stub = env.TRANSACTION_SCHEDULER.get(id);
          ctx.waitUntil(stub.fetch(new Request("http://internal/trigger")));
          doStatus = "armed";
        } catch (err) {
          console.warn("[Scheduler] DO trigger error:", err);
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          trackingActive: true,
          durableObjectScheduler: doStatus,
          message:
            "Transaction tracking activated. Checks will run lazily until confirmed.",
        }),
        {
          status: 200,
          headers: {
            ...security.corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Create Transaction endpoint (writes to transactions collection with service account auth)
    if (url.pathname === "/api/create-transaction") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Security validation: verify API Secret, App Check, and optional Auth token
      const security = await verifyWorkerSecurity(request, env, {
        requireAuth: false,
      });
      if (!security.isValid) {
        return security.errorResponse!;
      }

      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return new Response(
          JSON.stringify({ error: "Invalid JSON request body" }),
          {
            status: 400,
            headers: {
              ...security.corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }

      const userId = (body.userId || security.user?.uid || "").trim();
      if (!userId) {
        return new Response(
          JSON.stringify({ error: "Missing required userId field" }),
          {
            status: 400,
            headers: {
              ...security.corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }

      // Prevent user impersonation: if authenticated, verify userId matches
      if (security.user && security.user.uid !== userId) {
        return new Response(
          JSON.stringify({
            error: "Forbidden: Cannot create transaction for another user",
          }),
          {
            status: 403,
            headers: {
              ...security.corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }

      const projectId = env.FIREBASE_PROJECT_ID || "vectorizerr";
      const accessToken = await getGoogleAccessToken(
        env.FIREBASE_CLIENT_EMAIL,
        env.FIREBASE_PRIVATE_KEY,
      );

      // Validate testnet mode: only allow testnet transactions when TESTNET_SECRET matches
      const txIsTestnet = body.isTestnet === true || body.isTestnet === 'true';
      if (txIsTestnet && !isTestnetFromHeader) {
        return new Response(
          JSON.stringify({ error: "Testnet transactions require valid x-testnet-secret header" }),
          {
            status: 403,
            headers: {
              ...security.corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }

      const txId = await createTransactionDoc(projectId, accessToken, {
        id: body.id,
        userId,
        userEmail: body.userEmail || security.user?.email,
        packId: body.packId || "custom",
        credits: Number(body.credits) || 0,
        usdPrice: Number(body.usdPrice) || 0,
        cryptoAmount: String(body.cryptoAmount || "0"),
        cryptoToken: body.cryptoToken || "USDT",
        chainKey: body.chainKey || "bsc",
        chainId: body.chainId ? Number(body.chainId) : undefined,
        paymentMethod: body.paymentMethod || "web3",
        fromAddress: body.fromAddress,
        toAddress: body.toAddress || "",
        txHash: body.txHash,
        status: body.status || "pending",
        statusMessage:
          body.statusMessage || "Awaiting blockchain confirmation.",
        createdAt: body.createdAt || Date.now(),
        updatedAt: body.updatedAt || Date.now(),
        isTestnet: txIsTestnet,
      });

      // Trigger lazy tracking scheduler
      activateTransactionTracking();
      if (env.TRANSACTION_SCHEDULER) {
        try {
          const id = env.TRANSACTION_SCHEDULER.idFromName(
            "global_transaction_scheduler",
          );
          const stub = env.TRANSACTION_SCHEDULER.get(id);
          ctx.waitUntil(stub.fetch(new Request("http://internal/trigger")));
        } catch (err) {
          console.warn("[Scheduler] DO trigger error:", err);
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          transactionId: txId,
          status: "pending",
          message: "Transaction created successfully on server and tracked.",
        }),
        {
          status: 201,
          headers: {
            ...security.corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Save History endpoint (writes to users/{userId}/history with service account auth)
    if (url.pathname === "/api/save-history") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Security validation: verify API Secret, App Check, and optional Auth token
      const security = await verifyWorkerSecurity(request, env, {
        requireAuth: false,
      });
      if (!security.isValid) {
        return security.errorResponse!;
      }

      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return new Response(
          JSON.stringify({ error: "Invalid JSON request body" }),
          {
            status: 400,
            headers: {
              ...security.corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }

      const userId = (body.userId || security.user?.uid || "").trim();
      if (!userId) {
        return new Response(
          JSON.stringify({ error: "Missing required userId field" }),
          {
            status: 400,
            headers: {
              ...security.corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }

      // Prevent writing to another user's history
      if (security.user && security.user.uid !== userId) {
        return new Response(
          JSON.stringify({
            error: "Forbidden: Cannot write history for another user",
          }),
          {
            status: 403,
            headers: {
              ...security.corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }

      if (!body.svg) {
        return new Response(
          JSON.stringify({ error: "Missing required svg field" }),
          {
            status: 400,
            headers: {
              ...security.corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }

      const projectId = env.FIREBASE_PROJECT_ID || "vectorizerr";
      const accessToken = await getGoogleAccessToken(
        env.FIREBASE_CLIENT_EMAIL,
        env.FIREBASE_PRIVATE_KEY,
      );

      const historyId = await createHistoryDoc(projectId, accessToken, {
        id: body.id,
        userId,
        fileName: body.fileName || "vectorization.svg",
        originalDimensions: body.originalDimensions,
        originalSize: body.originalSize ? Number(body.originalSize) : undefined,
        originalBase64: body.originalBase64,
        imageHash: body.imageHash,
        nodeCount:
          body.nodeCount !== undefined ? Number(body.nodeCount) : undefined,
        executionTimeMs:
          body.executionTimeMs !== undefined
            ? Number(body.executionTimeMs)
            : undefined,
        parameters: body.parameters,
        svg: body.svg,
        svgSize: body.svgSize ? Number(body.svgSize) : undefined,
        createdAt: body.createdAt || Date.now(),
      });

      return new Response(
        JSON.stringify({
          success: true,
          historyId,
          message: "History entry saved successfully on server.",
        }),
        {
          status: 201,
          headers: {
            ...security.corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Contact & Support Inquiry endpoint (sends email to SUPPORT_EMAIL safely)
    if (url.pathname === "/api/support" || url.pathname === "/api/contact") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Centralized security validation (API secret, App Check, optional Auth token)
      const security = await verifyWorkerSecurity(request, env, {
        requireAuth: false,
      });
      if (!security.isValid) {
        return security.errorResponse!;
      }

      // Parse & validate request payload
      let body: any = {};
      try {
        body = await request.json();
      } catch {
        return new Response(
          JSON.stringify({ error: "Invalid JSON request body" }),
          {
            status: 400,
            headers: {
              ...security.corsHeaders,
              "Content-Type": "application/json",
            },
          },
        );
      }

      const authenticatedUserId = security.user?.uid;
      const authenticatedUserEmail = security.user?.email;

      const userEmail = (body.email || authenticatedUserEmail || "").trim();
      const message = (body.message || "").trim();
      const category = (body.category || "crypto_transaction").trim();
      const subject = (body.subject || "").trim();
      const name = (body.name || "").trim();
      const txHash = (body.txHash || "").trim();
      const chainKey = (body.chainKey || "").trim();
      const walletAddress = (body.walletAddress || "").trim();

      if (!userEmail || !userEmail.includes("@")) {
        return new Response(
          JSON.stringify({ error: "A valid email address is required" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      if (!message || message.length < 5) {
        return new Response(
          JSON.stringify({
            error: "Please provide a detailed message (minimum 5 characters)",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // Generate support ticket ID
      const ticketId =
        "VZ-" +
        Math.random().toString(36).substring(2, 8).toUpperCase() +
        "-" +
        Date.now().toString(36).slice(-3).toUpperCase();

      const ticketData = {
        id: ticketId,
        userId: authenticatedUserId || body.userId,
        userEmail,
        name: name || undefined,
        category,
        subject: subject || undefined,
        message,
        txHash: txHash || undefined,
        chainKey: chainKey || undefined,
        walletAddress: walletAddress || undefined,
        status: "open" as const,
        createdAt: Date.now(),
      };

      // 5. Send email notification to SUPPORT_EMAIL safely
      const targetSupportEmail = env.SUPPORT_EMAIL as string;
      const meta = {
        ip: request.headers.get("cf-connecting-ip") || undefined,
        country: request.headers.get("cf-ipcountry") || undefined,
        userAgent: request.headers.get("user-agent") || undefined,
      };

      const emailResult = await sendSupportNotificationEmail(
        targetSupportEmail,
        ticketData,
        meta,
      );

      // 6. Record ticket in Firestore for audit & durability
      if (env.FIREBASE_PROJECT_ID) {
        try {
          const accessToken = await getGoogleAccessToken(
            env.FIREBASE_CLIENT_EMAIL,
            env.FIREBASE_PRIVATE_KEY,
          );
          await createSupportTicketDoc(env.FIREBASE_PROJECT_ID, accessToken, {
            ...ticketData,
            emailSent: emailResult.success,
          });
        } catch (dbErr) {
          console.error("[Support] Error storing ticket in Firestore:", dbErr);
        }
      }

      return new Response(
        JSON.stringify({
          success: true,
          ticketId,
          message:
            "Support ticket submitted successfully. Our assistance team will review your inquiry shortly.",
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  },
};
