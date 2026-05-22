// Orders resource. /api/v1/merchant/orders.
// Some list/get methods may return 501 NotImplementedError until the merchant
// programmatic order management backend ships. The shape of inputs and
// outputs mirrors the dashboard /api/merchants/orders contract so callers
// can wire today and keep the same code when the v1 endpoints land.

import type { HttpTransport } from '../transport/httpTransport.js';
import type {
  CreateOrderInput,
  ListOrdersOptions,
  Order,
  Paginated,
  RequestOptions,
  UpdateOrderInput
} from '../types/common.js';
import { paginate } from './pagination.js';

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
   * @throws PermissionDeniedError when the API key lacks `orders:write`.
   * @example
   * const order = await client.orders.create({
   *   type: 'sell',
   *   asset: 'USDT',
   *   currency: 'KRW',
   *   price: '1350',
   *   minAmount: '10000',
   *   maxAmount: '500000'
   * });
   */
  async create(input: CreateOrderInput, opts: RequestOptions = {}): Promise<Order> {
    return this.http.request<Order>(
      { method: 'POST', path: BASE, body: input },
      opts
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
   * @throws NotImplementedError when the server-side endpoint is still stubbed.
   * @example
   * const page = await client.orders.list({ status: 'active', limit: 50 });
   * for (const order of page.items) console.log(order.id, order.price);
   */
  async list(opts: ListOrdersOptions = {}, requestOpts: RequestOptions = {}): Promise<Paginated<Order>> {
    const items = await this.http.request<Order[] | Paginated<Order>>(
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

    return normalizePage<Order>(items, opts.limit);
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
    return this.http.request<Order>(
      { method: 'GET', path: `${BASE}/${encodeURIComponent(orderId)}` },
      opts
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
    return this.http.request<Order>(
      {
        method: 'PATCH',
        path: `${BASE}/${encodeURIComponent(orderId)}`,
        body: patch
      },
      opts
    );
  }

  /**
   * Cancels a merchant order and removes it from the marketplace.
   *
   * @param orderId - The order identifier to cancel.
   * @param opts - Per-request transport overrides.
   * @returns The order record in its final cancelled state.
   * @throws NotFoundError when the order id is unknown.
   */
  async cancel(orderId: string, opts: RequestOptions = {}): Promise<Order> {
    return this.http.request<Order>(
      { method: 'DELETE', path: `${BASE}/${encodeURIComponent(orderId)}` },
      opts
    );
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
   *   console.log(order.id);
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

function normalizePage<T>(raw: T[] | Paginated<T>, requestedLimit: number | undefined): Paginated<T> {
  if (Array.isArray(raw)) {
    const items = raw;
    const hasMore = requestedLimit !== undefined ? items.length >= requestedLimit : false;
    return { items, hasMore };
  }
  return raw;
}
