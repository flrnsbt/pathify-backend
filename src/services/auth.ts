import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface VerifiedFirebaseUser {
  uid: string;
  email?: string;
}

/**
 * Verifies a Firebase ID token using the `jose` library with Google's JWKS endpoint.
 * Requires exact `iss` and `aud` matches, strict `exp` checking, and fails closed
 * if `FIREBASE_PROJECT_ID` is unset.
 *
 * Replaces the manual JWKS caching + Web Crypto RS256 + Identity Toolkit REST fallback
 * with a well-tested library implementation.
 */
// Hoisted to module scope: jose caches fetched keys per JWKS instance, so a
// per-request instance would refetch Google's JWKS on every verification.
const firebaseJwks = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com')
);

export async function verifyFirebaseToken(
  idToken: string,
  projectId?: string
): Promise<VerifiedFirebaseUser | null> {
  if (!idToken || typeof idToken !== 'string') {
    return null;
  }

  // Fail closed if project ID is not configured
  if (!projectId) {
    console.warn('[verifyFirebaseToken] FIREBASE_PROJECT_ID is not set, failing closed');
    return null;
  }

  try {
    const { payload } = await jwtVerify(idToken, firebaseJwks, {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });

    const uid = payload.user_id || payload.sub;
    if (!uid || typeof uid !== 'string') {
      console.warn('[verifyFirebaseToken] Missing sub/user_id in payload');
      return null;
    }

    return {
      uid,
      email: typeof payload.email === 'string' ? payload.email : undefined,
    };
  } catch (err) {
    console.warn('[verifyFirebaseToken] Token verification failed:', err);
    return null;
  }
}
