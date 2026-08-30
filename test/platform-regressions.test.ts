// Regression coverage for SaaS SDK fixes that had no unit test. Verifies that
// 1. platform.wallet.fundUser names the recipient as the acting user, since
//    the server treats fund-user as a per-end-user route
// 2. ScopedPaymentMethodsResource.list unwraps the {methods:[...]} envelope
// 3. a still-settling 409 is replayed on the SAME Idempotency-Key, which is
//    the property that makes retrying a money route safe at all
// 4. platform.users(uid).market.getMyRank attaches an acting user
//
// All transport-level, no network: axios.create is stubbed and every request
// config is captured.

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

interface StubResponse {
  status: number;
  headers?: Record<string, string>;
  data: string;
}

// Queues responses one per attempt so a retry can be given a different
// outcome from the call that triggered it. The last entry repeats once the
// queue drains, so single-response cases need no bookkeeping.
function buildClient(responses: StubResponse[], clientOpts: Record<string, unknown> = {}) {
  const captured: CapturedRequest[] = [];
  let index = 0;

  const fakeInstance = {
    request: vi.fn(async (cfg: any) => {
      captured.push({
        method: cfg.method,
        url: cfg.url,
        data: cfg.data,
        headers: cfg.headers
      });
      const next = responses[Math.min(index, responses.length - 1)];
      index++;
      return { status: next.status, headers: next.headers ?? {}, data: next.data };
    }),
    get: vi.fn(async () => ({
      data: { serverTime: Date.now(), iso: new Date().toISOString() }
    }))
  } as any;

  vi.spyOn(axios, 'create').mockReturnValue(fakeInstance);

  const client = new MerchantClient({
    apiKey: 'pk_test_regress',
    hmacSecret: 'whsec_regress_secret',
    baseUrl: 'https://api.example.test',
    skipInitialClockSample: true,
    ...clientOpts
  });

  return { client, captured };
}

const ok = (body: unknown): StubResponse => ({ status: 200, data: JSON.stringify(body) });

describe('client.platform.wallet.fundUser', () => {
  it('attaches X-PM-Acting-User equal to toUserId', async () => {
    const { client, captured } = buildClient([
      ok({ transferId: 'tr_1', toUserId: 'user_recipient', amount: '10', currency: 'USDT', status: 'completed' })
    ]);

    await client.platform.wallet.fundUser({
      toUserId: 'user_recipient',
      amount: '10',
      currency: 'USDT',
      source: 'bonus'
    });

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/merchant/wallet/fund-user');
    expect(req.headers?.['X-PM-Acting-User']).toBe('user_recipient');
    expect(req.headers?.['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('consumes idempotencyKey from the input rather than echoing it in the body', async () => {
    const { client, captured } = buildClient([ok({ transferId: 'tr_2' })]);

    await client.platform.wallet.fundUser({
      toUserId: 'user_recipient',
      amount: '10',
      currency: 'USDT',
      source: 'bonus',
      idempotencyKey: 'fund-user-regression-key'
    });

    const req = captured[0];
    expect(req.headers?.['Idempotency-Key']).toBe('fund-user-regression-key');
    expect(JSON.parse(req.data as string).idempotencyKey).toBeUndefined();
  });
});

describe('client.platform.users(userId).paymentMethods.list', () => {
  it('only advertises the read operation served by merchant-service', () => {
    const { client } = buildClient([]);
    const paymentMethods = client.platform.users('user_a').paymentMethods as unknown as
      Record<string, unknown>;

    expect(paymentMethods.list).toBeTypeOf('function');
    expect(paymentMethods.add).toBeUndefined();
    expect(paymentMethods.remove).toBeUndefined();
  });

  it('unwraps the {methods:[...]} envelope', async () => {
    const { client, captured } = buildClient([
      ok({
        methods: [
          { id: 'pm_1', methodType: 'bank_transfer', maskedAccount: '****1234', bankName: 'Bank', isVerified: true, readyForTrading: true, isDefault: true, createdAt: null },
          { id: 'pm_2', methodType: 'bank_transfer', maskedAccount: '****5678', bankName: 'Bank', isVerified: true, readyForTrading: true, isDefault: false, createdAt: null }
        ]
      })
    ]);

    const methods = await client.platform.users('user_a').paymentMethods.list();

    expect(methods).toHaveLength(2);
    expect(methods[0].id).toBe('pm_1');
    expect(methods[1].id).toBe('pm_2');
    expect(captured[0].headers?.['X-PM-Acting-User']).toBe('user_a');
  });

  it('passes a bare array through unchanged', async () => {
    const { client } = buildClient([ok([{ id: 'pm_bare', methodType: 'bank_transfer', maskedAccount: null, bankName: null, isVerified: true, readyForTrading: true, isDefault: true, createdAt: null }])]);

    const methods = await client.platform.users('user_a').paymentMethods.list();

    expect(methods).toHaveLength(1);
    expect(methods[0].id).toBe('pm_bare');
  });

  it('rejects a malformed methods envelope at the HTTP trust boundary', async () => {
    const { client } = buildClient([ok({ methods: null })]);

    await expect(client.platform.users('user_a').paymentMethods.list()).rejects.toThrow(
      /expected methods array/i
    );
  });
});

describe('still-settling 409 replay', () => {
  const inProgress = (code: string): StubResponse => ({
    status: 409,
    headers: { 'retry-after': '5' },
    data: JSON.stringify({ error: 'in_progress', code, retryable: true, retryAfter: 5 })
  });

  // retryMaxDelayMs caps the honoured Retry-After so the test does not sleep
  // for the five seconds the server asked for.
  const FAST_RETRY = { retryMaxDelayMs: 1 };

  it('retries a TRANSFER_IN_PROGRESS once and sends the SAME Idempotency-Key on both attempts', async () => {
    const { client, captured } = buildClient(
      [
        inProgress('TRANSFER_IN_PROGRESS'),
        ok({
          transferId: 'tr_settled',
          fromUserId: 'user_a',
          toUserId: 'user_b',
          amount: '25',
          currency: 'USDT',
          status: 'completed',
          createdAt: '2026-08-26T00:00:00.000Z'
        })
      ],
      FAST_RETRY
    );

    const result = await client.platform.users('user_a').wallet.transfer({
      toUserId: 'user_b',
      amount: '25',
      currency: 'USDT'
    });

    expect(captured).toHaveLength(2);
    const [first, second] = captured;

    // The property that makes retrying a money route safe: the replay lands on
    // the record the first attempt opened instead of starting a second one.
    const key = first.headers?.['Idempotency-Key'];
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(second.headers?.['Idempotency-Key']).toBe(key);

    // Same route, same body, same acting user on the replay.
    expect(second.url).toBe(first.url);
    expect(second.data).toBe(first.data);
    expect(second.headers?.['X-PM-Acting-User']).toBe('user_a');

    // Each attempt is signed afresh so the replay is not a replayed signature.
    expect(second.headers?.['X-Nonce']).not.toBe(first.headers?.['X-Nonce']);

    expect(result.transferId).toBe('tr_settled');
  });

  it('preserves a caller-supplied Idempotency-Key across the replay', async () => {
    const { client, captured } = buildClient(
      [inProgress('WITHDRAWAL_IN_PROGRESS'), ok({ withdrawalId: 'wd_settled', status: 'pending' })],
      FAST_RETRY
    );

    await client.platform.users('user_a').wallet.withdraw({
      amount: '5',
      currency: 'USDT',
      address: '0x00000000000000000000000000000000deadbeef',
      idempotencyKey: 'caller-supplied-withdraw-key'
    });

    expect(captured).toHaveLength(2);
    expect(captured[0].headers?.['Idempotency-Key']).toBe('caller-supplied-withdraw-key');
    expect(captured[1].headers?.['Idempotency-Key']).toBe('caller-supplied-withdraw-key');
  });

  it('stops at maxRetries rather than replaying a persistent conflict forever', async () => {
    const { client, captured } = buildClient([inProgress('TRANSFER_IN_PROGRESS')], {
      ...FAST_RETRY,
      maxRetries: 2
    });

    await expect(
      client.platform.users('user_a').wallet.transfer({
        toUserId: 'user_b',
        amount: '25',
        currency: 'USDT'
      })
    ).rejects.toMatchObject({ status: 409, code: 'TRANSFER_IN_PROGRESS' });

    expect(captured).toHaveLength(3);
  });

  it('does not replay a 409 the server did not mark as still settling', async () => {
    const { client, captured } = buildClient(
      [
        {
          status: 409,
          headers: {},
          data: JSON.stringify({ error: 'conflict', code: 'IDEMPOTENCY_KEY_CONFLICT' })
        }
      ],
      FAST_RETRY
    );

    await expect(
      client.platform.users('user_a').wallet.transfer({
        toUserId: 'user_b',
        amount: '25',
        currency: 'USDT'
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });

    expect(captured).toHaveLength(1);
  });
});

describe('client.platform.users(userId).market.getMyRank', () => {
  it('GETs the my-rank path with X-PM-Acting-User attached', async () => {
    const { client, captured } = buildClient([
      ok({ orderId: 'order_1', rank: 3, totalCompetitors: 12, score: 88.5, factors: { price: 40 } })
    ]);

    const rank = await client.platform.users('user_a').market.getMyRank('order_1');

    const req = captured[0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/api/v1/merchant/market/my-rank/order_1');
    expect(req.headers?.['X-PM-Acting-User']).toBe('user_a');
    expect(rank.rank).toBe(3);
    expect(rank.totalCompetitors).toBe(12);
  });
});
