import {
  getGoogleAccessToken,
  getPendingTransactions,
  updateTransactionDoc,
  incrementUserCredits,
  CryptoTransactionDoc,
} from './services/firestore';
import { verifyCryptoTransaction } from './services/verifier';
import { handleCryptographicHandshake } from './services/handshake';

export interface Env {
  ENVIRONMENT?: string;
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;
  API_SECRET?: string;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-secret',
};

/**
 * Iterates through pending transactions, validates them on-chain,
 * updates Firestore documents, and increments user credits upon confirmation.
 */
async function processPendingTransactions(
  env: Env,
  userIdFilter?: string
): Promise<{
  processedCount: number;
  confirmedCount: number;
  failedCount: number;
  pendingCount: number;
  confirmed: Array<{ id: string; txHash?: string; credits: number }>;
  failed: Array<{ id: string; reason: string }>;
}> {
  const projectId = env.FIREBASE_PROJECT_ID || 'vectorizerr';
  const accessToken = await getGoogleAccessToken(
    env.FIREBASE_CLIENT_EMAIL,
    env.FIREBASE_PRIVATE_KEY
  );

  const pending = await getPendingTransactions(projectId, accessToken, userIdFilter);

  const confirmed: Array<{ id: string; txHash?: string; credits: number }> = [];
  const failed: Array<{ id: string; reason: string }> = [];

  for (const tx of pending) {
    try {
      const verification = await verifyCryptoTransaction(tx);

      if (verification.isConfirmed) {
        const confirmedAt = Date.now();
        const finalTxHash = verification.actualTxHash || tx.txHash;

        // 1. Mark transaction confirmed in Firestore
        await updateTransactionDoc(projectId, accessToken, tx.id, {
          status: 'confirmed',
          confirmedAt,
          txHash: finalTxHash,
          statusMessage: verification.statusMessage,
          updatedAt: confirmedAt,
        });

        // 2. Increment user credits in Firestore
        await incrementUserCredits(projectId, accessToken, tx.userId, tx.credits);

        confirmed.push({
          id: tx.id,
          txHash: finalTxHash,
          credits: tx.credits,
        });

        console.log(`[CONFIRMED] Tx ${tx.id} for user ${tx.userId} (+${tx.credits} credits)`);
      } else if (verification.isFailed) {
        await updateTransactionDoc(projectId, accessToken, tx.id, {
          status: 'failed',
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
        if (verification.statusMessage && verification.statusMessage !== tx.statusMessage) {
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
   * Automatically runs every minute to verify pending crypto transactions
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[CRON] Triggered transaction tracking at ${new Date(event.scheduledTime).toISOString()}`);
    ctx.waitUntil(
      processPendingTransactions(env).then((res) => {
        console.log(
          `[CRON] Finished: processed ${res.processedCount}, confirmed ${res.confirmedCount}, failed ${res.failedCount}, pending ${res.pendingCount}`
        );
      })
    );
  },

  /**
   * HTTP Fetch Handler
   * Responds to client queries, on-demand refresh triggers, and health checks
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    // Health check endpoint
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(
        JSON.stringify({
          status: 'online',
          service: 'vectorizerr-backend-worker',
          engine: 'Cloudflare Workers (Edge)',
          cronSchedule: '* * * * *',
          timestamp: new Date().toISOString(),
          projectId: env.FIREBASE_PROJECT_ID || 'vectorizerr',
          authConfigured: Boolean(env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY),
        }),
        {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    // Cryptographic Server Handshake endpoint (protects vectorizing authorization)
    if (
      url.pathname === '/api/handshake' ||
      url.pathname === '/api/handshake/authorize'
    ) {
      return await handleCryptographicHandshake(request, env);
    }

    // On-demand refresh endpoint
    if (
      url.pathname === '/api/refresh-credits' ||
      url.pathname === '/api/check-transactions'
    ) {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      // Check optional secret if configured
      if (env.API_SECRET) {
        const authHeader = request.headers.get('Authorization') || request.headers.get('x-api-secret');
        const token = authHeader?.replace('Bearer ', '');
        if (token !== env.API_SECRET) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
      }

      let userIdFilter: string | undefined;
      try {
        const body = (await request.json().catch(() => ({}))) as { userId?: string };
        userIdFilter = body.userId;
      } catch {}

      const result = await processPendingTransactions(env, userIdFilter);

      return new Response(
        JSON.stringify({
          success: true,
          timestamp: new Date().toISOString(),
          ...result,
        }),
        {
          status: 200,
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/json',
          },
        }
      );
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  },
};
