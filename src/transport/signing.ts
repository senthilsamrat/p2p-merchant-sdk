// HMAC SHA-256 canonical signing for the merchant API.
// Mirrors the server-side scheme exactly: METHOD:PATH:timestamp:nonce:rawBody
// where METHOD is uppercase, PATH includes the leading slash and excludes
// querystring, timestamp is unix milliseconds as a decimal string, nonce is
// a single-use random token, and rawBody is the literal request body the
// server will see (empty string for GET / DELETE / WS upgrade).
//
// When the request acts on behalf of a platform end-user, X-PM-Acting-User
// is bound into the canonical string by appending `:${actingUserId}`. This
// closes the same-tenant impersonation gap where an attacker who replays a
// signed request could swap the header to a sibling end-user under the same
// parent merchant. Legacy direct-trader keys (no acting user) keep the
// 5-segment string so existing signatures verify unchanged.
//
// The output is the lowercase hex digest. Server compares with constant-time
// equality.
//
// This module is the stable contract that both the REST transport and the
// WebSocket handshake import. Keep the signature shape and canonical string
// stable across SDK versions; both halves of the SDK depend on byte-for-byte
// agreement with the server.

import { createHmac } from 'node:crypto';

export interface SignHmacOptions {
  // HTTP method. Pass 'CONNECT' for the WebSocket upgrade.
  method: string;
  // Request path (no querystring).
  path: string;
  // Unix milliseconds as decimal string. Match exactly what is sent on the wire.
  timestamp: string;
  // Single-use nonce. Server rejects replays.
  nonce: string;
  // Raw request body. Empty string for bodyless requests (GET, DELETE, WS upgrade).
  body: string;
  // Per-API-key HMAC secret as obtained at key creation time.
  hmacSecret: string;
  // Acting end-user id when the request carries X-PM-Acting-User. Bound into
  // the canonical string so the header cannot be swapped on a replayed
  // request without invalidating the signature. Omit on scope=self requests
  // and on platform-admin paths that do not impersonate a specific end-user.
  actingUserId?: string;
}

// Build the canonical string the server will reconstruct. The colons are
// fixed delimiters and are NOT URL-encoded; the server splits on them
// implicitly by re-deriving the same string. When actingUserId is supplied
// it is appended as a sixth segment; when absent the legacy five-segment
// string is produced.
export function buildCanonicalString(opts: Omit<SignHmacOptions, 'hmacSecret'>): string {
  const { method, path, timestamp, nonce, body, actingUserId } = opts;
  const base = `${method.toUpperCase()}:${path}:${timestamp}:${nonce}:${body}`;
  return actingUserId ? `${base}:${actingUserId}` : base;
}

// Compute the hex digest. Returns lowercase hex matching server expectation.
export function signHmac(opts: SignHmacOptions): string {
  const canonical = buildCanonicalString(opts);
  const hmac = createHmac('sha256', opts.hmacSecret);
  hmac.update(canonical);
  return hmac.digest('hex');
}
