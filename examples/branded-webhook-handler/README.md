# branded-webhook-handler

Express server tuned for SaaS-tier webhook deliveries. Verifies the HMAC
signature, dispatches events by type, and demonstrates two
platform-relevant handlers:

- `merchant.user.kyc_updated` updates a hypothetical local user record
- `merchant.revshare.commission.earned` appends to a platform revenue
  ledger

All other event types are logged and acked with 200 to stop server
retries.

## Run

```bash
export WEBHOOK_SECRET=whsec_...
export PORT=3000

npm install
npm start
```

Then point the webhook configuration at `https://your-host/webhook` and
watch the console.

## Notes

- `express.raw({ type: 'application/json' })` is required because the HMAC
  signature covers the literal request bytes; a JSON-parsed body will not
  verify.
- Handlers should return fast and offload real work to a queue. Returning
  5xx tells the server to retry with exponential backoff.
- Event payload shapes are typed via `WebhookEnvelope<T>` and
  `WebhookEventType` re-exported from the SDK.
