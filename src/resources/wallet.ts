// Wallet resource. /api/v1/merchant/wallet/*
// String values preserve BigNumber precision through the wire.

import type { HttpTransport } from '../transport/httpTransport.js';
import type {
  RequestOptions,
  VerifyTransferInput,
  VerifyTransferResult,
  WalletBalance,
  WalletHold
} from '../types/common.js';
import {
  expectObject,
  normalizeWalletBalance,
  normalizeWalletHold
} from '../utils/response.js';

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
    const response = await this.http.request<unknown>(
      {
        method: 'GET',
        path: `${BASE}/balance`,
        query: { currency: opts.currency }
      },
      requestOpts
    );
    const envelope = expectObject(response, 'wallet balance response');
    if (!Array.isArray(envelope.balances)) {
      throw new Error('Invalid wallet balance response: expected balances array');
    }
    return envelope.balances.map((balance, index) =>
      normalizeWalletBalance(balance, `wallet balance response.balances[${index}]`)
    );
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
    const response = await this.http.request<unknown>(
      {
        method: 'GET',
        path: `${BASE}/holds`,
        query: { currency: opts.currency, limit: opts.limit }
      },
      requestOpts
    );
    const envelope = expectObject(response, 'wallet holds response');
    if (!Array.isArray(envelope.holds)) {
      throw new Error('Invalid wallet holds response: expected holds array');
    }
    return envelope.holds.map((hold, index) =>
      normalizeWalletHold(hold, `wallet holds response.holds[${index}]`)
    );
  }

  /**
   * Confirms a claimed internal transfer against the merchant's own ledger.
   * The reference may be the full transfer reference or the short receipt code.
   */
  async verifyTransfer(
    input: VerifyTransferInput,
    requestOpts: RequestOptions = {}
  ): Promise<VerifyTransferResult> {
    return this.http.request<VerifyTransferResult>(
      {
        method: 'POST',
        path: `${BASE}/transfers/verify`,
        body: {
          type: input.type,
          reference: input.reference,
          ...(input.counterparty !== undefined ? { counterparty: input.counterparty } : {}),
          ...(input.amount !== undefined ? { amount: input.amount } : {})
        }
      },
      requestOpts
    );
  }
}
