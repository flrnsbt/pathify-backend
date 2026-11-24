import { Env } from '../index';
import { verifyWorkerSecurity } from './security';

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

function base64UrlToBytes(str: string): Uint8Array {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function decodeBase64UrlJson(str: string): any {
  const bytes = base64UrlToBytes(str);
  const jsonStr = new TextDecoder().decode(bytes);
  return JSON.parse(jsonStr);
}

interface GoogleJwk {
  alg: string;
  kty: string;
  use: string;
  n: string;
  e: string;
  kid: string;
}

let cachedGoogleJwks: { keys: GoogleJwk[]; expiresAt: number } | null = null;

async function getGooglePublicJwks(): Promise<GoogleJwk[]> {
  const now = Date.now();
  if (cachedGoogleJwks && cachedGoogleJwks.expiresAt > now) {
    return cachedGoogleJwks.keys;
  }

  const res = await fetch(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch Google JWKS: ${res.status}`);
  }

  let maxAge = 3600;
  const cacheControl = res.headers.get('cache-control');
  if (cacheControl) {
    const match = cacheControl.match(/max-age=(\d+)/);
    if (match) {
      maxAge = parseInt(match[1], 10);
    }
  }

  const data = (await res.json()) as { keys: GoogleJwk[] };
  cachedGoogleJwks = {
    keys: data.keys,
    expiresAt: now + maxAge * 1000,
  };
  return data.keys;
}

/**
 * Verifies Firebase ID token with Web Crypto RS256 JWKS validation (fast, zero API key restrictions)
 * and falls back to Google Identity Toolkit REST API.
 */
export async function verifyFirebaseToken(
  idToken: string,
  expectedProjectId: string = 'vectorizerr',
  apiKey: string = FIREBASE_API_KEY
): Promise<{ uid: string; email?: string } | null> {
  if (!idToken || typeof idToken !== 'string') {
    return null;
  }

  const parts = idToken.split('.');
  if (parts.length !== 3) {
    console.warn('[verifyFirebaseToken] Malformed JWT: Expected 3 parts, got', parts.length);
    return null;
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // 1. Attempt Cryptographic Web Crypto RS256 Verification against Google JWKS
  try {
    const headerJson = decodeBase64UrlJson(headerB64);
    const payloadJson = decodeBase64UrlJson(payloadB64);

    if (headerJson.alg !== 'RS256') {
      console.warn('[verifyFirebaseToken] Unsupported algorithm:', headerJson.alg);
      return null;
    }

    const kid = headerJson.kid;
    if (!kid) {
      console.warn('[verifyFirebaseToken] Missing kid in JWT header');
      return null;
    }

    let keys = await getGooglePublicJwks();
    let matchingKey = keys.find((k) => k.kid === kid);

    // If key not found, refresh cache once in case Google rotated keys
    if (!matchingKey) {
      cachedGoogleJwks = null;
      keys = await getGooglePublicJwks();
      matchingKey = keys.find((k) => k.kid === kid);
    }

    if (matchingKey) {
      const cryptoKey = await crypto.subtle.importKey(
        'jwk',
        matchingKey,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify']
      );

      const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
      const rawSignature = base64UrlToBytes(signatureB64);

      const isSignatureValid = await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        cryptoKey,
        rawSignature,
        signedData
      );

      if (!isSignatureValid) {
        console.warn('[verifyFirebaseToken] Signature verification failed');
        return null;
      }

      // Check standard claims with 5-minute clock drift tolerance
      const now = Math.floor(Date.now() / 1000);
      if (payloadJson.exp && payloadJson.exp < now - 300) {
        console.warn(`[verifyFirebaseToken] Token is expired (exp: ${payloadJson.exp}, now: ${now})`);
        return null;
      }

      if (payloadJson.iat && payloadJson.iat > now + 300) {
        console.warn('[verifyFirebaseToken] Token issued in future');
        return null;
      }

      const expectedAud = expectedProjectId || 'vectorizerr';
      const audMatches = payloadJson.aud === expectedAud;
      const issMatches =
        payloadJson.iss === `https://securetoken.google.com/${expectedAud}` ||
        (typeof payloadJson.iss === 'string' && payloadJson.iss.endsWith(expectedAud));

      if (!audMatches && !issMatches) {
        console.warn(
          `[verifyFirebaseToken] Audience/Issuer mismatch: expected ${expectedAud}, got aud=${payloadJson.aud}, iss=${payloadJson.iss}`
        );
        return null;
      }

      const uid = payloadJson.user_id || payloadJson.sub;
      if (!uid || typeof uid !== 'string') {
        console.warn('[verifyFirebaseToken] Missing sub/user_id in payload');
        return null;
      }

      return {
        uid,
        email: payloadJson.email,
      };
    } else {
      console.warn(`[verifyFirebaseToken] No matching JWK found for kid: ${kid}`);
    }
  } catch (jwksErr) {
    console.warn('[verifyFirebaseToken] JWKS verification error, attempting REST fallback:', jwksErr);
  }

  // 2. Fallback: Google Identity Toolkit REST API
  try {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': 'https://vectorizerr.pages.dev',
        'Origin': 'https://vectorizerr.pages.dev',
      },
      body: JSON.stringify({ idToken }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`[verifyFirebaseToken] Identity Toolkit failed status ${res.status}: ${errText}`);
      return null;
    }

    const data = (await res.json()) as any;
    if (!data.users || data.users.length === 0) return null;

    return {
      uid: data.users[0].localId,
      email: data.users[0].email,
    };
  } catch (err) {
    console.error('[verifyFirebaseToken] Auth verification error:', err);
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
  // 1. Unified security verification (CORS, API Secret, App Check, Auth Token)
  const security = await verifyWorkerSecurity(request, env, { requireAuth: true });
  if (!security.isValid) {
    return security.errorResponse!;
  }

  const corsHeaders = security.corsHeaders;
  const userId = security.user!.uid;

  try {
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
