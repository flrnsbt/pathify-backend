# Vectorizerr Cloudflare Worker Backend

High-performance, edge-native backend powered by **Cloudflare Workers** with **Cron Triggers** and **REST Endpoints** for tracking, verifying, and crediting crypto transactions on **vectorizerr**.

---

## ⚡ Why Cloudflare Workers over Google Cloud Functions?

1. **Zero Cold Starts**: Executes immediately on Cloudflare's global edge network (300+ locations).
2. **Cron Triggers (`[triggers.crons]`)**: Runs periodically every minute (`* * * * *`) without needing Cloud Scheduler or external cron jobs.
3. **Multi-Chain Verification**: Directly queries EVM JSON-RPC nodes (BSC, Ethereum, Polygon, Base, Arbitrum) and Bitcoin Mempool API via edge-native `fetch`.
4. **Direct Firestore REST Integration**: Uses Web Crypto API to sign RS256 Google Service Account JWTs and interacts with Firestore via REST API with atomic increments.
5. **Cost Effective**: 100,000 requests/day free on Cloudflare Workers.

---

## 🚀 Features

- **Automated Background Verification (Cron)**:
  - Runs every minute via Cloudflare Scheduled Events.
  - Queries all `status: 'pending'` transactions from the Firestore `transactions` collection.
  - Checks block confirmations, transfer recipients, and token amounts on-chain.
  - Upon confirmation:
    - Atomically increments user `credits` in `users/{userId}`.
    - Updates transaction to `status: 'confirmed'` with timestamp and verified block height.
  - If a transaction is reverted on-chain, marks it `status: 'failed'`.

- **On-Demand Client Refresh (`POST /api/refresh-credits`)**:
  - Called by the frontend when a user clicks "Refresh Credits" or when an active transaction is submitted.
  - Checks pending transactions immediately for that user and returns the verified balance.

- **Supported Chains & Tokens**:
  - **BNB Smart Chain (BSC)**: BNB (Native), USDT (BEP-20), USDC (BEP-20)
  - **Ethereum (ETH)**: ETH (Native), USDT (ERC-20), USDC (ERC-20)
  - **Bitcoin (BTC)**: BTC (Native Mempool API)
  - **Polygon (POL)**: POL (Native), USDT, USDC
  - **Base**: ETH (Native), USDC
  - **Arbitrum One**: ETH (Native), USDT, USDC

---

## 🛠️ Local Development

### 1. Install dependencies
```bash
cd backend
npm install
```

### 2. Configure Local Secrets (`.dev.vars`)
Create a `.dev.vars` file in `backend/` (based on `.dev.vars.example`):

```bash
FIREBASE_PROJECT_ID=vectorizerr
FIREBASE_CLIENT_EMAIL=your-service-account@vectorizerr.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
API_SECRET=your-optional-secret
```

### 3. Run Worker Locally
```bash
npm run dev
```

The worker will start on `http://localhost:8787`. You can test:
- `http://localhost:8787/health`
- `curl -X POST http://localhost:8787/api/refresh-credits -H "Content-Type: application/json" -d '{"userId":"test-uid"}'`

---

## 🚢 Production Deployment

### 1. Authenticate with Cloudflare
```bash
npx wrangler login
```

### 2. Set Production Secrets
Set your Firebase Service Account secrets in Cloudflare:
```bash
npx wrangler secret put FIREBASE_PRIVATE_KEY
# Paste your PEM private key when prompted

npx wrangler secret put FIREBASE_CLIENT_EMAIL
# Enter your service account email (e.g. your-service-account@vectorizerr.iam.gserviceaccount.com)

npx wrangler secret put API_SECRET
# Enter an optional shared secret if you want to protect the HTTP endpoint
```

### 3. Deploy
```bash
npm run deploy
```

Wrangler will output your live worker URL:
`https://vectorizerr-backend.<your-subdomain>.workers.dev`

---

## 🔗 Connecting Frontend to Worker

In `frontend/.env.local` (or Cloudflare Pages environment variables):

```bash
NEXT_PUBLIC_REFRESH_CREDITS_FUNCTION_URL=https://vectorizerr-backend.<your-subdomain>.workers.dev/api/refresh-credits
```
