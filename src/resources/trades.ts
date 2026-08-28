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
  Trade,
  TradeActionResult
} from '../types/common.js';
import { paginate } from './pagination.js';
import {
  expectObject,
  normalizeMessage,
  normalizeDisputeResponse,
  normalizeTrade,
  normalizeTradeAction,
  optionalString,
  unwrapObject
} from '../utils/response.js';

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
    const response = await this.http.request<unknown>(
      { method: 'GET', path: `${BASE}/${encodeURIComponent(tradeId)}` },
      opts
    );
    return normalizeTrade(
      unwrapObject(response, 'get trade response', ['trade']),
      'get trade response.trade'
    );
  }

  /**
   * Lists trades matching the supplied filters.
   *
   * @param opts - Filters: status, source (`quick_trade`/`marketplace`), limit, before cursor.
   * @param requestOpts - Per-request transport overrides.
   * @returns A page of matching trades with `hasMore` indicator.
   * @example
   * const page = await client.trades.list({ status: 'payment_sent', limit: 25 });
   */
  async list(
    opts: ListTradesOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<Paginated<Trade>> {
    const response = await this.http.request<unknown>(
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
    return normalizeTradePage(response, opts.limit);
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
  async markPaymentSent(
    tradeId: string,
    opts: RequestOptions = {}
  ): Promise<TradeActionResult> {
    const response = await this.http.request<unknown>(
      { method: 'POST', path: `${BASE}/${encodeURIComponent(tradeId)}/payment-sent` },
      opts
    );
    return normalizeTradeAction(
      unwrapObject(response, 'mark trade payment response', ['trade']),
      'mark trade payment response.trade'
    );
  }

  /**
   * Confirms fiat receipt and releases escrow to the buyer.
   *
   * The server route is named `confirm-payment`; {@link release} is a
   * friendlier alias that calls this same endpoint.
   * While settlement is running, the SDK retries the server's
   * `IDEMPOTENCY_IN_PROGRESS` response with the same idempotency key. If the
   * retry window ends first, poll {@link get} until the trade is terminal.
   *
   * @param tradeId - Trade identifier.
   * @param opts - Per-request transport overrides.
   * @returns The action result in `completed` state once settlement finishes.
   * @throws ValidationError when the trade is not in `payment_sent` status.
   */
  async confirmPayment(
    tradeId: string,
    opts: RequestOptions = {}
  ): Promise<TradeActionResult> {
    const response = await this.http.request<unknown>(
      { method: 'POST', path: `${BASE}/${encodeURIComponent(tradeId)}/confirm-payment` },
      opts
    );
    return normalizeTradeAction(
      unwrapObject(response, 'confirm trade payment response', ['trade']),
      'confirm trade payment response.trade'
    );
  }

  /**
   * Alias for {@link confirmPayment}. Same endpoint, naming parity with the spec.
   *
   * @param tradeId - Trade identifier.
   * @param opts - Per-request transport overrides.
   * @returns The action result in `completed` state.
   */
  async release(tradeId: string, opts: RequestOptions = {}): Promise<TradeActionResult> {
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
  async cancel(tradeId: string, opts: RequestOptions = {}): Promise<TradeActionResult> {
    const response = await this.http.request<unknown>(
      { method: 'POST', path: `${BASE}/${encodeURIComponent(tradeId)}/cancel` },
      opts
    );
    return normalizeTradeAction(
      unwrapObject(response, 'cancel trade response', ['trade']),
      'cancel trade response.trade'
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
    const response = await this.http.request<unknown>(
      {
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(tradeId)}/dispute`,
        body: input
      },
      opts
    );
    return normalizeDisputeResponse(response);
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
    const response = await this.http.request<unknown>(
      {
        method: 'POST',
        path: `${CHAT_BASE}/${encodeURIComponent(tradeId)}/messages`,
        body: input
      },
      opts
    );
    return normalizeMessage(
      unwrapObject(response, 'send message response', ['message']),
      tradeId,
      'send message response.message'
    );
  }

  /**
   * Lists messages on a trade thread.
   *
   * @param tradeId - Trade identifier.
   * @param opts - Filters: opaque `before` cursor and `limit`.
   * @param requestOpts - Per-request transport overrides.
   * @returns Object with `messages` array and `hasMore` flag.
   * @example
   * const first = await client.trades.listMessages(tradeId, { limit: 50 });
   * const second = await client.trades.listMessages(tradeId, {
   *   limit: 50,
   *   before: first.nextCursor
   * });
   */
  async listMessages(
    tradeId: string,
    opts: ListMessagesOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<ListMessagesResponse> {
    const response = await this.http.request<unknown>(
      {
        method: 'GET',
        path: `${CHAT_BASE}/${encodeURIComponent(tradeId)}/messages`,
        query: {
          before: opts.before,
          limit: opts.limit
        }
      },
      requestOpts
    );
    return normalizeMessagePage(response, tradeId, opts.limit);
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
   * for await (const trade of client.trades.listAll({ status: 'completed' })) {
   *   console.log(trade.tradeId, trade.amount);
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

function normalizeTradePage(raw: unknown, requestedLimit: number | undefined): Paginated<Trade> {
  if (Array.isArray(raw)) {
    const items = raw.map((item, index) => normalizeTrade(item, `list trades response[${index}]`));
    const hasMore = requestedLimit !== undefined ? items.length >= requestedLimit : false;
    return { items, hasMore };
  }
  const page = expectObject(raw, 'list trades response');
  if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean') {
    throw new Error('Invalid list trades response: expected items array and hasMore boolean');
  }
  const nextCursor = optionalString(page.nextCursor, 'list trades response.nextCursor');
  return {
    items: page.items.map((item, index) =>
      normalizeTrade(item, `list trades response.items[${index}]`)
    ),
    hasMore: page.hasMore,
    ...(nextCursor !== undefined ? { nextCursor } : {})
  };
}

function normalizeMessagePage(
  raw: unknown,
  tradeId: string,
  requestedLimit: number | undefined
): ListMessagesResponse {
  if (Array.isArray(raw)) {
    const messages = raw.map((message, index) =>
      normalizeMessage(message, tradeId, `list messages response[${index}]`)
    );
    const hasMore = requestedLimit !== undefined ? messages.length >= requestedLimit : false;
    return { messages, hasMore };
  }
  const page = expectObject(raw, 'list messages response');
  if (!Array.isArray(page.messages) || typeof page.hasMore !== 'boolean') {
    throw new Error('Invalid list messages response: expected messages array and hasMore boolean');
  }
  const nextCursor = optionalString(page.nextCursor, 'list messages response.nextCursor');
  const oldestMessageId = optionalString(page.oldestMessageId, 'list messages response.oldestMessageId');
  return {
    messages: page.messages.map((message, index) =>
      normalizeMessage(message, tradeId, `list messages response.messages[${index}]`)
    ),
    hasMore: page.hasMore,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(oldestMessageId !== undefined ? { oldestMessageId } : {})
  };
}
