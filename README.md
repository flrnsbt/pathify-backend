# Pathify Cloudflare Worker Backend

High-performance, edge-native backend service powered by **Cloudflare Workers** with **Cron Triggers**, **Cryptographic Handshake Verification**, **Multi-Chain Transaction Reconciler**, and **Confidential Support Email Dispatch** for **pathify**.

---

## ⚡ Edge Architecture Overview

1. **Zero Cold Starts**: Executes immediately on Cloudflare's global edge network (300+ locations).
2. **Cron Triggers (`* * * * *`)**: Monitors and reconciles pending cryptocurrency payments on-chain every minute without external scheduler overhead.
3. **Multi-Chain RPC Verification**: Directly verifies transactions across BNB Smart Chain, Ethereum, Polygon, Base, Arbitrum, and Bitcoin.
4. **Google Firebase REST & WebCrypto**: Signs RS256 Google Service Account JWTs at the edge using `crypto.subtle` to perform atomic increments in Firestore.
5. **Confidential Customer Support**: Handles customer assistance inquiries with safe edge email delivery to `SUPPORT_EMAIL` (`your-support-email@example.com`), keeping the recipient email address strictly hidden from client bundles.

---

## 🚀 Edge Endpoints & Features

### 1. Cryptographic Server Handshake (`POST /api/handshake`)
- **Route**: `/api/handshake` or `/api/handshake/authorize`
- **Purpose**: Authenticates image unlocking (1 credit = 10 fine-tuning generations) and signs tamper-proof HMAC-SHA256 tickets.
- **Security**:
  - Enforces `x-api-secret` matching `env.API_SECRET`.
  - Verifies `X-Firebase-AppCheck` token against Google's public JWKS keys (`https://firebaseappcheck.googleapis.com/v1/jwks`).
  - Verifies user ID token via Google Identity Toolkit API.
  - Prevents client-side manipulation of credit counters.

### 2. On-Demand Credit Refresh (`POST /api/refresh-credits`)
- **Route**: `/api/refresh-credits` or `/api/check-transactions`
- **Purpose**: Instantly verifies on-chain transaction hashes for the requesting user and updates Firestore credits.
- **Security**:
  - Validates `x-api-secret` and Firebase App Check.
  - Enforces ownership: authenticated user can only refresh their own `userId`.

### 3. Customer Support & Assistance Dispatch (`POST /api/support`)
- **Route**: `/api/support` or `/api/contact`
- **Purpose**: Receives user assistance requests (particularly crypto transaction inquiries), creates an immutable ticket record in Firestore (`support_tickets` collection), and sends a notification email to `SUPPORT_EMAIL`.
- **Confidentiality**: The destination email address (`your-support-email@example.com`) is kept strictly server-side and never exposed to the client.
- **Security**:
  - Validates `x-api-secret` and App Check.
  - Attaches user authentication ID if provided.
  - Logs client metadata (IP, country, User Agent).

### 4. Background Transaction Tracker (Cron)
- Runs every minute via Cloudflare Scheduled Events.
- Queries `status: 'pending'` transactions from the `transactions` Firestore collection.
- Checks block confirmations and transfer recipients on-chain.
- Atomically increments user credits and marks transactions `confirmed` or `failed`.

### 5. Strict CORS Origin Policy
- CORS is locked to authorized origins:
  - `https://pathify.art`
  - `http://localhost:3000`
  - `http://127.0.0.1:3000`

---

## 🛠️ Local Development

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Local Secrets (`.dev.vars`)
Create a `.dev.vars` file in the root directory:

```bash
FIREBASE_PROJECT_ID=vectorizerr
FIREBASE_CLIENT_EMAIL=your-service-account@vectorizerr.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
API_SECRET=your-secure-shared-secret
SUPPORT_EMAIL=your-support-email@example.com
```

### 3. Start Local Edge Worker
```bash
npm run dev
```
The worker will listen on `http://localhost:8787`.

---

## 🚢 Production Deployment

### 1. Configure Cloudflare Secrets
```bash
npx wrangler secret put FIREBASE_PRIVATE_KEY
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put API_SECRET
```

### 2. Configure Environment Variables in `wrangler.json`
`wrangler.json` provides edge defaults:
```json
{
  "vars": {
    "ENVIRONMENT": "production",
    "FIREBASE_PROJECT_ID": "vectorizerr",
    "REQUIRED_CONFIRMATIONS": "1",
    "SUPPORT_EMAIL": "your-support-email@example.com"
  }
}
```

### 3. Deploy to Cloudflare Workers
```bash
npm run deploy
```

---

## 📂 Project Structure

```
backend/
├── src/
│   ├── index.ts               # HTTP fetch router, Cron scheduled handler, and CORS rules
│   ├── config/
│   │   └── chains.ts          # Supported chains RPC endpoints and token contracts
│   └── services/
│       ├── app-check.ts       # RS256 JWKS App Check verification via WebCrypto
│       ├── email.ts           # Edge email notification service (MailChannels / Resend)
│       ├── firestore.ts       # Google Service Account JWT & Firestore REST integration
│       ├── handshake.ts       # HMAC-SHA256 ticket signing & token validation
│       └── verifier.ts        # EVM on-chain transaction receipt & block confirmation verifier
├── wrangler.json              # Cloudflare Worker configuration & Cron triggers
├── package.json
└── tsconfig.json
```
