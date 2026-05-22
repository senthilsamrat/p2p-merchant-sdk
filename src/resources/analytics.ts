// Analytics resource. /api/v1/merchant/analytics/stats.

import type { HttpTransport } from '../transport/httpTransport.js';
import type { AnalyticsStats, RequestOptions } from '../types/common.js';

const BASE = '/api/v1/merchant/analytics';

export interface AnalyticsStatsOptions {
  window?: '7d' | '30d' | '90d';
  from?: string;
  to?: string;
  granularity?: 'hour' | 'day' | 'week';
}

export class AnalyticsResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Fetches time-series merchant performance metrics.
   *
   * Provide either a preset `window` (e.g., `30d`) or an explicit
   * `from`/`to` ISO timestamp pair. When neither is set the server picks
   * a sensible default. `granularity` controls bucket size.
   *
   * @param opts - Window, range, and granularity selectors.
   * @param requestOpts - Per-request transport overrides.
   * @returns Aggregated stats and per-bucket time-series.
   * @example
   * const stats = await client.analytics.getStats({
   *   window: '30d',
   *   granularity: 'day'
   * });
   */
  async getStats(
    opts: AnalyticsStatsOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<AnalyticsStats> {
    return this.http.request<AnalyticsStats>(
      {
        method: 'GET',
        path: `${BASE}/stats`,
        query: {
          window: opts.window,
          from: opts.from,
          to: opts.to,
          granularity: opts.granularity
        }
      },
      requestOpts
    );
  }
}
