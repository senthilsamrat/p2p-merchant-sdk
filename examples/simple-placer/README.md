# simple-placer

Minimal example showing how to authenticate with the PlantMe Merchant SDK,
place an order, and iterate completed trades.

## Run

```bash
export MERCHANT_API_KEY=pk_live_...
export MERCHANT_HMAC_SECRET=...
export MERCHANT_PAYMENT_METHOD_ID=pm_...

npm install
npx tsx index.ts
```

## What it covers

- Constructing a `MerchantClient` with credentials
- Auto-generated `Idempotency-Key` headers for safe retries
- HMAC-signed REST calls
- Async iteration over paginated trade lists
