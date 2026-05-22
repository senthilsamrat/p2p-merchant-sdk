// Account resource. GET /api/v1/merchant/account.

import type { HttpTransport } from '../transport/httpTransport.js';
import type { MerchantAccount, RequestOptions } from '../types/common.js';

const BASE = '/api/v1/merchant';

export class AccountResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Fetches the calling merchant's account profile.
   *
   * Returns the merchant's profile, tier, status, KYC level, and the
   * effective permission set for the API key that signed the request.
   *
   * @param opts - Per-request overrides (idempotency key, extra headers, signal).
   * @returns The merchant account record.
   * @throws AuthenticationError when the API key or signature is rejected.
   * @example
   * const account = await client.account.get();
   * console.log(account.tier, account.kycLevel);
   */
  async get(opts: RequestOptions = {}): Promise<MerchantAccount> {
    return this.http.request<MerchantAccount>(
      { method: 'GET', path: `${BASE}/account` },
      opts
    );
  }
}
