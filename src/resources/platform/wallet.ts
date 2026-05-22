// Platform-owner wallet operations. Distinct from the per-end-user wallet
// (which lives on UserScopedClient.wallet) and from the top-level merchant
// wallet. Operations here originate from the SaaS platform owner's master
// wallet and target an end-user; every call writes a hash-chained audit row.
//
// fundUser is the dedicated platform-to-end-user funding path. Unlike a
// user-to-user transfer, the source side is the platform's master wallet
// rather than an end-user, so the call carries source tagging (bonus,
// refund, affiliate, other) and additional rate-limit / AML buckets.
//
// High-value transfers (>$10K USD-equiv) require:
//   1. The API key holds `platform:wallet:fund_user:high_value` (Enterprise
//      tier only).
//   2. A fresh TOTP token passed via X-PM-Owner-2FA on the same call.
//      Use the helper `client.with2FA(token).platform.wallet.fundUser(...)`
//      which forks a request-scoped client that injects the header.

import type { HttpTransport } from '../../transport/httpTransport.js';
import type { RequestOptions } from '../../types/common.js';
import { generateIdempotencyKey } from '../../transport/idempotency.js';
import type {
  PlatformFundUserInput,
  PlatformFundUserResult
} from './types.js';

const FUND_USER_PATH = '/api/v1/merchant/wallet/fund-user';

export class PlatformWalletResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Transfers funds from the platform owner's master wallet to an end-user.
   *
   * Maps to POST /api/v1/merchant/wallet/fund-user. Every call writes a
   * hash-chained audit row tagged with the supplied `source`.
   *
   * Required permissions:
   *  - `platform:wallet:fund_user` (Business + Enterprise)
   *  - `platform:wallet:fund_user:high_value` is ALSO required when the
   *    amount exceeds $10K USD-equiv. The server returns 403
   *    `FUND_USER_2FA_REQUIRED` when the permission is held but the TOTP
   *    is missing, and `PERMISSION_DENIED` when the permission is absent.
   *
   * Idempotency: the SDK auto-generates a uuid v4 when the caller omits
   * one and forwards it via the standard `Idempotency-Key` header. Same
   * key + same body returns the cached response for 24h; same key +
   * different body returns 409 `IDEMPOTENCY_KEY_CONFLICT`.
   *
   * @param input - Recipient userId, decimal-string amount, currency, source bucket.
   * @param opts - Per-request overrides; pass `extraHeaders['X-PM-Owner-2FA']` for high-value transfers, or use `client.with2FA(token)`.
   * @returns The settlement record with txnId, ledger ids, and audit hash.
   * @throws PlatformRefundRequiresTradeError when `source='refund'` lacks `linkedTradeId`.
   * @throws PlatformPiiInMemoError when memo trips the server PII detector.
   * @throws PlatformSelfFundError when `toUserId` resolves to the platform owner's own wallet.
   * @throws PlatformFundUser2FARequiredError on high-value without `X-PM-Owner-2FA`.
   * @throws PlatformFundUserAmlError when AML structuring buckets trip.
   * @throws PlatformFundUserRateLimitError on per-recipient / per-platform / refund-window / new-user-cooldown caps.
   * @throws IdempotencyConflictError when the same key is reused with a different body.
   * @throws NotFoundError on unknown `toUserId` OR cross-tenant probe (server returns 404 not 403 by design).
   * @example
   * await client.with2FA('123456').platform.wallet.fundUser({
   *   toUserId: 'user_abc',
   *   amount: '25000',
   *   currency: 'USDT',
   *   source: 'bonus',
   *   memo: 'Welcome bonus Q1'
   * });
   */
  async fundUser(
    input: PlatformFundUserInput,
    opts: RequestOptions = {}
  ): Promise<PlatformFundUserResult> {
    if (!input.toUserId || typeof input.toUserId !== 'string') {
      throw new Error('platform.wallet.fundUser: toUserId is required');
    }
    if (!input.amount || typeof input.amount !== 'string') {
      throw new Error('platform.wallet.fundUser: amount is required (decimal string)');
    }
    if (!input.currency) {
      throw new Error('platform.wallet.fundUser: currency is required');
    }
    if (!input.source) {
      throw new Error('platform.wallet.fundUser: source is required');
    }
    if (input.source === 'refund' && !input.linkedTradeId) {
      // Local short-circuit so callers fail fast without a server roundtrip.
      // The server still enforces the same rule and returns
      // FUND_USER_REFUND_REQUIRES_TRADE_ID; we throw the same typed error
      // shape here for parity.
      throw new Error(
        "platform.wallet.fundUser: source='refund' requires linkedTradeId (24-char hex ObjectId)"
      );
    }

    const merged: RequestOptions = { ...opts };
    if (merged.idempotencyKey === undefined) {
      merged.idempotencyKey = input.idempotencyKey ?? generateIdempotencyKey();
    }
    const { idempotencyKey: _drop, ...body } = input;

    return this.http.request<PlatformFundUserResult>(
      { method: 'POST', path: FUND_USER_PATH, body },
      merged
    );
  }
}
