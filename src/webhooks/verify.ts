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
  // Optional max age. Defaults to 5 minutes.
  toleranceMs?: number;
  // Required X-Webhook-Timestamp header, exactly as delivered. The signed JSON
  // payload must contain the same `timestamp` value. Requests without the
  // header fail closed because freshness cannot otherwise be authenticated.
  timestamp: string;
  // Override Date.now for testing. Internal.
  now?: () => number;
}

export type VerifyWebhookFailureReason =
  | 'invalid_signature'
  | 'timestamp_too_old'
  | 'timestamp_too_new'
  | 'timestamp_mismatch'
  | 'malformed';

export interface VerifyWebhookResult {
  valid: boolean;
  reason?: VerifyWebhookFailureReason;
}

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

// The header carries an ISO instant, which is what the delivery puts on the
// wire. Epoch milliseconds are parseable too, but callers must pass the header
// exactly as delivered so it remains equal to the signed payload timestamp.
function parseTimestamp(value: string): number | null {
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return asNumber;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

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
  if (!opts.timestamp || typeof opts.timestamp !== 'string') {
    return { valid: false, reason: 'malformed' };
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

  if (!timingSafeEqual(providedBuf, expectedBuf)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  const tolerance = opts.toleranceMs ?? DEFAULT_TOLERANCE_MS;
  const ts = parseTimestamp(opts.timestamp);
  if (ts === null) {
    return { valid: false, reason: 'malformed' };
  }

  let signedTimestamp: unknown;
  try {
    const parsed: unknown = JSON.parse(payloadBytes.toString('utf8'));
    signedTimestamp = parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).timestamp
      : undefined;
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (typeof signedTimestamp !== 'string' || signedTimestamp !== opts.timestamp) {
    return { valid: false, reason: 'timestamp_mismatch' };
  }

  const now = (opts.now ?? Date.now)();
  const diff = now - ts;
  if (diff > tolerance) {
    return { valid: false, reason: 'timestamp_too_old' };
  }
  if (diff < -tolerance) {
    return { valid: false, reason: 'timestamp_too_new' };
  }

  return { valid: true };
}
