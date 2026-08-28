// Webhook configuration resource. /api/v1/merchant/webhooks/*

import type { HttpTransport } from '../transport/httpTransport.js';
import type {
  Paginated,
  RequestOptions,
  UpdateWebhookConfigInput,
  WebhookConfig,
  WebhookLogEntry
} from '../types/common.js';

const BASE = '/api/v1/merchant/webhooks';

export class WebhooksResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Returns the current webhook configuration.
   *
   * @param opts - Per-request transport overrides.
   * @returns Webhook delivery URL, subscribed event filters, and status.
   */
  async getConfig(opts: RequestOptions = {}): Promise<WebhookConfig> {
    return this.http.request<WebhookConfig>(
      { method: 'GET', path: `${BASE}/config` },
      opts
    );
  }

  /**
   * Updates the webhook configuration.
   *
   * Replaces the entire configuration; pass the full desired state.
   *
   * @param input - Webhook URL, subscribed events, and any enable flag.
   * @param opts - Per-request transport overrides.
   * @returns The updated webhook configuration.
   * @throws ValidationError when the URL fails SSRF checks or event names are unknown.
   */
  async updateConfig(
    input: UpdateWebhookConfigInput,
    opts: RequestOptions = {}
  ): Promise<WebhookConfig> {
    return this.http.request<WebhookConfig>(
      { method: 'PUT', path: `${BASE}/config`, body: input },
      opts
    );
  }

  /**
   * Regenerates the webhook signing secret.
   *
   * The new secret is returned ONCE. The SDK does not persist it; callers
   * must store the value in a durable secret manager before the next call
   * or webhook signatures will fail to verify.
   *
   * @param opts - Per-request transport overrides.
   * @returns Object with the new `secret` value.
   */
  async regenerateSecret(opts: RequestOptions = {}): Promise<{ secret: string }> {
    // The server refuses a rotation that does not carry an explicit
    // acknowledgement, because it invalidates every signature the
    // merchant's receivers are currently verifying. Calling this method is
    // that acknowledgement, so the flag is sent on the caller's behalf
    // rather than surfaced as an argument they could omit and be confused by.
    return this.http.request<{ secret: string }>(
      {
        method: 'POST',
        path: `${BASE}/regenerate-secret`,
        body: { confirmRegenerate: true }
      },
      opts
    );
  }

  /**
   * Lists recent webhook delivery attempts.
   *
   * @param opts - Filters: `limit` and `status` (e.g., `delivered`, `failed`).
   * @param requestOpts - Per-request transport overrides.
   * @returns A page of delivery log entries with `hasMore` indicator.
   */
  async getLogs(
    opts: { limit?: number; status?: string } = {},
    requestOpts: RequestOptions = {}
  ): Promise<Paginated<WebhookLogEntry>> {
    const raw = await this.http.request<WebhookLogEntry[] | Paginated<WebhookLogEntry>>(
      {
        method: 'GET',
        path: `${BASE}/logs`,
        query: { limit: opts.limit, status: opts.status }
      },
      requestOpts
    );
    if (Array.isArray(raw)) {
      const hasMore = opts.limit !== undefined ? raw.length >= opts.limit : false;
      return { items: raw, hasMore };
    }
    return raw;
  }

  /**
   * Returns the list of event names the platform can deliver.
   *
   * Use the values from this list when building `updateConfig.events`.
   *
   * @param opts - Per-request transport overrides.
   * @returns Array of allowed event-name strings.
   */
  async getAllowedEvents(opts: RequestOptions = {}): Promise<string[]> {
    // The service wraps this list the way its sibling webhook routes wrap
    // theirs, so both shapes are accepted rather than assuming the bare array.
    const raw = await this.http.request<string[] | { events: string[] }>(
      { method: 'GET', path: `${BASE}/allowed-events` },
      opts
    );
    if (Array.isArray(raw)) {
      return raw;
    }
    return Array.isArray(raw?.events) ? raw.events : [];
  }

  /**
   * Sends a synthetic test event to the configured webhook URL.
   *
   * The server endpoint may still be stubbed and return 501; the SDK
   * surface stays so consumers can wire calls today and benefit when the
   * helper ships without an SDK upgrade.
   *
   * @param eventType - Event name to simulate (e.g., `trade.completed`).
   * @param payload - Optional payload body to deliver.
   * @param opts - Per-request transport overrides.
   * @returns Delivery result with `delivered` flag and optional `statusCode`.
   * @throws NotImplementedError when the endpoint is still stubbed.
   */
  async test(
    eventType: string,
    payload: unknown = {},
    opts: RequestOptions = {}
  ): Promise<{ delivered: boolean; statusCode?: number }> {
    return this.http.request(
      {
        method: 'POST',
        path: `${BASE}/test`,
        body: { eventType, payload }
      },
      opts
    );
  }
}
