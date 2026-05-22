// Client-side clock-drift sampler. The server enforces a recvWindow so the
// SDK must keep its timestamp within bounds even if the local clock has
// drifted. We sample /time at boot and provide a manual refresh helper.

import type { AxiosInstance } from 'axios';

const DEFAULT_RECV_WINDOW_MS = 5000;
const MIN_RECV_WINDOW_MS = 1000;
const MAX_RECV_WINDOW_MS = 30_000;

export function clampRecvWindow(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_RECV_WINDOW_MS;
  }
  return Math.min(MAX_RECV_WINDOW_MS, Math.max(MIN_RECV_WINDOW_MS, Math.floor(value)));
}

export interface ClockState {
  driftMs: number;
  lastSampledAt: number;
  rttMs?: number;
}

export class ClockDriftTracker {
  private state: ClockState = { driftMs: 0, lastSampledAt: 0 };

  current(): ClockState {
    return { ...this.state };
  }

  // Returns the wall-clock timestamp adjusted for measured drift. Used as
  // the X-Timestamp header value for every signed request.
  signedTimestampMs(): string {
    // Guard against NaN/Infinity drift bleeding into the signed header.
    const drift = Number.isFinite(this.state.driftMs) ? this.state.driftMs : 0;
    const adjusted = Date.now() + drift;
    return Math.floor(adjusted).toString();
  }

  // Single sample. Sends one request, computes drift = serverTime - midpoint
  // of the local sent/received window, returns RTT for the call.
  async sampleOnce(http: AxiosInstance, path: string): Promise<{ driftMs: number; rttMs: number }> {
    const sent = Date.now();
    const response = await http.get<{ serverTime: number; iso: string } | string>(path);
    const received = Date.now();
    const rttMs = received - sent;
    // Estimate the local clock value at the moment the server stamped the
    // response. Halfway through the round trip is the standard NTP approach.
    const localAtServerStamp = sent + Math.floor(rttMs / 2);
    // HttpTransport disables axios transformResponse to keep signed-request
    // bodies byte-stable, so rawAxios returns the raw JSON string. Parse it
    // here so the sampler does not silently corrupt drift to NaN if the
    // transport configuration changes.
    const body = typeof response.data === 'string'
      ? (JSON.parse(response.data) as { serverTime: number; iso: string })
      : response.data;
    if (!body || typeof body.serverTime !== 'number' || !Number.isFinite(body.serverTime)) {
      throw new Error('time endpoint returned no serverTime');
    }
    const driftMs = body.serverTime - localAtServerStamp;
    return { driftMs, rttMs };
  }

  // Multi-sample. Averages over several round trips, picks the median to
  // shed outliers from network jitter, then commits to state.
  async sample(http: AxiosInstance, path: string, samples = 5): Promise<{ driftMs: number; rttMs: number }> {
    const results: Array<{ driftMs: number; rttMs: number }> = [];
    for (let i = 0; i < samples; i++) {
      try {
        const r = await this.sampleOnce(http, path);
        results.push(r);
      } catch {
        // Skip a single bad sample; one network blip should not abort the
        // entire calibration.
      }
    }
    if (results.length === 0) {
      // Could not sample. Leave existing state untouched and surface zeros so
      // callers see the failure rather than a silent zero drift.
      return { driftMs: this.state.driftMs, rttMs: 0 };
    }
    results.sort((a, b) => a.driftMs - b.driftMs);
    const median = results[Math.floor(results.length / 2)];
    const medianRtt = [...results].sort((a, b) => a.rttMs - b.rttMs)[Math.floor(results.length / 2)];
    this.state = {
      driftMs: median.driftMs,
      lastSampledAt: Date.now(),
      rttMs: medianRtt.rttMs
    };
    return { driftMs: median.driftMs, rttMs: medianRtt.rttMs };
  }

  // Used during construction or unit tests to seed a known drift value
  // without making a network call.
  set(driftMs: number, rttMs?: number): void {
    this.state = { driftMs, lastSampledAt: Date.now(), rttMs };
  }

  // Test seam. Staging tests reach into the private clock via `as any` and
  // call setDriftMs to pin the timestamp drift before issuing a signed call.
  // Aliased to set() so the canonical surface stays one method.
  setDriftMs(driftMs: number): void {
    this.set(driftMs);
  }
}

export const RECV_WINDOW_BOUNDS = {
  default: DEFAULT_RECV_WINDOW_MS,
  min: MIN_RECV_WINDOW_MS,
  max: MAX_RECV_WINDOW_MS
};
