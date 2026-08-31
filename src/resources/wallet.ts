// Wallet resource. /api/v1/merchant/wallet/*
// String values preserve BigNumber precision through the wire.

import type { HttpTransport } from '../transport/httpTransport.js';
import type {
  ListWalletTransactionsOptions,
  Paginated,
  RequestOptions,
  WalletBalance,
  WalletHold,
  WalletTransaction
} from '../types/common.js';

const BASE = '/api/v1/merchant/wallet';

// Drops a leading minus without parsing the number, so a value wider than a
// double keeps every digit it arrived with.
function stripSign(amount: unknown): string {
  if (typeof amount !== 'string') return String(amount ?? '0');
  return amount.startsWith('-') ? amount.slice(1) : amount;
}

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

  /**
   * Lists movements in the merchant's own wallet.
   *
   * Deposits, withdrawals and internal transfers are rows of one ledger, so
   * `type` selects among them rather than each having its own call. This reads
   * the merchant the API key belongs to; a tenant's end-user wallets are a
   * different resource.
   *
   * Paging is by cursor rather than offset because the ledger grows at the
   * head, and an offset walk would skip or repeat rows as entries land
   * mid-iteration.
   *
   * @param opts - Filters: `type`, `currency`, `from`, `to`, `limit` (max 200), `cursor`.
   * @param requestOpts - Per-request transport overrides.
   * @returns A page of transactions with `hasMore` and `nextCursor`.
   * @throws AuthenticationError when the API key lacks `wallet:transactions:read`.
   * @throws ValidationError when `type` names an entry type the server rejects.
   * @example
   * const page = await client.wallet.getTransactions({
   *   type: ['deposit', 'withdrawal'],
   *   limit: 200
   * });
   * for (const tx of page.items) {
   *   console.log(tx.type, tx.direction, tx.amount, tx.currency);
   * }
   */
  async getTransactions(
    opts: ListWalletTransactionsOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<Paginated<WalletTransaction>> {
    const envelope = await this.http.request<{
      transactions?: WalletTransaction[];
      hasMore?: boolean;
      nextCursor?: string | null;
    }>(
      {
        method: 'GET',
        path: `${BASE}/transactions`,
        query: {
          // The server reads a comma separated list, so an array is joined
          // here rather than repeating the parameter.
          type: Array.isArray(opts.type) ? opts.type.join(',') : opts.type,
          currency: opts.currency,
          from: opts.from,
          to: opts.to,
          limit: opts.limit,
          cursor: opts.cursor
        }
      },
      requestOpts
    );

    // The stored sign is not consistent across entry types: a withdrawal is
    // held as a negative amount while transfer_out and escrow_lock are held
    // positive, though all three move funds out. A caller reading both fields
    // would subtract a negative and gain the money it meant to deduct, and the
    // resulting drift reads like a missing row rather than a sign error.
    // `amount` is therefore the magnitude and `direction` alone carries which
    // way the funds went.
    const raw = Array.isArray(envelope?.transactions) ? envelope.transactions : [];
    const items = raw.map((tx) => ({
      ...tx,
      amount: stripSign(tx?.amount),
      balanceAfter: tx?.balanceAfter
    }));

    return {
      items,
      hasMore: envelope?.hasMore === true,
      // The server sends null on the last page. Normalising to undefined lets
      // the pagination helpers stop on a falsy cursor without a null check.
      nextCursor: envelope?.nextCursor ?? undefined
    };
  }
}
