# webhook-receiver example

Minimal Express server that verifies merchant webhook deliveries.

## Run

```bash
export WEBHOOK_SECRET=...
npm install
npm start
```

Then point the merchant control plane's webhook configuration at
`http://your-host:3000/webhook` and watch the console as events arrive.

The example reads the raw request body before parsing JSON because the HMAC
signature covers the exact bytes the server signed; whitespace and field
ordering matter.
