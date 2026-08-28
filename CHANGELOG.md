# Changelog

All notable changes to `@plantmewallet/merchant-sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The beta line (`0.x`) may still break public surface between minor versions;
pin `~0.2.1-beta` if you want to opt out of incidental changes.

## [0.3.0-beta.0] - 2026-08-29

### Added

- `client.platform.users(uid).trades.create()` takes an order another user
  posted on the marketplace. The caller's own orders are refused, as are
  orders belonging to another platform's users. An idempotency key is
  required, and replaying one returns the trade the first call created.
- `client.platform.users(uid).trades.getMessages()` reads the chat thread on
  a trade as one of its parties.
- `client.platform.users(uid).market.getMyRank()` reads an end user's rank on
  an order they posted. Market rank for a `platform_users` key belongs to an
  end user, so it is reached under the user rather than the client.
- `hostedPageUrl` on the KYC start response, so a tenant can hand a user a
  link instead of embedding the widget. `sdkToken` is unchanged.
- `DEPOSIT_CURRENCIES` and `DEPOSIT_NETWORKS` are exported as values, so a
  caller can enumerate what a deposit address can be issued for at runtime
  without restating the list.
- Transfer and ledger records carry `direction`, `timestamp`, and the
  originating `tradeId`, `escrowId`, `withdrawalId` or `depositId` where the
  service supplies them.
- The transport replays a `409` carrying `TRANSFER_IN_PROGRESS` or
  `WITHDRAWAL_IN_PROGRESS` on the same `Idempotency-Key`, which reads the
  outcome of the call already in flight rather than starting a second one.
  A conflict is never replayed without a key. Every other `409`, including
  `IDEMPOTENCY_KEY_CONFLICT`, is decided state and is raised immediately.
  `Retry-After` is honoured when present, and the attempt budget is shared
  with the other retry reasons.

### Changed

- **Breaking.** `CreateOrderInput.paymentMethodIds` becomes `paymentMethods`
  and takes the display names the service publishes per fiat currency, for
  example `Bank Transfer` or `PayNow`. The set is validated against
  `fiatCurrency` and a value outside it is refused with the allowed list.
  `UpdateOrderInput` takes the same form.
- **Breaking.** `CreateOrderInput.timeLimit` replaces `paymentTimeLimit` and
  is required. The service rejects an order without it rather than applying
  a default.
- **Breaking.** The deposit address input requires `network` and accepts only
  `ERC20`, `TRC20` or `BEP20`, with `USDT` as the only currency. An address
  is valid solely on the chain it was issued for, so the chain is part of the
  request rather than a default.

### Fixed

- Trade chat is served by a different service from the rest of the trade
  surface and is now reached under its own path.
- Webhook signature verification parses the ISO instant the delivery puts on
  `X-Webhook-Timestamp`. Epoch milliseconds are still accepted.
- Rotating the webhook signing secret sends the acknowledgement the service
  requires, so the call no longer depends on a flag a caller could omit.
- The subscribed event list is unwrapped when it arrives wrapped the way the
  sibling webhook routes wrap theirs. A bare array passes through unchanged.
- `platform.wallet.fundUser` names the acting user, so the service runs its
  cross-tenant and account state gates against the recipient. Caller supplied
  headers are preserved.

## [0.2.1-beta.0] - 2026-05-22

### Security

- Bump `ws` to `>=8.20.1` to pick up the fix for GHSA-58qx-3vcg-4xpx
  (uninitialised memory disclosure in `Receiver.write` on certain frame
  shapes). The package range in `package.json` is now `^8.20.1`. No public
  API change.

## [0.2.0-beta.0] - 2026-04 (approximate)

### Added

- SaaS Platform namespace `client.platform.users(uid)` for parent-merchant
  accounts running an end-user fleet under HMAC credentials. Surfaces
  per-end-user wallet, order, trade, payment-method, and KYC operations
  with automatic `X-PM-Acting-User` header injection on every scoped call.
- `client.platform.users.create`, `.list`, `.listAll` for end-user
  provisioning, paginated listing, and async-iterable traversal.
- `client.platform.users(uid).wallet.fundUser` for platform-to-end-user
  funding flows with idempotency, 2FA escalation, AML structuring
  detection, and refund-source linkage.
- `client.platform.users(uid).wallet.transfer` for end-user-to-end-user
  transfers inside the same parent platform.
- Marketplace publishing toggle (`marketplaceEligible`, `publishEnabled`)
  on the user resource, with `MARKETPLACE_NOT_ELIGIBLE` surfaced as a
  dedicated typed error.
- `client.platform.revshare` reporting surface: `getConfig`,
  `getConfigHistory`, `previewConfig`, `createProposal`, `listProposals`,
  `getProposal`, `withdrawProposal`, `getEarnings`, `listRewards`,
  `listPayouts`, `getPayout`, `getReconciliation`, `testWebhook`.
- Typed error subclasses for the fund-user surface:
  `PlatformFundUserAmlError`, `PlatformFundUser2FARequiredError`,
  `PlatformFundUserRateLimitError`, `PlatformSelfFundError`,
  `PlatformRefundRequiresTradeError`, `PlatformPiiInMemoError`,
  `PlatformMarketplaceNotEligibleError`.
- `FUND_USER_ERROR_CODES` constant export so callers can branch on
  `error.code` without inline string literals.
- Per-end-user KYC orchestration (`platform.users(uid).kyc.start`, `.get`).
- Cursor-paginated user list with async iteration helpers.
- Runnable examples: `platform-starter`, `internal-transfer`,
  `branded-webhook-handler`, `kyc-vendor-bridge`.

### Changed

- README expanded with the Platform usage section and the SaaS namespace
  resource table.

## [0.1.0-beta.0] - 2026-01 (approximate)

### Added

- Initial beta release of `@plantmewallet/merchant-sdk`.
- REST surface: HMAC-signed access to orders, trades, wallet, market
  data, payment methods, webhook configuration, analytics, and
  server-time sampling.
- Typed error hierarchy rooted at `MerchantSdkError` with subclasses for
  401, 403, 404, 409, 429, 5xx, network failure, timeout, webhook
  verification, and reserved-not-implemented (501) responses.
- Idempotency-Key auto-generation on every `POST`, `PATCH`, `PUT`, and
  `DELETE` under `/api/v1/merchant/*`, plus an `idempotencyKey` override
  in per-call request options.
- Clock-drift sampler (`client.time.sampleClockDrift`) that calibrates
  the signing timestamp against the unsigned `GET /api/v1/merchant/time`
  endpoint to stay inside the server's `recvWindow`.
- Automatic retry with full-jitter exponential backoff on network
  failures, 5xx responses, and 429 responses (honouring `Retry-After`).
- Webhook verification helper (`verifyWebhook` under
  `@plantmewallet/merchant-sdk/webhooks`) with constant-time HMAC
  comparison and length-mismatch short-circuit.
- WebSocket streaming under the `/stream` subpath with resume buffer,
  heartbeat, sequence-gap detection, and tenant-aware close-code
  handling.
- Async-iterable `listAll` helpers on `orders` and `trades`.

### Notes

- The dates for `0.2.0-beta.0` and `0.1.0-beta.0` are approximate; the
  monorepo history was rewritten during a recovery operation and the
  original release commits no longer carry their authored dates. Use
  the package version itself (not the date) for ordering.
