// SaaS quick-trade SDK coverage. Verifies that
// 1. client.platform.users(uid).quickTrade.bestMatch GETs the per-user
//    best-match path with X-PM-Acting-User attached and a signed HMAC
// 2. client.platform.users(uid).quickTrade.initiate POSTs the per-user
//    initiate path, attaches X-PM-Acting-User, accepts a caller-supplied
//    Idempotency-Key, and consumes idempotencyKey from input rather than
//    echoing it in the body
// 3. client.platform.quickTrade.{pairs,featuredMerchants,recentActivity,
//    platformStats} hit the merchant-scope /api/v1/merchant/quick/* paths
//    without an acting user header
// 4. The {success, data} envelope is unwrapped consistently for all
//    quick-trade responses

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

function buildClient(responseBody: string = '{"success":true,"data":{}}') {
  const captured: CapturedRequest[] = [];
  const fakeResponse = {
    status: 200,
    headers: {},
    data: responseBody
  };

  const fakeInstance = {
    request: vi.fn(async (cfg: any) => {
      captured.push({
        method: cfg.method,
        url: cfg.url,
        data: cfg.data,
        headers: cfg.headers
      });
      return fakeResponse;
    }),
    get: vi.fn(async () => ({
      data: { serverTime: Date.now(), iso: new Date().toISOString() }
    }))
  } as any;

  vi.spyOn(axios, 'create').mockReturnValue(fakeInstance);

  const client = new MerchantClient({
    apiKey: 'pk_test_quick',
    hmacSecret: 'whsec_quick_secret',
    baseUrl: 'https://api.example.test',
    skipInitialClockSample: true
  });

  return { client, captured };
}

describe('client.platform.users(userId).quickTrade.bestMatch', () => {
  it('GETs /api/v1/merchant/users/:userId/quick/best-match with X-PM-Acting-User and query params', async () => {
    const body = JSON.stringify({
      success: true,
      data: {
        merchant: { id: 'm1', username: 'm1', tier: 'enterprise', rating: 4.8, completionRate: 0.99, avgResponseTime: 30, totalTrades: 100, isOnline: true, parentMerchantId: 'parent_a' },
        order: { orderId: 'o_xyz', price: 1450, availableAmount: 100, minTradeAmount: 5, maxTradeAmount: 200, paymentMethods: ['Bank Transfer'] },
        quote: { youPay: 14500, youReceive: 10, rate: 1450, fees: { platform: 14.5, total: 14.5 } },
        priorityScore: 95.2
      }
    });
    const { client, captured } = buildClient(body);
    const match = await client.platform.users('user_buyer').quickTrade.bestMatch({
      cryptocurrency: 'USDT',
      fiatCurrency: 'KRW',
      type: 'buy',
      amount: '10'
    });
    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/api/v1/merchant/users/user_buyer/quick/best-match?cryptocurrency=USDT&fiatCurrency=KRW&type=buy&amount=10');
    expect(req.headers?.['X-PM-Acting-User']).toBe('user_buyer');
    expect(req.headers?.['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(match.merchant.id).toBe('m1');
    expect(match.matchedOrder.orderId).toBe('o_xyz');
    expect(match.order.orderId).toBe('o_xyz');
    expect(match.priorityScore).toBe(95.2);
  });

  it('forwards optional paymentMethod query when supplied', async () => {
    const body = JSON.stringify({
      success: true,
      data: {
        merchant: { id: 'm1', username: 'm1', tier: 'business', rating: 4, completionRate: 0.9, avgResponseTime: 60, totalTrades: 5, isOnline: true },
        order: { orderId: 'o', price: 1, availableAmount: 1, minTradeAmount: 1, maxTradeAmount: 1, paymentMethods: ['Bank Transfer'] },
        quote: { youPay: 1, youReceive: 1, rate: 1, fees: { platform: 0, total: 0 } },
        priorityScore: 0
      }
    });
    const { client, captured } = buildClient(body);
    await client.platform.users('user_a').quickTrade.bestMatch({
      cryptocurrency: 'USDT',
      fiatCurrency: 'KRW',
      type: 'sell',
      amount: '5',
      paymentMethod: 'Bank Transfer'
    });
    const req = captured[0];
    expect(req.url).toContain('paymentMethod=Bank%20Transfer');
  });
});

describe('client.platform.users(userId).quickTrade.initiate', () => {
  it('POSTs /api/v1/merchant/users/:userId/quick/initiate with X-PM-Acting-User and an auto-generated Idempotency-Key', async () => {
    const body = JSON.stringify({
      success: true,
      data: {
        tradeId: 'trade_abc',
        orderId: 'order_xyz',
        buyerId: 'user_buyer',
        sellerId: 'user_seller',
        cryptocurrency: 'USDT',
        fiatCurrency: 'KRW',
        amount: '10',
        price: '1450',
        totalValue: '14500',
        status: 'initiated',
        paymentMethod: 'Bank Transfer'
      }
    });
    const { client, captured } = buildClient(body);
    const trade = await client.platform.users('user_buyer').quickTrade.initiate({
      cryptocurrency: 'USDT',
      fiatCurrency: 'KRW',
      type: 'buy',
      amount: '10',
      paymentMethod: 'Bank Transfer'
    });
    const req = captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/merchant/users/user_buyer/quick/initiate');
    expect(req.headers?.['X-PM-Acting-User']).toBe('user_buyer');
    expect(req.headers?.['Idempotency-Key']).toMatch(/^[0-9a-f]{32}$/);
    const parsed = JSON.parse(req.data as string);
    expect(parsed.cryptocurrency).toBe('USDT');
    expect(parsed.amount).toBe('10');
    expect(parsed.paymentMethod).toBe('Bank Transfer');
    expect(trade.tradeId).toBe('trade_abc');
    expect(trade.status).toBe('initiated');
  });

  it('honours a caller-supplied idempotencyKey from the input and strips it from the body', async () => {
    const body = JSON.stringify({
      success: true,
      data: { tradeId: 't1', orderId: 'o1', buyerId: 'b', sellerId: 's', cryptocurrency: 'USDT', fiatCurrency: 'KRW', amount: '1', price: '1', totalValue: '1', status: 'initiated', paymentMethod: 'Bank Transfer' }
    });
    const { client, captured } = buildClient(body);
    await client.platform.users('user_x').quickTrade.initiate({
      cryptocurrency: 'USDT',
      fiatCurrency: 'KRW',
      type: 'buy',
      amount: '10',
      paymentMethod: 'Bank Transfer',
      idempotencyKey: 'quick-init-2026-05-09-test'
    });
    const req = captured[0];
    expect(req.headers?.['Idempotency-Key']).toBe('quick-init-2026-05-09-test');
    const parsed = JSON.parse(req.data as string);
    expect(parsed.idempotencyKey).toBeUndefined();
  });

  it('forwards orderId, terms, and timeLimit when supplied', async () => {
    const body = JSON.stringify({
      success: true,
      data: { tradeId: 't1', orderId: 'order_specific', buyerId: 'b', sellerId: 's', cryptocurrency: 'USDT', fiatCurrency: 'KRW', amount: '10', price: '1450', totalValue: '14500', status: 'initiated', paymentMethod: 'Bank Transfer' }
    });
    const { client, captured } = buildClient(body);
    await client.platform.users('user_x').quickTrade.initiate({
      cryptocurrency: 'USDT',
      fiatCurrency: 'KRW',
      type: 'buy',
      amount: '10',
      paymentMethod: 'Bank Transfer',
      orderId: 'order_specific',
      terms: 'pay within 60 minutes',
      timeLimit: 60
    });
    const req = captured[0];
    const parsed = JSON.parse(req.data as string);
    expect(parsed.orderId).toBe('order_specific');
    expect(parsed.terms).toBe('pay within 60 minutes');
    expect(parsed.timeLimit).toBe(60);
  });
});

describe('client.platform.quickTrade (merchant-scope, no acting user)', () => {
  it('pairs() GETs /api/v1/merchant/quick/pairs without X-PM-Acting-User', async () => {
    const body = JSON.stringify({
      success: true,
      data: [
        { cryptocurrency: 'USDT', fiatCurrency: 'KRW', bestBuyPrice: 1450, bestSellPrice: 1448, spread: 2, volume24h: 1_000_000, activeOrders: 25 }
      ]
    });
    const { client, captured } = buildClient(body);
    const pairs = await client.platform.quickTrade.pairs();
    const req = captured[0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/api/v1/merchant/quick/pairs');
    expect(req.headers?.['X-PM-Acting-User']).toBeUndefined();
    expect(req.headers?.['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].cryptocurrency).toBe('USDT');
  });

  it('featuredMerchants() GETs /api/v1/merchant/quick/featured-merchants with the pair query', async () => {
    const body = JSON.stringify({
      success: true,
      data: [
        { merchantId: 'm1', username: 'mer1', tier: 'enterprise', rating: 4.9, completionRate: 0.99, totalTrades: 1000, isOnline: true, priorityScore: 100 }
      ]
    });
    const { client, captured } = buildClient(body);
    const merchants = await client.platform.quickTrade.featuredMerchants({
      cryptocurrency: 'USDT',
      fiatCurrency: 'KRW'
    });
    const req = captured[0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/api/v1/merchant/quick/featured-merchants?cryptocurrency=USDT&fiatCurrency=KRW');
    expect(req.headers?.['X-PM-Acting-User']).toBeUndefined();
    expect(merchants).toHaveLength(1);
    expect(merchants[0].merchantId).toBe('m1');
  });

  it('recentActivity() GETs /api/v1/merchant/quick/recent-activity', async () => {
    const body = JSON.stringify({
      success: true,
      data: [
        { tradeId: 't1', type: 'buy', cryptocurrency: 'USDT', fiatCurrency: 'KRW', amount: 10, price: 1450, completedAt: '2026-05-09T00:00:00.000Z' }
      ]
    });
    const { client, captured } = buildClient(body);
    const activity = await client.platform.quickTrade.recentActivity();
    const req = captured[0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/api/v1/merchant/quick/recent-activity');
    expect(req.headers?.['X-PM-Acting-User']).toBeUndefined();
    expect(activity).toHaveLength(1);
    expect(activity[0].tradeId).toBe('t1');
  });

  it('platformStats() GETs /api/v1/merchant/quick/platform-stats and returns the inner stats object', async () => {
    const body = JSON.stringify({
      success: true,
      data: {
        volume24h: 2_500_000,
        totalCompletedTrades: 48_300,
        avgCompletionTimeMinutes: 4.2,
        activeOrdersCount: 150,
        onlineMerchantsCount: 45,
        lastUpdated: '2026-05-09T00:00:00.000Z'
      }
    });
    const { client, captured } = buildClient(body);
    const stats = await client.platform.quickTrade.platformStats();
    const req = captured[0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/api/v1/merchant/quick/platform-stats');
    expect(req.headers?.['X-PM-Acting-User']).toBeUndefined();
    expect(stats.volume24h).toBe(2_500_000);
    expect(stats.totalCompletedTrades).toBe(48_300);
    expect(stats.activeOrdersCount).toBe(150);
  });
});

describe('quick-trade envelope handling', () => {
  it('extracts data from {success, data} envelopes for bestMatch', async () => {
    const body = JSON.stringify({
      success: true,
      data: {
        merchant: { id: 'wrap_m', username: 'm', tier: 'professional', rating: 4, completionRate: 0.95, avgResponseTime: 60, totalTrades: 50, isOnline: true },
        order: { orderId: 'wrap_o', price: 1450, availableAmount: 100, minTradeAmount: 5, maxTradeAmount: 200, paymentMethods: ['Bank Transfer'] },
        quote: { youPay: 14500, youReceive: 10, rate: 1450, fees: { platform: 14.5, total: 14.5 } },
        priorityScore: 50
      }
    });
    const { client } = buildClient(body);
    const match = await client.platform.users('u').quickTrade.bestMatch({
      cryptocurrency: 'USDT', fiatCurrency: 'KRW', type: 'buy', amount: '10'
    });
    expect(match.merchant.id).toBe('wrap_m');
    expect(match.matchedOrder.orderId).toBe('wrap_o');
  });

  it('accepts a bare-object response without the envelope wrapper', async () => {
    const body = JSON.stringify({
      merchant: { id: 'bare_m', username: 'm', tier: 'business', rating: 4.5, completionRate: 0.97, avgResponseTime: 45, totalTrades: 75, isOnline: true },
      order: { orderId: 'bare_o', price: 1450, availableAmount: 50, minTradeAmount: 5, maxTradeAmount: 100, paymentMethods: ['Bank Transfer'] },
      quote: { youPay: 14500, youReceive: 10, rate: 1450, fees: { platform: 14.5, total: 14.5 } },
      priorityScore: 75
    });
    const { client } = buildClient(body);
    const match = await client.platform.users('u').quickTrade.bestMatch({
      cryptocurrency: 'USDT', fiatCurrency: 'KRW', type: 'buy', amount: '10'
    });
    expect(match.merchant.id).toBe('bare_m');
    expect(match.matchedOrder.orderId).toBe('bare_o');
  });
});
