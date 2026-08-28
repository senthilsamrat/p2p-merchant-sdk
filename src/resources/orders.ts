// Orders resource. /api/v1/merchant/orders.
// Inputs and outputs mirror the merchant API wire contract and are validated
// before being returned to callers.

import type { HttpTransport } from '../transport/httpTransport.js';
import type {
  CancelOrderResult,
  CreateOrderInput,
  ListOrdersOptions,
  Order,
  Paginated,
  RequestOptions,
  UpdateOrderInput
} from '../types/common.js';
import { paginate } from './pagination.js';
import {
  expectObject,
  normalizeCancelOrder,
  normalizeOrder,
  optionalString,
  unwrapObject,
} from '../utils/response.js';
import { buildOrderUpdateRequest } from '../utils/orderUpdateRequest.js';

const BASE = '/api/v1/merchant/orders';

export class OrdersResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Creates a new merchant order (advertisement).
   *
   * The newly created order is returned with server-assigned id, status,
   * and timestamps. The order appears in the public marketplace once the
   * merchant's eligibility checks pass.
   *
   * @param input - Order definition: type (buy/sell), asset, currency, price, limits, payment methods.
   * @param opts - Per-request overrides (idempotency key, extra headers, signal).
   * @returns The created order record.
   * @throws ValidationError when input fields fail server-side validation.
   * @throws PermissionDeniedError when the API key lacks `orders:create`.
   * @example
   * const order = await client.orders.create({
   *   type: 'sell',
   *   cryptocurrency: 'USDT',
   *   fiatCurrency: 'KRW',
   *   amount: '100',
   *   price: '1350',
   *   paymentMethods: ['Bank Transfer'],
   *   // Order-listing lifetime: 60 minutes (not a trade payment window).
   *   timeLimit: 60,
   *   minTradeAmount: '10',
   *   maxTradeAmount: '100'
   * });
   */
  async create(input: CreateOrderInput, opts: RequestOptions = {}): Promise<Order> {
    const response = await this.http.request<unknown>(
      { method: 'POST', path: BASE, body: input },
      opts
    );
    return normalizeOrder(
      unwrapObject(response, 'create order response', ['order', 'data']),
      'create order response.order'
    );
  }

  /**
   * Lists merchant orders matching the supplied filters.
   *
   * The server returns a bare array; the SDK wraps it into a {@link Paginated}
   * envelope so iterator helpers and future cursor-based responses stay
   * source-compatible.
   *
   * @param opts - Filters: status, page-size limit, and `before` cursor.
   * @param requestOpts - Per-request transport overrides.
   * @returns A page of matching orders with `hasMore` indicator.
   * @example
   * const page = await client.orders.list({ status: 'active', limit: 50 });
   * for (const order of page.items) console.log(order.orderId, order.price);
   */
  async list(opts: ListOrdersOptions = {}, requestOpts: RequestOptions = {}): Promise<Paginated<Order>> {
    const response = await this.http.request<unknown>(
      {
        method: 'GET',
        path: BASE,
        query: {
          status: opts.status,
          limit: opts.limit,
          before: opts.before
        }
      },
      requestOpts
    );

    return normalizeOrderPage(response, opts.limit);
  }

  /**
   * Retrieves a single merchant order by id.
   *
   * @param orderId - The order identifier returned by `create()` or `list()`.
   * @param opts - Per-request transport overrides.
   * @returns The order record.
   * @throws NotFoundError when no order matches the id (or the order belongs to another merchant).
   */
  async get(orderId: string, opts: RequestOptions = {}): Promise<Order> {
    const response = await this.http.request<unknown>(
      { method: 'GET', path: `${BASE}/${encodeURIComponent(orderId)}` },
      opts
    );
    return normalizeOrder(
      unwrapObject(response, 'get order response', ['order']),
      'get order response.order'
    );
  }

  /**
   * Applies a partial update to an existing order.
   *
   * Only the fields supplied in `patch` are changed. Status transitions
   * (pause / resume) and price edits both flow through this method.
   *
   * @param orderId - The order identifier to update.
   * @param patch - Subset of order fields to overwrite.
   * @param opts - Per-request transport overrides.
   * @returns The updated order record.
   * @throws ValidationError when the patch violates server-side rules.
   * @throws NotFoundError when the order id is unknown.
   */
  async update(
    orderId: string,
    patch: UpdateOrderInput,
    opts: RequestOptions = {}
  ): Promise<Order> {
    const request = buildOrderUpdateRequest(`${BASE}/${encodeURIComponent(orderId)}`, patch);
    const response = await this.http.request<unknown>(
      request,
      opts
    );
    return normalizeOrder(
      unwrapObject(response, 'update order response', ['order']),
      'update order response.order'
    );
  }

  /**
   * Cancels a merchant order and removes it from the marketplace.
   *
   * @param orderId - The order identifier to cancel.
   * @param opts - Per-request transport overrides.
   * @returns The cancelled order id and service confirmation message.
   * @throws NotFoundError when the order id is unknown.
   */
  async cancel(orderId: string, opts: RequestOptions = {}): Promise<CancelOrderResult> {
    const response = await this.http.request<unknown>(
      { method: 'DELETE', path: `${BASE}/${encodeURIComponent(orderId)}` },
      opts
    );
    return normalizeCancelOrder(response);
  }

  /**
   * Async iterator over every matching order.
   *
   * Walks pages using the `before` cursor when the server supplies one,
   * otherwise stops after the first page. Use with `for await ... of` to
   * stream large result sets without manual pagination.
   *
   * @param opts - Filters (status, page-size limit, starting cursor).
   * @param requestOpts - Per-request transport overrides.
   * @returns Async iterable of orders.
   * @example
   * for await (const order of client.orders.listAll({ status: 'active' })) {
   *   console.log(order.orderId);
   * }
   */
  listAll(opts: ListOrdersOptions = {}, requestOpts: RequestOptions = {}): AsyncIterable<Order> {
    const fetchPage = async (cursor: string | undefined): Promise<Paginated<Order>> => {
      return this.list(
        {
          status: opts.status,
          limit: opts.limit,
          before: cursor ?? opts.before
        },
        requestOpts
      );
    };
    return paginate<Order>(fetchPage);
  }
}

function normalizeOrderPage(raw: unknown, requestedLimit: number | undefined): Paginated<Order> {
  if (Array.isArray(raw)) {
    const items = raw.map((item, index) => normalizeOrder(item, `list orders response[${index}]`));
    const hasMore = requestedLimit !== undefined ? items.length >= requestedLimit : false;
    return { items, hasMore };
  }
  const page = expectObject(raw, 'list orders response');
  if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean') {
    throw new Error('Invalid list orders response: expected items array and hasMore boolean');
  }
  const nextCursor = optionalString(page.nextCursor, 'list orders response.nextCursor');
  return {
    items: page.items.map((item, index) => normalizeOrder(item, `list orders response.items[${index}]`)),
    hasMore: page.hasMore,
    ...(nextCursor !== undefined ? { nextCursor } : {})
  };
}
