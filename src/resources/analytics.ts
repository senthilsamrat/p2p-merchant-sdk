// Analytics resource. /api/v1/merchant/analytics/stats.

import type { HttpTransport } from '../transport/httpTransport.js';
import type { AnalyticsStats, RequestOptions } from '../types/common.js';
import { normalizeAnalyticsStats } from '../utils/response.js';

const BASE = '/api/v1/merchant/analytics';

export interface AnalyticsStatsOptions {
  window?: '7d' | '30d' | '90d';
}

export class AnalyticsResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Fetches time-series merchant performance metrics.
   *
   * Select a preset aggregate window. When omitted, the service uses `30d`.
   *
   * @param opts - Aggregate window selector.
   * @param requestOpts - Per-request transport overrides.
   * @returns Aggregated stats and per-bucket time-series.
   * @example
   * const stats = await client.analytics.getStats({ window: '30d' });
   */
  async getStats(
    opts: AnalyticsStatsOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<AnalyticsStats> {
    const response = await this.http.request<unknown>(
      {
        method: 'GET',
        path: `${BASE}/stats`,
        query: { window: opts.window }
      },
      requestOpts
    );
    return normalizeAnalyticsStats(response);
  }
}
