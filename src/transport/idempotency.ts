// Idempotency-Key generator. The gateway requires this header on POST,
// PATCH, PUT, and DELETE under /api/v1/merchant/*. Server caches the
// response for 24h on first call so retries with the same key return the
// stored response rather than re-executing.

import { randomBytes } from 'node:crypto';

export function generateIdempotencyKey(): string {
  // 32 hex chars. Matches the server-side expected range of [8, 256].
  return randomBytes(16).toString('hex');
}

// Methods that need an Idempotency-Key header per the gateway contract.
const IDEMPOTENT_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function requiresIdempotencyKey(method: string): boolean {
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}
