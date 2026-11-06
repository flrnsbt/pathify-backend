/**
 * Product limits — single source of truth for generation quotas.
 * Exposed to the frontend via /api/app-config (`limits.generationsPerUnlock`).
 */
export const GENERATIONS_PER_UNLOCK = 3;

/**
 * One-time welcome credit grant for new accounts.
 * WELCOME_GRANT_CUTOFF_MS approximates the feature ship date: user docs created
 * before it belong to pre-existing accounts and are not eligible, so the grant
 * is never applied retroactively.
 */
export const WELCOME_CREDITS_AMOUNT = 3;
export const WELCOME_GRANT_CUTOFF_MS = Date.UTC(2026, 10, 6);

/**
 * Anti-abuse: maximum number of accounts sharing one device fingerprint
 * (FingerprintJS visitorId) that may receive the welcome bonus.
 * Accounts beyond this are denied — tune as abuse patterns emerge.
 */
export const WELCOME_GRANT_MAX_PER_FINGERPRINT = 3;
