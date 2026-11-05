import { Env } from '../index';
import { verifyWorkerSecurity } from './security';
import { getGoogleAccessToken, atomicUnlockImage, atomicConsumeGeneration } from './firestore';
import { GENERATIONS_PER_UNLOCK } from '../config/limits';

/**
 * Computes an HMAC-SHA256 signature using Web Crypto API
 */
async function computeHmacSha256(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Validates imageHash format: must be a hex string of reasonable length
 */
function isValidImageHash(hash: string): boolean {
  return /^[0-9a-fA-F]{16,128}$/.test(hash);
}

/**
 * Generates a secure ticket with HMAC signature
 */
async function generateTicket(
  secret: string,
  userId: string,
  imageHash: string,
  generationsRemaining: number,
  generationsUsed: number,
  maxGenerations: number,
  expiresAt: number,
  issuedAt: number
): Promise<{ ticketId: string; nonce: string; signature: string }> {
  const nonce = crypto.randomUUID();
  const ticketId = `ticket_${issuedAt}_${nonce.slice(0, 8)}`;

  // Sign canonical JSON of the whole ticket payload
  const payload = JSON.stringify({
    ticketId,
    userId,
    imageHash,
    generationsRemaining,
    generationsUsed,
    maxGenerations,
    expiresAt,
    issuedAt,
    nonce,
  });
  const signature = await computeHmacSha256(secret, payload);

  return { ticketId, nonce, signature };
}

/**
 * Handles Cryptographic Server Handshake in Cloudflare Worker
 */
export async function handleCryptographicHandshake(
  request: Request,
  env: Env
): Promise<Response> {
  // POST-only check
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ success: false, error: 'Method not allowed' }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // 1. Unified security verification (CORS, API Secret, App Check, Auth Token)
  const security = await verifyWorkerSecurity(request, env, { requireAuth: true });
  if (!security.isValid) {
    return security.errorResponse!;
  }

  const corsHeaders = security.corsHeaders;
  const userId = security.user!.uid;

  // Require HANDSHAKE_SECRET - fail closed if missing
  const secret = env.HANDSHAKE_SECRET;
  if (!secret) {
    console.error('[Handshake] HANDSHAKE_SECRET is not configured, failing closed');
    return new Response(
      JSON.stringify({ success: false, error: 'Server configuration error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  try {
    const body = (await request.json().catch(() => ({}))) as any;
    const { action, imageHash } = body;

    if (!imageHash || !isValidImageHash(imageHash)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing or invalid imageHash.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!action || (action !== 'unlock_image' && action !== 'consume_generation')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid action.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const projectId = env.FIREBASE_PROJECT_ID;
    if (!projectId) {
      console.error('[Handshake] FIREBASE_PROJECT_ID is not configured');
      return new Response(
        JSON.stringify({ success: false, error: 'Server configuration error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get access token for authenticated Firestore calls
    const accessToken = await getGoogleAccessToken(
      env.FIREBASE_CLIENT_EMAIL,
      env.FIREBASE_PRIVATE_KEY
    );
    if (!accessToken) {
      console.error('[Handshake] Failed to obtain Firestore access token');
      return new Response(
        JSON.stringify({ success: false, error: 'Server configuration error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch user doc from Firestore with auth
    const userUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;
    const userRes = await fetch(userUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
      },
    });

    if (!userRes.ok) {
      console.error(`[Handshake] Failed to fetch user doc: ${userRes.status}`);
      return new Response(
        JSON.stringify({ success: false, error: 'Failed to load user data.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userData = (await userRes.json()) as any;
    const fields = userData?.fields || {};

    const credits = fields.credits?.integerValue ? Number(fields.credits.integerValue) : 0;
    const isAdmin = Boolean(fields.isAdmin?.booleanValue);
    const isSubscribed = fields.subscription?.mapValue?.fields?.status?.stringValue === 'active';
    const unlockedImages = fields.unlockedImages?.mapValue?.fields || {};

    const existingUnlock = unlockedImages[imageHash]?.mapValue?.fields;
    const generationsUsed = existingUnlock?.generationsUsed?.integerValue
      ? Number(existingUnlock.generationsUsed.integerValue)
      : 0;
    const maxGenerations = existingUnlock?.maxGenerations?.integerValue
      ? Number(existingUnlock.maxGenerations.integerValue)
      : GENERATIONS_PER_UNLOCK;
    const remainingGens = Math.max(0, maxGenerations - generationsUsed);

    const now = Date.now();
    // Tickets are short-lived: 1 hour instead of 30 days
    const expiresAt = now + 3600000;

    if (action === 'unlock_image') {
      if (isAdmin || isSubscribed || (existingUnlock && remainingGens > 0)) {
        const quota = isAdmin || isSubscribed ? 9999 : remainingGens;
        const { ticketId, nonce, signature } = await generateTicket(
          secret, userId, imageHash, quota, generationsUsed, quota, expiresAt, now
        );

        return new Response(
          JSON.stringify({
            success: true,
            ticket: {
              ticketId,
              userId,
              imageHash,
              generationsRemaining: quota,
              generationsUsed,
              maxGenerations: quota,
              expiresAt,
              issuedAt: now,
              nonce,
              signature,
            },
            generationsRemaining: quota,
            creditsRemaining: credits,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (credits < 1) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Insufficient credits.',
            creditsRemaining: credits,
          }),
          { status: 402, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Atomic commit: decrement credits and set unlock entry in one transaction
      const writeSuccess = await atomicUnlockImage(projectId, accessToken, userId, imageHash, now);
      if (!writeSuccess) {
        console.error('[Handshake] Atomic unlock commit failed');
        return new Response(
          JSON.stringify({ success: false, error: 'Failed to save unlock data.' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Only issue ticket after successful write
      const { ticketId, nonce, signature } = await generateTicket(
        secret, userId, imageHash, GENERATIONS_PER_UNLOCK, 0, GENERATIONS_PER_UNLOCK, expiresAt, now
      );

      return new Response(
        JSON.stringify({
          success: true,
          ticket: {
            ticketId,
            userId,
            imageHash,
            generationsRemaining: GENERATIONS_PER_UNLOCK,
            generationsUsed: 0,
            maxGenerations: GENERATIONS_PER_UNLOCK,
            expiresAt,
            issuedAt: now,
            nonce,
            signature,
          },
          generationsRemaining: GENERATIONS_PER_UNLOCK,
          creditsRemaining: credits - 1,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else if (action === 'consume_generation') {
      if (isAdmin || isSubscribed) {
        const { ticketId, nonce, signature } = await generateTicket(
          secret, userId, imageHash, 9999, 0, 9999, expiresAt, now
        );
        return new Response(
          JSON.stringify({
            success: true,
            ticket: {
              ticketId,
              userId,
              imageHash,
              generationsRemaining: 9999,
              generationsUsed: 0,
              maxGenerations: 9999,
              expiresAt,
              issuedAt: now,
              nonce,
              signature,
            },
            generationsRemaining: 9999,
            creditsRemaining: credits,
          }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (!existingUnlock || remainingGens <= 0) {
        return new Response(
          JSON.stringify({ success: false, error: 'Quota exceeded for this image.', generationsRemaining: 0 }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Atomic commit: increment generationsUsed in one transaction
      const writeSuccess = await atomicConsumeGeneration(projectId, accessToken, userId, imageHash);
      if (!writeSuccess) {
        console.error('[Handshake] Atomic consume generation commit failed');
        return new Response(
          JSON.stringify({ success: false, error: 'Failed to save generation data.' }),
          { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const newGenerationsUsed = generationsUsed + 1;
      const updatedRemaining = Math.max(0, maxGenerations - newGenerationsUsed);

      // Only issue ticket after successful write
      const { ticketId, nonce, signature } = await generateTicket(
        secret, userId, imageHash, updatedRemaining, newGenerationsUsed, maxGenerations, expiresAt, now
      );

      return new Response(
        JSON.stringify({
          success: true,
          ticket: {
            ticketId,
            userId,
            imageHash,
            generationsRemaining: updatedRemaining,
            generationsUsed: newGenerationsUsed,
            maxGenerations,
            expiresAt,
            issuedAt: now,
            nonce,
            signature,
          },
          generationsRemaining: updatedRemaining,
          creditsRemaining: credits,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: false, error: 'Invalid action.' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[Handshake] Internal error:', err);
    // Don't leak error details to the client
    return new Response(
      JSON.stringify({ success: false, error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
