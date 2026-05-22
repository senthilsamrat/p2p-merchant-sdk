// Wallet resource. /api/v1/merchant/wallet/*
// String values preserve BigNumber precision through the wire.

import type { HttpTransport } from '../transport/httpTransport.js';
import type {
  RequestOptions,
  WalletBalance,
  WalletHold
} from '../types/common.js';

const BASE = '/api/v1/merchant/wallet';

export class WalletResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Fetches merchant wallet balances.
   *
   * Amounts are returned as decimal strings so callers can route through
   * BigNumber without precision loss.
   *
   * @param opts - Filter: restrict to a single `currency` (e.g., `USDT`).
   * @param requestOpts - Per-request transport overrides.
   * @returns Array of wallet balances (empty when no balances match).
   * @throws AuthenticationError when the API key lacks `wallet:read`.
   * @example
   * const balances = await client.wallet.getBalance({ currency: 'USDT' });
   * console.log(balances[0]?.available);
   */
  async getBalance(
    opts: { currency?: string } = {},
    requestOpts: RequestOptions = {}
  ): Promise<WalletBalance[]> {
    const envelope = await this.http.request<{ balances: WalletBalance[] }>(
      {
        method: 'GET',
        path: `${BASE}/balance`,
        query: { currency: opts.currency }
      },
      requestOpts
    );
    return Array.isArray(envelope?.balances) ? envelope.balances : [];
  }

  /**
   * Lists active escrow holds against merchant wallet balances.
   *
   * Each hold corresponds to an in-flight trade where the merchant is the
   * seller and escrow has locked funds against the available balance.
   *
   * @param opts - Filters: `currency` and `limit`.
   * @param requestOpts - Per-request transport overrides.
   * @returns Array of wallet holds (empty when none match).
   */
  async getHolds(
    opts: { currency?: string; limit?: number } = {},
    requestOpts: RequestOptions = {}
  ): Promise<WalletHold[]> {
    const envelope = await this.http.request<{ holds: WalletHold[] }>(
      {
        method: 'GET',
        path: `${BASE}/holds`,
        query: { currency: opts.currency, limit: opts.limit }
      },
      requestOpts
    );
    return Array.isArray(envelope?.holds) ? envelope.holds : [];
  }
}
