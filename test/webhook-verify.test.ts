// Coverage for the webhook verification helper. Mirrors the verification
// surface a merchant would actually exercise on receiving an event.

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhook } from '../src/webhooks/verify.js';

const SECRET = 'whsec_test_supersecret';
const TIMESTAMP = '2023-11-14T22:13:20.000Z';
const PAYLOAD = JSON.stringify({
  id: 'evt_123',
  type: 'merchant.trade.completed',
  timestamp: TIMESTAMP,
  data: { tradeId: 't_1' }
});

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

function payloadAt(timestamp: string): string {
  return JSON.stringify({
    id: 'evt_123',
    type: 'merchant.trade.completed',
    timestamp,
    data: { tradeId: 't_1' }
  });
}

describe('verifyWebhook - happy path', () => {
  it('returns valid:true for a correct signature', () => {
    const sig = sign(PAYLOAD, SECRET);
    const r = verifyWebhook({
      payload: PAYLOAD,
      signature: sig,
      secret: SECRET,
      timestamp: TIMESTAMP,
      now: () => Date.parse(TIMESTAMP)
    });
    expect(r.valid).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('accepts a Buffer payload', () => {
    const buf = Buffer.from(PAYLOAD, 'utf8');
    const sig = sign(PAYLOAD, SECRET);
    const r = verifyWebhook({
      payload: buf,
      signature: sig,
      secret: SECRET,
      timestamp: TIMESTAMP,
      now: () => Date.parse(TIMESTAMP)
    });
    expect(r.valid).toBe(true);
  });
});

describe('verifyWebhook - tampered payload', () => {
  it('rejects when the payload was modified after signing', () => {
    const sig = sign(PAYLOAD, SECRET);
    const tampered = PAYLOAD.replace('tradeId', 'tradeID');
    const r = verifyWebhook({ payload: tampered, signature: sig, secret: SECRET, timestamp: TIMESTAMP });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('invalid_signature');
  });

  it('rejects when the signature was computed with a different secret', () => {
    const wrongSig = sign(PAYLOAD, 'whsec_other_secret');
    const r = verifyWebhook({ payload: PAYLOAD, signature: wrongSig, secret: SECRET, timestamp: TIMESTAMP });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('invalid_signature');
  });
});

describe('verifyWebhook - length-mismatched signature', () => {
  it('returns false (no throw) when signature length is wrong', () => {
    const r = verifyWebhook({
      payload: PAYLOAD,
      signature: 'deadbeef',
      secret: SECRET,
      timestamp: TIMESTAMP
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('invalid_signature');
  });

  it('returns malformed when secret is empty', () => {
    const r = verifyWebhook({
      payload: PAYLOAD,
      signature: 'a'.repeat(64),
      secret: '',
      timestamp: TIMESTAMP
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('malformed');
  });

  it('returns malformed when signature is empty', () => {
    const r = verifyWebhook({ payload: PAYLOAD, signature: '', secret: SECRET, timestamp: TIMESTAMP });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('malformed');
  });
});

describe('verifyWebhook - timestamp tolerance', () => {
  it('rejects when the timestamp header is missing', () => {
    const r = verifyWebhook({
      payload: PAYLOAD,
      signature: sign(PAYLOAD, SECRET),
      secret: SECRET,
      timestamp: undefined as unknown as string
    });

    expect(r).toEqual({ valid: false, reason: 'malformed' });
  });

  it('rejects when timestamp is older than tolerance', () => {
    const now = 1_700_000_000_000;
    const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
    const payload = payloadAt(tenMinAgo);
    const r = verifyWebhook({
      payload,
      signature: sign(payload, SECRET),
      secret: SECRET,
      timestamp: tenMinAgo,
      toleranceMs: 5 * 60 * 1000,
      now: () => now
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('timestamp_too_old');
  });

  it('rejects when timestamp is too far in the future', () => {
    const now = 1_700_000_000_000;
    const tenMinAhead = new Date(now + 10 * 60 * 1000).toISOString();
    const payload = payloadAt(tenMinAhead);
    const r = verifyWebhook({
      payload,
      signature: sign(payload, SECRET),
      secret: SECRET,
      timestamp: tenMinAhead,
      toleranceMs: 5 * 60 * 1000,
      now: () => now
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('timestamp_too_new');
  });

  it('accepts when timestamp is within tolerance', () => {
    const now = 1_700_000_000_000;
    const fourMinAgo = new Date(now - 4 * 60 * 1000).toISOString();
    const payload = payloadAt(fourMinAgo);
    const r = verifyWebhook({
      payload,
      signature: sign(payload, SECRET),
      secret: SECRET,
      timestamp: fourMinAgo,
      toleranceMs: 5 * 60 * 1000,
      now: () => now
    });
    expect(r.valid).toBe(true);
  });

  it('rejects malformed timestamp string', () => {
    const sig = sign(PAYLOAD, SECRET);
    const r = verifyWebhook({
      payload: PAYLOAD,
      signature: sig,
      secret: SECRET,
      timestamp: 'not-a-number'
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('malformed');
  });

  it('rejects replay with a fresh header and an old signed payload timestamp', () => {
    const oldTimestamp = '2023-11-14T22:03:20.000Z';
    const freshTimestamp = '2023-11-14T22:13:20.000Z';
    const payload = JSON.stringify({ eventId: 'evt_123', timestamp: oldTimestamp, data: {} });
    const r = verifyWebhook({
      payload,
      signature: sign(payload, SECRET),
      secret: SECRET,
      timestamp: freshTimestamp,
      now: () => Date.parse(freshTimestamp)
    });

    expect(r).toEqual({ valid: false, reason: 'timestamp_mismatch' });
  });

  it('rejects a timestamp header when the signed payload has no timestamp', () => {
    const payload = JSON.stringify({ eventId: 'evt_123', data: {} });
    const r = verifyWebhook({
      payload,
      signature: sign(payload, SECRET),
      secret: SECRET,
      timestamp: '2023-11-14T22:13:20.000Z'
    });

    expect(r).toEqual({ valid: false, reason: 'timestamp_mismatch' });
  });

  it('rejects non-JSON signed content when timestamp verification is requested', () => {
    const payload = 'not-json';
    const r = verifyWebhook({
      payload,
      signature: sign(payload, SECRET),
      secret: SECRET,
      timestamp: '2023-11-14T22:13:20.000Z'
    });

    expect(r).toEqual({ valid: false, reason: 'malformed' });
  });
});
