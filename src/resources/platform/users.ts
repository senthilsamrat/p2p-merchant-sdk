// Platform end-user CRUD plus the UserScopedClient that auto-injects
// X-PM-Acting-User on every per-end-user call. Routes mirror the
// SaaS-WS-Platform-Users + SaaS-WS-Platform-Wallet endpoint families.

import type { HttpTransport } from '../../transport/httpTransport.js';
import type {
  CancelOrderResult,
  CreateOrderInput,
  DisputeResponse,
  ListMessagesOptions,
  ListMessagesResponse,
  ListOrdersOptions,
  ListTradesOptions,
  Message,
  Order,
  Paginated,
  RankInfo,
  RequestOptions,
  Trade,
  TradeActionResult,
  UpdateOrderInput
} from '../../types/common.js';
import type {
  CreatePlatformUserInput,
  DepositAddress,
  DepositAddressInput,
  KycStatus,
  ListLedgerOptions,
  ListLedgerResponse,
  ListPlatformUsersOptions,
  ListPlatformUsersResponse,
  MarketplaceDisableResult,
  MarketplaceEnableResult,
  PlatformMarketplaceState,
  PlatformUser,
  ScopedPaymentMethod,
  ScopedWalletBalance,
  ScopedWalletHold,
  SoftDeleteUserInput,
  AcceptOrderInput,
  StartKycInput,
  StartKycResponse,
  SuspendUserInput,
  TransferInput,
  TransferResult,
  UpdatePlatformUserInput,
  WithdrawInput,
  WithdrawResult
} from './types.js';
import { ScopedQuickTradeResource } from './quickTrade.js';
import {
  expectObject,
  normalizeCancelOrder,
  normalizeDisputeResponse,
  normalizeMessage,
  normalizeOrder,
  normalizePaymentMethod,
  normalizeTrade,
  normalizeTradeAction,
  normalizeWalletBalance,
  normalizeWalletHold,
  optionalString,
  unwrapObject
} from '../../utils/response.js';
import { buildOrderUpdateRequest } from '../../utils/orderUpdateRequest.js';

const BASE = '/api/v1/merchant/users';

export class PlatformUsersResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Creates a new end-user under the calling SaaS platform.
   *
   * The created user inherits the platform's parentMerchantId; cross-tenant
   * lookups remain blocked.
   *
   * @param input - End-user profile (email, external id, optional metadata).
   * @param opts - Per-request transport overrides.
   * @returns The created PlatformUser.
   * @throws ValidationError when email is malformed or external id collides.
   * @example
   * const user = await client.platform.users.create({
   *   email: 'alice@example.com',
   *   externalId: 'CRM-12345'
   * });
   */
  async create(
    input: CreatePlatformUserInput,
    opts: RequestOptions = {}
  ): Promise<PlatformUser> {
    return this.http.request<PlatformUser>(
      { method: 'POST', path: BASE, body: input },
      opts
    );
  }

  /**
   * Lists end-users under the calling SaaS platform.
   *
   * @param opts - Filters: pagination, `status`, `kycLevel`, `search`.
   * @param requestOpts - Per-request transport overrides.
   * @returns Paginated response with `users`, `hasMore`, optional `nextCursor`.
   */
  async list(
    opts: ListPlatformUsersOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<ListPlatformUsersResponse> {
    return this.http.request<ListPlatformUsersResponse>(
      {
        method: 'GET',
        path: BASE,
        query: {
          limit: opts.limit,
          cursor: opts.cursor,
          status: opts.status,
          kycLevel: opts.kycLevel,
          search: opts.search
        }
      },
      requestOpts
    );
  }

  /**
   * Async iterator over every matching end-user.
   *
   * Walks cursors transparently. Use with `for await ... of`.
   *
   * @param opts - Same filters as `list()`.
   * @param requestOpts - Per-request transport overrides.
   * @returns Async iterable of PlatformUsers.
   */
  async *listAll(
    opts: ListPlatformUsersOptions = {},
    requestOpts: RequestOptions = {}
  ): AsyncIterable<PlatformUser> {
    let cursor: string | undefined = opts.cursor;
    let exhausted = false;
    while (!exhausted) {
      const page = await this.list({ ...opts, cursor }, requestOpts);
      for (const user of page.users) {
        yield user;
      }
      cursor = page.nextCursor;
      if (!page.hasMore || cursor === undefined) {
        exhausted = true;
      }
    }
  }

  /**
   * Returns a user-scoped sub-client.
   *
   * Every call dispatched through the returned client carries
   * `X-PM-Acting-User: <userId>` so platform operators can act on behalf
   * of an end-user without threading the id through every request.
   *
   * @param userId - End-user identifier.
   * @returns A UserScopedClient bound to this id.
   * @example
   * await client.platform.users('user_abc').orders.create({ ... });
   */
  user(userId: string): UserScopedClient {
    if (!userId || typeof userId !== 'string') {
      throw new Error('platform.users(userId): userId is required');
    }
    return new UserScopedClient(this.http, userId);
  }
}

// User-scoped sub-client. Holds an end-user identifier and exposes the same
// resource families as the top-level MerchantClient but every request goes
// out with X-PM-Acting-User: <userId>. The header is merged through
// RequestOptions.extraHeaders so the canonical SDK signing flow stays intact.
export class UserScopedClient {
  public readonly userId: string;
  public readonly orders: ScopedOrdersResource;
  public readonly trades: ScopedTradesResource;
  public readonly wallet: ScopedWalletResource;
  public readonly paymentMethods: ScopedPaymentMethodsResource;
  public readonly kyc: ScopedKycResource;
  // Per-user marketplace publishing toggle. Platform owner controls whether
  // each end-user's ads appear in the public marketplace, independent of
  // tenant-wide eligibility.
  public readonly marketplace: ScopedMarketplaceResource;
  // SaaS quick-trade auto-match. bestMatch + initiate run as the end-user
  // through the X-PM-Acting-User binding so the matcher applies the user's
  // tenancy bucket and KYC level.
  public readonly quickTrade: ScopedQuickTradeResource;
  // Market reads whose subject is one end-user's own order. The pair-keyed
  // market data on the top-level client is identical for every caller and
  // stays there.
  public readonly market: ScopedMarketResource;

  private readonly http: HttpTransport;

  constructor(http: HttpTransport, userId: string) {
    this.http = http;
    this.userId = userId;
    this.orders = new ScopedOrdersResource(http, userId);
    this.trades = new ScopedTradesResource(http, userId);
    this.wallet = new ScopedWalletResource(http, userId);
    this.paymentMethods = new ScopedPaymentMethodsResource(http, userId);
    this.kyc = new ScopedKycResource(http, userId);
    this.marketplace = new ScopedMarketplaceResource(http, userId);
    this.quickTrade = new ScopedQuickTradeResource(http, userId);
    this.market = new ScopedMarketResource(http, userId);
  }

  /**
   * Fetches this end-user's profile record.
   *
   * @param opts - Per-request transport overrides.
   * @returns The PlatformUser.
   * @throws NotFoundError when the user does not exist or belongs to another tenant.
   */
  async get(opts: RequestOptions = {}): Promise<PlatformUser> {
    return this.http.request<PlatformUser>(
      {
        method: 'GET',
        path: `${BASE}/${encodeURIComponent(this.userId)}`
      },
      withActingUser(opts, this.userId)
    );
  }

  /**
   * Applies a partial update to this end-user's profile.
   *
   * @param patch - Subset of profile fields to overwrite.
   * @param opts - Per-request transport overrides.
   * @returns The updated PlatformUser.
   */
  async update(
    patch: UpdatePlatformUserInput,
    opts: RequestOptions = {}
  ): Promise<PlatformUser> {
    return this.http.request<PlatformUser>(
      {
        method: 'PATCH',
        path: `${BASE}/${encodeURIComponent(this.userId)}`,
        body: patch
      },
      withActingUser(opts, this.userId)
    );
  }

  /**
   * Suspends this end-user, blocking further trading actions.
   *
   * @param input - Optional `reason` annotation surfaced to compliance.
   * @param opts - Per-request transport overrides.
   * @returns The PlatformUser in suspended state.
   */
  async suspend(
    input: SuspendUserInput = {},
    opts: RequestOptions = {}
  ): Promise<PlatformUser> {
    return this.http.request<PlatformUser>(
      {
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(this.userId)}/suspend`,
        body: input
      },
      withActingUser(opts, this.userId)
    );
  }

  /**
   * Restores a previously suspended end-user.
   *
   * @param opts - Per-request transport overrides.
   * @returns The restored PlatformUser.
   */
  async restore(opts: RequestOptions = {}): Promise<PlatformUser> {
    return this.http.request<PlatformUser>(
      {
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(this.userId)}/restore`,
        body: {}
      },
      withActingUser(opts, this.userId)
    );
  }

  /**
   * Soft-deletes this end-user.
   *
   * The user is marked deleted but the record is retained for compliance.
   * The id can no longer be used for trading operations.
   *
   * @param input - Optional `reason` annotation.
   * @param opts - Per-request transport overrides.
   */
  async softDelete(
    input: SoftDeleteUserInput = {},
    opts: RequestOptions = {}
  ): Promise<void> {
    const reason = input.reason ?? input.deletionReason;
    await this.http.request<void>(
      {
        method: 'DELETE',
        path: `${BASE}/${encodeURIComponent(this.userId)}`,
        body: reason === undefined ? {} : { reason }
      },
      withActingUser(opts, this.userId)
    );
  }
}

// Helper that injects X-PM-Acting-User without clobbering caller-supplied
// extras. SDK-managed headers always win in the transport, so this is safe.
function withActingUser(opts: RequestOptions, userId: string): RequestOptions {
  return {
    ...opts,
    extraHeaders: {
      ...(opts.extraHeaders ?? {}),
      'X-PM-Acting-User': userId
    }
  };
}

// Per-user orders. Mirrors the top-level OrdersResource shape except every
// call carries the acting-user header. Path is the standard /orders root;
// the merchant-service routes the call to the named end-user via the header.
export class ScopedOrdersResource {
  constructor(
    private readonly http: HttpTransport,
    private readonly userId: string
  ) {}

  /**
   * Creates an order under this end-user's account.
   *
   * @param input - Order definition (same shape as the top-level OrdersResource).
   * @param opts - Per-request transport overrides.
   * @returns The created order record.
   */
  async create(input: CreateOrderInput, opts: RequestOptions = {}): Promise<Order> {
    const response = await this.http.request<unknown>(
      { method: 'POST', path: '/api/v1/merchant/orders', body: input },
      withActingUser(opts, this.userId)
    );
    return normalizeOrder(
      unwrapObject(response, 'create scoped order response', ['order', 'data']),
      'create scoped order response.order'
    );
  }

  /**
   * Lists this end-user's orders.
   *
   * @param opts - Filters: `status`, `limit`, `before` cursor.
   * @param requestOpts - Per-request transport overrides.
   * @returns A page of orders with `hasMore` indicator.
   */
  async list(
    opts: ListOrdersOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<Paginated<Order>> {
    const response = await this.http.request<unknown>(
      {
        method: 'GET',
        path: '/api/v1/merchant/orders',
        query: {
          status: opts.status,
          limit: opts.limit,
          before: opts.before
        }
      },
      withActingUser(requestOpts, this.userId)
    );
    return normalizeOrderPage(response, opts.limit);
  }

  /**
   * Fetches a single order owned by this end-user.
   *
   * @param orderId - Order identifier.
   * @param opts - Per-request transport overrides.
   * @returns The order record.
   * @throws NotFoundError when the id is unknown or the order belongs to another user.
   */
  async get(orderId: string, opts: RequestOptions = {}): Promise<Order> {
    const response = await this.http.request<unknown>(
      {
        method: 'GET',
        path: `/api/v1/merchant/orders/${encodeURIComponent(orderId)}`
      },
      withActingUser(opts, this.userId)
    );
    return normalizeOrder(
      unwrapObject(response, 'get scoped order response', ['order']),
      'get scoped order response.order'
    );
  }

  /**
   * Updates this end-user's order.
   *
   * @param orderId - Order identifier.
   * @param patch - Subset of order fields to overwrite.
   * @param opts - Per-request transport overrides.
   * @returns The updated order record.
   */
  async update(
    orderId: string,
    patch: UpdateOrderInput,
    opts: RequestOptions = {}
  ): Promise<Order> {
    const request = buildOrderUpdateRequest(
      `/api/v1/merchant/orders/${encodeURIComponent(orderId)}`,
      patch
    );
    const response = await this.http.request<unknown>(
      request,
      withActingUser(opts, this.userId)
    );
    return normalizeOrder(
      unwrapObject(response, 'update scoped order response', ['order']),
      'update scoped order response.order'
    );
  }

  /**
   * Cancels this end-user's order.
   *
   * @param orderId - Order identifier.
   * @param opts - Per-request transport overrides.
   * @returns The cancelled order id and service confirmation message.
   */
  async cancel(orderId: string, opts: RequestOptions = {}): Promise<CancelOrderResult> {
    const response = await this.http.request<unknown>(
      {
        method: 'DELETE',
        path: `/api/v1/merchant/orders/${encodeURIComponent(orderId)}`
      },
      withActingUser(opts, this.userId)
    );
    return normalizeCancelOrder(response);
  }
}

// Per-user trades. Same dispatch rules as ScopedOrdersResource.
export class ScopedTradesResource {
  constructor(
    private readonly http: HttpTransport,
    private readonly userId: string
  ) {}

  /**
   * Accepts an order from the marketplace on behalf of this end-user, opening
   * a trade against it.
   *
   * This is the counterpart to browsing the marketplace: the end-user picks an
   * order someone else posted and takes it. Their own orders are refused, as
   * are orders belonging to another platform's users.
   *
   * The trade opens in the payment stage. From there the buyer calls
   * markPaymentSent once they have paid off-platform, and the seller calls
   * confirmPayment to release the crypto.
   *
   * @param input - Order to accept, amount, payment method and an idempotency key.
   * @param opts - Per-request transport overrides.
   * @returns The created trade action result.
   */
  async create(input: AcceptOrderInput, opts: RequestOptions = {}): Promise<TradeActionResult> {
    if (!input?.orderId) {
      throw new Error('trades.create: orderId is required');
    }
    if (!input.amount || typeof input.amount !== 'string') {
      throw new Error('trades.create: amount is required (decimal string)');
    }
    if (!input.paymentMethod) {
      throw new Error('trades.create: paymentMethod is required');
    }
    if (!input.idempotencyKey) {
      // Required rather than auto-generated. A generated key would differ on a
      // caller's own retry and could open a second trade against the order.
      throw new Error('trades.create: idempotencyKey is required');
    }

    const merged: RequestOptions = withActingUser(opts, this.userId);
    merged.idempotencyKey = input.idempotencyKey;
    // The trade saga routinely outlasts the default client timeout, and giving
    // up early leaves the caller unsure whether a trade was opened.
    if (merged.timeoutMs === undefined) {
      merged.timeoutMs = 120_000;
    }

    const { idempotencyKey: _drop, ...body } = input;
    const response = await this.http.request<unknown>(
      { method: 'POST', path: '/api/v1/merchant/trades', body },
      merged
    );
    return normalizeTradeAction(
      unwrapObject(response, 'create scoped trade response', ['trade']),
      'create scoped trade response.trade'
    );
  }

  /**
   * Lists this end-user's trades.
   *
   * @param opts - Filters: `status`, `source`, `limit`, `before` cursor.
   * @param requestOpts - Per-request transport overrides.
   * @returns A page of trades with `hasMore` indicator.
   */
  async list(
    opts: ListTradesOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<Paginated<Trade>> {
    const response = await this.http.request<unknown>(
      {
        method: 'GET',
        path: '/api/v1/merchant/trades',
        query: {
          status: opts.status,
          source: opts.source,
          limit: opts.limit,
          before: opts.before
        }
      },
      withActingUser(requestOpts, this.userId)
    );
    return normalizeTradePage(response, opts.limit);
  }

  /**
   * Fetches a single trade for this end-user.
   *
   * @param tradeId - Trade identifier.
   * @param opts - Per-request transport overrides.
   * @returns The trade record.
  */
  async get(tradeId: string, opts: RequestOptions = {}): Promise<Trade> {
    const response = await this.http.request<unknown>(
      {
        method: 'GET',
        path: `/api/v1/merchant/trades/${encodeURIComponent(tradeId)}`
      },
      withActingUser(opts, this.userId)
    );
    return normalizeTrade(
      unwrapObject(response, 'get scoped trade response', ['trade']),
      'get scoped trade response.trade'
    );
  }

  /**
   * Marks the trade as buyer-paid on behalf of this end-user.
   *
   * @param tradeId - Trade identifier.
   * @param opts - Per-request transport overrides.
   * @returns The payment-sent action result.
   */
  async markPaymentSent(
    tradeId: string,
    opts: RequestOptions = {}
  ): Promise<TradeActionResult> {
    const response = await this.http.request<unknown>(
      {
        method: 'POST',
        path: `/api/v1/merchant/trades/${encodeURIComponent(tradeId)}/payment-sent`
      },
      withActingUser(opts, this.userId)
    );
    return normalizeTradeAction(
      unwrapObject(response, 'mark scoped trade payment response', ['trade']),
      'mark scoped trade payment response.trade'
    );
  }

  /**
   * Confirms fiat receipt and releases escrow on behalf of this end-user.
   *
   * @param tradeId - Trade identifier.
   * @param opts - Per-request transport overrides.
   * @returns The confirmation action result.
   */
  async confirmPayment(
    tradeId: string,
    opts: RequestOptions = {}
  ): Promise<TradeActionResult> {
    const response = await this.http.request<unknown>(
      {
        method: 'POST',
        path: `/api/v1/merchant/trades/${encodeURIComponent(tradeId)}/confirm-payment`
      },
      withActingUser(opts, this.userId)
    );
    return normalizeTradeAction(
      unwrapObject(response, 'confirm scoped trade payment response', ['trade']),
      'confirm scoped trade payment response.trade'
    );
  }

  /**
   * Cancels a trade on behalf of this end-user.
   *
   * @param tradeId - Trade identifier.
   * @param opts - Per-request transport overrides.
   * @returns The cancellation action result.
   */
  async cancel(tradeId: string, opts: RequestOptions = {}): Promise<TradeActionResult> {
    const response = await this.http.request<unknown>(
      {
        method: 'POST',
        path: `/api/v1/merchant/trades/${encodeURIComponent(tradeId)}/cancel`
      },
      withActingUser(opts, this.userId)
    );
    return normalizeTradeAction(
      unwrapObject(response, 'cancel scoped trade response', ['trade']),
      'cancel scoped trade response.trade'
    );
  }

  /**
   * Opens a dispute on a trade on behalf of this end-user.
   *
   * @param tradeId - Trade identifier.
   * @param input - Dispute reason and optional evidence URLs.
   * @param opts - Per-request transport overrides.
   * @returns The server's dispute response payload.
   */
  async openDispute(
    tradeId: string,
    input: { reason: string; evidence?: string[] },
    opts: RequestOptions = {}
  ): Promise<DisputeResponse> {
    const response = await this.http.request<unknown>(
      {
        method: 'POST',
        path: `/api/v1/merchant/trades/${encodeURIComponent(tradeId)}/dispute`,
        body: input
      },
      withActingUser(opts, this.userId)
    );
    return normalizeDisputeResponse(response);
  }

  /**
   * Switches the merchant counterparty on an in-flight Express trade.
   *
   * Pre-payment only. This operation is user-scoped because the service must
   * authenticate which platform end-user owns the in-flight trade.
   *
   * @param tradeId - The original trade identifier.
   * @param input - Optional `reason` annotation.
   * @param opts - Per-request transport overrides.
   * @returns The server's switch-merchant payload.
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
    return this.http.request<{
      success: boolean;
      code: string;
      previousTradeId: string;
      newTradeId: string;
    }>(
      {
        method: 'POST',
        path: `/api/v1/merchant/quick/${encodeURIComponent(tradeId)}/switch-merchant`,
        body: input
      },
      withActingUser(opts, this.userId)
    );
  }

  /**
   * Sends a chat message on a trade thread on behalf of this end-user.
   *
   * @param tradeId - Trade identifier.
   * @param input - Message content and optional type.
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
        path: `/api/v1/merchant/chat/trades/${encodeURIComponent(tradeId)}/messages`,
        body: input
      },
      withActingUser(opts, this.userId)
    );
    return normalizeMessage(
      unwrapObject(response, 'send scoped message response', ['message']),
      tradeId,
      'send scoped message response.message'
    );
  }

  /**
   * Reads the chat thread on a trade, as this end-user sees it.
   *
   * Only a party to the trade can read its thread. The acting user is carried
   * on the request, so this returns the thread from that user's side and a
   * user who is not on the trade is refused.
   *
   * @param tradeId - Trade identifier.
   * @param options - Page size and opaque `before` cursor.
   * @param requestOpts - Per-request transport overrides.
   * @returns The messages and the cursor for the next older page.
   */
  async getMessages(
    tradeId: string,
    options: ListMessagesOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<ListMessagesResponse> {
    const response = await this.http.request<unknown>(
      {
        method: 'GET',
        path: `/api/v1/merchant/chat/trades/${encodeURIComponent(tradeId)}/messages`,
        query: { limit: options.limit, before: options.before }
      },
      withActingUser(requestOpts, this.userId)
    );
    return normalizeMessagePage(response, tradeId);
  }
}

// Per-end-user wallet. The path is rooted at /merchant/users/:userId/wallet
// so the URL itself carries the user; the X-PM-Acting-User header is added
// for parity with the rest of the scoped surface and to give the gateway
// a single place to enforce parent-merchant ownership.
export class ScopedWalletResource {
  constructor(
    private readonly http: HttpTransport,
    private readonly userId: string
  ) {}

  private root(): string {
    return `/api/v1/merchant/users/${encodeURIComponent(this.userId)}/wallet`;
  }

  /**
   * Fetches this end-user's wallet balances.
   *
   * Amounts are decimal strings so callers can route through BigNumber
   * without precision loss.
   *
   * @param opts - Filter by `currency`.
   * @param requestOpts - Per-request transport overrides.
   * @returns Array of wallet balances.
   */
  async getBalance(
    opts: { currency?: string } = {},
    requestOpts: RequestOptions = {}
  ): Promise<ScopedWalletBalance[]> {
    // Server returns {balances: [...]} envelope; extract the array.
    const response = await this.http.request<unknown>(
      {
        method: 'GET',
        path: `${this.root()}/balance`,
        query: { currency: opts.currency }
      },
      withActingUser(requestOpts, this.userId)
    );
    const balances = Array.isArray(response)
      ? response
      : expectObject(response, 'scoped wallet balance response').balances;
    if (!Array.isArray(balances)) {
      throw new Error('Invalid scoped wallet balance response: expected balances array');
    }
    return balances.map((balance, index) =>
      normalizeWalletBalance(balance, `scoped wallet balance response.balances[${index}]`)
    );
  }

  /**
   * Lists active escrow holds against this end-user's balances.
   *
   * @param opts - Filters: `currency`, `limit`.
   * @param requestOpts - Per-request transport overrides.
   * @returns Array of wallet holds.
   */
  async getHolds(
    opts: { currency?: string; limit?: number } = {},
    requestOpts: RequestOptions = {}
  ): Promise<ScopedWalletHold[]> {
    // Server returns {holds: [...]} envelope; extract the array.
    const response = await this.http.request<unknown>(
      {
        method: 'GET',
        path: `${this.root()}/holds`,
        query: { currency: opts.currency, limit: opts.limit }
      },
      withActingUser(requestOpts, this.userId)
    );
    const holds = Array.isArray(response)
      ? response
      : expectObject(response, 'scoped wallet holds response').holds;
    if (!Array.isArray(holds)) {
      throw new Error('Invalid scoped wallet holds response: expected holds array');
    }
    return holds.map((hold, index) =>
      normalizeWalletHold(hold, `scoped wallet holds response.holds[${index}]`)
    );
  }

  /**
   * Lists ledger entries for this end-user.
   *
   * @param opts - Filters: `currency`, `from`, `to`, pagination.
   * @param requestOpts - Per-request transport overrides.
   * @returns Paginated ledger entries with `hasMore` indicator.
   */
  async getLedger(
    opts: ListLedgerOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<ListLedgerResponse> {
    return this.http.request<ListLedgerResponse>(
      {
        method: 'GET',
        path: `${this.root()}/ledger`,
        query: {
          currency: opts.currency,
          from: opts.from,
          to: opts.to,
          limit: opts.limit,
          cursor: opts.cursor
        }
      },
      withActingUser(requestOpts, this.userId)
    );
  }

  /**
   * Transfers funds between two end-users of the same parent platform.
   *
   * The gateway rejects the call when the destination userId belongs to
   * a different parentMerchantId; cross-tenant transfers are not allowed.
   *
   * @param input - Destination userId, amount (decimal string), currency, optional idempotency key.
   * @param opts - Per-request transport overrides.
   * @returns Transfer result with ledger ids and settled balances.
   * @throws ValidationError when amount or destination fails server-side checks.
   * @throws NotFoundError on cross-tenant attempts. The server answers as if
   * the destination did not exist, so the response cannot confirm that a
   * userId is live on another tenant.
   */
  async transfer(input: TransferInput, opts: RequestOptions = {}): Promise<TransferResult> {
    const merged = withActingUser(opts, this.userId);
    if (input.idempotencyKey !== undefined && merged.idempotencyKey === undefined) {
      merged.idempotencyKey = input.idempotencyKey;
    }
    const { idempotencyKey: _drop, ...body } = input;
    return this.http.request<TransferResult>(
      {
        method: 'POST',
        path: `${this.root()}/transfer`,
        body
      },
      merged
    );
  }

  /**
   * Withdraws funds from this end-user's wallet to an external address.
   *
   * @param input - Destination address, amount, currency, network, optional idempotency key.
   * @param opts - Per-request transport overrides.
   * @returns Withdrawal result with txnId and status.
   * @throws ValidationError when amount, network, or address fails server-side checks.
   */
  async withdraw(input: WithdrawInput, opts: RequestOptions = {}): Promise<WithdrawResult> {
    const merged = withActingUser(opts, this.userId);
    if (input.idempotencyKey !== undefined && merged.idempotencyKey === undefined) {
      merged.idempotencyKey = input.idempotencyKey;
    }
    const { idempotencyKey: _drop, ...body } = input;
    return this.http.request<WithdrawResult>(
      {
        method: 'POST',
        path: `${this.root()}/withdraw`,
        body
      },
      merged
    );
  }

  /**
   * Returns a deposit address for this end-user on the requested network.
   *
   * Addresses are HD-derived and persisted across calls; repeated calls
   * return the same address. `network` is required and has no default, and the
   * returned `network` always describes the address that came back: a request
   * the platform cannot serve on that chain fails rather than answering with an
   * address from another one.
   *
   * ERC20 and BEP20 return the same 0x address, since both are EVM chains
   * derived from one key. TRC20 returns a different address.
   *
   * Sharing one address does not make the two interchangeable. Asking for the
   * network the end-user will actually send on is what puts the address under
   * that chain's deposit monitoring, so an address obtained for ERC20 and then
   * presented for a BEP20 deposit is not watched and the deposit is not
   * credited until it is reconciled by hand. Call once per network offered.
   *
   * @param input - `currency` (USDT only) and the required `network`.
   * @param opts - Per-request transport overrides.
   * @returns Deposit address for the requested network.
   */
  async getDepositAddress(
    input: DepositAddressInput,
    opts: RequestOptions = {}
  ): Promise<DepositAddress> {
    return this.http.request<DepositAddress>(
      {
        method: 'GET',
        path: `${this.root()}/deposit-address`,
        query: { currency: input.currency, network: input.network }
      },
      withActingUser(opts, this.userId)
    );
  }
}

// Per-end-user payment methods. merchant-service currently exposes this as a
// read-only surface; mutations are intentionally absent until routes ship.
export class ScopedPaymentMethodsResource {
  constructor(
    private readonly http: HttpTransport,
    private readonly userId: string
  ) {}

  /**
   * Lists this end-user's payment methods.
   *
   * @param opts - Per-request transport overrides.
   * @returns Array of payment methods (account numbers masked).
   */
  async list(opts: RequestOptions = {}): Promise<ScopedPaymentMethod[]> {
    // Server returns {methods: [...]} envelope; extract the array.
    const response = await this.http.request<unknown>(
      { method: 'GET', path: '/api/v1/merchant/payment-methods' },
      withActingUser(opts, this.userId)
    );
    const methods = Array.isArray(response)
      ? response
      : expectObject(response, 'scoped payment methods response').methods;
    if (!Array.isArray(methods)) {
      throw new Error('Invalid scoped payment methods response: expected methods array');
    }
    return methods.map((method, index) =>
      normalizePaymentMethod(method, `scoped payment methods response.methods[${index}]`)
    );
  }

}

// White-label KYC orchestration. start() returns a hosted page URL that the
// platform redirects its end-user to; the vendor calls back into
// merchant-service which then emits merchant.user.kyc_updated webhooks.
export class ScopedKycResource {
  constructor(
    private readonly http: HttpTransport,
    private readonly userId: string
  ) {}

  /**
   * Starts a white-labelled KYC flow for this end-user.
   *
   * Returns both ways in, and you pick. Redirect the end-user to
   * `hostedPageUrl`, or embed the vendor widget yourself with `sdkToken`.
   * The vendor calls back into merchant-service, which emits
   * `merchant.user.kyc_updated` webhooks on each status change.
   *
   * @param input - KYC level, locale, and any vendor-specific options.
   * @param opts - Per-request transport overrides.
   * @returns Hosted-page URL, an embeddable token, and provider correlation ids.
   */
  async start(input: StartKycInput, opts: RequestOptions = {}): Promise<StartKycResponse> {
    return this.http.request<StartKycResponse>(
      {
        method: 'POST',
        path: `${BASE}/${encodeURIComponent(this.userId)}/kyc/start`,
        body: input
      },
      withActingUser(opts, this.userId)
    );
  }

  /**
   * Returns the current KYC status for this end-user.
   *
   * @param opts - Per-request transport overrides.
   * @returns KYC level, status, and provider metadata.
   */
  async get(opts: RequestOptions = {}): Promise<KycStatus> {
    return this.http.request<KycStatus>(
      {
        method: 'GET',
        path: `${BASE}/${encodeURIComponent(this.userId)}/kyc`
      },
      withActingUser(opts, this.userId)
    );
  }
}

// Per-user marketplace publishing toggle. Eligibility is computed by the
// server from the user's KYC level and the tenant's saasConfig; enable() is
// rejected with 409 MARKETPLACE_NOT_ELIGIBLE until eligibility flips true.
// Disable is always permitted (idempotent off-switch).
//
// PATCH carries a body of {publishEnabled: boolean}. The server normalises
// to enable/disable so the SDK exposes both verbs for ergonomics; both call
// the same PATCH route under the hood.
export class ScopedMarketplaceResource {
  constructor(
    private readonly http: HttpTransport,
    private readonly userId: string
  ) {}

  private root(): string {
    return `${BASE}/${encodeURIComponent(this.userId)}/marketplace`;
  }

  /**
   * Returns marketplace eligibility and the current publish state.
   *
   * Cacheable for ~30 seconds at the consumer layer; eligibility flips
   * are rare.
   *
   * @param opts - Per-request transport overrides.
   * @returns Marketplace state including `eligible`, `publishEnabled`, and `reason` when ineligible.
   */
  async get(opts: RequestOptions = {}): Promise<PlatformMarketplaceState> {
    return this.http.request<PlatformMarketplaceState>(
      { method: 'GET', path: this.root() },
      withActingUser(opts, this.userId)
    );
  }

  /**
   * Enables marketplace publishing for this end-user.
   *
   * Calls PATCH with `publishEnabled: true`. Returns 409
   * `MARKETPLACE_NOT_ELIGIBLE` when the precondition is unmet; callers
   * should invoke `get()` first and surface `result.reason`.
   *
   * @param opts - Per-request transport overrides.
   * @returns Enable result with new publish state.
   * @throws PlatformMarketplaceNotEligibleError when eligibility is false.
   */
  async enable(opts: RequestOptions = {}): Promise<MarketplaceEnableResult> {
    return this.http.request<MarketplaceEnableResult>(
      { method: 'PATCH', path: this.root(), body: { publishEnabled: true } },
      withActingUser(opts, this.userId)
    );
  }

  /**
   * Disables marketplace publishing for this end-user.
   *
   * Idempotent: always succeeds even when the user has never been published.
   *
   * @param opts - Per-request transport overrides.
   * @returns Disable result with new publish state.
   */
  async disable(opts: RequestOptions = {}): Promise<MarketplaceDisableResult> {
    return this.http.request<MarketplaceDisableResult>(
      { method: 'PATCH', path: this.root(), body: { publishEnabled: false } },
      withActingUser(opts, this.userId)
    );
  }
}

// Per-end-user market reads. my-rank ranks one order against its competitors
// and the order belongs to an end-user, so the server classifies it as a
// per-user route and refuses it without an acting user. The pair-keyed
// endpoints (best-prices, active-ads, reference-price) return the same answer
// for every caller and are reached through client.market instead.
export class ScopedMarketResource {
  constructor(
    private readonly http: HttpTransport,
    private readonly userId: string
  ) {}

  /**
   * Returns this end-user's marketplace rank for one of their orders.
   *
   * @param orderId - An order belonging to this end-user.
   * @param opts - Per-request transport overrides.
   * @returns Rank info with position, competitor count, and score factors.
   * @throws NotImplementedError when the endpoint is still stubbed.
   * @throws NotFoundError when the order id is unknown.
   * @example
   * const rank = await client.platform.users('user_abc').market.getMyRank('order_1');
   */
  async getMyRank(orderId: string, opts: RequestOptions = {}): Promise<RankInfo> {
    return this.http.request<RankInfo>(
      {
        method: 'GET',
        path: `/api/v1/merchant/market/my-rank/${encodeURIComponent(orderId)}`
      },
      withActingUser(opts, this.userId)
    );
  }
}

function normalizeOrderPage(raw: unknown, requestedLimit: number | undefined): Paginated<Order> {
  if (Array.isArray(raw)) {
    const items = raw.map((item, index) => normalizeOrder(item, `list scoped orders response[${index}]`));
    const hasMore = requestedLimit !== undefined ? items.length >= requestedLimit : false;
    return { items, hasMore };
  }
  const page = expectObject(raw, 'list scoped orders response');
  if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean') {
    throw new Error('Invalid list scoped orders response: expected items array and hasMore boolean');
  }
  const nextCursor = optionalString(page.nextCursor, 'list scoped orders response.nextCursor');
  return {
    items: page.items.map((item, index) =>
      normalizeOrder(item, `list scoped orders response.items[${index}]`)
    ),
    hasMore: page.hasMore,
    ...(nextCursor !== undefined ? { nextCursor } : {})
  };
}

function normalizeTradePage(raw: unknown, requestedLimit: number | undefined): Paginated<Trade> {
  if (Array.isArray(raw)) {
    const items = raw.map((item, index) => normalizeTrade(item, `list scoped trades response[${index}]`));
    const hasMore = requestedLimit !== undefined ? items.length >= requestedLimit : false;
    return { items, hasMore };
  }
  const page = expectObject(raw, 'list scoped trades response');
  if (!Array.isArray(page.items) || typeof page.hasMore !== 'boolean') {
    throw new Error('Invalid list scoped trades response: expected items array and hasMore boolean');
  }
  const nextCursor = optionalString(page.nextCursor, 'list scoped trades response.nextCursor');
  return {
    items: page.items.map((item, index) =>
      normalizeTrade(item, `list scoped trades response.items[${index}]`)
    ),
    hasMore: page.hasMore,
    ...(nextCursor !== undefined ? { nextCursor } : {})
  };
}

function normalizeMessagePage(raw: unknown, tradeId: string): ListMessagesResponse {
  const page = expectObject(raw, 'list scoped messages response');
  if (!Array.isArray(page.messages) || typeof page.hasMore !== 'boolean') {
    throw new Error('Invalid list scoped messages response: expected messages array and hasMore boolean');
  }
  const nextCursor = optionalString(page.nextCursor, 'list scoped messages response.nextCursor');
  const oldestMessageId = optionalString(
    page.oldestMessageId,
    'list scoped messages response.oldestMessageId'
  );
  return {
    messages: page.messages.map((message, index) =>
      normalizeMessage(message, tradeId, `list scoped messages response.messages[${index}]`)
    ),
    hasMore: page.hasMore,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
    ...(oldestMessageId !== undefined ? { oldestMessageId } : {})
  };
}
