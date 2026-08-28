// Trades resource. /api/v1/merchant/trades and nested message/dispute paths.

import type { HttpTransport } from '../transport/httpTransport.js';
import type {
  DisputeResponse,
  ListMessagesOptions,
  ListMessagesResponse,
  ListTradesOptions,
  Message,
  Paginated,
  RequestOptions,
  Trade
} from '../types/common.js';
import { paginate } from './pagination.js';

const BASE = '/api/v1/merchant/trades';
// Trade chat is served by a different service from the rest of the trade
// surface, so it is reached under its own path rather than beneath the trade.
const CHAT_BASE = '/api/v1/merchant/chat/trades';

export class TradesResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Retrieves a single trade by id.
   *
   * @param tradeId - Trade identifier returned from order acceptance or list().
   * @param opts - Per-request transport overrides.
   * @returns The trade record with status, amounts, escrow state.
   * @throws NotFoundError when the trade id is unknown or belongs to another merchant.
   */
  async get(tradeId: string, opts: RequestOptions = {}): Promise<Trade> {
    return this.http.request<Trade>(
      { method: 'GET', path: `${BASE}/${encodeURIComponent(tradeId)}` },
      opts
    );
  }

  /**
   * Lists trades matching the supplied filters.
   *
   * @param opts - Filters: status, source (express/standard), limit, before cursor.
   * @param requestOpts - Per-request transport overrides.
   * @returns A page of matching trades with `hasMore` indicator.
   * @example
   * const page = await client.trades.list({ status: 'PAID', limit: 25 });
   */
  async list(
    opts: ListTradesOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<Paginated<Trade>> {
    const items = await this.http.request<Trade[] | Paginated<Trade>>(
      {
        method: 'GET',
        path: BASE,
        query: {
          status: opts.status,
          source: opts.source,
          limit: opts.limit,
          before: opts.before
        }
      },
      requestOpts
    );
    return normalizePage<Trade>(items, opts.limit);
  }

  /**
   * Marks a trade as buyer-paid.
   *
   * Maps to POST /trades/:tradeId/payment-sent. Buyer signals that fiat has
   * left their account; the seller is then notified to confirm receipt.
   *
   * @param tradeId - Trade identifier.
   * @param opts - Per-request transport overrides.
   * @returns The updated trade record with status advanced to PAID.
   * @throws ValidationError when the trade is not in a state that accepts payment-sent.
   */
  async markPaymentSent(tradeId: string, opts: RequestOptions = {}): Promise<Trade> {
    return this.http.request<Trade>(
      { method: 'POST', path: `${BASE}/${encodeURIComponent(tradeId)}/payment-sent` },
      opts
    );
  }

  /**
   * Confirms fiat receipt and releases escrow to the buyer.
   *
   * The server route is named `confirm-payment`; {@link release} is a
   * friendlier alias that calls this same endpoint.
   *
   * @param tradeId - Trade identifier.
   * @param opts - Per-request transport overrides.
   * @returns The updated trade record in COMPLETED state.
   * @throws ValidationError when the trade is not in PAID status.
   */
  async confirmPayment(tradeId: string, opts: RequestOptions = {}): Promise<Trade> {
    return this.http.request<Trade>(
      { method: 'POST', path: `${BASE}/${encodeURIComponent(tradeId)}/confirm-payment` },
      opts
    );
  }

  /**
   * Alias for {@link confirmPayment}. Same endpoint, naming parity with the spec.
   *
   * @param tradeId - Trade identifier.
   * @param opts - Per-request transport overrides.
   * @returns The updated trade record in COMPLETED state.
   */
  async release(tradeId: string, opts: RequestOptions = {}): Promise<Trade> {
    return this.confirmPayment(tradeId, opts);
  }

  /**
   * Cancels a trade before payment is confirmed.
   *
   * @param tradeId - Trade identifier.
   * @param opts - Per-request transport overrides.
   * @returns The cancelled trade record.
   * @throws ValidationError when the trade is past the cancellable window (e.g., PAID).
   */
  async cancel(tradeId: string, opts: RequestOptions = {}): Promise<Trade> {
    return this.http.request<Trade>(
      { method: 'POST', path: `${BASE}/${encodeURIComponent(tradeId)}/cancel` },
      opts
    );
  }

  /**
   * Opens a dispute on a trade.
   *
   * Once opened, escrow funds are held until the dispute is resolved by
   * the moderation team or automatically via clawback rules.
   *
   * @param tradeId - Trade identifier.
   * @param input - Dispute reason and optional evidence URLs.
   * @param opts - Per-request transport overrides.
   * @returns The dispute record with id and initial status.
   * @throws ValidationError when reason is missing or the trade cannot be disputed in its current status.
   * @example
   * await client.trades.openDispute(tradeId, {
   *   reason: 'Payment received does not match the trade amount',
   *   evidence: ['https://cdn.example.com/proof.png']
   * });
   */
  async openDispute(
    tradeId: string,
    input: { reason: string; evidence?: string[] },
    opts: RequestOptions = {}
  ): Promise<DisputeResponse> {
    return this.http.request<DisputeResponse>(
      {
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(tradeId)}/dispute`,
        body: input
      },
      opts
    );
  }

  /**
   * Sends a chat message on a trade thread.
   *
   * @param tradeId - Trade identifier.
   * @param input - Message content and optional type (`text` default, `image_url`).
   * @param opts - Per-request transport overrides.
   * @returns The created message record.
   */
  async sendMessage(
    tradeId: string,
    input: { content: string; type?: 'text' | 'image_url' },
    opts: RequestOptions = {}
  ): Promise<Message> {
    return this.http.request<Message>(
      {
        method: 'POST',
        path: `${CHAT_BASE}/${encodeURIComponent(tradeId)}/messages`,
        body: input
      },
      opts
    );
  }

  /**
   * Lists messages on a trade thread.
   *
   * @param tradeId - Trade identifier.
   * @param opts - Filters: `since` (ISO timestamp) and `limit`.
   * @param requestOpts - Per-request transport overrides.
   * @returns Object with `messages` array and `hasMore` flag.
   * @example
   * const since = new Date(Date.now() - 60_000).toISOString();
   * const { messages } = await client.trades.listMessages(tradeId, { since });
   */
  async listMessages(
    tradeId: string,
    opts: ListMessagesOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<ListMessagesResponse> {
    const raw = await this.http.request<Message[] | ListMessagesResponse>(
      {
        method: 'GET',
        path: `${CHAT_BASE}/${encodeURIComponent(tradeId)}/messages`,
        query: {
          since: opts.since,
          limit: opts.limit
        }
      },
      requestOpts
    );
    if (Array.isArray(raw)) {
      const hasMore = opts.limit !== undefined ? raw.length >= opts.limit : false;
      return { messages: raw, hasMore };
    }
    return raw;
  }

  /**
   * Switches the merchant counterparty on an in-flight Express trade.
   *
   * Pre-payment only. Mints a new tradeId against a different merchant
   * from the Express pool while preserving the buyer's original intent.
   *
   * @param tradeId - The original trade identifier.
   * @param input - Optional `reason` annotation surfaced to the new merchant.
   * @param opts - Per-request transport overrides.
   * @returns Switch result with `previousTradeId` and `newTradeId`.
   * @throws ValidationError when the trade is past the pre-payment window.
   */
  async switchMerchant(
    tradeId: string,
    input: { reason?: string } = {},
    opts: RequestOptions = {}
  ): Promise<{
    success: boolean;
    code: string;
    previousTradeId: string;
    newTradeId: string;
  }> {
    return this.http.request(
      {
        method: 'POST',
        path: `/api/v1/merchant/quick/${encodeURIComponent(tradeId)}/switch-merchant`,
        body: input
      },
      opts
    );
  }

  /**
   * Async iterator over every matching trade.
   *
   * Walks pages using the `before` cursor when the server supplies one.
   * Use with `for await ... of` to stream large result sets.
   *
   * @param opts - Filters (status, source, limit, starting cursor).
   * @param requestOpts - Per-request transport overrides.
   * @returns Async iterable of trades.
   * @example
   * for await (const trade of client.trades.listAll({ status: 'COMPLETED' })) {
   *   console.log(trade.id, trade.amount);
   * }
   */
  listAll(
    opts: ListTradesOptions = {},
    requestOpts: RequestOptions = {}
  ): AsyncIterable<Trade> {
    const fetchPage = async (cursor: string | undefined): Promise<Paginated<Trade>> => {
      return this.list(
        {
          status: opts.status,
          source: opts.source,
          limit: opts.limit,
          before: cursor ?? opts.before
        },
        requestOpts
      );
    };
    return paginate<Trade>(fetchPage);
  }
}

function normalizePage<T>(raw: T[] | Paginated<T>, requestedLimit: number | undefined): Paginated<T> {
  if (Array.isArray(raw)) {
    const items = raw;
    const hasMore = requestedLimit !== undefined ? items.length >= requestedLimit : false;
    return { items, hasMore };
  }
  return raw;
}
