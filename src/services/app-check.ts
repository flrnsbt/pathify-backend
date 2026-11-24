/**
 * Firebase App Check Verification Service for Cloudflare Workers
 * Cryptographically verifies X-Firebase-AppCheck JWT tokens against Google's JWKS.
 */

const FIREBASE_PROJECT_NUMBER = "717678476656";

let cachedJwks: {
  keys: Array<{ n: string; e: string; kid: string }>;
  exp: number;
} | null = null;

async function getAppCheckJwks(): Promise<
  Array<{ n: string; e: string; kid: string }>
> {
  const now = Date.now();
  if (cachedJwks && cachedJwks.exp > now) {
    return cachedJwks.keys;
  }

  try {
    const res = await fetch("https://firebaseappcheck.googleapis.com/v1/jwks");
    if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
    const data = (await res.json()) as {
      keys: Array<{ n: string; e: string; kid: string }>;
    };
    cachedJwks = { keys: data.keys, exp: now + 3600000 };
    return data.keys;
  } catch (err) {
    console.error("[AppCheck] Error fetching JWKS:", err);
    throw err;
  }
}

function base64UrlToBuffer(base64url: string): ArrayBuffer {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Cryptographically verifies a Firebase App Check token.
 * Returns the appId on success, or null on failure.
 */
export async function verifyAppCheckToken(
  token?: string | null,
  projectNumber = FIREBASE_PROJECT_NUMBER,
): Promise<{ appId: string } | null> {
  if (!token) return null;

  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    // Decode header
    const header = JSON.parse(
      new TextDecoder().decode(base64UrlToBuffer(parts[0])),
    ) as { alg: string; typ: string; kid: string };

    if (header.alg !== "RS256") return null;

    // Decode payload
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlToBuffer(parts[1])),
    ) as {
      iss: string;
      aud: string | string[];
      exp: number;
      sub: string;
    };

    // Verify expiration
    if (payload.exp <= Date.now() / 1000) return null;

    // Verify issuer & audience
    const expectedIss = `https://firebaseappcheck.googleapis.com/${projectNumber}`;
    if (payload.iss !== expectedIss) return null;

    const expectedAud = `projects/${projectNumber}`;
    const audArray = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audArray.some((a) => a.includes(expectedAud))) return null;

    // Verify signature with JWKS
    const jwks = await getAppCheckJwks();
    const key = jwks.find((k) => k.kid === header.kid);
    if (!key) return null;

    const fullJwk = {
      kty: "RSA",
      n: key.n,
      e: key.e,
      alg: "RS256",
      use: "sig",
    };

    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      fullJwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const signatureBuf = base64UrlToBuffer(parts[2]);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      signatureBuf,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );

    if (!valid) return null;

    return { appId: payload.sub };
  } catch (err) {
    console.warn("[AppCheck] Token verification failed:", err);
    return null;
  }
}
