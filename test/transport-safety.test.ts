import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { MerchantClient } from '../src/client.js';
import { MerchantStream } from '../src/stream/MerchantStream.js';
import { HttpTransport } from '../src/transport/httpTransport.js';
import { ClockDriftTracker } from '../src/transport/recvWindow.js';
import { DEFAULT_RETRY_CONFIG } from '../src/transport/retry.js';

const servers: Server[] = [];
const originalHttpProxy = process.env.HTTP_PROXY;
const originalNoProxy = process.env.NO_PROXY;

async function listen(handler: Parameters<typeof createServer>[0]): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  if (originalHttpProxy === undefined) delete process.env.HTTP_PROXY;
  else process.env.HTTP_PROXY = originalHttpProxy;
  if (originalNoProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = originalNoProxy;
  await Promise.all(servers.splice(0).map(
    (server) => new Promise<void>((resolve) => server.close(() => resolve()))
  ));
});

describe('transport URL policy', () => {
  it('rejects non-loopback plaintext REST and WebSocket URLs by default', () => {
    expect(() => new MerchantClient({
      apiKey: 'pk_test',
      hmacSecret: 'secret',
      baseUrl: 'http://api.example.test',
      skipInitialClockSample: true
    })).toThrow(/refusing plaintext/);

    expect(() => new MerchantStream({
      apiKey: 'pk_test',
      hmacSecret: 'secret',
      baseUrl: 'ws://stream.example.test'
    })).toThrow(/refusing plaintext/);
  });

  it('allows explicit insecure development transport opt-in', () => {
    const client = new MerchantClient({
      apiKey: 'pk_test',
      hmacSecret: 'secret',
      baseUrl: 'http://api.example.test',
      allowInsecureTransport: true,
      skipInitialClockSample: true
    });
    expect(client.describe().baseUrl).toBe('http://api.example.test');
  });

  it('never proxies the plaintext loopback exception', async () => {
    let targetHits = 0;
    let proxyHits = 0;
    const target = await listen((_req, res) => {
      targetHits++;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
    const proxy = await listen((_req, res) => {
      proxyHits++;
      res.statusCode = 502;
      res.end();
    });
    process.env.HTTP_PROXY = proxy.url;
    process.env.NO_PROXY = '';

    const transport = new HttpTransport({
      apiKey: 'pk_test',
      hmacSecret: 'secret',
      baseUrl: target.url.replace('127.0.0.1', 'localhost'),
      recvWindowMs: 5000,
      timeoutMs: 1000,
      retry: { ...DEFAULT_RETRY_CONFIG, maxRetries: 0 },
      clock: new ClockDriftTracker(),
      userAgent: 'transport-safety-test'
    });

    await expect(transport.request({ method: 'GET', path: '/signed' }))
      .resolves.toEqual({ ok: true });
    expect(targetHits).toBe(1);
    expect(proxyHits).toBe(0);
  });
});

describe('redirect policy', () => {
  it('does not forward signed headers across a redirect', async () => {
    let targetHits = 0;
    const target = await listen((_req, res) => {
      targetHits++;
      res.setHeader('Content-Type', 'application/json');
      res.end('{"ok":true}');
    });
    const origin = await listen((_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', `${target.url}/captured`);
      res.end();
    });
    const transport = new HttpTransport({
      apiKey: 'pk_test',
      hmacSecret: 'secret',
      baseUrl: origin.url,
      recvWindowMs: 5000,
      timeoutMs: 1000,
      retry: { ...DEFAULT_RETRY_CONFIG, maxRetries: 0 },
      clock: new ClockDriftTracker(),
      userAgent: 'transport-safety-test'
    });

    await expect(transport.request({ method: 'GET', path: '/signed' })).rejects.toBeDefined();
    expect(targetHits).toBe(0);
  });

  it('keeps redirects available for the unsigned public time request', async () => {
    let receivedSensitiveHeader = false;
    const target = await listen((req, res) => {
      receivedSensitiveHeader = Boolean(
        req.headers['x-api-key'] || req.headers['x-signature'] || req.headers['x-timestamp']
      );
      res.setHeader('Content-Type', 'application/json');
      res.end('{"serverTime":"2026-08-30T00:00:00.000Z","serverTimeMs":1788048000000}');
    });
    const origin = await listen((_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', `${target.url}/time`);
      res.end();
    });
    const transport = new HttpTransport({
      apiKey: 'pk_test',
      hmacSecret: 'secret',
      baseUrl: origin.url,
      recvWindowMs: 5000,
      timeoutMs: 1000,
      retry: { ...DEFAULT_RETRY_CONFIG, maxRetries: 0 },
      clock: new ClockDriftTracker(),
      userAgent: 'transport-safety-test'
    });

    await expect(transport.request(
      { method: 'GET', path: '/api/v1/merchant/time' },
      { unsigned: true }
    )).resolves.toMatchObject({ serverTimeMs: 1788048000000 });
    expect(receivedSensitiveHeader).toBe(false);
  });
});
