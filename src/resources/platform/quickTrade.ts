// SaaS quick-trade resources. Two surfaces:
// 1. ScopedQuickTradeResource: per-end-user matcher actions. Hits
//    /api/v1/merchant/users/:userId/quick/{best-match,initiate} and carries
//    X-PM-Acting-User: <userId> on every call so the gateway routes the
//    matcher request as if the end-user invoked it themselves.
// 2. PlatformQuickTradeResource: merchant-scope read-only browsing
//    endpoints under /api/v1/merchant/quick/*. HMAC only, no acting user.

import type { HttpTransport } from '../../transport/httpTransport.js';
import type { RequestOptions } from '../../types/common.js';
import type {
  QuickTradeBestMatch,
  QuickTradeBestMatchInput,
  QuickTradeFeaturedMerchant,
  QuickTradeFeaturedMerchantsInput,
  QuickTradeInitiateInput,
  QuickTradeInitiateResult,
  QuickTradePair,
  QuickTradePlatformStats,
  QuickTradeRecentActivity
} from './types.js';

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

// Per-end-user matcher operations. The gateway rejects calls whose
// X-PM-Acting-User does not equal the :userId in the path; the SDK
// constructs both sides from the same id so the gate is satisfied
// automatically when callers go through client.platform.users(uid).quickTrade.
export class ScopedQuickTradeResource {
  constructor(
    private readonly http: HttpTransport,
    private readonly userId: string
  ) {}

  private root(): string {
    // Path-segment order is /quick/users/:userId/... so the gateway
    // routes /api/v1/merchant/quick/* to trading-service. The reverse
    // form /users/:userId/quick/* would match the merchant-service
    // /users/* prefix and return 404 from the wrong upstream.
    return `/api/v1/merchant/quick/users/${encodeURIComponent(this.userId)}`;
  }

  /**
   * Finds the best counterparty for an end-user's quick-trade request.
   *
   * Hits GET .../quick/best-match with `X-PM-Acting-User` set. The server
   * returns a `{success, data: {...}}` envelope; the SDK extracts `data`
   * and aliases `order` to `matchedOrder` so callers can use either field.
   *
   * @param input - Pair (`cryptocurrency`, `fiatCurrency`), `type`, `amount`, optional `paymentMethod`.
   * @param opts - Per-request transport overrides.
   * @returns Best-match payload with merchant, order, quote, and priorityScore.
   * @throws NotFoundError when no eligible candidate exists for the requested triple.
   * @example
   * const match = await client.platform.users('user_abc').quickTrade.bestMatch({
   *   cryptocurrency: 'USDT',
   *   fiatCurrency: 'KRW',
   *   type: 'buy',
   *   amount: '100'
   * });
   */
  async bestMatch(
    input: QuickTradeBestMatchInput,
    opts: RequestOptions = {}
  ): Promise<QuickTradeBestMatch> {
    const envelope = await this.http.request<unknown>(
      {
        method: 'GET',
        path: `${this.root()}/best-match`,
        query: {
          cryptocurrency: input.cryptocurrency,
          fiatCurrency: input.fiatCurrency,
          type: input.type,
          amount: input.amount,
          paymentMethod: input.paymentMethod
        }
      },
      withActingUser(opts, this.userId)
    );
    return normalizeBestMatch(envelope);
  }

  /**
   * Locks a matched order and starts the trade-creation saga.
   *
   * Hits POST .../quick/initiate with `X-PM-Acting-User`. The SDK
   * auto-generates `Idempotency-Key` when the caller omits one.
   *
   * @param input - Match identifier + amounts from a prior `bestMatch()` call.
   * @param opts - Per-request transport overrides.
   * @returns Initiate result with the newly created `tradeId` and lock metadata.
   * @throws ValidationError when the match is stale or the order has been taken.
   * @throws IdempotencyConflictError when the same key is reused with a different body.
   */
  async initiate(
    input: QuickTradeInitiateInput,
    opts: RequestOptions = {}
  ): Promise<QuickTradeInitiateResult> {
    const merged = withActingUser(opts, this.userId);
    if (input.idempotencyKey !== undefined && merged.idempotencyKey === undefined) {
      merged.idempotencyKey = input.idempotencyKey;
    }
    const { idempotencyKey: _drop, ...body } = input;
    const envelope = await this.http.request<unknown>(
      {
        method: 'POST',
        path: `${this.root()}/initiate`,
        body
      },
      merged
    );
    return normalizeInitiateResult(envelope);
  }
}

// Merchant-scope read-only browsing. No acting user. SaaS platforms call
// these to render market widgets (pairs, featured merchants, recent
// activity, platform stats) directly from the merchant API without
// proxying through their own backend.
export class PlatformQuickTradeResource {
  constructor(private readonly http: HttpTransport) {}

  private root(): string {
    return '/api/v1/merchant/quick';
  }

  /**
   * Lists the supported quick-trade pairs for the calling platform.
   *
   * @param opts - Per-request transport overrides.
   * @returns Array of pair descriptors.
   */
  async pairs(opts: RequestOptions = {}): Promise<QuickTradePair[]> {
    const envelope = await this.http.request<unknown>(
      { method: 'GET', path: `${this.root()}/pairs` },
      opts
    );
    return extractDataArray<QuickTradePair>(envelope);
  }

  /**
   * Returns the featured-merchant carousel for a pair.
   *
   * @param input - Pair (`cryptocurrency`, `fiatCurrency`) to feature against.
   * @param opts - Per-request transport overrides.
   * @returns Array of featured-merchant descriptors.
   */
  async featuredMerchants(
    input: QuickTradeFeaturedMerchantsInput,
    opts: RequestOptions = {}
  ): Promise<QuickTradeFeaturedMerchant[]> {
    const envelope = await this.http.request<unknown>(
      {
        method: 'GET',
        path: `${this.root()}/featured-merchants`,
        query: {
          cryptocurrency: input.cryptocurrency,
          fiatCurrency: input.fiatCurrency
        }
      },
      opts
    );
    return extractDataArray<QuickTradeFeaturedMerchant>(envelope);
  }

  /**
   * Returns recent platform trade activity for marketing widgets.
   *
   * @param opts - Per-request transport overrides.
   * @returns Array of recent-activity entries.
   */
  async recentActivity(opts: RequestOptions = {}): Promise<QuickTradeRecentActivity[]> {
    const envelope = await this.http.request<unknown>(
      { method: 'GET', path: `${this.root()}/recent-activity` },
      opts
    );
    return extractDataArray<QuickTradeRecentActivity>(envelope);
  }

  /**
   * Returns aggregated platform stats (24h volume, online merchants).
   *
   * @param opts - Per-request transport overrides.
   * @returns Platform stats object.
   */
  async platformStats(opts: RequestOptions = {}): Promise<QuickTradePlatformStats> {
    const envelope = await this.http.request<unknown>(
      { method: 'GET', path: `${this.root()}/platform-stats` },
      opts
    );
    return extractDataObject<QuickTradePlatformStats>(envelope);
  }
}

// Best-match envelope normaliser. Server returns one of:
//   {success: true, data: {merchant, order, quote, priorityScore}}
//   {merchant, order, quote, priorityScore}
// The SDK extracts the inner shape and aliases `order` to `matchedOrder`
// so callers can reach the matched order via either field.
function normalizeBestMatch(raw: unknown): QuickTradeBestMatch {
  const inner = unwrapEnvelope(raw) as Partial<QuickTradeBestMatch> | null | undefined;
  if (!inner || typeof inner !== 'object') {
    throw new Error('quickTrade.bestMatch: empty response from server');
  }
  const order = inner.order ?? inner.matchedOrder;
  if (!order) {
    throw new Error('quickTrade.bestMatch: missing order in response');
  }
  return {
    merchant: inner.merchant as QuickTradeBestMatch['merchant'],
    order,
    matchedOrder: order,
    quote: inner.quote as QuickTradeBestMatch['quote'],
    priorityScore: typeof inner.priorityScore === 'number' ? inner.priorityScore : 0
  };
}

// Initiate envelope normaliser. Server returns either {success, data: {...}}
// or the bare result. The SDK extracts the inner result either way.
function normalizeInitiateResult(raw: unknown): QuickTradeInitiateResult {
  const inner = unwrapEnvelope(raw) as Partial<QuickTradeInitiateResult> | null | undefined;
  if (!inner || typeof inner !== 'object') {
    throw new Error('quickTrade.initiate: empty response from server');
  }
  if (typeof inner.tradeId !== 'string' || inner.tradeId.length === 0) {
    throw new Error('quickTrade.initiate: missing tradeId in response');
  }
  return inner as QuickTradeInitiateResult;
}

// Generic envelope unwrap. {success, data} -> data; bare object -> object.
function unwrapEnvelope(raw: unknown): unknown {
  if (raw && typeof raw === 'object' && 'data' in (raw as Record<string, unknown>)) {
    return (raw as { data: unknown }).data;
  }
  return raw;
}

function extractDataArray<T>(raw: unknown): T[] {
  const inner = unwrapEnvelope(raw);
  if (Array.isArray(inner)) return inner as T[];
  return [];
}

function extractDataObject<T>(raw: unknown): T {
  const inner = unwrapEnvelope(raw);
  if (inner && typeof inner === 'object') return inner as T;
  return {} as T;
}
