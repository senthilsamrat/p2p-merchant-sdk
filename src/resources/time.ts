// Server time + clock-drift sampler. GET /api/v1/merchant/time is a public
// endpoint that does NOT require API key or signature. SDK uses it at boot
// to calibrate clock skew before signing any HMAC request.

import type { HttpTransport } from '../transport/httpTransport.js';
import type { ClockDriftTracker } from '../transport/recvWindow.js';
import type { ClockDriftSample, RequestOptions, ServerTime } from '../types/common.js';

const PATH = '/api/v1/merchant/time';

export class TimeResource {
  constructor(
    private readonly http: HttpTransport,
    private readonly clock: ClockDriftTracker
  ) {}

  /**
   * Returns the server's current wall-clock time.
   *
   * This is the only documented unsigned endpoint; the request goes out
   * without HMAC headers.
   *
   * @param opts - Per-request transport overrides.
   * @returns Object with the server's ISO timestamp and epoch millis.
   */
  async getServerTime(opts: RequestOptions = {}): Promise<ServerTime> {
    return this.http.request<ServerTime>(
      { method: 'GET', path: PATH },
      { ...opts, unsigned: true }
    );
  }

  /**
   * Samples the server clock and persists the median drift estimate.
   *
   * Performed once at SDK construction (configurable via
   * `skipInitialClockSample`). Call manually after long client-side sleeps
   * or VM suspensions to keep signed timestamps inside `recvWindow`.
   *
   * @param samples - Number of probe requests to take the median over (default 5).
   * @returns The persisted ClockDriftSample with median offset and round-trip time.
   * @example
   * const sample = await client.time.sampleClockDrift();
   * console.log('drift ms:', sample.driftMs);
   */
  async sampleClockDrift(samples = 5): Promise<ClockDriftSample> {
    const result = await this.clock.sample(this.http.rawAxios(), PATH, samples);
    return result;
  }
}
