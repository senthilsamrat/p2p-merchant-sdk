import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { MerchantClient, SDK_METADATA } from '../src/index.js';

interface CapturedRequest {
  method?: string;
  url?: string;
  data?: unknown;
  headers?: Record<string, string>;
}

function buildClient(responses: unknown[]) {
  const captured: CapturedRequest[] = [];
  let responseIndex = 0;
  const fakeInstance = {
    request: vi.fn(async (config: any) => {
      captured.push(config);
      const data = responses[Math.min(responseIndex, responses.length - 1)];
      responseIndex += 1;
      return { status: 200, headers: {}, data: JSON.stringify(data) };
    }),
    get: vi.fn(async () => ({
      data: { serverTime: Date.now(), iso: new Date().toISOString() },
    })),
  } as any;
  vi.spyOn(axios, 'create').mockReturnValue(fakeInstance);
  return {
    captured,
    client: new MerchantClient({
      apiKey: 'pk_test_contract',
      hmacSecret: 'contract-test-secret',
      baseUrl: 'https://api.example.test',
      skipInitialClockSample: true,
    }),
  };
}

const ORDER = {
  orderId: 'o-1',
  type: 'sell',
  cryptocurrency: 'USDT',
  fiatCurrency: 'KRW',
  amount: 100,
  remainingAmount: 90,
  price: 1400,
  status: 'active',
  minTradeAmount: 10,
  maxTradeAmount: 50,
  paymentMethods: ['Bank Transfer'],
  timeLimit: 60,
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:01:00.000Z',
};

const TRADE = {
  tradeId: 't-1',
  orderId: 'o-1',
  type: 'buy',
  cryptocurrency: 'USDT',
  fiatCurrency: 'KRW',
  amount: 10,
  price: 1400,
  totalValue: 14000,
  status: 'payment_pending',
  source: 'marketplace',
  buyerId: 'u-buyer',
  sellerId: 'u-seller',
  paymentMethod: 'Bank Transfer',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:01:00.000Z',
};

afterEach(() => vi.restoreAllMocks());

describe('order contracts', () => {
  it('unwraps create and sends canonical limit fields', async () => {
    const { client, captured } = buildClient([{ success: true, order: ORDER }]);
    const order = await client.orders.create({
      type: 'sell',
      cryptocurrency: 'USDT',
      fiatCurrency: 'KRW',
      amount: '100',
      price: '1400',
      minTradeAmount: '10',
      maxTradeAmount: '50',
      paymentMethods: ['Bank Transfer'],
      timeLimit: 60,
    });
    expect(order.orderId).toBe('o-1');
    expect(order.amount).toBe('100');
    expect(order.minTradeAmount).toBe('10');
    const body = JSON.parse(captured[0].data as string);
    expect(body.minTradeAmount).toBe('10');
    expect(body.maxTradeAmount).toBe('50');
    expect(body.minAmount).toBeUndefined();
  });

  it('routes pause separately and returns the cancellation wire result', async () => {
    const { client, captured } = buildClient([
      { order: { ...ORDER, status: 'paused' } },
      { message: 'Order cancelled successfully', orderId: 'o-1' },
    ]);
    await client.orders.update('o-1', { status: 'paused' });
    const cancelled = await client.orders.cancel('o-1');
    expect(captured[0].method).toBe('POST');
    expect(captured[0].url).toBe('/api/v1/merchant/orders/o-1/pause');
    expect(cancelled).toEqual({ orderId: 'o-1', message: 'Order cancelled successfully' });
  });

  it('rejects invalid or mixed lifecycle updates before sending HTTP', async () => {
    const { client, captured } = buildClient([{ order: ORDER }]);
    await expect(client.orders.update('o-1', { status: 'cancelled' } as any)).rejects.toThrow();
    await expect(client.orders.update('o-1', { status: 'paused', price: '1500' } as any)).rejects.toThrow();
    expect(captured).toHaveLength(0);
  });
});

describe('trade and chat contracts', () => {
  it('unwraps full trades and preserves partial mutation results', async () => {
    const { client } = buildClient([
      { trade: TRADE },
      { message: 'Payment marked as sent', trade: { tradeId: 't-1', status: 'payment_sent' } },
    ]);
    const trade = await client.trades.get('t-1');
    const action = await client.trades.markPaymentSent('t-1');
    expect(trade.totalValue).toBe('14000');
    expect(trade.paymentMethod).toBe('Bank Transfer');
    expect(action).toEqual({ tradeId: 't-1', status: 'payment_sent' });
  });

  it('uses the before cursor and normalizes image/timestamp fields', async () => {
    const { client, captured } = buildClient([{
      messages: [{
        messageId: 'm-1',
        senderId: 'u-1',
        content: 'https://cdn.example/image.png',
        type: 'attachment',
        timestamp: '2026-08-29T00:00:00.000Z',
      }],
      hasMore: true,
      nextCursor: '50',
    }]);
    const page = await client.trades.listMessages('t-1', { limit: 50, before: '0' });
    expect(captured[0].url).toContain('before=0');
    expect(captured[0].url).not.toContain('since=');
    expect(page.messages[0].type).toBe('image_url');
    expect(page.messages[0].timestamp).toBe('2026-08-29T00:00:00.000Z');
    expect(page.nextCursor).toBe('50');
  });

  it('unwraps dispute responses', async () => {
    const { client } = buildClient([{ dispute: { disputeId: 'd-1', status: 'open' } }]);
    await expect(client.trades.dispute('t-1', { reason: 'payment_not_received' }))
      .resolves.toEqual({ disputeId: 'd-1', status: 'open' });
  });
});

describe('merchant-service response contracts', () => {
  it('normalizes wallet holds, payment methods, and analytics', async () => {
    const { client } = buildClient([
      { holds: [{ id: 'h-1', currency: 'USDT', amount: '5', reason: 'escrow', tradeId: 't-1', escrowId: 'e-1', createdAt: '2026-08-29T00:00:00.000Z', expiresAt: null }] },
      { methods: [{ id: 'pm-1', methodType: 'bank_transfer', maskedAccount: '****1234', bankName: 'Bank', isVerified: true, readyForTrading: true, isDefault: true, createdAt: null }] },
      { window: '30d', tradeCount: 3, completionRate: 100, volumeUsdt: '30', revenueUsdt: '1', avgTradeTimeSeconds: 90, disputeRate: 0, topCurrencies: [{ code: 'USDT', volumeUsdt: '30' }] },
    ]);
    expect((await client.wallet.getHolds())[0].id).toBe('h-1');
    expect((await client.paymentMethods.list())[0].methodType).toBe('bank_transfer');
    expect((await client.analytics.getStats()).tradeCount).toBe(3);
  });

  it('unwraps webhook config and maps logs plus cursor pagination', async () => {
    const { client } = buildClient([
      { webhook: { url: 'https://merchant.example/webhook', events: ['trade.completed'], active: true } },
      { logs: [{ id: 'l-1', eventType: 'trade.completed', status: 'delivered', responseCode: 200, durationMs: 15, retryCount: 1, deliveredAt: '2026-08-29T00:00:00.000Z', errorMessage: null, createdAt: '2026-08-29T00:00:00.000Z' }], pagination: { limit: 1, nextCursor: '2026-08-28T00:00:00.000Z' } },
    ]);
    expect((await client.webhooks.getConfig()).url).toBe('https://merchant.example/webhook');
    const logs = await client.webhooks.getLogs({ limit: 1 });
    expect(logs.items[0].eventType).toBe('trade.completed');
    expect(logs.hasMore).toBe(true);
    expect(logs.nextCursor).toBe('2026-08-28T00:00:00.000Z');
  });

  it('returns the webhook test acknowledgement exposed by merchant-service', async () => {
    const { client } = buildClient([{ success: true, message: 'Test webhook sent' }]);
    await expect(client.webhooks.test('trade.completed')).resolves.toEqual({
      success: true,
      message: 'Test webhook sent',
    });
  });

  it('validates the account and best-price summary contracts', async () => {
    const { client } = buildClient([
      {
        merchantId: 'MER-1', tier: 'professional', status: 'active',
        expressEligible: true, expressAvailable: false, kycStatus: 'verified',
        permissions: ['account:read'], createdAt: '2026-08-29T00:00:00.000Z'
      },
      {
        crypto: 'USDT', fiat: 'KRW', bestBuy: null, bestSell: null,
        spread: null, spreadPercent: null
      },
      {
        crypto: 'USDT', fiat: 'KRW',
        bestBuy: { price: '1400', lastUpdated: '2026-08-29T00:00:00.000Z' },
        bestSell: { price: '1390', lastUpdated: '2026-08-29T00:00:00.000Z' },
        spread: '10', spreadPercent: '0.7194'
      }
    ]);
    expect((await client.account.get()).permissions).toEqual(['account:read']);
    expect((await client.market.getBestPrices('USDT', 'KRW')).spread).toBeNull();
    expect((await client.market.getBestPrices('USDT', 'KRW')).bestBuy?.price).toBe('1400');
  });
});

describe('runtime metadata', () => {
  it('matches the package release version', () => {
    expect(SDK_METADATA.version).toBe('0.3.0-beta.0');
  });
});
