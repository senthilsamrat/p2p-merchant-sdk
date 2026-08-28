// Market data resource. /api/v1/merchant/market/*
// best-prices is live; some endpoints may return 501 NotImplementedError
// until the underlying market-data backend ships. The SDK surfaces the
// typed error so consumers can branch on `instanceof NotImplementedError`.

import type { HttpTransport } from '../transport/httpTransport.js';
import type {
  BestPrices,
  MarketAd,
  RankInfo,
  ReferencePrice,
  RequestOptions
} from '../types/common.js';
import { normalizeBestPrices } from '../utils/response.js';

const BASE = '/api/v1/merchant/market';

export class MarketResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Returns the best buy/sell prices for an asset/fiat pair.
   *
   * @param crypto - Crypto asset ticker (e.g., `USDT`).
   * @param fiat - Fiat currency code (e.g., `KRW`).
   * @param opts - Per-request transport overrides.
   * @returns Best buy and sell prices with associated merchant tier.
   * @example
   * const prices = await client.market.getBestPrices('USDT', 'KRW');
   * console.log(prices.bestBuy, prices.bestSell);
   */
  async getBestPrices(
    crypto: string,
    fiat: string,
    opts: RequestOptions = {}
  ): Promise<BestPrices> {
    const response = await this.http.request<unknown>(
      {
        method: 'GET',
        path: `${BASE}/best-prices/${encodeURIComponent(crypto)}/${encodeURIComponent(fiat)}`
      },
      opts
    );
    return normalizeBestPrices(response);
  }

  /**
   * Lists active marketplace ads for an asset/fiat pair.
   *
   * @param crypto - Crypto asset ticker.
   * @param fiat - Fiat currency code.
   * @param opts - Required side (`type`: `buy`/`sell`) and optional `limit`.
   * @param requestOpts - Per-request transport overrides.
   * @returns Array of active marketplace ads.
   * @throws NotImplementedError when the endpoint is still stubbed.
   */
  async getActiveAds(
    crypto: string,
    fiat: string,
    opts: { type: 'buy' | 'sell'; limit?: number },
    requestOpts: RequestOptions = {}
  ): Promise<MarketAd[]> {
    return this.http.request<MarketAd[]>(
      {
        method: 'GET',
        path: `${BASE}/active-ads/${encodeURIComponent(crypto)}/${encodeURIComponent(fiat)}`,
        query: { type: opts.type, limit: opts.limit }
      },
      requestOpts
    );
  }

  /**
   * Returns the platform reference price for an asset/fiat pair.
   *
   * Useful for pricing engines that need a server-derived mid-market rate.
   *
   * @param crypto - Crypto asset ticker.
   * @param fiat - Fiat currency code.
   * @param opts - Per-request transport overrides.
   * @returns Reference price with source attribution.
   * @throws NotImplementedError when the endpoint is still stubbed.
   */
  async getReferencePrice(
    crypto: string,
    fiat: string,
    opts: RequestOptions = {}
  ): Promise<ReferencePrice> {
    return this.http.request<ReferencePrice>(
      {
        method: 'GET',
        path: `${BASE}/reference-price/${encodeURIComponent(crypto)}/${encodeURIComponent(fiat)}`
      },
      opts
    );
  }

  /**
   * Returns the calling merchant's marketplace rank for a specific order.
   *
   * For a `scope=platform_users` key the order belongs to an end-user rather
   * than to the key holder, and the server refuses the call without an acting
   * user. Reach it as
   * `client.platform.users(userId).market.getMyRank(orderId)` instead.
   *
   * @param orderId - The merchant's order id to rank.
   * @param opts - Per-request transport overrides.
   * @returns Rank info with position, neighbouring offers, and competitive gap.
   * @throws NotImplementedError when the endpoint is still stubbed.
   * @throws NotFoundError when the order id is unknown.
   */
  async getMyRank(orderId: string, opts: RequestOptions = {}): Promise<RankInfo> {
    return this.http.request<RankInfo>(
      {
        method: 'GET',
        path: `${BASE}/my-rank/${encodeURIComponent(orderId)}`
      },
      opts
    );
  }
}
