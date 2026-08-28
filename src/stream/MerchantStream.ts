// MerchantStream: WebSocket client for the merchant event stream.
// Owns a single WebSocket lifecycle: handshake, session.start, event
// dispatch, system frames, reconnect with backoff and jitter, dedup via
// the client-side ResumeBuffer, and resume hints via numeric resumeAfter on
// reconnect. Inbound API only; the server only accepts ping/pong.
//
// Behavior contract (kept aligned with merchant-service/src/websocket):
//   - Handshake: HMAC headers via buildHandshakeHeaders.
//   - First server frame after upgrade is session.start; connect() resolves
//     when we see it.
//   - Server frames are JSON. Three top-level shapes:
//       1) {type: 'session.start', ...}              session boundary
//       2) {type: 'system.*' | 'server.*', ...}      system signal
//       3) {eventId, eventType, sequence, ...}       business event
//   - Client never sends application frames. ws library handles ping/pong.
//   - Inactivity guard: if no inbound frame (incl. pong) for pingTimeoutMs,
//     force-close 1006. Server pings every 30s so 90s default tolerates 3 misses.
//   - Reconnect policy:
//       4001 AUTH_FAILED            -> NO reconnect
//       4002 PERMISSION_DENIED      -> NO reconnect
//       4008 CONNECTION_LIMIT       -> NO reconnect
//       4500 CROSS_TENANT_LEAK      -> NO reconnect, log loud
//       4403 ORIGIN_FORBIDDEN       -> NO reconnect (browser case)
//       4499 RECONNECT_REQUIRED     -> immediate reconnect (no backoff)
//       1001 GOING_AWAY             -> reconnect after server.draining hint
//       1006 ABNORMAL_CLOSE         -> exponential backoff with jitter
//       1009 MESSAGE_TOO_BIG        -> exponential backoff (slow down)
//       1011 SERVER_ERROR           -> exponential backoff
//       4000 NORMAL                 -> NO reconnect (clean close)
//       other                       -> exponential backoff
//   - Resume: on each reconnect, include the last server sequence as the
//     resumeAfter query parameter. If server returns system.resume_unavailable,
//     emit a structured error so the caller can reconcile via REST.

import { EventEmitter } from 'node:events';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import {
  AuthenticationError,
  MerchantSdkError,
  PermissionDeniedError,
  ServerError,
} from '../errors/index.js';
import {
  STREAM_DEFAULTS,
  WS_PATH,
  type CloseReason,
  type DisconnectedInfo,
  type MerchantEvent,
  type MerchantStreamConstructorOpts,
  type ReconnectingInfo,
  type SessionStart,
  type StreamOptions,
} from './types.js';
import { buildHandshakeHeaders } from './handshake.js';
import { ResumeBuffer } from './resumeBuffer.js';

// Close codes mirrored from merchant-service/src/websocket/types.ts. We keep
// our own copy because importing from the server would couple the SDK to
// the service codebase.
const CLOSE = {
  NORMAL: 4000,
  AUTH_FAILED: 4001,
  PERMISSION_DENIED: 4002,
  CONNECTION_LIMIT: 4008,
  ORIGIN_FORBIDDEN: 4403,
  RECONNECT_REQUIRED: 4499,
  CROSS_TENANT_LEAK: 4500,
  UNSUPPORTED_FRAME: 1003,
  RATE_LIMIT: 1008,
  MESSAGE_TOO_BIG: 1009,
  GOING_AWAY: 1001,
  ABNORMAL_CLOSE: 1006,
  SERVER_ERROR: 1011,
} as const;

// Close codes that MUST NOT trigger an automatic reconnect. Any code in this
// set means the failure is permanent without operator intervention.
const NO_RECONNECT_CODES: ReadonlySet<number> = new Set([
  CLOSE.AUTH_FAILED,
  CLOSE.PERMISSION_DENIED,
  CLOSE.CONNECTION_LIMIT,
  CLOSE.ORIGIN_FORBIDDEN,
  CLOSE.CROSS_TENANT_LEAK,
  CLOSE.NORMAL,
]);

// Base url scheme normalization. We accept http/https for ergonomics and
// rewrite to ws/wss because the ws library refuses non-ws schemes.
function toWsBaseUrl(input: string): string {
  if (input.startsWith('wss://') || input.startsWith('ws://')) return input;
  if (input.startsWith('https://')) return 'wss://' + input.slice('https://'.length);
  if (input.startsWith('http://')) return 'ws://' + input.slice('http://'.length);
  throw new Error(`MerchantStream: baseUrl must use ws/wss/http/https scheme, got: ${input}`);
}

// Map close codes to a stable reason string. Used in the disconnected event.
function classifyClose(code: number): CloseReason {
  switch (code) {
    case CLOSE.NORMAL:
      return 'normal';
    case CLOSE.AUTH_FAILED:
      return 'auth_failed';
    case CLOSE.PERMISSION_DENIED:
      return 'permission_denied';
    case CLOSE.CONNECTION_LIMIT:
      return 'connection_limit';
    case CLOSE.ORIGIN_FORBIDDEN:
      return 'origin_forbidden';
    case CLOSE.RECONNECT_REQUIRED:
      return 'reconnect_required';
    case CLOSE.CROSS_TENANT_LEAK:
      return 'cross_tenant_leak';
    case CLOSE.GOING_AWAY:
      return 'going_away';
    case CLOSE.ABNORMAL_CLOSE:
      return 'abnormal_close';
    case CLOSE.MESSAGE_TOO_BIG:
      return 'message_too_big';
    case CLOSE.SERVER_ERROR:
      return 'server_error';
    case CLOSE.UNSUPPORTED_FRAME:
      return 'unsupported_frame';
    case CLOSE.RATE_LIMIT:
      return 'rate_limit';
    default:
      return 'unknown';
  }
}

// Public error class emitted on the 'error' channel when the server signals
// that the client's resume cursor has been evicted from the buffer. Caller
// MUST reconcile state via REST before relying on live events again.
export class ResumeUnavailableError extends MerchantSdkError {
  constructor(message = 'Resume buffer unavailable; reconcile via REST') {
    super(message, { code: 'RESUME_UNAVAILABLE' });
  }
}

// Public error class emitted when the per-socket sequence advances by more
// than 1, indicating an in-flight loss the server-side resume buffer would
// normally cover. Caller can decide whether to reconcile or ignore.
export class SequenceGapError extends MerchantSdkError {
  public readonly expected: number;
  public readonly actual: number;
  constructor(expected: number, actual: number) {
    super(`Sequence gap detected: expected ${expected}, got ${actual}`, {
      code: 'SEQUENCE_GAP',
    });
    this.expected = expected;
    this.actual = actual;
  }
}

// Internal connection state. Drives the orchestrator's branching for connect
// resolution and reconnect decisions.
type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'closing'
  | 'closed';

export class MerchantStream extends EventEmitter {
  private readonly apiKey: string;
  private readonly hmacSecret: string;
  private readonly baseUrl: string;
  private readonly opts: Required<StreamOptions>;

  // Live socket and orchestration state.
  private ws: WebSocket | null = null;
  private state: ConnectionState = 'idle';
  // Reset to false on each connect cycle. True once we've seen session.start.
  private sessionEstablished = false;
  // Pending connect() promise resolvers; cleared on session.start or final failure.
  private pendingConnect: {
    resolve: () => void;
    reject: (err: Error) => void;
  } | null = null;
  // True once the caller has explicitly requested close(). Suppresses reconnect.
  private closedByCaller = false;
  // Reconnect bookkeeping.
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  // server.draining hint stored so the next reconnect can wait the requested
  // backoff before attempting; cleared once consumed.
  private pendingDrainBackoffMs: number | null = null;
  // Inactivity guard. Tracks the last inbound frame (any frame, including pong).
  private lastMessageAt = 0;
  private inactivityTimer: NodeJS.Timeout | null = null;

  // Session identity. Cleared on each new connect cycle.
  private sessionId: string | null = null;
  private readonly resumeBuffer: ResumeBuffer;

  constructor(opts: MerchantStreamConstructorOpts) {
    super();
    if (!opts.apiKey) throw new Error('MerchantStream: apiKey is required');
    if (!opts.hmacSecret) throw new Error('MerchantStream: hmacSecret is required');

    this.apiKey = opts.apiKey;
    this.hmacSecret = opts.hmacSecret;
    this.baseUrl = toWsBaseUrl(opts.baseUrl ?? STREAM_DEFAULTS.baseUrl);

    const o = opts.options ?? {};
    this.opts = {
      baseUrl: this.baseUrl,
      recvWindow: o.recvWindow ?? STREAM_DEFAULTS.recvWindow,
      reconnect: o.reconnect ?? STREAM_DEFAULTS.reconnect,
      reconnectMaxAttempts: o.reconnectMaxAttempts ?? STREAM_DEFAULTS.reconnectMaxAttempts,
      reconnectBaseDelayMs: o.reconnectBaseDelayMs ?? STREAM_DEFAULTS.reconnectBaseDelayMs,
      reconnectMaxDelayMs: o.reconnectMaxDelayMs ?? STREAM_DEFAULTS.reconnectMaxDelayMs,
      resumeBufferSize: o.resumeBufferSize ?? STREAM_DEFAULTS.resumeBufferSize,
      pingTimeoutMs: o.pingTimeoutMs ?? STREAM_DEFAULTS.pingTimeoutMs,
      handshakeTimeoutMs: o.handshakeTimeoutMs ?? STREAM_DEFAULTS.handshakeTimeoutMs,
      clockDriftMs: o.clockDriftMs ?? STREAM_DEFAULTS.clockDriftMs,
    };

    this.resumeBuffer = new ResumeBuffer(this.opts.resumeBufferSize);

    // Don't crash the process when no error listener is attached. Callers
    // should listen but a missed listener is a UX bug, not a crash bug.
    this.on('error', () => {});
  }

  // Open a new connection. Resolves on first session.start. Rejects on
  // permanent-failure close codes seen during the initial handshake.
  connect(): Promise<void> {
    if (this.state === 'open' && this.sessionEstablished) {
      return Promise.resolve();
    }
    if (this.state === 'connecting' && this.pendingConnect) {
      // Coalesce multiple connect() calls onto the same in-flight handshake.
      return new Promise<void>((resolve, reject) => {
        const prior = this.pendingConnect!;
        this.pendingConnect = {
          resolve: () => {
            prior.resolve();
            resolve();
          },
          reject: (err) => {
            prior.reject(err);
            reject(err);
          },
        };
      });
    }

    this.closedByCaller = false;
    this.reconnectAttempt = 0;

    return new Promise<void>((resolve, reject) => {
      this.pendingConnect = { resolve, reject };
      this.openSocket();
    });
  }

  // Graceful caller-initiated close. Sends NORMAL (4000), suppresses reconnect.
  close(): Promise<void> {
    this.closedByCaller = true;
    this.clearReconnectTimer();
    this.clearInactivityTimer();
    this.failPendingConnect(
      new MerchantSdkError('Connection closed by caller before session.start', {
        code: 'CLOSED_BY_CALLER',
      }),
    );

    if (this.state === 'closed' || this.state === 'idle') {
      this.state = 'closed';
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const w = this.ws;
      if (!w) {
        this.state = 'closed';
        resolve();
        return;
      }
      const onClose = () => {
        this.state = 'closed';
        resolve();
      };
      // Listen for the close event; ws emits 'close' even when initiated
      // locally. Use once() so we don't double-resolve if the socket is
      // already in the process of closing.
      w.once('close', onClose);
      try {
        this.state = 'closing';
        // Send close frame with NORMAL code. ws.close() is a no-op if the
        // socket is already CLOSING or CLOSED.
        w.close(CLOSE.NORMAL, 'client_close');
      } catch {
        // Swallow; the close handler will still resolve via the event chain.
      }
    });
  }

  // Liveness checks. isConnected returns true only after session.start so
  // callers can wait for first-event readiness, not just TCP connectivity.
  isConnected(): boolean {
    return this.state === 'open' && this.sessionEstablished;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getLastSequence(): number {
    return this.resumeBuffer.getLastSequence();
  }

  // Internal: open a single ws connection. On success transitions to 'open'
  // and waits for session.start to resolve any pending connect() promise.
  // On TCP-level error, classifies and either reconnects or rejects.
  private openSocket(): void {
    if (this.state === 'connecting' || this.state === 'open') {
      // Already in flight or open. Defensive guard against accidental re-entry.
      return;
    }

    this.state = 'connecting';
    this.sessionEstablished = false;
    this.sessionId = null;

    // The service's replay buffer is keyed by numeric sequence, not UUID
    // eventId. Keep eventIds for client-side dedup and send the last sequence
    // as the explicit resumeAfter query cursor.
    const lastSequence = this.resumeBuffer.getLastSequence();
    const url = `${this.baseUrl}${WS_PATH}${lastSequence >= 0 ? `?resumeAfter=${lastSequence}` : ''}`;

    let rawHeaders;
    try {
      rawHeaders = buildHandshakeHeaders({
        apiKey: this.apiKey,
        hmacSecret: this.hmacSecret,
        recvWindowMs: this.opts.recvWindow,
        clockDriftMs: this.opts.clockDriftMs,
      });
    } catch (err) {
      // Synchronous failure to build the signature is a permanent error;
      // surface it to the caller and stop.
      this.failPendingConnect(err instanceof Error ? err : new Error(String(err)));
      this.state = 'closed';
      return;
    }

    // Materialize a plain object with no undefined values. ws library typings
    // expect Record<string, string> so the optional headers must be filtered.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (typeof v === 'string') headers[k] = v;
    }

    const wsOpts: ClientOptions = {
      headers,
      handshakeTimeout: this.opts.handshakeTimeoutMs,
      // Server has perMessageDeflate disabled. Match on the client to avoid
      // negotiation churn and to remove a compression-side-channel surface.
      perMessageDeflate: false,
      // Cap inbound frames so a server bug or downgrade attack cannot push
      // an oversized frame into our buffer. Server enforces 1KB on inbound
      // from the client; outbound frames carry events that may be larger.
      // Use a generous 1MB ceiling matching the server's backpressure cutoff.
      maxPayload: 1_048_576,
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, wsOpts);
    } catch (err) {
      // Constructor can throw on invalid URL or scheme. Treat as permanent.
      this.failPendingConnect(err instanceof Error ? err : new Error(String(err)));
      this.state = 'closed';
      return;
    }

    this.ws = ws;
    this.lastMessageAt = Date.now();

    ws.on('open', () => {
      // 'open' means the WebSocket handshake completed; we now wait for
      // session.start before resolving connect().
      this.state = 'open';
      this.touchInactivity();
      this.startInactivityTimer();
    });

    ws.on('message', (data: RawData, isBinary: boolean) => {
      this.touchInactivity();
      this.handleMessage(data, isBinary);
    });

    // Track pong arrivals so the inactivity timer is satisfied even when no
    // event traffic flows. ws auto-replies to pings; we only need to observe
    // pongs that the server may eventually send back.
    ws.on('pong', () => {
      this.touchInactivity();
    });

    // ws emits 'ping' when the SERVER pings us; the library auto-pongs but
    // we still want to refresh the inactivity timer.
    ws.on('ping', () => {
      this.touchInactivity();
    });

    ws.on('error', (err: Error) => {
      // 'error' precedes 'close' for failure cases. Surface to listeners but
      // defer reconnect / pending-connect resolution to the close handler so
      // we observe the close code.
      this.emit('error', err);
    });

    ws.on('unexpected-response', (upgradeRequest, res) => {
      // Server rejected the upgrade with a non-101 HTTP response. Translate
      // common statuses to typed errors so the caller can branch.
      const status = res.statusCode ?? 0;
      let err: Error;
      if (status === 401) {
        err = new AuthenticationError('Authentication failed during WebSocket upgrade', {
          status: 401,
        });
      } else if (status === 403) {
        err = new PermissionDeniedError('Permission denied during WebSocket upgrade', {
          status: 403,
        });
      } else if (status >= 500) {
        err = new ServerError(`Server returned ${status} on WebSocket upgrade`, { status });
      } else {
        err = new MerchantSdkError(`Unexpected ${status} on WebSocket upgrade`, {
          status,
          code: 'WS_UPGRADE_FAILED',
        });
      }
      // Drain the response body to free the socket.
      res.resume();
      this.emit('error', err);
      // Registering unexpected-response makes this listener responsible for
      // aborting the ws handshake. Transition through the same close path used
      // by established sockets so 401/403 are permanent, while 5xx responses
      // retain reconnect/backoff behavior. Handle synchronously and guard the
      // later ws close event below to avoid a double transition.
      try {
        upgradeRequest.destroy();
      } catch {
        // best effort; terminate() below also aborts a CONNECTING socket
      }
      try {
        ws.terminate();
      } catch {
        // handleClose still resets state even if ws has already torn down
      }
      const closeCode = status === 401
        ? CLOSE.AUTH_FAILED
        : status === 403
          ? CLOSE.PERMISSION_DENIED
          : status >= 500
            ? CLOSE.SERVER_ERROR
            : CLOSE.ABNORMAL_CLOSE;
      this.handleClose(closeCode, `HTTP ${status} upgrade rejection`, err);
    });

    ws.on('close', (code: number, reasonBuf: Buffer) => {
      if (this.ws !== ws) return;
      const reasonText = reasonBuf?.toString('utf8') || undefined;
      this.handleClose(code, reasonText);
    });
  }

  private handleMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      // Server only sends text JSON frames. Any binary frame is a protocol
      // violation. Surface and force-close so we don't process garbage.
      this.emit(
        'error',
        new MerchantSdkError('Received unexpected binary frame from server', {
          code: 'PROTOCOL_VIOLATION',
        }),
      );
      this.terminateAbnormal();
      return;
    }

    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      this.emit(
        'error',
        new MerchantSdkError('Failed to parse server frame as JSON', {
          code: 'PROTOCOL_VIOLATION',
          cause: err,
        }),
      );
      this.terminateAbnormal();
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      this.emit(
        'error',
        new MerchantSdkError('Server frame is not an object', {
          code: 'PROTOCOL_VIOLATION',
        }),
      );
      this.terminateAbnormal();
      return;
    }

    const obj = parsed as Record<string, unknown>;

    // Branch on whether this is a system frame (has top-level `type`) or an
    // event frame (has top-level `eventType`). Both forms are legal and
    // distinct on the wire.
    if (typeof obj.type === 'string') {
      this.handleSystemFrame(obj);
      return;
    }

    if (typeof obj.eventType === 'string') {
      this.handleEventFrame(obj);
      return;
    }

    // Unknown frame shape. Don't crash; surface and continue. The server
    // may add new frame variants in the future and we want forward
    // compatibility.
    this.emit(
      'error',
      new MerchantSdkError('Unrecognized server frame shape', {
        code: 'PROTOCOL_UNKNOWN',
        details: { keys: Object.keys(obj) },
      }),
    );
  }

  private handleSystemFrame(obj: Record<string, unknown>): void {
    const type = obj.type as string;

    switch (type) {
      case 'session.start': {
        const sid = typeof obj.sessionId === 'string' ? obj.sessionId : null;
        if (!sid) {
          this.emit(
            'error',
            new MerchantSdkError('session.start missing sessionId', {
              code: 'PROTOCOL_VIOLATION',
            }),
          );
          this.terminateAbnormal();
          return;
        }
        // Preserve both the numeric replay cursor and event-id dedup state.
        // Replay frames arrive after session.start, so clearing here would
        // duplicate already-consumed events and lose the next reconnect point.
        this.sessionId = sid;
        this.sessionEstablished = true;
        this.reconnectAttempt = 0;
        const sessionFrame: SessionStart = {
          type: 'session.start',
          sessionId: sid,
          serverSeq: typeof obj.serverSeq === 'number' ? obj.serverSeq : 0,
          tier: obj.tier as SessionStart['tier'],
          authExpiresAt: typeof obj.authExpiresAt === 'number' ? obj.authExpiresAt : undefined,
        };
        // Emit 'connected' for the typed listener and resolve the pending
        // connect() promise. Order matters: resolve callers first so they
        // can wire any follow-up subscriptions before user-side handlers run.
        if (this.pendingConnect) {
          const p = this.pendingConnect;
          this.pendingConnect = null;
          p.resolve();
        }
        this.emit('connected', sid, sessionFrame);
        // Forward the session.start frame on the generic 'system' channel
        // for callers who want raw frames.
        this.emit('system', sessionFrame);
        return;
      }
      case 'system.resume_unavailable': {
        // Server-side buffer evicted our cursor. Caller MUST reconcile.
        this.resumeBuffer.resetSequence();
        this.emit('system', obj);
        this.emit('error', new ResumeUnavailableError());
        return;
      }
      case 'system.session_invalid': {
        // Session is being terminated; close will follow. Surface for caller
        // visibility but don't take action here; the close handler classifies.
        this.emit('system', obj);
        return;
      }
      case 'server.draining': {
        // Pod draining. Stash the suggested backoff for the next reconnect.
        const ms = typeof obj.reconnectAfterMs === 'number' ? obj.reconnectAfterMs : 1000;
        this.pendingDrainBackoffMs = Math.max(0, Math.floor(ms));
        this.emit('system', obj);
        return;
      }
      default: {
        // Unknown system type. Forward for forward-compatibility.
        this.emit('system', obj);
        return;
      }
    }
  }

  private handleEventFrame(obj: Record<string, unknown>): void {
    const eventType = obj.eventType as string;
    const eventId = typeof obj.eventId === 'string' ? obj.eventId : null;
    const sequence = typeof obj.sequence === 'number'
      && Number.isSafeInteger(obj.sequence)
      && obj.sequence > 0
      ? obj.sequence
      : null;
    const timestamp = obj.timestamp === undefined
      ? Date.now()
      : typeof obj.timestamp === 'number' && Number.isFinite(obj.timestamp)
        ? obj.timestamp
        : null;
    const replay = obj.replay === true;
    const data = obj.data;

    // Strict event shape. eventId and sequence are required by the contract.
    if (!eventId || sequence === null || timestamp === null) {
      this.emit(
        'error',
        new MerchantSdkError('Event frame has invalid eventId, sequence, or timestamp', {
          code: 'PROTOCOL_VIOLATION',
          details: { eventType },
        }),
      );
      this.terminateAbnormal();
      return;
    }

    // Dedup. If we've already seen this eventId, drop silently; this is the
    // expected case during a reconnect race or replay overlap.
    if (this.resumeBuffer.has(eventId)) {
      return;
    }

    // The resume cursor is a contiguous commit point, never merely the
    // largest sequence observed. If N+1 arrives before N, close before
    // dispatching or recording it so reconnect asks the server to replay from
    // the last contiguous sequence and delivers N..N+1 exactly once.
    const last = this.resumeBuffer.getLastSequence();
    if (last >= 0 && sequence > last + 1) {
      this.emit('error', new SequenceGapError(last + 1, sequence));
      this.terminateAbnormal();
      return;
    }
    if (last >= 0 && sequence <= last) {
      // An overlapping replay may outlive the in-memory event-id window. The
      // contiguous cursor proves this sequence was already committed, so it
      // must not be emitted a second time.
      this.resumeBuffer.add(eventId);
      return;
    }

    // Record dedup state. Bump the high-water sequence only if this advances it.
    this.resumeBuffer.add(eventId);
    this.resumeBuffer.recordSequence(sequence);

    const event: MerchantEvent = {
      eventId,
      eventType,
      timestamp,
      sequence,
      data,
      replay,
    };

    // Generic 'event' channel followed by the eventType-specific channel so
    // listeners can subscribe at either granularity.
    this.emit('event', event);
    this.emit(eventType, event);
  }

  private handleClose(
    code: number,
    reasonText: string | undefined,
    connectionError?: Error,
  ): void {
    // Snapshot the prior state so we can decide whether reconnect is wanted.
    const wasOpen = this.state === 'open';
    this.state = 'closed';
    this.clearInactivityTimer();
    this.ws = null;

    const reason = classifyClose(code);

    // Decide reconnect intent before emitting so the disconnected payload
    // accurately reflects what we're about to do.
    let willReconnect = false;
    let nextDelayMs = 0;

    if (this.closedByCaller) {
      willReconnect = false;
    } else if (!this.opts.reconnect) {
      willReconnect = false;
    } else if (NO_RECONNECT_CODES.has(code)) {
      willReconnect = false;
    } else if (this.reconnectAttempt >= this.opts.reconnectMaxAttempts) {
      willReconnect = false;
    } else {
      willReconnect = true;
      nextDelayMs = this.computeReconnectDelay(code);
    }

    // For permanent failure during the initial handshake, reject the pending
    // connect() promise with a typed error.
    if (this.pendingConnect && !willReconnect) {
      const err = connectionError || this.makeCloseError(code, reasonText);
      const p = this.pendingConnect;
      this.pendingConnect = null;
      p.reject(err);
    }

    // Emit a permanent-failure error on the error channel for cross-tenant
    // leak so it shows up in central logging even when nobody listens to
    // 'disconnected'. Per spec: log loudly.
    if (code === CLOSE.CROSS_TENANT_LEAK) {
      this.emit(
        'error',
        new MerchantSdkError('Server reported a cross-tenant routing error; reconnect blocked', {
          code: 'CROSS_TENANT_LEAK',
          details: { closeCode: code, reasonText },
        }),
      );
    }

    const info: DisconnectedInfo = {
      code,
      reason: this.closedByCaller ? 'client_initiated' : reason,
      willReconnect,
      details: reasonText,
    };
    this.emit('disconnected', info);

    if (!willReconnect) {
      // Drop session identity so isConnected() returns false going forward.
      this.sessionEstablished = false;
      this.sessionId = null;
      // Keep resume and dedup state across non-reconnect closes in case the
      // caller manually connects again.
      return;
    }

    // Schedule reconnect.
    if (wasOpen || this.reconnectAttempt > 0) {
      this.reconnectAttempt += 1;
    } else {
      // Failed before the socket ever opened; still count this attempt so
      // backoff progresses.
      this.reconnectAttempt += 1;
    }

    const reconnectInfo: ReconnectingInfo = {
      attempt: this.reconnectAttempt,
      nextDelayMs,
    };
    this.emit('reconnecting', reconnectInfo);

    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Caller may have invoked close() while waiting; bail if so.
      if (this.closedByCaller) return;
      this.openSocket();
    }, nextDelayMs);
    // Prevent the timer from blocking process exit so SDK consumers can shut
    // down without explicit cleanup.
    this.reconnectTimer.unref?.();
  }

  // Decide the reconnect delay for the given close code.
  // - 4499 RECONNECT_REQUIRED: immediate (no backoff). Server explicitly
  //   asks the client to come back.
  // - 1001 GOING_AWAY: honour any server.draining hint we received earlier.
  // - everything else: exponential backoff with jitter, capped at the max.
  private computeReconnectDelay(code: number): number {
    if (code === CLOSE.RECONNECT_REQUIRED) {
      return 0;
    }
    if (code === CLOSE.GOING_AWAY && this.pendingDrainBackoffMs !== null) {
      const hint = this.pendingDrainBackoffMs;
      this.pendingDrainBackoffMs = null;
      return hint;
    }
    const base = this.opts.reconnectBaseDelayMs;
    const cap = this.opts.reconnectMaxDelayMs;
    // Exponential growth: base * 2^attempt. Use the current attempt count
    // before increment because increment happens in handleClose just before
    // this is called for live socket cases.
    const attempt = Math.min(this.reconnectAttempt, 30);
    const expo = base * Math.pow(2, attempt);
    // Decorrelated jitter: random in [0, base) added to the exponential. Keeps
    // herds from synchronizing across clients reconnecting after a drain.
    const jitter = Math.random() * base;
    return Math.min(cap, Math.floor(expo + jitter));
  }

  // Construct a typed error for permanent-failure close codes so the caller
  // gets actionable information when connect() rejects.
  private makeCloseError(code: number, reasonText?: string): Error {
    const detail = reasonText ? ` (${reasonText})` : '';
    switch (code) {
      case CLOSE.AUTH_FAILED:
        return new AuthenticationError(`WebSocket auth failed${detail}`, { status: 401 });
      case CLOSE.PERMISSION_DENIED:
        return new PermissionDeniedError(`WebSocket permission denied${detail}`, { status: 403 });
      case CLOSE.CONNECTION_LIMIT:
        return new MerchantSdkError(`Connection limit exceeded for tier${detail}`, {
          code: 'CONNECTION_LIMIT',
          details: { closeCode: code },
        });
      case CLOSE.ORIGIN_FORBIDDEN:
        return new MerchantSdkError(`Origin forbidden${detail}`, {
          code: 'ORIGIN_FORBIDDEN',
          status: 403,
          details: { closeCode: code },
        });
      case CLOSE.CROSS_TENANT_LEAK:
        return new MerchantSdkError(`Cross-tenant leak detected by server${detail}`, {
          code: 'CROSS_TENANT_LEAK',
          details: { closeCode: code },
        });
      case CLOSE.NORMAL:
        return new MerchantSdkError(`Connection closed normally before session.start${detail}`, {
          code: 'CLOSED_BEFORE_SESSION',
          details: { closeCode: code },
        });
      default:
        return new MerchantSdkError(`WebSocket closed with code ${code}${detail}`, {
          code: 'WS_CLOSED',
          details: { closeCode: code },
        });
    }
  }

  private failPendingConnect(err: Error): void {
    if (this.pendingConnect) {
      const p = this.pendingConnect;
      this.pendingConnect = null;
      p.reject(err);
    }
  }

  private touchInactivity(): void {
    this.lastMessageAt = Date.now();
  }

  private startInactivityTimer(): void {
    this.clearInactivityTimer();
    // Sample at half the timeout so we never overshoot by more than half the
    // window. Cheap and good enough; the precision contract is "close at
    // most pingTimeoutMs after the last frame" not "close exactly at that mark".
    const sample = Math.max(1000, Math.floor(this.opts.pingTimeoutMs / 2));
    this.inactivityTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastMessageAt;
      if (elapsed > this.opts.pingTimeoutMs) {
        this.emit(
          'error',
          new MerchantSdkError(`No inbound frame for ${elapsed}ms; force-closing`, {
            code: 'INACTIVITY_TIMEOUT',
          }),
        );
        this.terminateAbnormal();
      }
    }, sample);
    this.inactivityTimer.unref?.();
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearInterval(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // Force-close the socket without sending a close frame. Used for protocol
  // violations and inactivity. Triggers the normal 'close' handler chain so
  // reconnect logic still runs.
  private terminateAbnormal(): void {
    if (!this.ws) return;
    try {
      this.ws.terminate();
    } catch {
      // ignore
    }
  }
}
