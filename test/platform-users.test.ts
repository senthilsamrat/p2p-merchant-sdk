// Platform-namespace coverage. Verifies that
// 1. client.platform.users.create posts to the correct path with the input body
// 2. client.platform.users(uid).wallet.getBalance issues a GET to the
//    user-scoped wallet path with X-PM-Acting-User attached
// 3. client.platform.users(uid).orders.create attaches X-PM-Acting-User on
//    the standard orders endpoint
// 4. switchMerchant is available only through the acting-user scoped client
// 5. SDK-managed headers cannot be clobbered by a caller-supplied extras map
// 6. Revshare endpoints are reachable via client.platform.revshare

import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import { MerchantClient } from '../src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

interface CapturedRequest {
  method?: string;
  url?: string;
  data?: unknown;
  headers?: Record<string, string>;
}

function buildClient() {
  const captured: CapturedRequest[] = [];

  // Patch axios.create so MerchantClient's HttpTransport spins up a fake.
  const fakeInstance = {
    request: vi.fn(async (cfg: any) => {
      captured.push({
        method: cfg.method,
        url: cfg.url,
        data: cfg.data,
        headers: cfg.headers
      });
      const body = cfg.url === '/api/v1/merchant/orders'
        ? {
            order: {
              orderId: 'order_test',
              type: 'sell',
              cryptocurrency: 'USDT',
              fiatCurrency: 'KRW',
              amount: 100,
              remainingAmount: 100,
              price: 1320.5,
              status: 'active',
              paymentMethods: ['Bank Transfer'],
              timeLimit: 60,
              createdAt: '2026-08-29T00:00:00.000Z',
              updatedAt: '2026-08-29T00:00:00.000Z'
            }
          }
        : cfg.url === '/api/v1/merchant/account'
          ? {
              merchantId: 'merchant_test',
              tier: 'enterprise',
              status: 'active',
              expressEligible: true,
              expressAvailable: false,
              kycStatus: 'verified',
              permissions: ['account:read'],
              createdAt: '2026-08-29T00:00:00.000Z'
            }
        : cfg.url?.includes('/wallet/balance')
          ? { balances: [] }
          : { ok: true };
      return { status: 200, headers: {}, data: JSON.stringify(body) };
    }),
    get: vi.fn(async () => ({
      data: { serverTime: Date.now(), iso: new Date().toISOString() }
    }))
  } as any;

  vi.spyOn(axios, 'create').mockReturnValue(fakeInstance);

  const client = new MerchantClient({
    apiKey: 'pk_test_abc',
    hmacSecret: 'whsec_test_secret',
    baseUrl: 'https://api.example.test',
    skipInitialClockSample: true
  });

  return { client, captured };
}

describe('client.platform.users.create', () => {
  it('POSTs to /api/v1/merchant/users with the input body', async () => {
    const { client, captured } = buildClient();
    await client.platform.users.create({
      externalUserId: 'tradekr_user_123',
      email: 'user@tradekr.example',
      kycLevelRequired: 2
    });
    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/merchant/users');
    const parsed = JSON.parse(req.data as string);
    expect(parsed).toEqual({
      externalUserId: 'tradekr_user_123',
      email: 'user@tradekr.example',
      kycLevelRequired: 2
    });
    expect(req.headers?.['X-API-Key']).toBe('pk_test_abc');
    expect(req.headers?.['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(req.headers?.['Idempotency-Key']).toMatch(/^[0-9a-f]{32}$/);
    // create() is not user-scoped; no acting-user header.
    expect(req.headers?.['X-PM-Acting-User']).toBeUndefined();
  });
});

describe('client.platform.users(userId).wallet.getBalance', () => {
  it('GETs /api/v1/merchant/users/:userId/wallet/balance with X-PM-Acting-User', async () => {
    const { client, captured } = buildClient();
    await client.platform.users('user_abc123').wallet.getBalance();
    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/api/v1/merchant/users/user_abc123/wallet/balance');
    expect(req.headers?.['X-PM-Acting-User']).toBe('user_abc123');
    expect(req.headers?.['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('passes the currency query when supplied', async () => {
    const { client, captured } = buildClient();
    await client.platform.users('user_abc').wallet.getBalance({ currency: 'KRW' });
    const req = captured[0];
    expect(req.url).toBe('/api/v1/merchant/users/user_abc/wallet/balance?currency=KRW');
  });
});

describe('client.platform.users(userId).orders.create', () => {
  it('POSTs the standard orders endpoint with X-PM-Acting-User', async () => {
    const { client, captured } = buildClient();
    await client.platform.users('user_xyz').orders.create({
      type: 'sell',
      cryptocurrency: 'USDT',
      fiatCurrency: 'KRW',
      amount: '100.00000000',
      price: '1320.50',
      paymentMethods: ['Bank Transfer'],
      timeLimit: 60
    });
    const req = captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/merchant/orders');
    expect(req.headers?.['X-PM-Acting-User']).toBe('user_xyz');
    expect(req.headers?.['Idempotency-Key']).toMatch(/^[0-9a-f]{32}$/);
    const parsed = JSON.parse(req.data as string);
    expect(parsed.cryptocurrency).toBe('USDT');
    expect(parsed.amount).toBe('100.00000000');
  });
});

describe('client.platform.users(userId).trades.switchMerchant', () => {
  it('POSTs the quick-trade route with X-PM-Acting-User', async () => {
    const { client, captured } = buildClient();
    await client.platform.users('buyer_123').trades.switchMerchant('trade_123', {
      reason: 'better payment window'
    });
    const req = captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/merchant/quick/trade_123/switch-merchant');
    expect(req.headers?.['X-PM-Acting-User']).toBe('buyer_123');
    expect(JSON.parse(req.data as string)).toEqual({ reason: 'better payment window' });
  });
});

describe('client.platform.users(userId).wallet.transfer', () => {
  it('POSTs the per-user transfer path with X-PM-Acting-User', async () => {
    const { client, captured } = buildClient();
    await client.platform.users('danny').wallet.transfer({
      toUserId: 'bob',
      amount: '10.5',
      currency: 'KRW',
      memo: 'rent split'
    });
    const req = captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/merchant/users/danny/wallet/transfer');
    expect(req.headers?.['X-PM-Acting-User']).toBe('danny');
    const parsed = JSON.parse(req.data as string);
    expect(parsed).toEqual({ toUserId: 'bob', amount: '10.5', currency: 'KRW', memo: 'rent split' });
    // idempotencyKey was not in the input; transport must auto-generate one.
    expect(req.headers?.['Idempotency-Key']).toMatch(/^[0-9a-f]{32}$/);
  });

  it('honours a caller-supplied idempotency key', async () => {
    const { client, captured } = buildClient();
    await client.platform.users('danny').wallet.transfer({
      toUserId: 'bob',
      amount: '1.00',
      currency: 'KRW',
      idempotencyKey: 'transfer:rent:2026-04-23'
    });
    const req = captured[0];
    expect(req.headers?.['Idempotency-Key']).toBe('transfer:rent:2026-04-23');
    const parsed = JSON.parse(req.data as string);
    // idempotencyKey is consumed for the header, not echoed in the body.
    expect(parsed.idempotencyKey).toBeUndefined();
  });
});

describe('client.platform.users(userId).kyc', () => {
  it('start() POSTs the kyc/start path with the level body', async () => {
    const { client, captured } = buildClient();
    await client.platform.users('user_kyc').kyc.start({ level: 2, returnUrl: 'https://tradekr.example/kyc/callback' });
    const req = captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/merchant/users/user_kyc/kyc/start');
    expect(req.headers?.['X-PM-Acting-User']).toBe('user_kyc');
    const parsed = JSON.parse(req.data as string);
    expect(parsed).toEqual({ level: 2, returnUrl: 'https://tradekr.example/kyc/callback' });
  });

  it('get() GETs the kyc status path', async () => {
    const { client, captured } = buildClient();
    await client.platform.users('user_kyc').kyc.get();
    const req = captured[0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/api/v1/merchant/users/user_kyc/kyc');
    expect(req.headers?.['X-PM-Acting-User']).toBe('user_kyc');
  });
});

describe('client.platform.users(userId) lifecycle ops', () => {
  it('suspend() POSTs the suspend path with the reason body', async () => {
    const { client, captured } = buildClient();
    await client.platform.users('u1').suspend({ reason: 'manual review' });
    const req = captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/merchant/users/u1/suspend');
    expect(req.headers?.['X-PM-Acting-User']).toBe('u1');
    expect(JSON.parse(req.data as string)).toEqual({ reason: 'manual review' });
  });

  it('restore() POSTs the restore path with empty body', async () => {
    const { client, captured } = buildClient();
    await client.platform.users('u1').restore();
    const req = captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/merchant/users/u1/restore');
    expect(req.headers?.['X-PM-Acting-User']).toBe('u1');
  });

  it('softDelete() DELETEs the user path', async () => {
    const { client, captured } = buildClient();
    await client.platform.users('u1').softDelete({ deletionReason: 'GDPR right to erasure' });
    const req = captured[0];
    expect(req.method).toBe('DELETE');
    expect(req.url).toBe('/api/v1/merchant/users/u1');
    expect(req.headers?.['X-PM-Acting-User']).toBe('u1');
  });
});

describe('SDK-managed headers cannot be clobbered by extraHeaders', () => {
  it('extraHeaders cannot overwrite X-API-Key or X-Signature', async () => {
    const { client, captured } = buildClient();
    await client.account.get({
      extraHeaders: {
        'X-API-Key': 'attacker-key',
        'X-Signature': 'forged-sig',
        'X-Custom-Trace': 'trace-123'
      }
    });
    const req = captured[0];
    expect(req.headers?.['X-API-Key']).toBe('pk_test_abc');
    expect(req.headers?.['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(req.headers?.['X-Signature']).not.toBe('forged-sig');
    // Caller-defined non-conflicting headers do pass through.
    expect(req.headers?.['X-Custom-Trace']).toBe('trace-123');
  });
});

describe('client.platform.revshare', () => {
  it('getEarnings() GETs the revshare earnings path with from/to query', async () => {
    const { client, captured } = buildClient();
    await client.platform.revshare.getEarnings({ from: '2026-01-01', to: '2026-04-01' });
    const req = captured[0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/api/v1/merchant/revshare/earnings?from=2026-01-01&to=2026-04-01');
    // Revshare is merchant-level, not user-scoped; no acting-user header.
    expect(req.headers?.['X-PM-Acting-User']).toBeUndefined();
  });

  it('createProposal() POSTs the proposals path with body', async () => {
    const { client, captured } = buildClient();
    await client.platform.revshare.createProposal({
      splits: [
        { target: 'merchant', basisPoints: 4000 },
        { target: 'platform', basisPoints: 4000 },
        { target: 'house', basisPoints: 2000 }
      ],
      rationale: 'Q2 fee restructure'
    });
    const req = captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/merchant/revshare/config/proposals');
    expect(req.headers?.['Idempotency-Key']).toMatch(/^[0-9a-f]{32}$/);
    const parsed = JSON.parse(req.data as string);
    expect(parsed.splits).toHaveLength(3);
    expect(parsed.rationale).toBe('Q2 fee restructure');
  });

  it('testWebhook() POSTs the test path', async () => {
    const { client, captured } = buildClient();
    await client.platform.revshare.testWebhook();
    const req = captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/merchant/revshare/webhooks/test');
  });
});

describe('client.platform.users(userId) input validation', () => {
  it('throws when called with an empty userId', () => {
    const { client } = buildClient();
    expect(() => client.platform.users('')).toThrow(/userId is required/);
  });
});
