import { Env } from '../index';

const DEFAULT_SECRET = 'vz-cryptographic-handshake-secret-key-prod-994';
const FIREBASE_API_KEY = 'AIzaSyAJ1he5OrzyuuLy9S3Q6efQmRCQsDV5O-s';

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
 * Verifies Firebase ID token with Google Identity Toolkit REST API
 */
async function verifyFirebaseToken(idToken: string): Promise<{ uid: string; email?: string } | null> {
  try {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as any;
    if (!data.users || data.users.length === 0) return null;

    return {
      uid: data.users[0].localId,
      email: data.users[0].email,
    };
  } catch (err) {
    console.error('[Worker Handshake] Auth verification error:', err);
    return null;
  }
}

/**
 * Handles Cryptographic Server Handshake in Cloudflare Worker
 */
export async function handleCryptographicHandshake(
  request: Request,
  env: Env
): Promise<Response> {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Firebase-AppCheck',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    const authHeader = request.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing Authorization header.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const idToken = authHeader.replace('Bearer ', '').trim();
    const verified = await verifyFirebaseToken(idToken);
    if (!verified) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid Firebase ID token.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userId = verified.uid;
    const body = (await request.json().catch(() => ({}))) as any;
    const { action, imageHash } = body;

    if (!imageHash) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing imageHash.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const projectId = env.FIREBASE_PROJECT_ID || 'vectorizerr';
    const secret = env.FIREBASE_PRIVATE_KEY || DEFAULT_SECRET;

    // Fetch user doc from Firestore
    const userUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}`;
    const userRes = await fetch(userUrl);
    const userData = userRes.ok ? ((await userRes.json()) as any) : null;
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
      : 10;
    const remainingGens = Math.max(0, maxGenerations - generationsUsed);

    const now = Date.now();
    const expiresAt = now + 86400000 * 30; // 30 days
    const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const ticketId = `ticket_${now}_${nonce.slice(0, 8)}`;

    if (action === 'unlock_image') {
      if (isAdmin || isSubscribed || (existingUnlock && remainingGens > 0)) {
        const quota = isAdmin || isSubscribed ? 9999 : remainingGens;
        const msg = `${ticketId}:${userId}:${imageHash}:${quota}:${expiresAt}:${nonce}`;
        const signature = await computeHmacSha256(secret, msg);

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

      // Deduct 1 credit & unlock image for 10 generations in Firestore
      const newCredits = credits - 1;
      const updatedUnlocked = {
        ...unlockedImages,
        [imageHash]: {
          mapValue: {
            fields: {
              imageHash: { stringValue: imageHash },
              generationsUsed: { integerValue: '0' },
              maxGenerations: { integerValue: '10' },
              unlockedAt: { integerValue: String(now) },
            },
          },
        },
      };

      const patchUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=credits&updateMask.fieldPaths=unlockedImages&updateMask.fieldPaths=updatedAt`;
      await fetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            credits: { integerValue: String(newCredits) },
            unlockedImages: { mapValue: { fields: updatedUnlocked } },
            updatedAt: { timestampValue: new Date().toISOString() },
          },
        }),
      });

      const msg = `${ticketId}:${userId}:${imageHash}:10:${expiresAt}:${nonce}`;
      const signature = await computeHmacSha256(secret, msg);

      return new Response(
        JSON.stringify({
          success: true,
          ticket: {
            ticketId,
            userId,
            imageHash,
            generationsRemaining: 10,
            generationsUsed: 0,
            maxGenerations: 10,
            expiresAt,
            issuedAt: now,
            nonce,
            signature,
          },
          generationsRemaining: 10,
          creditsRemaining: newCredits,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else if (action === 'consume_generation') {
      if (isAdmin || isSubscribed) {
        const msg = `${ticketId}:${userId}:${imageHash}:9999:${expiresAt}:${nonce}`;
        const signature = await computeHmacSha256(secret, msg);
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

      const newGenerationsUsed = generationsUsed + 1;
      const updatedRemaining = Math.max(0, maxGenerations - newGenerationsUsed);

      const updatedUnlocked = {
        ...unlockedImages,
        [imageHash]: {
          mapValue: {
            fields: {
              imageHash: { stringValue: imageHash },
              generationsUsed: { integerValue: String(newGenerationsUsed) },
              maxGenerations: { integerValue: String(maxGenerations) },
              unlockedAt: { integerValue: existingUnlock?.unlockedAt?.integerValue || String(now) },
            },
          },
        },
      };

      const patchUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}?updateMask.fieldPaths=unlockedImages&updateMask.fieldPaths=updatedAt`;
      await fetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: {
            unlockedImages: { mapValue: { fields: updatedUnlocked } },
            updatedAt: { timestampValue: new Date().toISOString() },
          },
        }),
      });

      const msg = `${ticketId}:${userId}:${imageHash}:${updatedRemaining}:${expiresAt}:${nonce}`;
      const signature = await computeHmacSha256(secret, msg);

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
      JSON.stringify({ success: false, error: `Unsupported action: ${action}` }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
}
