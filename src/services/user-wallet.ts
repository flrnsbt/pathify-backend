import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Env } from "../index";

/**
 * Per-user EVM deposit wallets.
 *
 * - Public address lives on the user doc (`users/{uid}.evmAddress`) so the
 *   client can read it with normal Firestore rules.
 * - The private key lives in a separate `user_wallet_keys` collection
 *   (doc id = userId), AES-GCM encrypted with a key derived from a server
 *   secret — clients never read this collection.
 * - One EVM address serves every EVM chain (same address on all of them);
 *   non-EVM chains (e.g. btc) keep using the static wallets.*.json addresses.
 */

const USER_WALLET_KEYS_COLLECTION = "user_wallet_keys";

function docPath(projectId: string, collection: string, docId: string): string {
  return `projects/${projectId}/databases/(default)/documents/${collection}/${docId}`;
}

async function getEncryptionKey(env: Env): Promise<CryptoKey> {
  const secret =
    env.WALLET_ENCRYPTION_SECRET;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function encryptPrivateKey(
  privateKey: `0x${string}`,
  env: Env,
): Promise<string> {
  const key = await getEncryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(privateKey),
  );
  const toB64 = (buf: ArrayBuffer | Uint8Array) =>
    btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));
  return `${toB64(iv)}.${toB64(ciphertext)}`;
}

export async function decryptPrivateKey(
  payload: string,
  env: Env,
): Promise<`0x${string}`> {
  const key = await getEncryptionKey(env);
  const [ivB64, ctB64] = payload.split(".");
  const fromB64 = (b64: string) =>
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64(ivB64) as BufferSource },
    key,
    fromB64(ctB64) as BufferSource,
  );
  return new TextDecoder().decode(plaintext) as `0x${string}`;
}

function authHeaders(accessToken: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  return headers;
}

// Resolved EVM addresses are immutable once written, so cache hits per
// isolate for 10 minutes. Misses are never cached — a first-time wallet must
// be created promptly. Keyed by `${projectId}:${userId}`.
const ADDRESS_CACHE_TTL_MS = 10 * 60 * 1000;
const addressCache = new Map<string, { address: string; expiresAt: number }>();

function addressCacheKey(projectId: string, userId: string): string {
  return `${projectId}:${userId}`;
}

/** Reads users/{uid}.evmAddress. Returns null when absent. */
export async function getUserEvmAddress(
  projectId: string,
  accessToken: string | null,
  userId: string,
): Promise<string | null> {
  const cacheKey = addressCacheKey(projectId, userId);
  const hit = addressCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.address;
  if (hit) addressCache.delete(cacheKey);

  const url = `https://firestore.googleapis.com/v1/${docPath(projectId, "users", userId)}`;
  try {
    const res = await fetch(url, { headers: authHeaders(accessToken) });
    if (!res.ok) return null;
    const doc = (await res.json()) as any;
    const address = doc?.fields?.evmAddress?.stringValue || null;
    if (address) {
      addressCache.set(cacheKey, {
        address,
        expiresAt: Date.now() + ADDRESS_CACHE_TTL_MS,
      });
    }
    return address;
  } catch {
    return null;
  }
}

/** Reads the address stored in user_wallet_keys/{userId}. */
async function getKeyDocAddress(
  projectId: string,
  accessToken: string | null,
  userId: string,
): Promise<string | null> {
  const url = `https://firestore.googleapis.com/v1/${docPath(
    projectId,
    USER_WALLET_KEYS_COLLECTION,
    userId,
  )}`;
  try {
    const res = await fetch(url, { headers: authHeaders(accessToken) });
    if (!res.ok) return null;
    const doc = (await res.json()) as any;
    return doc?.fields?.address?.stringValue || null;
  } catch {
    return null;
  }
}

async function patchUserEvmAddress(
  projectId: string,
  accessToken: string | null,
  userId: string,
  address: string,
): Promise<boolean> {
  const url = `https://firestore.googleapis.com/v1/${docPath(
    projectId,
    "users",
    userId,
  )}?updateMask.fieldPaths=evmAddress`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      fields: { evmAddress: { stringValue: address } },
    }),
  });
  if (!res.ok) {
    console.error(
      "[user-wallet] Failed to patch evmAddress:",
      res.status,
      await res.text().catch(() => ""),
    );
    return false;
  }
  return true;
}

/**
 * Returns the user's EVM address, generating and storing a new wallet on first
 * use. Safe under concurrent calls: the key doc id is the userId, so only one
 * creation wins; losers recover the winner's address.
 */
export async function getOrCreateUserEvmAddress(
  projectId: string,
  accessToken: string | null,
  userId: string,
  env: Env,
): Promise<string> {
  const existing = await getUserEvmAddress(projectId, accessToken, userId);
  if (existing) return existing;

  const privateKey = generatePrivateKey();
  const address = privateKeyToAccount(privateKey).address;
  const encryptedKey = await encryptPrivateKey(privateKey, env);

  const collectionUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${USER_WALLET_KEYS_COLLECTION}?documentId=${encodeURIComponent(userId)}`;
  const createRes = await fetch(collectionUrl, {
    method: "POST",
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      fields: {
        userId: { stringValue: userId },
        address: { stringValue: address },
        privateKey: { stringValue: encryptedKey },
        createdAt: { integerValue: String(Date.now()) },
      },
    }),
  });

  let resolvedAddress: string = address;
  if (createRes.status === 409) {
    // Another request created the wallet first — use its address
    const winnerAddress = await getKeyDocAddress(
      projectId,
      accessToken,
      userId,
    );
    if (!winnerAddress) {
      throw new Error("Failed to resolve existing user wallet");
    }
    resolvedAddress = winnerAddress;
  } else if (!createRes.ok) {
    const errText = await createRes.text().catch(() => "");
    throw new Error(`Failed to store user wallet key (${createRes.status}): ${errText}`);
  }

  await patchUserEvmAddress(projectId, accessToken, userId, resolvedAddress);
  addressCache.set(addressCacheKey(projectId, userId), {
    address: resolvedAddress,
    expiresAt: Date.now() + ADDRESS_CACHE_TTL_MS,
  });
  return resolvedAddress;
}
