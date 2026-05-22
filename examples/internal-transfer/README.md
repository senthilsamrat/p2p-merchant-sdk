# internal-transfer

Moves funds from one platform end-user to another inside the same SaaS
parent merchant. Demonstrates per-user wallet reads, deterministic
idempotency keys, and the user-scoped transfer endpoint.

## Run

```bash
export MERCHANT_API_KEY=pk_live_...
export MERCHANT_HMAC_SECRET=...
export FROM_USER_ID=user_danny
export TO_USER_ID=user_bob
export TRANSFER_AMOUNT=10.00
export TRANSFER_CURRENCY=KRW
export TRANSFER_MEMO='lunch split'

npm install
npm start
```

## Notes

- Both userIds must belong to the same parent merchant. Cross-tenant
  transfers are rejected unless the platform has opted into the
  cross-platform-trade-gate flag.
- The deterministic idempotency key in this example is keyed by
  `from:to:amount:currency:date`. A retry on the same calendar day with the
  same amount returns the cached transfer record rather than executing
  twice.
- Real platforms should subscribe to the `merchant.wallet.transferred` and
  `merchant.user.kyc_updated` events over the WebSocket stream rather than
  polling REST after each call.
