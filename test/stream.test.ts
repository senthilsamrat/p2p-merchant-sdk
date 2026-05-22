// Tests for the MerchantStream WebSocket client.
// We spin up a local ws server inside the test process and exercise the
// client against it. The server validates handshake headers and emits
// canonical frames that mirror the production server's contract.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { WebSocketServer, type WebSocket as WsServerSocket } from 'ws';
import { createHmac, randomUUID } from 'node:crypto';
import {
  MerchantStream,
  ResumeUnavailableError,
  SequenceGapError,
} from '../src/stream/MerchantStream.js';
import { ResumeBuffer } from '../src/stream/resumeBuffer.js';
import { buildHandshakeHeaders } from '../src/stream/handshake.js';
import type { MerchantEvent } from '../src/stream/types.js';

// Test fixtures. Use deterministic credentials so signature checks are
// reproducible across runs.
const TEST_API_KEY = 'pk_test_unit';
const TEST_HMAC_SECRET = 'unit-test-secret-do-not-use-in-prod';

interface TestServer {
  http: http.Server;
  wss: WebSocketServer;
  port: number;
  url: string;
  // Accept callback receives the ws socket plus the upgrade request so the
  // test can validate handshake headers and decide what frames to send.
  setOnConnection: (cb: (ws: WsServerSocket, req: http.IncomingMessage) => void) => void;
  close: () => Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
  const httpServer = http.createServer();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  let onConnection: ((ws: WsServerSocket, req: http.IncomingMessage) => void) | null = null;

  httpServer.on('upgrade', (req, socket, head) => {
    if ((req.url || '').split('?')[0] !== '/ws/merchant-stream') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (onConnection) onConnection(ws, req);
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
  const port = addr.port;
  const url = `ws://127.0.0.1:${port}`;

  return {
    http: httpServer,
    wss,
    port,
    url,
    setOnConnection(cb) {
      onConnection = cb;
    },
    close() {
      return new Promise<void>((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      });
    },
  };
}

// Helper to send a session.start frame with the conventional shape.
function sendSessionStart(ws: WsServerSocket, sessionId?: string): string {
  const id: string = sessionId ?? (randomUUID() as string);
  ws.send(
    JSON.stringify({
      type: 'session.start',
      sessionId: id,
      serverSeq: 0,
      tier: 'professional',
      authExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
    }),
  );
  return id;
}

// Helper to build a canonical event frame.
function makeEvent(seq: number, eventType = 'merchant.trades.completed', overrides: Partial<MerchantEvent> = {}): unknown {
  return {
    eventId: overrides.eventId ?? randomUUID(),
    eventType,
    timestamp: Date.now(),
    sequence: seq,
    data: overrides.data ?? { tradeId: `t-${seq}` },
    ...(overrides.replay !== undefined ? { replay: overrides.replay } : {}),
  };
}

// Verify the handshake signature server-side using the same canonical
// scheme as production. Returns true if the X-Signature header matches.
function verifyHandshakeSignature(req: http.IncomingMessage): boolean {
  const apiKey = req.headers['x-api-key'];
  const sig = req.headers['x-signature'];
  const ts = req.headers['x-timestamp'];
  const nonce = req.headers['x-nonce'];
  if (typeof apiKey !== 'string' || typeof sig !== 'string' || typeof ts !== 'string' || typeof nonce !== 'string') {
    return false;
  }
  if (apiKey !== TEST_API_KEY) return false;
  const canonical = `CONNECT:/ws/merchant-stream:${ts}:${nonce}:`;
  const expected = createHmac('sha256', TEST_HMAC_SECRET).update(canonical).digest('hex');
  return expected === sig;
}

describe('buildHandshakeHeaders', () => {
  it('produces all required HMAC headers with the correct shape', () => {
    const headers = buildHandshakeHeaders({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
      recvWindowMs: 5000,
    });
    expect(headers['X-API-Key']).toBe(TEST_API_KEY);
    expect(headers['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['X-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-Nonce']).toMatch(/^[0-9a-f]{32}$/);
    expect(headers['X-Recv-Window']).toBe('5000');
  });

  it('omits Last-Event-Id when no resume cursor is provided', () => {
    const headers = buildHandshakeHeaders({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
    });
    expect(headers['Last-Event-Id']).toBeUndefined();
  });

  it('includes Last-Event-Id when resume cursor is provided', () => {
    const headers = buildHandshakeHeaders({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
      resumeFromEventId: 'evt-abc-123',
    });
    expect(headers['Last-Event-Id']).toBe('evt-abc-123');
  });

  it('produces signatures that verify against the canonical scheme', () => {
    const headers = buildHandshakeHeaders({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
    });
    const canonical = `CONNECT:/ws/merchant-stream:${headers['X-Timestamp']}:${headers['X-Nonce']}:`;
    const expected = createHmac('sha256', TEST_HMAC_SECRET).update(canonical).digest('hex');
    expect(headers['X-Signature']).toBe(expected);
  });

  it('rejects empty apiKey', () => {
    expect(() =>
      buildHandshakeHeaders({ apiKey: '', hmacSecret: TEST_HMAC_SECRET }),
    ).toThrow(/apiKey is required/);
  });

  it('rejects empty hmacSecret', () => {
    expect(() =>
      buildHandshakeHeaders({ apiKey: TEST_API_KEY, hmacSecret: '' }),
    ).toThrow(/hmacSecret is required/);
  });
});

describe('ResumeBuffer', () => {
  it('dedupes by eventId', () => {
    const buf = new ResumeBuffer(10);
    expect(buf.has('a')).toBe(false);
    buf.add('a');
    expect(buf.has('a')).toBe(true);
  });

  it('tracks the high-water sequence monotonically', () => {
    const buf = new ResumeBuffer(10);
    expect(buf.getLastSequence()).toBe(-1);
    buf.recordSequence(5);
    expect(buf.getLastSequence()).toBe(5);
    buf.recordSequence(3);
    expect(buf.getLastSequence()).toBe(5);
    buf.recordSequence(7);
    expect(buf.getLastSequence()).toBe(7);
  });

  it('evicts the oldest entry when at capacity', () => {
    const buf = new ResumeBuffer(3);
    buf.add('a');
    buf.add('b');
    buf.add('c');
    expect(buf.size()).toBe(3);
    buf.add('d');
    expect(buf.has('a')).toBe(false);
    expect(buf.has('b')).toBe(true);
    expect(buf.has('c')).toBe(true);
    expect(buf.has('d')).toBe(true);
    expect(buf.size()).toBe(3);
  });

  it('returns the most-recently-added eventId via getLastEventId', () => {
    const buf = new ResumeBuffer(5);
    expect(buf.getLastEventId()).toBeNull();
    buf.add('first');
    buf.add('second');
    buf.add('third');
    expect(buf.getLastEventId()).toBe('third');
  });

  it('clear resets state', () => {
    const buf = new ResumeBuffer(5);
    buf.add('x');
    buf.recordSequence(10);
    buf.clear();
    expect(buf.size()).toBe(0);
    expect(buf.getLastSequence()).toBe(-1);
  });
});

describe('MerchantStream', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('connects, validates handshake signature, resolves on session.start', async () => {
    let sigOk = false;
    server.setOnConnection((ws, req) => {
      sigOk = verifyHandshakeSignature(req);
      sendSessionStart(ws, 'sess-1');
    });

    const stream = new MerchantStream({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
      baseUrl: server.url,
      options: { reconnect: false, handshakeTimeoutMs: 5000 },
    });

    await stream.connect();
    expect(sigOk).toBe(true);
    expect(stream.isConnected()).toBe(true);
    expect(stream.getSessionId()).toBe('sess-1');
    await stream.close();
  });

  it('emits typed event listeners and the generic event channel', async () => {
    server.setOnConnection((ws) => {
      sendSessionStart(ws);
      ws.send(JSON.stringify(makeEvent(1, 'merchant.trades.completed', { eventId: 'evt-1' })));
    });

    const stream = new MerchantStream({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
      baseUrl: server.url,
      options: { reconnect: false },
    });

    const generic: MerchantEvent[] = [];
    const typed: MerchantEvent[] = [];
    stream.on('event', (e) => generic.push(e));
    stream.on('merchant.trades.completed', (e) => typed.push(e));

    await stream.connect();
    await new Promise((r) => setTimeout(r, 50));

    expect(generic).toHaveLength(1);
    expect(typed).toHaveLength(1);
    expect(generic[0].eventId).toBe('evt-1');
    expect(typed[0].eventId).toBe('evt-1');
    await stream.close();
  });

  it('dedupes events with the same eventId', async () => {
    server.setOnConnection((ws) => {
      sendSessionStart(ws);
      const evt = makeEvent(1, 'merchant.orders.created', { eventId: 'dup-1' });
      ws.send(JSON.stringify(evt));
      ws.send(JSON.stringify({ ...(evt as object), sequence: 2 }));
    });

    const stream = new MerchantStream({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
      baseUrl: server.url,
      options: { reconnect: false },
    });

    const seen: MerchantEvent[] = [];
    stream.on('event', (e) => seen.push(e));

    await stream.connect();
    await new Promise((r) => setTimeout(r, 50));

    expect(seen).toHaveLength(1);
    expect(seen[0].eventId).toBe('dup-1');
    await stream.close();
  });

  it('detects sequence gaps via SequenceGapError on the error channel', async () => {
    server.setOnConnection((ws) => {
      sendSessionStart(ws);
      ws.send(JSON.stringify(makeEvent(1, 'merchant.trades.completed', { eventId: 'a' })));
      ws.send(JSON.stringify(makeEvent(2, 'merchant.trades.completed', { eventId: 'b' })));
      ws.send(JSON.stringify(makeEvent(5, 'merchant.trades.completed', { eventId: 'c' })));
    });

    const stream = new MerchantStream({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
      baseUrl: server.url,
      options: { reconnect: false },
    });

    const errors: Error[] = [];
    stream.on('error', (e) => errors.push(e));

    await stream.connect();
    await new Promise((r) => setTimeout(r, 50));

    const gaps = errors.filter((e) => e instanceof SequenceGapError) as SequenceGapError[];
    expect(gaps).toHaveLength(1);
    expect(gaps[0].expected).toBe(3);
    expect(gaps[0].actual).toBe(5);
    await stream.close();
  });

  it('emits ResumeUnavailableError on system.resume_unavailable', async () => {
    server.setOnConnection((ws) => {
      sendSessionStart(ws);
      ws.send(JSON.stringify({ type: 'system.resume_unavailable', code: 'RESUME_UNAVAILABLE' }));
    });

    const stream = new MerchantStream({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
      baseUrl: server.url,
      options: { reconnect: false },
    });

    const errors: Error[] = [];
    stream.on('error', (e) => errors.push(e));

    await stream.connect();
    await new Promise((r) => setTimeout(r, 50));

    expect(errors.some((e) => e instanceof ResumeUnavailableError)).toBe(true);
    await stream.close();
  });

  it('does NOT reconnect on AUTH_FAILED (4001)', async () => {
    let connections = 0;
    server.setOnConnection((ws) => {
      connections += 1;
      ws.close(4001, 'auth failed');
    });

    const stream = new MerchantStream({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
      baseUrl: server.url,
      options: {
        reconnect: true,
        reconnectBaseDelayMs: 10,
      },
    });

    let rejection: unknown = null;
    try {
      await stream.connect();
    } catch (e) {
      rejection = e;
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(connections).toBe(1);
    expect(rejection).toBeTruthy();
    await stream.close();
  });

  it('reconnects on ABNORMAL_CLOSE (1006) when reconnect=true', async () => {
    let connections = 0;
    let reconnects = 0;
    server.setOnConnection((ws) => {
      connections += 1;
      sendSessionStart(ws, `sess-${connections}`);
      if (connections === 1) {
        // Force a TCP-level abnormal close.
        setTimeout(() => ws.terminate(), 30);
      }
    });

    const stream = new MerchantStream({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
      baseUrl: server.url,
      options: {
        reconnect: true,
        reconnectBaseDelayMs: 20,
        reconnectMaxDelayMs: 50,
      },
    });
    stream.on('reconnecting', () => {
      reconnects += 1;
    });

    await stream.connect();
    await new Promise((r) => setTimeout(r, 400));
    expect(connections).toBeGreaterThanOrEqual(2);
    expect(reconnects).toBeGreaterThanOrEqual(1);
    await stream.close();
  });

  it('on reconnect, sends Last-Event-Id header carrying the last seen eventId', async () => {
    let attempt = 0;
    let resumeHeader: string | undefined;
    server.setOnConnection((ws, req) => {
      attempt += 1;
      if (attempt === 1) {
        sendSessionStart(ws, 'sess-1');
        ws.send(JSON.stringify(makeEvent(1, 'merchant.orders.created', { eventId: 'evt-A' })));
        setTimeout(() => ws.terminate(), 30);
      } else {
        resumeHeader = req.headers['last-event-id'] as string | undefined;
        sendSessionStart(ws, 'sess-2');
      }
    });

    const stream = new MerchantStream({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
      baseUrl: server.url,
      options: {
        reconnect: true,
        reconnectBaseDelayMs: 20,
        reconnectMaxDelayMs: 50,
      },
    });

    await stream.connect();
    await new Promise((r) => setTimeout(r, 400));
    expect(attempt).toBeGreaterThanOrEqual(2);
    expect(resumeHeader).toBe('evt-A');
    await stream.close();
  });

  it('close() does not trigger reconnect', async () => {
    let connections = 0;
    server.setOnConnection((ws) => {
      connections += 1;
      sendSessionStart(ws);
    });

    const stream = new MerchantStream({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
      baseUrl: server.url,
      options: { reconnect: true, reconnectBaseDelayMs: 10 },
    });
    await stream.connect();
    await stream.close();
    await new Promise((r) => setTimeout(r, 150));
    expect(connections).toBe(1);
    expect(stream.isConnected()).toBe(false);
  });

  it('rejects an unsupported binary frame from the server', async () => {
    server.setOnConnection((ws) => {
      sendSessionStart(ws);
      ws.send(Buffer.from([0x01, 0x02, 0x03]), { binary: true });
    });

    const stream = new MerchantStream({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
      baseUrl: server.url,
      options: { reconnect: false },
    });
    const errors: Error[] = [];
    stream.on('error', (e) => errors.push(e));
    await stream.connect();
    await new Promise((r) => setTimeout(r, 100));
    expect(errors.some((e) => /binary/i.test(e.message))).toBe(true);
    await stream.close();
  });

  it('honours server.draining backoff hint on the next reconnect', async () => {
    let attempt = 0;
    const attemptTimes: number[] = [];
    server.setOnConnection((ws) => {
      attempt += 1;
      attemptTimes.push(Date.now());
      if (attempt === 1) {
        sendSessionStart(ws, 'sess-1');
        ws.send(JSON.stringify({ type: 'server.draining', reconnectAfterMs: 200 }));
        setTimeout(() => ws.close(1001, 'going away'), 20);
      } else {
        sendSessionStart(ws, 'sess-2');
      }
    });

    const stream = new MerchantStream({
      apiKey: TEST_API_KEY,
      hmacSecret: TEST_HMAC_SECRET,
      baseUrl: server.url,
      options: { reconnect: true, reconnectBaseDelayMs: 5 },
    });
    await stream.connect();
    await new Promise((r) => setTimeout(r, 600));
    expect(attempt).toBeGreaterThanOrEqual(2);
    if (attempt >= 2) {
      const delta = attemptTimes[1] - attemptTimes[0];
      // Allow generous slack: scheduling jitter + close handshake.
      expect(delta).toBeGreaterThanOrEqual(150);
    }
    await stream.close();
  });
});
