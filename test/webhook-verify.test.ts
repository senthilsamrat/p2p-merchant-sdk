// Coverage for the webhook verification helper. Mirrors the verification
// surface a merchant would actually exercise on receiving an event.

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhook } from '../src/webhooks/verify.js';

const SECRET = 'whsec_test_supersecret';
const PAYLOAD = JSON.stringify({
  id: 'evt_123',
  type: 'merchant.trade.completed',
  data: { tradeId: 't_1' }
});

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

describe('verifyWebhook - happy path', () => {
  it('returns valid:true for a correct signature', () => {
    const sig = sign(PAYLOAD, SECRET);
    const r = verifyWebhook({ payload: PAYLOAD, signature: sig, secret: SECRET });
    expect(r.valid).toBe(true);
    expect(r.reason).toBeUndefined();
  });

  it('accepts a Buffer payload', () => {
    const buf = Buffer.from(PAYLOAD, 'utf8');
    const sig = sign(PAYLOAD, SECRET);
    const r = verifyWebhook({ payload: buf, signature: sig, secret: SECRET });
    expect(r.valid).toBe(true);
  });
});

describe('verifyWebhook - tampered payload', () => {
  it('rejects when the payload was modified after signing', () => {
    const sig = sign(PAYLOAD, SECRET);
    const tampered = PAYLOAD.replace('tradeId', 'tradeID');
    const r = verifyWebhook({ payload: tampered, signature: sig, secret: SECRET });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('invalid_signature');
  });

  it('rejects when the signature was computed with a different secret', () => {
    const wrongSig = sign(PAYLOAD, 'whsec_other_secret');
    const r = verifyWebhook({ payload: PAYLOAD, signature: wrongSig, secret: SECRET });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('invalid_signature');
  });
});

describe('verifyWebhook - length-mismatched signature', () => {
  it('returns false (no throw) when signature length is wrong', () => {
    const r = verifyWebhook({
      payload: PAYLOAD,
      signature: 'deadbeef',
      secret: SECRET
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('invalid_signature');
  });

  it('returns malformed when secret is empty', () => {
    const r = verifyWebhook({ payload: PAYLOAD, signature: 'a'.repeat(64), secret: '' });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('malformed');
  });

  it('returns malformed when signature is empty', () => {
    const r = verifyWebhook({ payload: PAYLOAD, signature: '', secret: SECRET });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('malformed');
  });
});

describe('verifyWebhook - timestamp tolerance', () => {
  it('rejects when timestamp is older than tolerance', () => {
    const sig = sign(PAYLOAD, SECRET);
    const now = 1_700_000_000_000;
    const tenMinAgo = now - 10 * 60 * 1000;
    const r = verifyWebhook({
      payload: PAYLOAD,
      signature: sig,
      secret: SECRET,
      timestamp: String(tenMinAgo),
      toleranceMs: 5 * 60 * 1000,
      now: () => now
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('timestamp_too_old');
  });

  it('rejects when timestamp is too far in the future', () => {
    const sig = sign(PAYLOAD, SECRET);
    const now = 1_700_000_000_000;
    const tenMinAhead = now + 10 * 60 * 1000;
    const r = verifyWebhook({
      payload: PAYLOAD,
      signature: sig,
      secret: SECRET,
      timestamp: String(tenMinAhead),
      toleranceMs: 5 * 60 * 1000,
      now: () => now
    });
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('timestamp_too_new');
  });

  it('accepts when timestamp is within tolerance', () => {
    const sig = sign(PAYLOAD, SECRET);
    const now = 1_700_000_000_000;
    const fourMinAgo = now - 4 * 60 * 1000;
    const r = verifyWebhook({
      payload: PAYLOAD,
      signature: sig,
      secret: SECRET,
      timestamp: String(fourMinAgo),
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
});
