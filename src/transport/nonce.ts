// Random nonce generation for HMAC requests.
// Server requires a nonce of at least 8 characters and rejects reuse. We
// default to 32 hex chars (128 bits of entropy) which keeps collision
// probability negligible across the per-key Redis SET NX EX nonce store.

import { randomBytes } from 'node:crypto';

// Default byte count. 16 bytes -> 32 hex chars. Comfortable headroom over
// the 8-char minimum the server enforces.
const DEFAULT_NONCE_BYTES = 16;

export function generateNonce(byteLength: number = DEFAULT_NONCE_BYTES): string {
  if (!Number.isInteger(byteLength) || byteLength < 4) {
    throw new Error('nonce byte length must be an integer >= 4');
  }
  return randomBytes(byteLength).toString('hex');
}
