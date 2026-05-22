# market-maker example

Minimal example showing how to subscribe to the merchant event stream.

## Run

```bash
export MERCHANT_API_KEY=pk_test_...
export MERCHANT_HMAC_SECRET=...
export MERCHANT_API_BASE_URL=https://api.staging.plantmewallet.com  # optional
npm install
npm start
```

The script opens a single WebSocket connection and prints every trade and
balance event it receives. The SDK handles reconnect, resume, and dedup
automatically; the example focuses on the consumer-side handlers.
