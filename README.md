# @plantmewallet/merchant-sdk

Official JavaScript / TypeScript SDK for the PlantMe Wallet Merchant API.

`v0.3.0-beta.0` ships the REST surface (HMAC-signed access to orders, trades,
wallet, market data, payment methods, webhook configuration, analytics, and
server-time sampling), the SaaS Platform namespace (`client.platform.users(uid)`)
for per-end-user wallet, order, trade, KYC, marketplace, and fund-user flows,
and the revshare reporting surface (`client.platform.revshare`). WebSocket
streaming is shipped under the `/stream` subpath.

## Install

```bash
npm install @plantmewallet/merchant-sdk
```

Requires Node 18 or newer. The package ships as CommonJS with full
TypeScript declarations and resolves cleanly from both `require()` and
`import` syntax (Node 18+ ESM interop, NodeNext module resolution, and
modern bundlers such as Vite, webpack 5, esbuild, Rollup, and Bun).

## Quick start

```ts
import { MerchantClient } from '@plantmewallet/merchant-sdk';

const client = new MerchantClient({
  apiKey: process.env.MERCHANT_API_KEY!,
  hmacSecret: process.env.MERCHANT_HMAC_SECRET!,
  baseUrl: 'https://api.plantmewallet.com'
});

const order = await client.orders.create({
  type: 'sell',
  cryptocurrency: 'USDT',
  fiatCurrency: 'KRW',
  amount: '100.00000000',
  price: '1320.50',
  paymentMethods: ['Bank Transfer'],
  // Listing expires after 60 minutes; valid range is 15..43200.
  timeLimit: 60
});

for await (const trade of client.trades.listAll({ status: 'completed' })) {
  console.log(trade.tradeId);
}
```

A complete runnable script lives under `examples/simple-placer`.

## Authentication

Every request to `/api/v1/merchant/*` carries five headers:

| Header           | Value                                                                |
| ---------------- | -------------------------------------------------------------------- |
| `X-API-Key`      | Public key identifier (`pk_live_...`)                                |
| `X-Signature`    | hex HMAC-SHA256 of the canonical signing string                      |
| `X-Timestamp`    | Unix milliseconds (decimal string), drift-corrected by the SDK       |
| `X-Nonce`        | 32 hex chars from `crypto.randomBytes(16)` (server enforces uniqueness) |
| `X-Recv-Window`  | Optional; clamped server-side to `[1000, 30000]`. Defaults to 5000    |

The canonical signing string is exactly:

```
${METHOD_UPPER}:${PATH_NO_QUERY}:${TIMESTAMP_MS}:${NONCE}:${RAW_BODY_OR_EMPTY_STRING}
```

The body must be the literal bytes the server receives; for `GET` and
`DELETE` this is the empty string (not `"null"` or `"undefined"`). The SDK
serializes JSON exactly once and signs that string before handing it to
axios with `Content-Type: application/json` so axios cannot re-stringify and
break the signature.

The previous `X-API-Secret` plaintext header was removed in the WS0.2 cut
and is no longer accepted. Pass `hmacSecret` only.

## Idempotency

`POST`, `PATCH`, `PUT`, and `DELETE` requests under `/api/v1/merchant/*`
require an `Idempotency-Key` header. The SDK auto-generates a 32-char hex
key for every mutating request. The server caches the response for 24h on
first call; a retry with the same key returns the cached response rather
than re-executing.

To pin your own key (recommended for cross-process workflows):

```ts
await client.orders.create(input, {
  idempotencyKey: 'order:my-workflow:2026-04-23-T103000-001'
});
```

## Clock drift sampling

`recvWindow` enforcement on the server rejects requests whose `X-Timestamp`
is outside the agreed window. The SDK calls `GET /api/v1/merchant/time`
(an unsigned public endpoint) at boot, takes 3 samples, and uses the median
to correct local drift on every signed request.

To resample manually:

```ts
const drift = await client.time.sampleClockDrift();
console.log(drift); // { driftMs, rttMs }
```

## Errors

All transport-layer errors are typed. Branch on `instanceof` for retry
decisions:

| Class                       | Trigger                                              |
| --------------------------- | ---------------------------------------------------- |
| `AuthenticationError`       | 401 (bad key, bad signature)                         |
| `PermissionDeniedError`     | 403 (missing scope or tier)                          |
| `NotFoundError`             | 404                                                  |
| `IdempotencyConflictError`  | 409 with code `IDEMPOTENCY_KEY_CONFLICT`             |
| `RateLimitError`            | 429; carries `retryAfterMs`                          |
| `ValidationError`           | 400                                                  |
| `NetworkError`              | `ECONNREFUSED`, `ECONNRESET`, etc                    |
| `ServerError`               | 5xx                                                  |
| `TimeoutError`              | axios timeout                                        |
| `NotImplementedError`       | 501 (endpoint reserved but not yet shipped)          |

`MerchantSdkError` is the base class. All errors carry `.code`, `.status`,
`.requestId`, and `.details`.

## Error codes

When the SDK throws, inspect `error.code` to determine the failure class.
The codes below are emitted either by the SDK transport (network, parse,
clock-drift) or surfaced verbatim from the gateway / merchant-service
response body. Cross-reference with the typed-error table above when a
specific code is promoted to a dedicated subclass.

| Code | Meaning | Recommended action |
|---|---|---|
| `SDK_ERROR` | Generic fallback on `MerchantSdkError` when no more specific code was attached | Inspect `error.message`, `error.status`, `error.details`; treat as non-retryable unless the underlying transport indicates otherwise |
| `AUTHENTICATION_FAILED` | 401 from gateway. Bad API key, bad HMAC signature, missing required header, or expired key | Verify `apiKey` / `hmacSecret`, check clock drift (`client.time.sampleClockDrift()`), confirm the key is active in the merchant dashboard |
| `PERMISSION_DENIED` | 403 generic. Caller lacks the scope, tier, or KYC level for the route | Confirm key scope (`scope=platform_users` for platform endpoints), upgrade merchant tier, or complete KYC |
| `NOT_FOUND` | 404. Resource does not exist or is not visible to this tenant | Verify the ID; cross-tenant lookups are blocked by design |
| `VALIDATION_ERROR` | 400 generic. Server-side schema or business-rule rejection | Inspect `error.details` for the structured field map; do not retry without fixing the payload |
| `IDEMPOTENCY_KEY_CONFLICT` | 409. Same `Idempotency-Key` reused within the dedup window with a different request body | Generate a fresh idempotency key, OR ensure the request body is byte-identical to the original |
| `RATE_LIMITED` | 429 from the per-API-key sliding-window limiter | Honour `error.retryAfterMs`; back off with jitter; the SDK already retries automatically up to `maxRetries` |
| `NETWORK_ERROR` | Transport failure before any HTTP response (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`, `EAI_AGAIN`) | Retryable; the SDK retries automatically. Persistent failures indicate an outage or local DNS issue |
| `REQUEST_TIMEOUT` | Axios client-side timeout fired before the server responded | Increase `timeout`, or investigate gateway latency |
| `SERVER_ERROR` | 5xx from the backend | Retryable; the SDK retries automatically. If persistent, surface to ops |
| `ENDPOINT_PENDING` | 501. Endpoint is reserved in the contract but not yet implemented server-side | Defer the call until the corresponding server stub ships; see `NotImplementedError` |
| `FUND_USER_AML_STRUCTURING_DETECTED` | 429 from the platform fund-user route when the structuring detector trips across the sliding compliance windows | Stop the funding loop, route to compliance review, do NOT auto-retry. Surface a distinct compliance message to the operator |
| `FUND_USER_2FA_REQUIRED` | 403. High-value fund-user transfer (>$10K USD-equiv) requires a fresh TOTP in `X-PM-Owner-2FA` | Use `client.with2FA(token).platform.users(uid).wallet.fundUser(...)` to inject the header on the next call |
| `FUND_USER_RECIPIENT_LIMIT` | 429. Per-recipient fund-user throttle exceeded | Honour `retryAfterMs`; back off until the window resets |
| `FUND_USER_REFUND_LIMIT` | 429. Refund-source fund-user throttle exceeded | Honour `retryAfterMs`; aggregate refunds where possible |
| `FUND_USER_PLATFORM_LIMIT` | 429. Platform-wide fund-user throttle exceeded | Honour `retryAfterMs`; consider batch-mode or schedule outside peak |
| `FUND_USER_NEW_USER_COOLDOWN` | 429. Recipient is inside the new-user fund-user cooldown window | Wait for `retryAfterMs`; warn operator that the recipient is newly KYCed |
| `FUND_USER_REFUND_REQUIRES_TRADE_ID` | 400. `source: 'refund'` was supplied without `linkedTradeId` | Add `linkedTradeId` to the fund-user payload; the audit trail requires it |
| `SELF_FUND_NOT_ALLOWED` | 403. fund-user target equals the platform owner's own wallet | Resolve a different recipient; the route refuses self-funding |
| `PII_IN_MEMO` | 400. PII detector matched a card number, IBAN, SSN, or similar in the memo string | Strip the memo or substitute a non-PII identifier; do not retry without changing the memo |
| `MARKETPLACE_NOT_ELIGIBLE` | 409. User's KYC level or tenant config does not allow marketplace publishing | Complete KYC or update tenant config; poll the user's eligibility flag before retry |
| `CLOSED_BEFORE_SESSION` | Stream closed before the server `session.ready` frame arrived | Inspect the close code; usually paired with an `AUTHENTICATION_FAILED` upgrade error |
| `WS_UPGRADE_FAILED` | WebSocket upgrade was rejected by the gateway | Inspect the HTTP status returned with the upgrade response; common causes: bad signature, revoked key, missing `stream:read` permission |
| `WS_CLOSED` | Stream closed by the server with a non-fatal code | The SDK auto-reconnects with backoff unless the close code is in the no-reconnect list |
| `RESUME_UNAVAILABLE` | Server discarded the resume buffer for this session (typically because the gap was too large) | Re-subscribe from the latest position; do not assume continuity |
| `SEQUENCE_GAP` | Detected a gap between consecutive frame sequence numbers | Treat as a partial outage; reconcile state from REST before resuming |
| `PROTOCOL_VIOLATION` | Server sent a frame the client could not parse against the contract | Open a bug; payload is in `error.details` |
| `PROTOCOL_UNKNOWN` | Server selected a sub-protocol the client did not offer | Open a bug; the SDK and gateway are version-mismatched |
| `CONNECTION_LIMIT` | Server close code 4008. Per-API-key concurrent connection cap exceeded | Close idle streams; do not reconnect blindly |
| `ORIGIN_FORBIDDEN` | Server close code 4403. Browser origin not in the allowlist | Add the origin in the merchant dashboard; do not reconnect |
| `CROSS_TENANT_LEAK` | Server close code 4500. Tenancy guard tripped on an outbound frame | Stop the consumer immediately, log loud, file a security ticket. Do NOT auto-reconnect |
| `INACTIVITY_TIMEOUT` | Server closed the stream after the heartbeat / pong deadline elapsed | The SDK reconnects automatically; investigate consumer back-pressure if frequent |

## Retries

The SDK retries automatically on:

- network failures (`ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`)
- 5xx responses
- 429 responses (using `Retry-After` when present)
- 409 `TRANSFER_IN_PROGRESS` / `WITHDRAWAL_IN_PROGRESS` (using `Retry-After`
  when present)

Exponential backoff with full jitter, capped at 30s. Idempotency-Key makes
mutating retries safe. Tune via `maxRetries`, `retryBaseDelayMs`,
`retryMaxDelayMs`.

The two 409 codes mean the money movement is still settling upstream and the
response carries no transfer or withdrawal id yet. The SDK replays the request
on the same Idempotency-Key, so the retry reads the outcome of the call that is
already in flight rather than starting a second one; it never retries a 409
without a key. Every other 409, including `IDEMPOTENCY_KEY_CONFLICT`, is
decided state and is raised to the caller immediately.

## Rate limits

The server returns `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
`X-RateLimit-Reset` headers. On 429, `Retry-After` (seconds) tells the SDK
how long to back off.

## Webhook verification

Verify incoming webhooks without pulling axios into your handler:

```ts
import { verifyWebhook } from '@plantmewallet/merchant-sdk/webhooks';

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const result = verifyWebhook({
    payload: req.body,
    signature: req.header('x-webhook-signature') ?? '',
    secret: process.env.MERCHANT_WEBHOOK_SECRET!,
    timestamp: req.header('x-webhook-timestamp') ?? undefined
  });

  if (!result.valid) {
    return res.status(401).send(result.reason);
  }

  res.status(200).end();
});
```

Constant-time HMAC comparison. Length-mismatched signatures are rejected
without invoking `timingSafeEqual` so timing leaks via buffer length cannot
occur.

Get or rotate the webhook secret via the SDK:

```ts
const cfg = await client.webhooks.getConfig();
const { secret } = await client.webhooks.regenerateSecret(); // returned ONCE
```

## Resources

| Namespace             | Methods                                                      |
| --------------------- | ------------------------------------------------------------ |
| `client.account`      | `get`                                                        |
| `client.availability` | `update`                                                     |
| `client.orders`       | `create`, `list`, `get`, `update`, `cancel`, `listAll`       |
| `client.trades`       | `get`, `list`, `markPaymentSent`, `confirmPayment`, `release`, `cancel`, `openDispute`, `sendMessage`, `listMessages`, `listAll` |
| `client.wallet`       | `getBalance`, `getHolds`                                     |
| `client.market`       | `getBestPrices`, `getActiveAds`, `getReferencePrice`, `getMyRank` |
| `client.paymentMethods` | `list`                                                     |
| `client.webhooks`     | `getConfig`, `updateConfig`, `regenerateSecret`, `getLogs`, `getAllowedEvents`, `test` |
| `client.analytics`    | `getStats`                                                   |
| `client.time`         | `getServerTime`, `sampleClockDrift`                          |
| `client.platform`     | `users`, `revshare` (SaaS-tier only, see below)              |

Some market and webhook helpers (`getActiveAds`, `getReferencePrice`,
`getMyRank`, `webhooks.test`) currently return `NotImplementedError` (501)
until the corresponding server stubs ship. The shape stays stable across
the upgrade.

## Platform usage (SaaS API keys)

If your API key has `scope=platform_users` (issued to a Merchant with
`accountType=saas_platform`), you can manage end-users via the platform
namespace. Direct-merchant keys see `403 Forbidden` from these routes.

```typescript
import { MerchantClient } from '@plantmewallet/merchant-sdk';

const client = new MerchantClient({ apiKey, hmacSecret });

// Provision an end-user inside the platform's parent merchant account.
const user = await client.platform.users.create({
  externalUserId: 'tradekr_user_123',
  email: 'user@tradekr.example',
  kycLevelRequired: 1
});

// Act on behalf of the end-user. The SDK auto-injects the
// X-PM-Acting-User header on every scoped call.
const balances = await client.platform.users(user.userId).wallet.getBalance();
const order = await client.platform.users(user.userId).orders.create({
  type: 'sell',
  cryptocurrency: 'USDT',
  fiatCurrency: 'KRW',
  amount: '100.00000000',
  price: '1320.50',
  paymentMethods: ['Bank Transfer'],
  // Listing lifetime in minutes, not the resulting trade's payment window.
  timeLimit: 60
});
const kyc = await client.platform.users(user.userId).kyc.get();

// User-to-user transfer inside the same parent platform.
await client.platform.users('danny').wallet.transfer({
  toUserId: 'bob',
  amount: '10.00',
  currency: 'KRW'
});

// Cursor-paginated user list with async iteration.
for await (const u of client.platform.users.listAll({ status: 'active' })) {
  console.log(u.userId, u.kycLevel);
}

// Revshare reporting (merchant-level, no acting-user header).
const earnings = await client.platform.revshare.getEarnings({
  from: '2026-01-01',
  to: '2026-04-01'
});
const proposal = await client.platform.revshare.createProposal({
  splits: [
    { target: 'merchant', basisPoints: 4000 },
    { target: 'platform', basisPoints: 4000 },
    { target: 'house', basisPoints: 2000 }
  ],
  rationale: 'Q2 fee restructure'
});
```

| Namespace                              | Methods                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| `client.platform.users`                | `create`, `list`, `listAll`, callable as `users(uid)` for the scoped sub-client        |
| `client.platform.users(uid)`           | `get`, `update`, `suspend`, `restore`, `softDelete`                                    |
| `client.platform.users(uid).orders`    | `create`, `list`, `get`, `update`, `cancel`                                            |
| `client.platform.users(uid).trades`    | `list`, `get`, `markPaymentSent`, `confirmPayment`, `cancel`, `switchMerchant`, `sendMessage` |
| `client.platform.users(uid).wallet`    | `getBalance`, `getHolds`, `getLedger`, `transfer`, `withdraw`, `getDepositAddress`     |
| `client.platform.users(uid).paymentMethods` | `list`, `add`, `remove`                                                           |
| `client.platform.users(uid).kyc`       | `start`, `get`                                                                         |
| `client.platform.revshare`             | `getConfig`, `getConfigHistory`, `previewConfig`, `createProposal`, `listProposals`, `getProposal`, `withdrawProposal`, `getEarnings`, `listRewards`, `listPayouts`, `getPayout`, `getReconciliation`, `testWebhook` |

The SaaS-Onboarding endpoints under `/api/merchants/saas/*` (apply,
branding, billing, custom domain) use JWT authentication and are managed
from the merchant web dashboard; they are intentionally not bridged into
this SDK because the SDK only carries HMAC credentials. SaaS platforms
that need application-lifecycle visibility should subscribe to the
`merchant.saas.*` webhook events.

Runnable examples:

- `examples/platform-starter` end-to-end signup, KYC, list, balance
- `examples/internal-transfer` user-to-user transfer with idempotency
- `examples/branded-webhook-handler` Express receiver for KYC and revshare events
- `examples/kyc-vendor-bridge` external vendor callback to PlantMe KYC kick

## Versioning

The package follows semver from `1.0.0` onward. Until then betas may break
the public surface; pin `~0.3.0-beta` to opt out of incidental changes.

## License

MIT.
