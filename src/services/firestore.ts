import { SupportedChainKey, SupportedToken } from '../config/chains';

export interface CryptoTransactionDoc {
  id: string;
  userId: string;
  userEmail?: string;
  packId: string;
  credits: number;
  usdPrice: number;
  cryptoAmount: string;
  cryptoToken: SupportedToken;
  chainKey: SupportedChainKey;
  chainId?: number;
  paymentMethod: 'web3' | 'direct';
  fromAddress?: string;
  toAddress: string;
  txHash?: string;
  status: 'pending' | 'confirmed' | 'failed' | 'cancelled';
  statusMessage?: string;
  createdAt: number;
  updatedAt: number;
  confirmedAt?: number;
  isTestnet?: boolean;
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
 * Converts a PEM formatted private key to a WebCrypto CryptoKey
 */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Clean up PEM wrapper and whitespace
  const cleanPem = pem
    .replace(/-----BEGIN[A-Z0-9_-]+PRIVATE KEY-----/g, '')
    .replace(/-----END[A-Z0-9_-]+PRIVATE KEY-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\s+/g, '');

  const binaryDerString = atob(cleanPem);
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
        userEmail: parsed.userEmail,
        packId: parsed.packId || '',
        credits: parsed.credits || 0,
        usdPrice: parsed.usdPrice || 0,
        cryptoAmount: parsed.cryptoAmount || '0',
        cryptoToken: parsed.cryptoToken || 'USDT',
        chainKey: parsed.chainKey || 'bsc',
        chainId: parsed.chainId,
        paymentMethod: parsed.paymentMethod || 'web3',
        fromAddress: parsed.fromAddress,
        toAddress: parsed.toAddress || '',
        txHash: parsed.txHash,
        status: parsed.status || 'pending',
        statusMessage: parsed.statusMessage,
        createdAt: parsed.createdAt || Date.now(),
        updatedAt: parsed.updatedAt || Date.now(),
        confirmedAt: parsed.confirmedAt,
        isTestnet: Boolean(parsed.isTestnet),
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
  id?: string;
  userId: string;
  userEmail?: string;
  packId: string;
  credits: number;
  usdPrice: number;
  cryptoAmount: string;
  cryptoToken: string;
  chainKey: string;
  chainId?: number;
  paymentMethod: 'web3' | 'direct';
  fromAddress?: string;
  toAddress: string;
  txHash?: string;
  status?: 'pending' | 'confirmed' | 'failed' | 'cancelled';
  statusMessage?: string;
  createdAt?: number;
  updatedAt?: number;
  isTestnet?: boolean;
}

/**
 * Creates a transaction document in Firestore (transactions collection)
 * using the Google Service Account via Firestore REST API.
 */
export async function createTransactionDoc(
  projectId: string,
  accessToken: string | null,
  data: CreateTransactionInput
): Promise<string> {
  const now = Date.now();
  const docId = data.id || `tx_${now}_${Math.random().toString(36).slice(2, 9)}`;

  const txData = {
    ...data,
    id: docId,
    status: data.status || 'pending',
    createdAt: data.createdAt || now,
    updatedAt: data.updatedAt || now,
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

export interface CreateHistoryInput {
  id?: string;
  userId: string;
  fileName: string;
  originalDimensions?: { width: number; height: number };
  originalSize?: number;
  originalBase64?: string;
  imageHash?: string;
  nodeCount?: number;
  executionTimeMs?: number;
  parameters?: Record<string, any>;
  svg: string;
  svgSize?: number;
  createdAt?: number;
}

/**
 * Creates a history item document in Firestore under users/{userId}/history subcollection
 * using the Google Service Account via Firestore REST API.
 */
export async function createHistoryDoc(
  projectId: string,
  accessToken: string | null,
  data: CreateHistoryInput
): Promise<string> {
  const now = Date.now();
  const docId = data.id || `hist_${now}_${Math.random().toString(36).slice(2, 9)}`;

  const historyData = {
    ...data,
    id: docId,
    createdAt: data.createdAt || now,
  };

  const fields = toFirestoreFields(historyData);
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${data.userId}/history?documentId=${docId}`;

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
    throw new Error(`Failed to create history document in Firestore (${res.status}): ${errText}`);
  }

  return docId;
}
