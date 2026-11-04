import { Env, getCorsHeaders, ALLOWED_ORIGINS } from '../index';
import { verifyAppCheckToken } from './app-check';
import { verifyFirebaseToken } from './auth';

export interface SecurityCheckOptions {
  /**
   * Whether to require a valid API secret (checked against env.API_SECRET).
   * Defaults to true if env.API_SECRET is defined.
   */
  requireApiSecret?: boolean;

  /**
   * Whether App Check token is strictly required.
   * Defaults to true when env.ENVIRONMENT is 'production'.
   */
  requireAppCheck?: boolean;

  /**
   * Whether a valid Firebase ID Token (Bearer) is required.
   * If true, returns 401 if missing or invalid.
   * If false, extracts and verifies user if provided, but does not block guests.
   */
  requireAuth?: boolean;
}

export interface SecurityCheckResult {
  isValid: boolean;
  errorResponse?: Response;
  corsHeaders: Record<string, string>;
  user?: { uid: string; email?: string };
  appId?: string;
}

/**
 * Convenient, centralized security validator for all Cloudflare Worker API endpoints.
 * Validates:
 * 1. CORS Origin and OPTIONS preflight
 * 2. API Secret (x-api-secret)
 * 3. Firebase App Check (X-Firebase-AppCheck)
 * 4. Firebase Authentication ID Token (Authorization: Bearer <token>)
 */
export async function verifyWorkerSecurity(
  request: Request,
  env: Env,
  options: SecurityCheckOptions = {}
): Promise<SecurityCheckResult> {
  const corsHeaders = getCorsHeaders(request);

  // 1. CORS Preflight check
  if (request.method === 'OPTIONS') {
    const origin = request.headers.get('Origin');
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return {
        isValid: false,
        errorResponse: new Response('CORS origin not allowed', { status: 403 }),
        corsHeaders,
      };
    }
    return {
      isValid: false,
      errorResponse: new Response(null, { status: 204, headers: corsHeaders }),
      corsHeaders,
    };
  }

  // 2. API Secret Verification (server-to-server protection)
  const shouldCheckSecret =
    options.requireApiSecret !== undefined
      ? options.requireApiSecret
      : Boolean(env.API_SECRET);

  if (shouldCheckSecret && env.API_SECRET) {
    const apiSecret = request.headers.get('x-api-secret');
    if (!apiSecret || apiSecret !== env.API_SECRET) {
      return {
        isValid: false,
        errorResponse: new Response(
          JSON.stringify({
            success: false,
            error: 'Unauthorized: Invalid or missing x-api-secret header.',
          }),
          {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        ),
        corsHeaders,
      };
    }
  }

  // 3. Firebase App Check Verification (anti-bot / app attestation)
  const isProd = env.ENVIRONMENT === 'production';
  const shouldRequireAppCheck =
    options.requireAppCheck !== undefined ? options.requireAppCheck : isProd;

  const appCheckToken = request.headers.get('X-Firebase-AppCheck');
  let validatedAppId: string | undefined;

  if (appCheckToken) {
    const appCheckResult = await verifyAppCheckToken(appCheckToken);
    if (!appCheckResult && isProd) {
      return {
        isValid: false,
        errorResponse: new Response(
          JSON.stringify({
            success: false,
            error: 'Unauthorized: Invalid App Check token.',
          }),
          {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        ),
        corsHeaders,
      };
    }
    if (appCheckResult) {
      validatedAppId = appCheckResult.appId;
    }
  } else if (shouldRequireAppCheck) {
    return {
      isValid: false,
      errorResponse: new Response(
        JSON.stringify({
          success: false,
          error: 'Unauthorized: Missing App Check token.',
        }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      ),
      corsHeaders,
    };
  }

  // 4. Firebase Auth Token Verification (user identity for Firestore safety)
  const authHeader = request.headers.get('Authorization') || '';
  let verifiedUser: { uid: string; email?: string } | undefined;

  if (authHeader.startsWith('Bearer ')) {
    const idToken = authHeader.slice(7).trim();
    const userResult = await verifyFirebaseToken(idToken, env.FIREBASE_PROJECT_ID);
    if (userResult) {
      verifiedUser = userResult;
    } else if (options.requireAuth) {
      // ONLY reject with 401 if authentication is strictly required by this endpoint
      return {
        isValid: false,
        errorResponse: new Response(
          JSON.stringify({
            success: false,
            error: 'Unauthorized: Invalid or expired Firebase authentication token.',
          }),
          {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        ),
        corsHeaders,
      };
    } else {
      console.warn('[Worker Security] Token provided but unverified, proceeding without user context.');
    }
  } else if (options.requireAuth) {
    return {
      isValid: false,
      errorResponse: new Response(
        JSON.stringify({
          success: false,
          error: 'Unauthorized: Missing Authorization header.',
        }),
        {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      ),
      corsHeaders,
    };
  }

  return {
    isValid: true,
    corsHeaders,
    user: verifiedUser,
    appId: validatedAppId,
  };
}
