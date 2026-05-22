// Webhook signature verification helper. Imported via the dedicated subpath
// `@plantmewallet/merchant-sdk/webhooks` so consumers running in workers
// or edge environments can import the verifier without pulling in axios.
//
// Algorithm matches WebhookService.verifyWebhookSignature in
// merchant-service exactly:
//   expected = HMAC-SHA256(payload, secret) -> hex
//   constant-time compare against the X-Webhook-Signature header
// Length mismatch returns false BEFORE timingSafeEqual to avoid throwing on
// different-length buffers and to keep the timing surface uniform.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyWebhookOptions {
  // Raw bytes the server sent. If your framework gave you a parsed JSON
  // object, you must capture and pass the raw body instead, otherwise the
  // signature will not match.
  payload: string | Buffer;
  // Hex digest from the X-Webhook-Signature header.
  signature: string;
  // The webhook secret returned ONCE by webhooks.regenerateSecret(). Store
  // securely in your secret manager.
  secret: string;
  // Optional max age. Defaults to 5 minutes when timestamp is provided.
  toleranceMs?: number;
  // Optional X-Webhook-Timestamp header. When set with toleranceMs we also
  // reject payloads that drift too far in either direction.
  timestamp?: string;
  // Override Date.now for testing. Internal.
  now?: () => number;
}

export type VerifyWebhookFailureReason =
  | 'invalid_signature'
  | 'timestamp_too_old'
  | 'timestamp_too_new'
  | 'malformed';

export interface VerifyWebhookResult {
  valid: boolean;
  reason?: VerifyWebhookFailureReason;
}

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

export function verifyWebhook(opts: VerifyWebhookOptions): VerifyWebhookResult {
  if (!opts.signature || typeof opts.signature !== 'string') {
    return { valid: false, reason: 'malformed' };
  }
  if (!opts.secret || typeof opts.secret !== 'string') {
    return { valid: false, reason: 'malformed' };
  }
  if (opts.payload === undefined || opts.payload === null) {
    return { valid: false, reason: 'malformed' };
  }

  // Optional age check before HMAC. Cheap rejection saves a hash on stale
  // payloads.
  if (opts.timestamp !== undefined) {
    const tolerance = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS;
    const ts = Number(opts.timestamp);
    if (!Number.isFinite(ts)) {
      return { valid: false, reason: 'malformed' };
    }
    const now = (opts.now ?? Date.now)();
    const diff = now - ts;
    if (diff > tolerance) {
      return { valid: false, reason: 'timestamp_too_old' };
    }
    if (diff < -tolerance) {
      return { valid: false, reason: 'timestamp_too_new' };
    }
  }

  const payloadBytes = typeof opts.payload === 'string'
    ? Buffer.from(opts.payload, 'utf8')
    : opts.payload;

  const expectedHex = createHmac('sha256', opts.secret)
    .update(payloadBytes)
    .digest('hex');

  // Hex signature must be the right length and decodable. A length mismatch
  // here means the caller passed garbage; reject without invoking
  // timingSafeEqual which would otherwise throw on unequal lengths.
  if (opts.signature.length !== expectedHex.length) {
    return { valid: false, reason: 'invalid_signature' };
  }

  let providedBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    providedBuf = Buffer.from(opts.signature, 'hex');
    expectedBuf = Buffer.from(expectedHex, 'hex');
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (providedBuf.length !== expectedBuf.length) {
    return { valid: false, reason: 'invalid_signature' };
  }

  const matches = timingSafeEqual(providedBuf, expectedBuf);
  return matches ? { valid: true } : { valid: false, reason: 'invalid_signature' };
}
