// Revshare resource for SaaS platforms. Surfaces the adapted
// endpoints under /api/v1/merchant/revshare/*. Configuration changes go
// through a proposal workflow; reporting endpoints expose earnings,
// rewards, payouts, and reconciliation findings.

import type { HttpTransport } from '../../transport/httpTransport.js';
import type { RequestOptions } from '../../types/common.js';
import type {
  ConfigProposal,
  ConfigHistoryPage,
  ConfigProposalsPage,
  CreateConfigProposalResponse,
  GetEarningsOptions,
  ListConfigHistoryOptions,
  ListPayoutsOptions,
  ListProposalsOptions,
  ListRewardsOptions,
  PreviewConfigInput,
  PreviewConfigResponse,
  ProposeConfigChangeInput,
  ReconciliationResponse,
  RevshareConfig,
  RevshareEarnings,
  RevsharePayout,
  RevsharePayoutsPage,
  RevshareRewardsPage,
  RevshareWebhookTestResult
} from './types.js';

const BASE = '/api/v1/merchant/revshare';

export class RevshareResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Returns the active revshare configuration for the calling SaaS platform.
   *
   * @param opts - Per-request transport overrides.
   * @returns The current config, or a `configured: false` shell when no config exists.
   */
  async getConfig(opts: RequestOptions = {}): Promise<RevshareConfig> {
    return this.http.request<RevshareConfig>(
      { method: 'GET', path: `${BASE}/config` },
      opts
    );
  }

  /**
   * Lists historical revshare configurations.
   *
   * @param opts - Pagination: `limit` and `cursor`.
   * @param requestOpts - Per-request transport overrides.
   * @returns A page of past configurations ordered newest-first.
   */
  async getConfigHistory(
    opts: ListConfigHistoryOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<ConfigHistoryPage> {
    return this.http.request<ConfigHistoryPage>(
      {
        method: 'GET',
        path: `${BASE}/config/history`,
        query: { limit: opts.limit, cursor: opts.cursor }
      },
      requestOpts
    );
  }

  /**
   * Previews the financial impact of a proposed config change without applying it.
   *
   * Useful before submitting a proposal to surface revenue deltas to the
   * platform owner.
   *
   * @param input - Hypothetical config + the window to simulate.
   * @param opts - Per-request transport overrides.
   * @returns Projected earnings deltas vs. the current config.
   */
  async previewConfig(
    input: PreviewConfigInput,
    opts: RequestOptions = {}
  ): Promise<PreviewConfigResponse> {
    return this.http.request<PreviewConfigResponse>(
      { method: 'POST', path: `${BASE}/config/preview`, body: input },
      opts
    );
  }

  /**
   * Submits a config-change proposal.
   *
   * Small changes may be auto-applied; material changes go through an
   * admin-approval workflow. Inspect `autoApplied` on the result.
   *
   * @param input - Proposed config delta + justification text.
   * @param opts - Per-request transport overrides.
   * @returns Proposal id and initial status.
   */
  async createProposal(
    input: ProposeConfigChangeInput,
    opts: RequestOptions = {}
  ): Promise<CreateConfigProposalResponse> {
    return this.http.request<CreateConfigProposalResponse>(
      { method: 'POST', path: `${BASE}/config/proposals`, body: input },
      opts
    );
  }

  /**
   * Lists revshare config proposals.
   *
   * @param opts - Filters: `status`, pagination `limit` and `cursor`.
   * @param requestOpts - Per-request transport overrides.
   * @returns A page of proposals ordered newest-first.
   */
  async listProposals(
    opts: ListProposalsOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<ConfigProposalsPage> {
    return this.http.request<ConfigProposalsPage>(
      {
        method: 'GET',
        path: `${BASE}/config/proposals`,
        query: {
          status: opts.status,
          limit: opts.limit,
          cursor: opts.cursor
        }
      },
      requestOpts
    );
  }

  /**
   * Fetches a single proposal by id.
   *
   * @param proposalId - Proposal identifier.
   * @param opts - Per-request transport overrides.
   * @returns The proposal record with status, payload, reviewer history.
   * @throws NotFoundError when the proposal id is unknown.
   */
  async getProposal(proposalId: string, opts: RequestOptions = {}): Promise<ConfigProposal> {
    return this.http.request<ConfigProposal>(
      {
        method: 'GET',
        path: `${BASE}/config/proposals/${encodeURIComponent(proposalId)}`
      },
      opts
    );
  }

  /**
   * Withdraws a proposal before it is approved or rejected.
   *
   * @param proposalId - Proposal identifier.
   * @param opts - Per-request transport overrides.
   * @returns `{ status: 'withdrawn' }`.
   */
  async withdrawProposal(
    proposalId: string,
    opts: RequestOptions = {}
  ): Promise<{ proposalId: string; status: 'withdrawn' }> {
    return this.http.request<{ proposalId: string; status: 'withdrawn' }>(
      {
        method: 'DELETE',
        path: `${BASE}/config/proposals/${encodeURIComponent(proposalId)}`
      },
      opts
    );
  }

  /**
   * Returns aggregated revshare earnings for a date range.
   *
   * @param opts - Filters: `from`, `to` (ISO timestamps), `currency`.
   * @param requestOpts - Per-request transport overrides.
   * @returns Earnings totals and per-bucket breakdown.
   */
  async getEarnings(
    opts: GetEarningsOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<RevshareEarnings> {
    return this.http.request<RevshareEarnings>(
      {
        method: 'GET',
        path: `${BASE}/earnings`,
        query: { from: opts.from, to: opts.to }
      },
      requestOpts
    );
  }

  /**
   * Lists per-trade revshare rewards.
   *
   * @param opts - Filters: `from`, `to`, pagination `limit` and `cursor`.
   * @param requestOpts - Per-request transport overrides.
   * @returns A page of reward records ordered newest-first.
   */
  async listRewards(
    opts: ListRewardsOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<RevshareRewardsPage> {
    // Per-trade rewards live under the /earnings sub-tree on the
    // merchant-service; the route is mounted at
    // /api/v1/merchant/revshare/earnings/rewards. Keeping the path here
    // aligned with the server mount so SaaS integrators do not have to
    // discover the extra /earnings segment by trial and error.
    return this.http.request<RevshareRewardsPage>(
      {
        method: 'GET',
        path: `${BASE}/earnings/rewards`,
        query: {
          from: opts.from,
          to: opts.to,
          limit: opts.limit,
          cursor: opts.cursor
        }
      },
      requestOpts
    );
  }

  /**
   * Lists revshare payout batches.
   *
   * @param opts - Pagination `limit` and `cursor`.
   * @param requestOpts - Per-request transport overrides.
   * @returns A page of payout records ordered newest-first.
   */
  async listPayouts(
    opts: ListPayoutsOptions = {},
    requestOpts: RequestOptions = {}
  ): Promise<RevsharePayoutsPage> {
    return this.http.request<RevsharePayoutsPage>(
      {
        method: 'GET',
        path: `${BASE}/payouts`,
        query: {
          limit: opts.limit,
          cursor: opts.cursor
        }
      },
      requestOpts
    );
  }

  /**
   * Fetches a single payout batch by id.
   *
   * @param payoutId - Payout batch identifier.
   * @param opts - Per-request transport overrides.
   * @returns The payout record with line items and settlement state.
   * @throws NotFoundError when the payout id is unknown.
   */
  async getPayout(payoutId: string, opts: RequestOptions = {}): Promise<RevsharePayout> {
    return this.http.request<RevsharePayout>(
      {
        method: 'GET',
        path: `${BASE}/payouts/${encodeURIComponent(payoutId)}`
      },
      opts
    );
  }

  /**
   * Returns open reconciliation findings against revshare books.
   *
   * Each finding is a discrepancy between ledger sub-totals and the
   * commission engine's expected splits. Investigate any non-empty result.
   *
   * @param opts - Per-request transport overrides.
   * @returns A `findings` envelope (with an empty array when books balance).
   */
  async getReconciliation(opts: RequestOptions = {}): Promise<ReconciliationResponse> {
    return this.http.request<ReconciliationResponse>(
      { method: 'GET', path: `${BASE}/reconciliation` },
      opts
    );
  }

  /**
   * Sends a synthetic revshare webhook to the configured URL.
   *
   * Useful to validate signature verification on the consumer side.
   *
   * @param opts - Per-request transport overrides.
   * @returns Delivery result with status code and response body.
   */
  async testWebhook(opts: RequestOptions = {}): Promise<RevshareWebhookTestResult> {
    return this.http.request<RevshareWebhookTestResult>(
      { method: 'POST', path: `${BASE}/webhooks/test` },
      opts
    );
  }
}
