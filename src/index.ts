// Public surface area. Anything exported here is part of the SDK contract
// and follows semver. Internal modules (transport/*, resources/*) are
// re-exported so advanced users can build custom integrations on top, but
// the documented entry point remains MerchantClient.

export {
  MerchantClient,
  SDK_METADATA,
  TwoFactorScopedClient,
  TwoFactorPlatformFacade,
  TwoFactorPlatformWalletFacade
} from './client.js';
export type { MerchantClientOptions } from './client.js';

// Resources are exposed through MerchantClient. Direct exports are useful
// for type assertions and dependency injection in tests.
export { AccountResource } from './resources/account.js';
export { AvailabilityResource } from './resources/availability.js';
export { OrdersResource } from './resources/orders.js';
export { TradesResource } from './resources/trades.js';
export { WalletResource } from './resources/wallet.js';
export { MarketResource } from './resources/market.js';
export { PaymentMethodsResource } from './resources/paymentMethods.js';
export { WebhooksResource } from './resources/webhooks.js';
export { AnalyticsResource } from './resources/analytics.js';
export { TimeResource } from './resources/time.js';

// Platform namespace. Exposed at client.platform for SaaS-tier API keys.
export {
  PlatformNamespace,
  PlatformUsersResource,
  UserScopedClient,
  ScopedOrdersResource,
  ScopedTradesResource,
  ScopedWalletResource,
  ScopedPaymentMethodsResource,
  ScopedKycResource,
  ScopedMarketplaceResource,
  RevshareResource,
  PlatformWalletResource,
  PlatformQuickTradeResource,
  ScopedQuickTradeResource
} from './resources/platform/index.js';
export type * from './resources/platform/types.js';

// Webhook verifier is also re-exported here as a convenience even though
// the recommended import path for verify-only consumers is the
// `@plantmewallet/merchant-sdk/webhooks` subpath.
export { verifyWebhook } from './webhooks/verify.js';
export type {
  VerifyWebhookOptions,
  VerifyWebhookResult,
  VerifyWebhookFailureReason
} from './webhooks/verify.js';

// Errors. Consumers should branch on `instanceof` for retry decisions.
export {
  MerchantSdkError,
  AuthenticationError,
  PermissionDeniedError,
  NotFoundError,
  IdempotencyConflictError,
  RateLimitError,
  ValidationError,
  NetworkError,
  ServerError,
  TimeoutError,
  WebhookVerificationError,
  NotImplementedError,
  PlatformFundUserAmlError,
  PlatformFundUserRateLimitError,
  PlatformFundUser2FARequiredError,
  PlatformMarketplaceNotEligibleError,
  PlatformSelfFundError,
  PlatformRefundRequiresTradeError,
  PlatformPiiInMemoError,
  FUND_USER_ERROR_CODES
} from './errors/index.js';
export type { FundUserErrorCode } from './errors/index.js';

// Public type contracts.
export * from './types/common.js';
export * from './types/events.js';

// Low-level transport pieces. Exposed so the parallel WebSocket client and
// power users can reuse the canonical signing function.
export { signHmac, buildCanonicalString } from './transport/signing.js';
export type { SignHmacOptions } from './transport/signing.js';
export { generateNonce } from './transport/nonce.js';
export { generateIdempotencyKey } from './transport/idempotency.js';
export { ClockDriftTracker, clampRecvWindow, RECV_WINDOW_BOUNDS } from './transport/recvWindow.js';

// WebSocket stream surface. Recommended import path for stream-only
// consumers is `@plantmewallet/merchant-sdk/stream` but we re-export the
// public API here for convenience.
export {
  MerchantStream,
  ResumeUnavailableError,
  SequenceGapError,
  ResumeBuffer,
  buildHandshakeHeaders,
  STREAM_DEFAULTS,
  WS_PATH,
} from './stream/index.js';
export type {
  CloseReason,
  DisconnectedInfo,
  HandshakeHeaders,
  BuildHandshakeOptions,
  MerchantEvent,
  MerchantEventType,
  MerchantStreamConstructorOpts,
  ReconnectingInfo,
  ResumeUnavailable,
  ServerDraining,
  SessionInvalid,
  SessionStart,
  StreamOptions,
  SystemFrame,
} from './stream/index.js';
