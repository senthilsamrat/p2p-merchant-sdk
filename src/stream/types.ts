// Public types for the merchant WebSocket stream client.
// Mirrors the server contract in merchant-service/src/websocket/types.ts and
// the SendableEvent envelope written by eventRouter.ts. Any change here must
// keep both halves byte-compatible with the server.

// First server frame after a successful upgrade. Carries session identity so
// callers can correlate logs with server traces and observe their tier.
export interface SessionStart {
  type: 'session.start';
  sessionId: string;
  serverSeq: number;
  // Echoed by the server for the SDK's convenience. Keep optional so older
  // server builds that omit it still type-check.
  tier?: 'professional' | 'business' | 'enterprise';
  authExpiresAt?: number;
}

// Server tells us the resume buffer no longer holds the requested cursor.
// Caller MUST reconcile state via REST before relying on live events again.
export interface ResumeUnavailable {
  type: 'system.resume_unavailable';
  code: 'RESUME_UNAVAILABLE';
  // Server emits an epoch-ms timestamp on this frame; expose it for logging.
  timestamp?: number;
}

// Session terminated server-side. Don't reconnect with the same key.
export interface SessionInvalid {
  type: 'system.session_invalid';
  reason:
    | 'key_rotated'
    | 'key_revoked'
    | 'merchant_suspended'
    | 'permission_revoked'
    | 'session_expired';
}

// Pod is draining. Reconnect after the suggested backoff.
export interface ServerDraining {
  type: 'server.draining';
  reconnectAfterMs: number;
}

// Catch-all for system frames the server may add later. Keeps consumers from
// crashing on a forward-compatible field add.
export interface SystemFrame {
  type: string;
  reason?: string;
  code?: string;
  [k: string]: unknown;
}

// SendableEvent envelope as written by the server-side eventRouter. eventId
// is server-generated (uuid v4). sequence is monotonic per socket. timestamp
// is unix milliseconds. data is the application payload after PII redaction.
// `replay: true` marks events delivered as part of a resume backfill.
export interface MerchantEvent<T = unknown> {
  eventId: string;
  eventType: string;
  timestamp: number;
  sequence: number;
  data: T;
  replay?: boolean;
}

// Server's outbound event types. These are the values you can subscribe to
// directly via on('merchant.<type>', ...). Source of truth: eventRouter's
// OUTBOUND_TYPE map. Keep this enum in sync when the server adds new events.
export type MerchantEventType =
  | 'merchant.trades.completed'
  | 'merchant.trades.expired'
  | 'merchant.trades.disputed'
  | 'merchant.trades.payment_confirmed'
  | 'merchant.orders.created'
  | 'merchant.orders.cancelled'
  | 'merchant.orders.updated'
  | 'merchant.orders.paused'
  | 'merchant.orders.reactivated'
  | 'merchant.disputes.opened'
  | 'merchant.disputes.resolved'
  | 'merchant.disputes.escalated'
  | 'merchant.disputes.cancelled'
  | 'merchant.wallet.balance_changed'
  | 'merchant.wallet.hold_created'
  | 'merchant.wallet.hold_released'
  | 'merchant.wallet.transferred'
  | 'merchant.wallet.fee_collected';

// Reason classification surfaced on the 'disconnected' event so callers can
// branch on close semantics without parsing close codes themselves.
export type CloseReason =
  | 'normal'
  | 'auth_failed'
  | 'permission_denied'
  | 'connection_limit'
  | 'reconnect_required'
  | 'cross_tenant_leak'
  | 'origin_forbidden'
  | 'going_away'
  | 'abnormal_close'
  | 'message_too_big'
  | 'rate_limit'
  | 'unsupported_frame'
  | 'server_error'
  | 'client_initiated'
  | 'unknown';

// Construction-time options for the WebSocket client. All fields optional;
// defaults match the server's expectations and the spec.
export interface StreamOptions {
  // Override the default base URL. wss:// in production, ws:// for local dev.
  baseUrl?: string;
  // recvWindow header passed on the upgrade. Server clamps to its own range.
  recvWindow?: number;
  // Auto-reconnect on transient close codes. Disable for one-shot clients.
  reconnect?: boolean;
  // Cap on consecutive reconnect attempts. Default Infinity for production bots.
  reconnectMaxAttempts?: number;
  // Initial backoff in milliseconds. Doubles each attempt with jitter.
  reconnectBaseDelayMs?: number;
  // Ceiling on reconnect backoff between attempts.
  reconnectMaxDelayMs?: number;
  // Number of recent eventIds kept client-side for dedup on resume.
  resumeBufferSize?: number;
  // Hard ceiling between any inbound frame (including pong) and a forced close.
  // Server pings every 30s; default 90s gives a 3-miss tolerance.
  pingTimeoutMs?: number;
  // ws library handshake timeout in ms. Bound on TCP-level connect.
  handshakeTimeoutMs?: number;
  // Optional clock-drift correction added to Date.now() when stamping the
  // X-Timestamp header. Useful when the host clock is known to skew.
  clockDriftMs?: number;
}

// Construction-time options for MerchantStream. apiKey + hmacSecret are
// required; baseUrl optional; options merged with internal defaults.
export interface MerchantStreamConstructorOpts {
  apiKey: string;
  hmacSecret: string;
  baseUrl?: string;
  options?: StreamOptions;
}

// Payload shape passed to the 'disconnected' listener. willReconnect lets
// callers decide whether to surface a UI banner immediately or wait.
export interface DisconnectedInfo {
  code: number;
  reason: CloseReason;
  willReconnect: boolean;
  // Server-supplied close reason text when present. Pass-through for logging.
  details?: string;
}

// Payload shape passed to the 'reconnecting' listener.
export interface ReconnectingInfo {
  attempt: number;
  nextDelayMs: number;
}

// Default values used by MerchantStream. Exported so tests and consumers can
// inspect the live defaults instead of duplicating literals.
export const STREAM_DEFAULTS = {
  baseUrl: 'wss://api.plantmewallet.com',
  recvWindow: 5000,
  reconnect: true,
  reconnectMaxAttempts: Number.POSITIVE_INFINITY,
  reconnectBaseDelayMs: 1000,
  reconnectMaxDelayMs: 30_000,
  resumeBufferSize: 200,
  pingTimeoutMs: 90_000,
  handshakeTimeoutMs: 10_000,
  clockDriftMs: 0,
} as const;

// Path the server listens on. Both the handshake signing canonical string
// and the URL the ws library opens come from this constant; keep them in sync.
export const WS_PATH = '/ws/merchant-stream';
