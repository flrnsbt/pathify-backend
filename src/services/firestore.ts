import { SupportedChainKey, SupportedToken } from '../config/chains';
import { GENERATIONS_PER_UNLOCK, WELCOME_CREDITS_AMOUNT, WELCOME_GRANT_CUTOFF_MS, WELCOME_GRANT_MAX_PER_FINGERPRINT } from '../config/limits';

export interface CryptoTransactionDoc {
  id: string;
  userId: string;
  packId: string;
  credits: number;
  usdPrice: number;
  cryptoAmount: string;
  cryptoToken: SupportedToken;
  chainKey: SupportedChainKey;
  chainId?: number;
  toAddress: string;
  txHash: string;
  status: 'pending' | 'confirmed' | 'failed' | 'cancelled';
  statusMessage?: string;
  createdAt: number;
  updatedAt: number;
  confirmedAt?: number;
}

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * Base64URL encoding helper
 */
function base64UrlEncode(data: Uint8Array | string): string {
  let str: string;
  if (typeof data === 'string') {
    str = btoa(data);
  } else {
    str = btoa(String.fromCharCode(...data));
  }
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Converts a Base64-encoded PEM private key string to a WebCrypto CryptoKey
 */
async function importPrivateKey(base64Pem: string): Promise<CryptoKey> {
  if (!base64Pem || typeof base64Pem !== 'string') {
    throw new Error('Invalid private key: input is empty or not a string.');
  }

  const sanitizedBase64 = base64Pem.trim().replace(/^["']|["']$/g, '');


  const binaryDerString = atob(sanitizedBase64);
  const binaryDer = new Uint8Array(binaryDerString.length);
  for (let i = 0; i < binaryDerString.length; i++) {
    binaryDer[i] = binaryDerString.charCodeAt(i);
  }

  return await crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );
}

/**
 * Generates an OAuth2 access token for Google Firestore REST API using Service Account
 */
export async function getGoogleAccessToken(
  clientEmail?: string,
  privateKeyPem?: string
): Promise<string | null> {
  if (!clientEmail || !privateKeyPem) {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (cachedAccessToken && tokenExpiresAt > now + 120) {
    return cachedAccessToken;
  }

  try {
    const cryptoKey = await importPrivateKey(privateKeyPem);

    const header = {
      alg: 'RS256',
      typ: 'JWT',
    };

    const payload = {
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/datastore',
      aud: 'https://oauth2.googleapis.com/token',
      exp: now + 3600,
      iat: now,
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const unsignedToken = `${encodedHeader}.${encodedPayload}`;

    const signature = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      new TextEncoder().encode(unsignedToken)
    );

    const signedJwt = `${unsignedToken}.${base64UrlEncode(new Uint8Array(signature))}`;

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedJwt,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('Failed to exchange Google OAuth JWT:', errText);
      return null;
    }

    const tokenData = (await tokenRes.json()) as { access_token: string; expires_in: number };
    cachedAccessToken = tokenData.access_token;
    tokenExpiresAt = now + tokenData.expires_in;

    return cachedAccessToken;
  } catch (err) {
    console.error('Error generating Google OAuth access token:', err);
    return null;
  }
}

/**
 * Parses Firestore REST API field format into standard JavaScript values
 */
function parseFirestoreFields(fields?: Record<string, any>): Record<string, any> {
  if (!fields) return {};
  const res: Record<string, any> = {};
  for (const [key, val] of Object.entries(fields)) {
    if (val.stringValue !== undefined) res[key] = val.stringValue;
    else if (val.integerValue !== undefined) res[key] = Number(val.integerValue);
    else if (val.doubleValue !== undefined) res[key] = Number(val.doubleValue);
    else if (val.booleanValue !== undefined) res[key] = val.booleanValue;
    else if (val.timestampValue !== undefined) res[key] = new Date(val.timestampValue).getTime();
    else if (val.nullValue !== undefined) res[key] = null;
    else if (val.mapValue?.fields) res[key] = parseFirestoreFields(val.mapValue.fields);
  }
  return res;
}

/**
 * Converts a JavaScript object into Firestore REST API typed values
 */
export function toFirestoreFields(obj: Record<string, any>): Record<string, any> {
  const fields: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue;
    if (val === null) fields[key] = { nullValue: null };
    else if (typeof val === 'string') fields[key] = { stringValue: val };
    else if (typeof val === 'number') {
      if (Number.isInteger(val)) fields[key] = { integerValue: String(val) };
      else fields[key] = { doubleValue: val };
    } else if (typeof val === 'boolean') fields[key] = { booleanValue: val };
    else if (Array.isArray(val)) {
      fields[key] = {
        arrayValue: {
          values: val.map((v) => {
            if (v === null || v === undefined) return { nullValue: null };
            if (typeof v === 'string') return { stringValue: v };
            if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
            if (typeof v === 'boolean') return { booleanValue: v };
            if (typeof v === 'object') return { mapValue: { fields: toFirestoreFields(v) } };
            return { stringValue: String(v) };
          }),
        },
      };
    } else if (typeof val === 'object') {
      fields[key] = { mapValue: { fields: toFirestoreFields(val) } };
    }
  }
  return fields;
}

/**
 * Queries all pending transactions from Firestore
 */
export async function getPendingTransactions(
  projectId: string,
  accessToken: string | null,
  userIdFilter?: string
): Promise<CryptoTransactionDoc[]> {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;

  const filters: any[] = [
    {
      fieldFilter: {
        field: { fieldPath: 'status' },
        op: 'EQUAL',
        value: { stringValue: 'pending' },
      },
    },
  ];

  if (userIdFilter) {
    filters.push({
      fieldFilter: {
        field: { fieldPath: 'userId' },
        op: 'EQUAL',
        value: { stringValue: userIdFilter },
      },
    });
  }

  const queryBody = {
    structuredQuery: {
      from: [{ collectionId: 'transactions' }],
      where:
        filters.length === 1
          ? filters[0]
          : {
              compositeFilter: {
                op: 'AND',
                filters,
              },
            },
    },
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(queryBody),
    });

    if (!res.ok) {
      console.warn('Firestore runQuery response not ok:', res.status, await res.text());
      return [];
    }

    const items = (await res.json()) as any[];
    const result: CryptoTransactionDoc[] = [];

    for (const item of items) {
      if (!item.document) continue;
      const docName = item.document.name as string;
      const docId = docName.split('/').pop() || '';
      const parsed = parseFirestoreFields(item.document.fields);

      result.push({
        id: docId,
        userId: parsed.userId || '',
        packId: parsed.packId || '',
        credits: parsed.credits || 0,
        usdPrice: parsed.usdPrice || 0,
        cryptoAmount: parsed.cryptoAmount || '0',
        cryptoToken: parsed.cryptoToken || 'USDT',
        chainKey: parsed.chainKey || 'bsc',
        chainId: parsed.chainId,
        toAddress: parsed.toAddress || '',
        txHash: parsed.txHash || '',
        status: parsed.status || 'pending',
        statusMessage: parsed.statusMessage,
        createdAt: parsed.createdAt || Date.now(),
        updatedAt: parsed.updatedAt || Date.now(),
        confirmedAt: parsed.confirmedAt,
      });
    }

    return result;
  } catch (err) {
    console.error('Error fetching pending transactions from Firestore:', err);
    return [];
  }
}

/**
 * Updates a transaction document in Firestore (status, confirmedAt, etc.)
 */
export async function updateTransactionDoc(
  projectId: string,
  accessToken: string | null,
  transactionId: string,
  patch: Partial<CryptoTransactionDoc>
): Promise<boolean> {
  const fields = toFirestoreFields(patch);
  const updateMask = Object.keys(patch)
    .map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`)
    .join('&');

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/transactions/${transactionId}?${updateMask}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ fields }),
    });

    if (!res.ok) {
      console.error('Failed to patch transaction in Firestore:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('Error updating transaction in Firestore:', err);
    return false;
  }
}

/**
 * Atomically increments user credits in Firestore
 */
export async function incrementUserCredits(
  projectId: string,
  accessToken: string | null,
  userId: string,
  creditsToAdd: number
): Promise<boolean> {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`;

  const commitBody = {
    writes: [
      {
        transform: {
          document: `projects/${projectId}/databases/(default)/documents/users/${userId}`,
          fieldTransforms: [
            {
              fieldPath: 'credits',
              increment: {
                integerValue: String(creditsToAdd),
              },
            },
            {
              fieldPath: 'updatedAt',
              setToServerValue: 'REQUEST_TIME',
            },
          ],
        },
      },
    ],
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(commitBody),
    });

    if (!res.ok) {
      console.error('Failed to increment user credits:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('Error incrementing user credits:', err);
    return false;
  }
}

export interface SupportTicketData {
  id: string;
  userId?: string;
  userEmail: string;
  name?: string;
  category: string;
  subject?: string;
  message: string;
  txHash?: string;
  chainKey?: string;
  walletAddress?: string;
  status: 'open' | 'in_progress' | 'resolved';
  createdAt: number;
  emailSent?: boolean;
}

/**
 * Creates a support ticket document in Firestore (support_tickets collection)
 */
export async function createSupportTicketDoc(
  projectId: string,
  accessToken: string | null,
  ticket: SupportTicketData
): Promise<boolean> {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/support_tickets?documentId=${ticket.id}`;

  const fields: Record<string, any> = {
    id: { stringValue: ticket.id },
    userEmail: { stringValue: ticket.userEmail },
    category: { stringValue: ticket.category },
    message: { stringValue: ticket.message },
    status: { stringValue: ticket.status || 'open' },
    createdAt: { integerValue: String(ticket.createdAt) },
  };

  if (ticket.userId) fields.userId = { stringValue: ticket.userId };
  if (ticket.name) fields.name = { stringValue: ticket.name };
  if (ticket.subject) fields.subject = { stringValue: ticket.subject };
  if (ticket.txHash) fields.txHash = { stringValue: ticket.txHash };
  if (ticket.chainKey) fields.chainKey = { stringValue: ticket.chainKey };
  if (ticket.walletAddress) fields.walletAddress = { stringValue: ticket.walletAddress };
  if (typeof ticket.emailSent === 'boolean') fields.emailSent = { booleanValue: ticket.emailSent };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ fields }),
    });

    if (!res.ok) {
      console.error('Failed to create support ticket in Firestore:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('Error creating support ticket in Firestore:', err);
    return false;
  }
}

export interface CreateTransactionInput {
  userId: string;
  packId: string;
  credits: number;
  usdPrice: number;
  cryptoAmount: string;
  cryptoToken: string;
  chainKey: string;
  chainId?: number;
  toAddress: string;
  txHash?: string;
  paymentMethod?: "web3" | "direct";
  fromAddress?: string;
  statusMessage?: string;
}

/**
 * Creates a transaction document in Firestore (transactions collection).
 * Status, timestamps and paymentMethod are set server-side.
 */
export async function createTransactionDoc(
  projectId: string,
  accessToken: string | null,
  data: CreateTransactionInput
): Promise<string> {
  const now = Date.now();
  const docId = `tx_${now}_${crypto.randomUUID().slice(0, 8)}`;

  const txData = {
    ...data,
    id: docId,
    paymentMethod: data.paymentMethod ?? 'web3',
    status: 'pending' as const,
    statusMessage: data.statusMessage ?? 'Awaiting blockchain confirmation.',
    createdAt: now,
    updatedAt: now,
  };

  const fields = toFirestoreFields(txData);
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/transactions?documentId=${docId}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ fields }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Failed to create transaction document in Firestore (${res.status}): ${errText}`);
  }

  return docId;
}

/**
 * Atomically unlocks an image for a user: decrements credits by 1 and sets the unlock entry
 * in a single Firestore commit with updateTime precondition.
 * Returns true on success, false on precondition failure or error.
 */
export async function atomicUnlockImage(
  projectId: string,
  accessToken: string | null,
  userId: string,
  imageHash: string,
  unlockedAt: number,
  maxAttempts = 3
): Promise<boolean> {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`;

  const userDocPath = `projects/${projectId}/databases/(default)/documents/users/${userId}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const commitBody = {
      writes: [
        {
          transform: {
            document: userDocPath,
            fieldTransforms: [
              {
                fieldPath: 'credits',
                increment: {
                  integerValue: '-1',
                },
              },
              {
                fieldPath: 'updatedAt',
                setToServerValue: 'REQUEST_TIME',
              },
            ],
          },
        },
        {
          update: {
            name: userDocPath,
            fields: {
              unlockedImages: {
                mapValue: {
                  fields: {
                    [imageHash]: {
                      mapValue: {
                        fields: {
                          imageHash: { stringValue: imageHash },
                          generationsUsed: { integerValue: '0' },
                          maxGenerations: { integerValue: String(GENERATIONS_PER_UNLOCK) },
                          unlockedAt: { integerValue: String(unlockedAt) },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          updateMask: {
            fieldPaths: [`unlockedImages.\`${imageHash}\``],
          },
        },
      ],
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(commitBody),
      });

      if (res.ok) {
        return true;
      }

      const errText = await res.text().catch(() => '');
      if (res.status === 400 && errText.includes('FAILED_PRECONDITION')) {
        console.warn(`[atomicUnlockImage] Precondition failed, attempt ${attempt + 1}/${maxAttempts}`);
        continue;
      }

      console.error(
        `[atomicUnlockImage] Commit failed: ${res.status} body=${errText} request=${JSON.stringify(commitBody)}`
      );
      return false;
    } catch (err) {
      console.error(`[atomicUnlockImage] Error:`, err);
      return false;
    }
  }

  console.error(`[atomicUnlockImage] Failed after ${maxAttempts} attempts`);
  return false;
}

/**
 * Records that a generation (keyed by SVG content hash) has been validated —
 * i.e. quota was consumed for it. Account-scoped and independent of the
 * source-image history docs, so re-exports of the same SVG stay free even
 * after the history entry was deleted. Idempotent upsert via PATCH.
 */
export async function markGenerationValidated(
  projectId: string,
  accessToken: string | null,
  userId: string,
  imageHash: string,
  generationId: string
): Promise<void> {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${userId}/validatedGenerations/${generationId}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  const res = await fetch(url, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      fields: {
        userId: { stringValue: userId },
        imageHash: { stringValue: imageHash },
        generationId: { stringValue: generationId },
        createdAt: { integerValue: String(Date.now()) },
      },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[markGenerationValidated] Failed (${res.status}): ${errText}`);
  }
}

export type ConsumeGenerationResult = 'ok' | 'conflict' | 'error';

/**
 * Atomically consumes one generation for an unlocked image.
 *
 * Uses a slot-claim pattern: the commit creates
 * `users/{uid}/image_quota/{imageHash}_{quotaEpoch}_{slotIndex}` with an
 * exists=false precondition AND increments generationsUsed — all in one
 * atomic commit. Two concurrent consumers claiming the same slot index
 * cannot both succeed; the loser gets 'conflict' and must re-read state.
 * `quotaEpoch` (the unlock's unlockedAt timestamp) namespaces slots per
 * unlock so re-unlocking an image doesn't collide with old slot docs.
 */
export async function atomicConsumeGeneration(
  projectId: string,
  accessToken: string | null,
  userId: string,
  imageHash: string,
  quotaEpoch: number,
  slotIndex: number,
  maxAttempts = 3
): Promise<ConsumeGenerationResult> {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`;

  const userDocPath = `projects/${projectId}/databases/(default)/documents/users/${userId}`;
  const slotDocPath = `projects/${projectId}/databases/(default)/documents/users/${userId}/image_quota/${imageHash}_${quotaEpoch}_${slotIndex}`;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const commitBody = {
      writes: [
        {
          // Slot claim: fails with FAILED_PRECONDITION if already consumed
          update: {
            name: slotDocPath,
            fields: {
              imageHash: { stringValue: imageHash },
              quotaEpoch: { integerValue: String(quotaEpoch) },
              slotIndex: { integerValue: String(slotIndex) },
            },
          },
          currentDocument: { exists: false },
        },
        {
          transform: {
            document: userDocPath,
            fieldTransforms: [
              {
                fieldPath: `unlockedImages.\`${imageHash}\`.generationsUsed`,
                increment: {
                  integerValue: '1',
                },
              },
              {
                fieldPath: 'updatedAt',
                setToServerValue: 'REQUEST_TIME',
              },
            ],
          },
        },
      ],
    };

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (accessToken) {
      headers['Authorization'] = `Bearer ${accessToken}`;
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(commitBody),
      });

      if (res.ok) {
        return 'ok';
      }

      const errText = await res.text().catch(() => '');
      if (
        (res.status === 400 || res.status === 409) &&
        (errText.includes('FAILED_PRECONDITION') || errText.includes('ALREADY_EXISTS'))
      ) {
        // Slot already claimed by a concurrent consume — caller must re-read and retry
        return 'conflict';
      }

      console.error(
        `[atomicConsumeGeneration] Commit failed: ${res.status} body=${errText} request=${JSON.stringify(commitBody)}`
      );
      return 'error';
    } catch (err) {
      console.error(`[atomicConsumeGeneration] Error:`, err);
      return 'error';
    }
  }

  console.error(`[atomicConsumeGeneration] Failed after ${maxAttempts} attempts`);
  return 'error';
}

export type WelcomeGrantResult =
  | 'granted'
  | 'already_granted'
  | 'ineligible'
  | 'no_fingerprint'
  | 'blacklisted'
  | 'fingerprint_limit'
  | 'error';

const MARKER_SUBCOLLECTION = 'onboarding';
const WELCOME_MARKER_DOC = 'welcomeCredits';
const BLACKLIST_COLLECTION = 'welcome_credit_blacklist';
const FINGERPRINT_CLAIMS_COLLECTION = 'fingerprint_claims';

function isValidFingerprintId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(id);
}

async function getDocJson(
  url: string,
  headers: Record<string, string>
): Promise<{ status: number; doc?: any }> {
  const res = await fetch(url, { headers });
  if (!res.ok) return { status: res.status };
  return { status: res.status, doc: await res.json().catch(() => undefined) };
}

/**
 * Grants the one-time welcome credit bonus to a newly created account.
 *
 * Eligibility gates (any failure denies the grant, never partial):
 *  1. Account age — user doc `createTime` must be at/after
 *     WELCOME_GRANT_CUTOFF_MS (or the doc must not exist yet), so existing
 *     accounts get nothing retroactively.
 *  2. One-time marker — `users/{uid}/onboarding/welcomeCredits` must not exist.
 *  3. Fingerprint required — client must supply a FingerprintJS visitorId.
 *  4. Manual blacklist — `welcome_credit_blacklist/{fingerprintId}` must not exist.
 *  5. Fingerprint cap — `fingerprint_claims/{fingerprintId}.userCount` must be
 *     below WELCOME_GRANT_MAX_PER_FINGERPRINT.
 *
 * The grant itself is a single atomic commit: it claims the fingerprint slot
 * (absolute userCount write guarded by an updateTime/exists precondition),
 * creates the user marker (exists=false), and increments `credits`. Any
 * precondition failure retries with fresh state, so concurrent claims cannot
 * exceed the cap or double-grant.
 */
export async function grantWelcomeCredits(
  projectId: string,
  accessToken: string | null,
  userId: string,
  fingerprintId?: string
): Promise<WelcomeGrantResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const dbBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const userDocPath = `projects/${projectId}/databases/(default)/documents/users/${userId}`;
  const markerDocPath = `${userDocPath}/${MARKER_SUBCOLLECTION}/${WELCOME_MARKER_DOC}`;
  const fp = typeof fingerprintId === 'string' ? fingerprintId.trim() : '';

  try {
    // 1. Account-age gate
    const userRes = await getDocJson(`${dbBase}/users/${userId}`, headers);
    if (userRes.status === 200 && userRes.doc) {
      const createTimeMs = userRes.doc.createTime ? Date.parse(userRes.doc.createTime) : NaN;
      if (Number.isFinite(createTimeMs) && createTimeMs < WELCOME_GRANT_CUTOFF_MS) {
        return 'ineligible';
      }
    } else if (userRes.status !== 404) {
      console.error(`[grantWelcomeCredits] Failed to fetch user doc: ${userRes.status}`);
      return 'error';
    }
    // 404 = doc doesn't exist yet → brand-new account.

    // 2. One-time marker gate
    const markerRes = await getDocJson(`${dbBase}/users/${userId}/${MARKER_SUBCOLLECTION}/${WELCOME_MARKER_DOC}`, headers);
    if (markerRes.status === 200 && markerRes.doc) {
      return 'already_granted';
    }
    if (markerRes.status !== 200 && markerRes.status !== 404) {
      console.error(`[grantWelcomeCredits] Failed to fetch marker doc: ${markerRes.status}`);
      return 'error';
    }

    // 3. Fingerprint required
    if (!isValidFingerprintId(fp)) {
      return 'no_fingerprint';
    }

    // 4. Manual blacklist gate
    const blacklistRes = await getDocJson(
      `${dbBase}/${BLACKLIST_COLLECTION}/${encodeURIComponent(fp)}`,
      headers
    );
    if (blacklistRes.status === 200 && blacklistRes.doc) {
      return 'blacklisted';
    }
    if (blacklistRes.status !== 200 && blacklistRes.status !== 404) {
      console.error(`[grantWelcomeCredits] Failed to fetch blacklist doc: ${blacklistRes.status}`);
      return 'error';
    }

    // 5. Fingerprint cap + atomic grant, with optimistic retries
    const claimsDocPath = `projects/${projectId}/databases/(default)/documents/${FINGERPRINT_CLAIMS_COLLECTION}/${fp}`;
    const claimsUrl = `${dbBase}/${FINGERPRINT_CLAIMS_COLLECTION}/${encodeURIComponent(fp)}`;

    for (let attempt = 0; attempt < 3; attempt++) {
      const claimsRes = await getDocJson(claimsUrl, headers);
      if (claimsRes.status !== 200 && claimsRes.status !== 404) {
        console.error(`[grantWelcomeCredits] Failed to fetch fingerprint claims: ${claimsRes.status}`);
        return 'error';
      }

      const currentCount = claimsRes.doc?.fields?.userCount?.integerValue
        ? Number(claimsRes.doc.fields.userCount.integerValue)
        : 0;
      if (currentCount >= WELCOME_GRANT_MAX_PER_FINGERPRINT) {
        return 'fingerprint_limit';
      }

      const commitBody = {
        writes: [
          {
            // Claim one slot on this fingerprint. Absolute write guarded by
            // updateTime/exists precondition so concurrent claims serialize.
            update: {
              name: claimsDocPath,
              fields: {
                userCount: { integerValue: String(currentCount + 1) },
                lastUserId: { stringValue: userId },
                updatedAt: { integerValue: String(Date.now()) },
              },
            },
            updateMask: { fieldPaths: ['userCount', 'lastUserId', 'updatedAt'] },
            currentDocument: claimsRes.doc?.updateTime
              ? { updateTime: claimsRes.doc.updateTime }
              : { exists: false },
          },
          {
            // One-time marker claim
            update: {
              name: markerDocPath,
              fields: {
                userId: { stringValue: userId },
                fingerprintId: { stringValue: fp },
                amount: { integerValue: String(WELCOME_CREDITS_AMOUNT) },
                grantedAt: { integerValue: String(Date.now()) },
              },
            },
            currentDocument: { exists: false },
          },
          {
            transform: {
              document: userDocPath,
              fieldTransforms: [
                {
                  fieldPath: 'credits',
                  increment: { integerValue: String(WELCOME_CREDITS_AMOUNT) },
                },
                {
                  fieldPath: 'updatedAt',
                  setToServerValue: 'REQUEST_TIME',
                },
              ],
            },
          },
        ],
      };

      const res = await fetch(`${dbBase}:commit`, {
        method: 'POST',
        headers,
        body: JSON.stringify(commitBody),
      });

      if (res.ok) {
        return 'granted';
      }

      const errText = await res.text().catch(() => '');
      if (
        (res.status === 400 || res.status === 409 || res.status === 412) &&
        (errText.includes('FAILED_PRECONDITION') ||
          errText.includes('ABORTED') ||
          errText.includes('ALREADY_EXISTS'))
      ) {
        // Concurrent claim changed state — re-read and retry
        continue;
      }

      console.error(`[grantWelcomeCredits] Commit failed: ${res.status} body=${errText}`);
      return 'error';
    }

    // Retries exhausted — check whether a concurrent call already granted
    const markerCheck = await getDocJson(
      `${dbBase}/users/${userId}/${MARKER_SUBCOLLECTION}/${WELCOME_MARKER_DOC}`,
      headers
    );
    if (markerCheck.status === 200 && markerCheck.doc) {
      return 'already_granted';
    }
    return 'error';
  } catch (err) {
    console.error('[grantWelcomeCredits] Error:', err);
    return 'error';
  }
}

/**
 * Atomically confirms a transaction and increments user credits in a single Firestore commit.
 * Uses currentDocument precondition on the transaction document so concurrent runs can't both win.
 */
export async function confirmAndCreditAtomically(
  projectId: string,
  accessToken: string | null,
  transactionId: string,
  userId: string,
  creditsToAdd: number,
  confirmedAt: number,
  txHash?: string,
  statusMessage?: string
): Promise<boolean> {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`;

  const txDocPath = `projects/${projectId}/databases/(default)/documents/transactions/${transactionId}`;
  const userDocPath = `projects/${projectId}/databases/(default)/documents/users/${userId}`;

  const txFields: Record<string, any> = {
    status: { stringValue: 'confirmed' },
    confirmedAt: { integerValue: String(confirmedAt) },
    updatedAt: { integerValue: String(confirmedAt) },
  };
  if (txHash) {
    txFields.txHash = { stringValue: txHash };
  }
  if (statusMessage) {
    txFields.statusMessage = { stringValue: statusMessage };
  }

  const txUpdateMask = ['status', 'confirmedAt', 'updatedAt'];
  if (txHash) txUpdateMask.push('txHash');
  if (statusMessage) txUpdateMask.push('statusMessage');

  const commitBody = {
    writes: [
      {
        update: {
          name: txDocPath,
          fields: txFields,
        },
        updateMask: {
          fieldPaths: txUpdateMask,
        },
        currentDocument: {
          exists: true,
        },
      },
      {
        transform: {
          document: userDocPath,
          fieldTransforms: [
            {
              fieldPath: 'credits',
              increment: {
                integerValue: String(creditsToAdd),
              },
            },
            {
              fieldPath: 'updatedAt',
              setToServerValue: 'REQUEST_TIME',
            },
          ],
        },
      },
    ],
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(commitBody),
    });

    if (res.ok) {
      return true;
    }

    const errText = await res.text().catch(() => '');
    console.error(`[confirmAndCreditAtomically] Commit failed: ${res.status} body=${errText} request=${JSON.stringify(commitBody)}`);
    return false;
  } catch (err) {
    console.error(`[confirmAndCreditAtomically] Error:`, err);
    return false;
  }
}

/**
 * Fetches a single Firestore document's parsed fields, or null when missing.
 * `docPath` is relative to the database root, e.g. `users/{uid}/history/{id}`.
 */
async function getFirestoreDocFields(
  projectId: string,
  accessToken: string | null,
  docPath: string
): Promise<Record<string, any> | null> {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${docPath}`;
  const headers: Record<string, string> = {};
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn(`Firestore GET ${docPath} failed:`, res.status, await res.text());
    return null;
  }
  const doc = (await res.json()) as any;
  return parseFirestoreFields(doc.fields);
}

export interface SaveGenerationInput {
  userId: string;
  imageHash: string;
  generationId?: string;
  svg: string;
  [key: string]: any;
}

export interface SaveGenerationResult {
  historyId: string;
  generationId: string;
  deduped: boolean;
}

// Firestore caps a single field at ~1MiB; keep margin for the rest of the doc.
const MAX_SVG_STORAGE_BYTES = 1_000_000;

function uint8ToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/**
 * Encodes an SVG for Firestore storage as raw gzip bytes (bytesValue), avoiding
 * the ~33% base64 inflation of the previous 'gz:' string format. Accepts either
 * a 'gz:'-prefixed base64 payload or a raw SVG string (gzipped here).
 * Throws 'SVG_TOO_LARGE' when the payload exceeds the field limit.
 */
async function encodeSvgField(svg: string): Promise<{ bytesValue: string }> {
  let bytes: Uint8Array;
  if (typeof svg === 'string' && svg.startsWith('gz:')) {
    const bin = atob(svg.slice(3));
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
  } else {
    const stream = new Blob([svg ?? ''])
      .stream()
      .pipeThrough(new CompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }

  if (bytes.length > MAX_SVG_STORAGE_BYTES) {
    throw new Error('SVG_TOO_LARGE');
  }
  return { bytesValue: uint8ToBase64(bytes) };
}

/**
 * Saves a validated generation under the source-image history entry:
 * `users/{userId}/history/{imageHash}` holds image-level data, and each
 * generation lives in its `generations` subcollection keyed by generationId
 * (the SVG content hash), making saves idempotent.
 */
export async function saveGenerationDoc(
  projectId: string,
  accessToken: string | null,
  data: SaveGenerationInput
): Promise<SaveGenerationResult> {
  const now = Date.now();
  const historyId = data.imageHash || `hist_${now}_${crypto.randomUUID().slice(0, 8)}`;
  const generationId = data.generationId || `gen_${now}_${crypto.randomUUID().slice(0, 8)}`;

  const docRoot = `projects/${projectId}/databases/(default)/documents`;
  const histPath = `users/${data.userId}/history/${historyId}`;
  const histDocPath = `${docRoot}/${histPath}`;
  const genDocPath = `${histDocPath}/generations/${generationId}`;

  const { userId: _u, generationId: _g, createdAt: _c, svg: _svg, ...genRest } = data;
  const generationFields = toFirestoreFields({
    id: generationId,
    generationId,
    userId: data.userId,
    createdAt: now,
    ...genRest,
  });
  generationFields.svg = await encodeSvgField(data.svg);

  const histMutable = {
    imageHash: data.imageHash,
    fileName: data.fileName,
    originalDimensions: data.originalDimensions,
    originalSize: data.originalSize,
    updatedAt: now,
  };

  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    // Idempotent: generation already stored -> nothing to do
    const existingGen = await getFirestoreDocFields(projectId, accessToken, `${histPath}/generations/${generationId}`);
    if (existingGen) {
      return { historyId, generationId, deduped: true };
    }
    const histExists = (await getFirestoreDocFields(projectId, accessToken, histPath)) !== null;

    const writes: any[] = [
      {
        update: { name: genDocPath, fields: generationFields },
        currentDocument: { exists: false },
      },
    ];

    if (histExists) {
      const histFields = toFirestoreFields(histMutable);
      writes.push({
        update: {
          name: histDocPath,
          fields: histFields,
          updateMask: { fieldPaths: Object.keys(histFields) },
        },
        currentDocument: { exists: true },
      });
    } else {
      writes.push({
        update: {
          name: histDocPath,
          fields: toFirestoreFields({
            id: historyId,
            userId: data.userId,
            imageHash: data.imageHash,
            fileName: data.fileName,
            originalDimensions: data.originalDimensions,
            originalSize: data.originalSize,
            createdAt: now,
            updatedAt: now,
          }),
        },
        currentDocument: { exists: false },
      });
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ writes }),
    });

    if (res.ok) {
      return { historyId, generationId, deduped: false };
    }

    const errText = await res.text().catch(() => '');
    if (
      (res.status === 400 || res.status === 409) &&
      (errText.includes('FAILED_PRECONDITION') || errText.includes('ALREADY_EXISTS'))
    ) {
      continue;
    }

    throw new Error(`Failed to save generation in Firestore (${res.status}): ${errText}`);
  }

  throw new Error('Failed to save generation in Firestore: precondition retries exhausted');
}
