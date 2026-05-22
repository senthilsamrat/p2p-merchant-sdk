// Typed error classes thrown by the SDK transport layer.
// Consumers can branch on `instanceof` for retry / surface decisions.

export interface MerchantSdkErrorOptions {
  code?: string;
  cause?: unknown;
  status?: number;
  requestId?: string;
  details?: unknown;
}

export class MerchantSdkError extends Error {
  public readonly code: string;
  public readonly status?: number;
  public readonly requestId?: string;
  public readonly details?: unknown;

  constructor(message: string, opts: MerchantSdkErrorOptions = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = opts.code ?? 'SDK_ERROR';
    this.status = opts.status;
    this.requestId = opts.requestId;
    this.details = opts.details;
    if (opts.cause !== undefined) {
      // Node.js error cause chain. Avoids losing the original stack.
      (this as unknown as { cause: unknown }).cause = opts.cause;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// 401. API key missing, invalid, or signature failed verification.
export class AuthenticationError extends MerchantSdkError {
  constructor(message = 'Authentication failed', opts: MerchantSdkErrorOptions = {}) {
    super(message, { code: opts.code ?? 'AUTHENTICATION_FAILED', ...opts, status: 401 });
  }
}

// 403. Caller authenticated but lacks the required permission scope or tier.
export class PermissionDeniedError extends MerchantSdkError {
  constructor(message = 'Permission denied', opts: MerchantSdkErrorOptions = {}) {
    super(message, { code: opts.code ?? 'PERMISSION_DENIED', ...opts, status: 403 });
  }
}

// 404. Resource does not exist or is not visible to the caller.
export class NotFoundError extends MerchantSdkError {
  constructor(message = 'Not found', opts: MerchantSdkErrorOptions = {}) {
    super(message, { code: opts.code ?? 'NOT_FOUND', ...opts, status: 404 });
  }
}

// 409 with code IDEMPOTENCY_KEY_CONFLICT. Same key reused for a different payload.
export class IdempotencyConflictError extends MerchantSdkError {
  constructor(message = 'Idempotency key conflict', opts: MerchantSdkErrorOptions = {}) {
    super(message, { code: opts.code ?? 'IDEMPOTENCY_KEY_CONFLICT', ...opts, status: 409 });
  }
}

// 429. Rate limited. retryAfterMs honours Retry-After header when present.
export class RateLimitError extends MerchantSdkError {
  public readonly retryAfterMs: number;

  constructor(message = 'Rate limited', opts: MerchantSdkErrorOptions & { retryAfterMs?: number } = {}) {
    super(message, { code: opts.code ?? 'RATE_LIMITED', ...opts, status: 429 });
    this.retryAfterMs = opts.retryAfterMs ?? 1000;
  }
}

// 400. Validation error from server. details holds the structured field map when available.
export class ValidationError extends MerchantSdkError {
  constructor(message = 'Validation failed', opts: MerchantSdkErrorOptions = {}) {
    super(message, { code: opts.code ?? 'VALIDATION_ERROR', ...opts, status: 400 });
  }
}

// Network failure before any HTTP response was received. Retryable.
export class NetworkError extends MerchantSdkError {
  constructor(message = 'Network error', opts: MerchantSdkErrorOptions = {}) {
    super(message, { code: opts.code ?? 'NETWORK_ERROR', ...opts });
  }
}

// 5xx. Backend reported an internal failure. Retryable.
export class ServerError extends MerchantSdkError {
  constructor(message = 'Server error', opts: MerchantSdkErrorOptions = {}) {
    super(message, { code: opts.code ?? 'SERVER_ERROR', ...opts });
  }
}

// Axios request timeout. Retryable.
export class TimeoutError extends MerchantSdkError {
  constructor(message = 'Request timed out', opts: MerchantSdkErrorOptions = {}) {
    super(message, { code: opts.code ?? 'REQUEST_TIMEOUT', ...opts });
  }
}

// Thrown by verifyWebhook helper when the signature does not match.
export class WebhookVerificationError extends MerchantSdkError {
  constructor(message = 'Webhook signature verification failed', opts: MerchantSdkErrorOptions = {}) {
    super(message, { code: opts.code ?? 'WEBHOOK_VERIFICATION_FAILED', ...opts });
  }
}

// 501 from the server. Endpoint is reserved but not yet implemented.
export class NotImplementedError extends MerchantSdkError {
  constructor(message = 'Endpoint not implemented yet', opts: MerchantSdkErrorOptions = {}) {
    super(message, { code: opts.code ?? 'ENDPOINT_PENDING', ...opts, status: 501 });
  }
}

// 429 with code FUND_USER_AML_STRUCTURING_DETECTED. Returned by the
// platform-fund-user endpoint when the AML structuring detector trips. The
// detector tracks the last N transfers per recipient across 4 sliding Redis
// buckets; small repeated transfers that aggregate above the per-window cap
// trip this code rather than the generic rate-limit code so callers can
// surface a distinct compliance message.
export class PlatformFundUserAmlError extends RateLimitError {
  constructor(message = 'AML structuring threshold tripped', opts: MerchantSdkErrorOptions & { retryAfterMs?: number } = {}) {
    super(message, {
      ...opts,
      code: opts.code ?? 'FUND_USER_AML_STRUCTURING_DETECTED'
    });
  }
}

// 429 with one of the documented fund-user rate-limit codes. Distinct
// subclass (rather than a generic RateLimitError) so callers can pattern
// match on instanceof to surface a fund-user-specific UI hint without
// peeking at .code.
export class PlatformFundUserRateLimitError extends RateLimitError {
  constructor(message = 'Fund-user rate limited', opts: MerchantSdkErrorOptions & { retryAfterMs?: number } = {}) {
    super(message, opts);
  }
}

// 403 with code FUND_USER_2FA_REQUIRED. High-value transfers (>$10K
// USD-equiv) require a fresh TOTP via X-PM-Owner-2FA. The SDK exposes a
// helper `client.with2FA(token).platform.wallet.fundUser(...)` that injects
// the header on the next call.
export class PlatformFundUser2FARequiredError extends PermissionDeniedError {
  constructor(message = 'High-value fund-user requires X-PM-Owner-2FA TOTP', opts: MerchantSdkErrorOptions = {}) {
    super(message, { ...opts, code: opts.code ?? 'FUND_USER_2FA_REQUIRED' });
  }
}

// 409 with code MARKETPLACE_NOT_ELIGIBLE. The user's KYC level or tenant
// config does not allow marketplace publishing. Caller must remediate
// eligibility (e.g., complete KYC) before retrying.
export class PlatformMarketplaceNotEligibleError extends MerchantSdkError {
  constructor(message = 'User not eligible for marketplace publishing', opts: MerchantSdkErrorOptions = {}) {
    super(message, { ...opts, status: 409, code: opts.code ?? 'MARKETPLACE_NOT_ELIGIBLE' });
  }
}

// 403 with code SELF_FUND_NOT_ALLOWED. fund-user cannot target the platform
// owner's own wallet. Distinct from the cross-tenant guard.
export class PlatformSelfFundError extends PermissionDeniedError {
  constructor(message = 'Cannot fund your own wallet', opts: MerchantSdkErrorOptions = {}) {
    super(message, { ...opts, code: opts.code ?? 'SELF_FUND_NOT_ALLOWED' });
  }
}

// 400 with code FUND_USER_REFUND_REQUIRES_TRADE_ID. source='refund' was
// supplied without linkedTradeId, which the audit trail needs to resolve
// the underlying trade.
export class PlatformRefundRequiresTradeError extends ValidationError {
  constructor(message = "source='refund' requires linkedTradeId", opts: MerchantSdkErrorOptions = {}) {
    super(message, { ...opts, code: opts.code ?? 'FUND_USER_REFUND_REQUIRES_TRADE_ID' });
  }
}

// 400 with code PII_IN_MEMO. Server PII detector matched a card number,
// IBAN, SSN, or similar in the memo string. Caller must strip the memo or
// substitute with a non-PII identifier before retry.
export class PlatformPiiInMemoError extends ValidationError {
  constructor(message = 'memo contains PII; strip and retry', opts: MerchantSdkErrorOptions = {}) {
    super(message, { ...opts, code: opts.code ?? 'PII_IN_MEMO' });
  }
}

// Codes returned by the server inside fund-user rate-limit / aml responses.
// Exported as a const so callers can branch on err.code without magic strings.
export const FUND_USER_ERROR_CODES = {
  AML_STRUCTURING_DETECTED: 'FUND_USER_AML_STRUCTURING_DETECTED',
  RECIPIENT_LIMIT: 'FUND_USER_RECIPIENT_LIMIT',
  REFUND_LIMIT: 'FUND_USER_REFUND_LIMIT',
  PLATFORM_LIMIT: 'FUND_USER_PLATFORM_LIMIT',
  NEW_USER_COOLDOWN: 'FUND_USER_NEW_USER_COOLDOWN',
  TWO_FA_REQUIRED: 'FUND_USER_2FA_REQUIRED',
  REFUND_REQUIRES_TRADE_ID: 'FUND_USER_REFUND_REQUIRES_TRADE_ID',
  SELF_FUND_NOT_ALLOWED: 'SELF_FUND_NOT_ALLOWED',
  PII_IN_MEMO: 'PII_IN_MEMO',
  MARKETPLACE_NOT_ELIGIBLE: 'MARKETPLACE_NOT_ELIGIBLE'
} as const;

export type FundUserErrorCode =
  typeof FUND_USER_ERROR_CODES[keyof typeof FUND_USER_ERROR_CODES];
