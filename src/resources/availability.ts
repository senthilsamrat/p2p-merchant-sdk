// Express availability. PATCH /api/v1/merchant/availability.

import type { HttpTransport } from '../transport/httpTransport.js';
import type { AvailabilityResponse, RequestOptions } from '../types/common.js';

const BASE = '/api/v1/merchant';

export class AvailabilityResource {
  constructor(private readonly http: HttpTransport) {}

  /**
   * Toggles Express-pool participation for the calling merchant.
   *
   * The server gates enabling on merchant tier (Professional or higher)
   * and verified KYC. Disabling is always permitted.
   *
   * @param input - `{ available: boolean }` flag.
   * @param opts - Per-request transport overrides.
   * @returns The new availability state and timestamp.
   * @throws PermissionDeniedError when tier or KYC checks fail on enable.
   * @example
   * await client.availability.update({ available: true });
   */
  async update(
    input: { available: boolean },
    opts: RequestOptions = {}
  ): Promise<AvailabilityResponse> {
    return this.http.request<AvailabilityResponse>(
      { method: 'PATCH', path: `${BASE}/availability`, body: input },
      opts
    );
  }
}
