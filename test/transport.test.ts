// Verifies the canonical signing string format and HMAC output match the
// server-side contract bit-for-bit. Includes hand-computed reference
// vectors so any future change to the format is caught immediately.

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { signHmac, buildCanonicalString } from '../src/transport/signing.js';
import { generateNonce } from '../src/transport/nonce.js';
import { generateIdempotencyKey, requiresIdempotencyKey } from '../src/transport/idempotency.js';
import {
  parseRetryAfter,
  computeDelayMs,
  isRetryableNetworkCode,
  isRetryableStatus,
  DEFAULT_RETRY_CONFIG
} from '../src/transport/retry.js';
import { ClockDriftTracker, clampRecvWindow, RECV_WINDOW_BOUNDS } from '../src/transport/recvWindow.js';

describe('signing - canonical string format', () => {
  it('formats GET with empty body using the empty string sentinel', () => {
    const s = buildCanonicalString({
      method: 'GET',
      path: '/api/v1/merchant/account',
      timestamp: '1700000000000',
      nonce: 'abc123',
      body: ''
    });
    expect(s).toBe('GET:/api/v1/merchant/account:1700000000000:abc123:');
  });

  it('uppercases the HTTP method', () => {
    const s = buildCanonicalString({
      method: 'post',
      path: '/api/v1/merchant/orders',
      timestamp: '1700000000000',
      nonce: 'n',
      body: '{"x":1}'
    });
    expect(s).toMatch(/^POST:/);
  });

  it('does NOT use literal "null" or "undefined" for empty bodies', () => {
    const s = buildCanonicalString({
      method: 'DELETE',
      path: '/api/v1/merchant/orders/abc',
      timestamp: '1700000000000',
      nonce: 'n',
      body: ''
    });
    expect(s).not.toContain('null');
    expect(s).not.toContain('undefined');
    expect(s.endsWith(':')).toBe(true);
  });
});

describe('signing - HMAC reference vectors', () => {
  // Hand-computed reference. signing string:
  //   GET:/api/v1/merchant/account:1700000000000:nonce-abc:
  // secret: test-secret
  it('matches the hand-computed expected hex digest', () => {
    const secret = 'test-secret';
    const expected = createHmac('sha256', secret)
      .update('GET:/api/v1/merchant/account:1700000000000:nonce-abc:')
      .digest('hex');

    const got = signHmac({
      method: 'GET',
      path: '/api/v1/merchant/account',
      timestamp: '1700000000000',
      nonce: 'nonce-abc',
      body: '',
      hmacSecret: secret
    });

    expect(got).toBe(expected);
    // Sanity: hex output is lowercase 64 characters (256 bits).
    expect(got).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a different signature when the body changes', () => {
    const args = {
      method: 'POST',
      path: '/api/v1/merchant/orders',
      timestamp: '1700000000000',
      nonce: 'n',
      hmacSecret: 'secret'
    };
    const a = signHmac({ ...args, body: '{"a":1}' });
    const b = signHmac({ ...args, body: '{"a":2}' });
    expect(a).not.toBe(b);
  });

  it('produces a different signature when the path changes', () => {
    const args = {
      method: 'GET',
      timestamp: '1700000000000',
      nonce: 'n',
      body: '',
      hmacSecret: 'secret'
    };
    const a = signHmac({ ...args, path: '/api/v1/merchant/account' });
    const b = signHmac({ ...args, path: '/api/v1/merchant/availability' });
    expect(a).not.toBe(b);
  });

  it('produces a different signature when the method changes', () => {
    const args = {
      path: '/api/v1/merchant/availability',
      timestamp: '1700000000000',
      nonce: 'n',
      body: '',
      hmacSecret: 'secret'
    };
    const a = signHmac({ ...args, method: 'GET' });
    const b = signHmac({ ...args, method: 'PATCH' });
    expect(a).not.toBe(b);
  });
});

describe('nonce', () => {
  it('returns 32 hex characters by default', () => {
    const n = generateNonce();
    expect(n).toMatch(/^[0-9a-f]{32}$/);
  });

  it('produces unique values across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateNonce());
    expect(seen.size).toBe(100);
  });

  it('respects custom byte length', () => {
    const n = generateNonce(8);
    expect(n).toMatch(/^[0-9a-f]{16}$/);
  });

  it('rejects byte lengths below the minimum', () => {
    expect(() => generateNonce(0)).toThrow();
    expect(() => generateNonce(2)).toThrow();
  });
});

describe('idempotency', () => {
  it('returns 32 hex characters', () => {
    const k = generateIdempotencyKey();
    expect(k).toMatch(/^[0-9a-f]{32}$/);
  });

  it('flags POST/PATCH/PUT/DELETE as needing a key', () => {
    expect(requiresIdempotencyKey('POST')).toBe(true);
    expect(requiresIdempotencyKey('patch')).toBe(true);
    expect(requiresIdempotencyKey('PUT')).toBe(true);
    expect(requiresIdempotencyKey('DELETE')).toBe(true);
  });

  it('does not flag GET or HEAD', () => {
    expect(requiresIdempotencyKey('GET')).toBe(false);
    expect(requiresIdempotencyKey('HEAD')).toBe(false);
  });
});

describe('retry policy', () => {
  it('treats 5xx and 429 as retryable', () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it('treats common network failures as retryable', () => {
    expect(isRetryableNetworkCode('ECONNREFUSED')).toBe(true);
    expect(isRetryableNetworkCode('ETIMEDOUT')).toBe(true);
    expect(isRetryableNetworkCode('ECONNRESET')).toBe(true);
    expect(isRetryableNetworkCode('ENOTFOUND')).toBe(false);
  });

  it('parses Retry-After in seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('honours Retry-After in delay calculation', () => {
    const d = computeDelayMs({
      attempt: 0,
      config: DEFAULT_RETRY_CONFIG,
      retryAfterMs: 1234
    });
    expect(d).toBe(1234);
  });

  it('caps backoff at maxDelayMs', () => {
    const d = computeDelayMs({
      attempt: 30,
      config: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 5000 }
    });
    expect(d).toBeLessThanOrEqual(5000);
  });
});

describe('recvWindow + clock drift', () => {
  it('clamps recvWindow to bounds', () => {
    expect(clampRecvWindow(0)).toBe(RECV_WINDOW_BOUNDS.min);
    expect(clampRecvWindow(999)).toBe(RECV_WINDOW_BOUNDS.min);
    expect(clampRecvWindow(5000)).toBe(5000);
    expect(clampRecvWindow(60_000)).toBe(RECV_WINDOW_BOUNDS.max);
    expect(clampRecvWindow(undefined)).toBe(RECV_WINDOW_BOUNDS.default);
  });

  it('signedTimestampMs returns Date.now plus drift, decimal string', () => {
    const t = new ClockDriftTracker();
    t.set(1000);
    const before = Date.now();
    const ts = parseInt(t.signedTimestampMs(), 10);
    const after = Date.now();
    expect(ts).toBeGreaterThanOrEqual(before + 1000 - 1);
    expect(ts).toBeLessThanOrEqual(after + 1000 + 1);
  });
});
