// Exponential backoff with full jitter, capped at 30s. Idempotency-Key
// makes POST/PATCH/PUT/DELETE retry-safe so we treat all methods the same.

import { setTimeout as sleep } from 'node:timers/promises';

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 250,
  maxDelayMs: 30_000
};

// Network-layer error codes that warrant a retry. Server gave us nothing,
// so the request never reached the destination resource.
const RETRYABLE_AXIOS_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ECONNABORTED'
]);

export function isRetryableNetworkCode(code: string | undefined): boolean {
  return code !== undefined && RETRYABLE_AXIOS_CODES.has(code);
}

export function isRetryableStatus(status: number | undefined): boolean {
  if (status === undefined) return false;
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

// Compute the next delay. Honour Retry-After when provided since the server
// is telling us when it will accept us next. Otherwise use exponential with
// full jitter capped at maxDelayMs.
export function computeDelayMs(opts: {
  attempt: number;
  config: RetryConfig;
  retryAfterMs?: number;
}): number {
  if (opts.retryAfterMs !== undefined && opts.retryAfterMs > 0) {
    return Math.min(opts.retryAfterMs, opts.config.maxDelayMs);
  }
  const exp = opts.config.baseDelayMs * Math.pow(2, opts.attempt);
  const jitter = Math.random() * opts.config.baseDelayMs;
  return Math.min(exp + jitter, opts.config.maxDelayMs);
}

// Parse a Retry-After header. Per RFC, value can be seconds (decimal) or an
// HTTP date. We support both since both appear in the wild.
export function parseRetryAfter(header: string | string[] | undefined): number | undefined {
  if (header === undefined) return undefined;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return Math.max(0, asNumber * 1000);
  }
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }
  return undefined;
}

export async function delay(ms: number): Promise<void> {
  if (ms <= 0) return;
  await sleep(ms);
}
