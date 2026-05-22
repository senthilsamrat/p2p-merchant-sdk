// Handshake header construction for the merchant WebSocket upgrade.
// The server's upgradeAuth.ts validates these headers byte-for-byte against
// the same canonical scheme used for REST. Empty body, METHOD=CONNECT,
// PATH=/ws/merchant-stream. Anything else fails the signature check.

import { signHmac } from '../transport/signing.js';
import { generateNonce } from '../transport/nonce.js';
import { WS_PATH } from './types.js';

// Header names sent on the upgrade. Lowercased on the wire by Node's http
// client; the server reads them case-insensitively. Use the canonical
// capitalized names here so logs and tests stay readable.
export interface HandshakeHeaders {
  'X-API-Key': string;
  'X-Signature': string;
  'X-Timestamp': string;
  'X-Nonce': string;
  'X-Recv-Window'?: string;
  'Last-Event-Id'?: string;
}

export interface BuildHandshakeOptions {
  apiKey: string;
  hmacSecret: string;
  // Optional override for the recvWindow header. Server has its own clamp.
  recvWindowMs?: number;
  // Optional resume cursor; sent as Last-Event-Id per RFC SSE convention.
  resumeFromEventId?: string;
  // Optional clock-drift correction. Useful when the host clock is known to
  // skew off NTP. Server allows ~5s of skew by default.
  clockDriftMs?: number;
  // Override for the path component of the canonical signing string. Defaults
  // to WS_PATH. Exposed so tests can verify a different path produces a
  // different signature (negative case).
  path?: string;
}

// Build the full set of HMAC headers for a WebSocket upgrade. Returns an
// object the caller can spread into the ws library's `headers` option.
//
// Signature contract (must match server):
//   canonical = `CONNECT:/ws/merchant-stream:${timestamp}:${nonce}:`
// Empty body because WS upgrades carry none. The trailing colon is from
// the `:${body}` segment with body=''.
export function buildHandshakeHeaders(opts: BuildHandshakeOptions): HandshakeHeaders {
  if (!opts.apiKey || typeof opts.apiKey !== 'string') {
    throw new Error('buildHandshakeHeaders: apiKey is required');
  }
  if (!opts.hmacSecret || typeof opts.hmacSecret !== 'string') {
    throw new Error('buildHandshakeHeaders: hmacSecret is required');
  }

  const path = opts.path ?? WS_PATH;
  const timestamp = String(Date.now() + (opts.clockDriftMs ?? 0));
  const nonce = generateNonce();

  const signature = signHmac({
    method: 'CONNECT',
    path,
    timestamp,
    nonce,
    body: '',
    hmacSecret: opts.hmacSecret,
  });

  const headers: HandshakeHeaders = {
    'X-API-Key': opts.apiKey,
    'X-Signature': signature,
    'X-Timestamp': timestamp,
    'X-Nonce': nonce,
  };

  if (opts.recvWindowMs !== undefined) {
    if (!Number.isFinite(opts.recvWindowMs) || opts.recvWindowMs <= 0) {
      throw new Error('buildHandshakeHeaders: recvWindowMs must be a positive number');
    }
    headers['X-Recv-Window'] = String(Math.floor(opts.recvWindowMs));
  }

  if (opts.resumeFromEventId) {
    if (typeof opts.resumeFromEventId !== 'string') {
      throw new Error('buildHandshakeHeaders: resumeFromEventId must be a string');
    }
    headers['Last-Event-Id'] = opts.resumeFromEventId;
  }

  return headers;
}
