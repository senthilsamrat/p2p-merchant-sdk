// Coverage for client.wallet.getTransactions. Verifies that
// 1. it GETs the merchant-scoped path and attaches no acting-user header
// 2. an array of types is sent as the comma separated list the server reads
// 3. the server envelope is normalised into the SDK's Paginated shape
// 4. a last page reports no cursor so pagination helpers stop
// 5. amounts survive as strings rather than being parsed into numbers

import { describe, it, expect, vi, afterEach } from 'vitest';
import axios from 'axios';
import { MerchantClient } from '../src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

interface CapturedRequest {
  method?: string;
  url?: string;
  params?: unknown;
  headers?: Record<string, string>;
}

function buildClient(responseBody: unknown) {
  const captured: CapturedRequest[] = [];
  const fakeInstance = {
    request: vi.fn(async (cfg: any) => {
      captured.push({
        method: cfg.method,
        url: cfg.url,
        params: cfg.params,
        headers: cfg.headers
      });
      return { status: 200, headers: {}, data: JSON.stringify(responseBody) };
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

const PAGE = {
  transactions: [
    {
      id: 'le_1',
      type: 'deposit',
      direction: 'in',
      amount: '125.40000000',
      balanceAfter: '8734.12000000',
      currency: 'USDT',
      tradeId: null,
      escrowId: null,
      withdrawalId: null,
      depositId: 'dep_9',
      createdAt: '2026-08-30T10:34:12.988Z'
    }
  ],
  hasMore: true,
  nextCursor: 'cursor_abc'
};

describe('client.wallet.getTransactions', () => {
  it('GETs the merchant wallet transactions path without an acting user', async () => {
    const { client, captured } = buildClient(PAGE);
    await client.wallet.getTransactions();

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/api/v1/merchant/wallet/transactions');
    expect(req.headers?.['X-API-Key']).toBe('pk_test_abc');
    expect(req.headers?.['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
    // The merchant's own wallet has no end-user subject to name.
    expect(req.headers?.['X-PM-Acting-User']).toBeUndefined();
  });

  it('sends an array of types as one comma separated value', async () => {
    const { client, captured } = buildClient(PAGE);
    await client.wallet.getTransactions({
      type: ['deposit', 'withdrawal', 'transfer_in'],
      currency: 'USDT',
      limit: 200
    });

    // The transport folds the query into the url, so the encoded comma list
    // is what actually reaches the server.
    const query = new URL('https://x.test' + captured[0].url).searchParams;
    expect(query.get('type')).toBe('deposit,withdrawal,transfer_in');
    expect(query.get('currency')).toBe('USDT');
    expect(query.get('limit')).toBe('200');
  });

  it('passes a single type through unchanged', async () => {
    const { client, captured } = buildClient(PAGE);
    await client.wallet.getTransactions({ type: 'withdrawal' });
    const query = new URL('https://x.test' + captured[0].url).searchParams;
    expect(query.get('type')).toBe('withdrawal');
  });

  it('omits filters that were not supplied', async () => {
    const { client, captured } = buildClient(PAGE);
    await client.wallet.getTransactions({ limit: 50 });
    const query = new URL('https://x.test' + captured[0].url).searchParams;
    expect(query.get('limit')).toBe('50');
    expect(query.has('type')).toBe(false);
    expect(query.has('cursor')).toBe(false);
  });

  it('normalises the server envelope into a Paginated page', async () => {
    const { client } = buildClient(PAGE);
    const page = await client.wallet.getTransactions();

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe('cursor_abc');
    expect(page.items[0].type).toBe('deposit');
    expect(page.items[0].direction).toBe('in');
    expect(page.items[0].depositId).toBe('dep_9');
  });

  it('reports no cursor on the last page so a walk terminates', async () => {
    const { client } = buildClient({
      transactions: [],
      hasMore: false,
      nextCursor: null
    });
    const page = await client.wallet.getTransactions();

    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
    // Null from the server becomes undefined, so `while (cursor)` stops.
    expect(page.nextCursor).toBeUndefined();
  });

  // Shapes below are the ones staging actually returns. The server stores a
  // withdrawal negative and a transfer out positive though both move funds
  // out, so the magnitude has to survive that difference.
  it('returns a withdrawal as a magnitude with direction out', async () => {
    const { client } = buildClient({
      transactions: [
        { ...PAGE.transactions[0], type: 'withdrawal', direction: 'out', amount: '-10' }
      ],
      hasMore: false,
      nextCursor: null
    });
    const page = await client.wallet.getTransactions({ type: 'withdrawal' });

    expect(page.items[0].amount).toBe('10');
    expect(page.items[0].direction).toBe('out');
  });

  it('leaves an already positive out-movement untouched', async () => {
    const { client } = buildClient({
      transactions: [
        { ...PAGE.transactions[0], type: 'transfer_out', direction: 'out', amount: '10' },
        { ...PAGE.transactions[0], type: 'escrow_lock', direction: 'out', amount: '10.1' }
      ],
      hasMore: false,
      nextCursor: null
    });
    const page = await client.wallet.getTransactions();

    expect(page.items[0].amount).toBe('10');
    expect(page.items[1].amount).toBe('10.1');
  });

  // The point of the normalisation: direction and amount must agree, so the
  // obvious running total lands on the right number.
  it('lets direction and amount be combined without double negation', async () => {
    const { client } = buildClient({
      transactions: [
        { ...PAGE.transactions[0], type: 'deposit', direction: 'in', amount: '100' },
        { ...PAGE.transactions[0], type: 'withdrawal', direction: 'out', amount: '-10' },
        { ...PAGE.transactions[0], type: 'transfer_out', direction: 'out', amount: '30' }
      ],
      hasMore: false,
      nextCursor: null
    });
    const page = await client.wallet.getTransactions();

    const net = page.items.reduce(
      (sum, tx) => (tx.direction === 'out' ? sum - Number(tx.amount) : sum + Number(tx.amount)),
      0
    );
    // 100 in, 10 out, 30 out. Reading the raw signs would give 120.
    expect(net).toBe(60);
  });

  // Both legs of a transfer carry the same referenceId. Without it a merchant
  // sees two unrelated movements and cannot tell a paired transfer from two
  // separate ones of the same size.
  it('carries referenceId so a transfer can be paired', async () => {
    const REF = 'internal-transfer:merchant-service:fund-user-f7f80ed9';
    const { client } = buildClient({
      transactions: [
        { ...PAGE.transactions[0], id: 'le_out', type: 'transfer_out', direction: 'out', amount: '10', referenceId: REF },
        { ...PAGE.transactions[0], id: 'le_in', type: 'transfer_in', direction: 'in', amount: '10', referenceId: REF }
      ],
      hasMore: false,
      nextCursor: null
    });
    const page = await client.wallet.getTransactions();

    expect(page.items[0].referenceId).toBe(REF);
    expect(page.items[1].referenceId).toBe(REF);
    // Same operation, different rows.
    expect(page.items[0].id).not.toBe(page.items[1].id);
  });

  // The name is read from whichever side the row sits on, so a merchant sees
  // who it sent to on its debit and who paid it on its credit.
  it('names the counterparty on both legs of a transfer', async () => {
    const { client } = buildClient({
      transactions: [
        { ...PAGE.transactions[0], type: 'transfer_out', direction: 'out', counterparty: 'alice' },
        { ...PAGE.transactions[0], type: 'transfer_in', direction: 'in', counterparty: 'bob' }
      ],
      hasMore: false,
      nextCursor: null
    });
    const page = await client.wallet.getTransactions();
    expect(page.items[0].counterparty).toBe('alice');
    expect(page.items[1].counterparty).toBe('bob');
  });

  // Under half of transfers carry a name, so absence is the normal case and
  // must not read as an error.
  it('reports counterparty as null when the row carries no name', async () => {
    const { client } = buildClient({
      transactions: [
        { ...PAGE.transactions[0], type: 'transfer_out', direction: 'out', counterparty: null },
        { ...PAGE.transactions[0], type: 'deposit', direction: 'in', counterparty: null }
      ],
      hasMore: false,
      nextCursor: null
    });
    const page = await client.wallet.getTransactions();
    expect(page.items[0].counterparty).toBe(null);
    expect(page.items[1].counterparty).toBe(null);
  });

  // The sender is debited the gross and the recipient credited the net, so
  // without the fee neither side can account for the difference.
  it('reports the transfer fee on both legs', async () => {
    const { client } = buildClient({
      transactions: [
        { ...PAGE.transactions[0], type: 'transfer_out', direction: 'out', amount: '1', fee: '0.01' },
        { ...PAGE.transactions[0], type: 'transfer_in', direction: 'in', amount: '0.99', fee: '0.01' }
      ],
      hasMore: false,
      nextCursor: null
    });
    const page = await client.wallet.getTransactions();

    expect(page.items[0].fee).toBe('0.01');
    expect(page.items[1].fee).toBe('0.01');
    // Gross out, net in, and the difference accounted for.
    expect(Number(page.items[0].amount) - Number(page.items[1].amount))
      .toBeCloseTo(Number(page.items[0].fee), 8);
  });

  // A transfer that carried no fee, and every non-transfer type, report null.
  // Absence says there was no fee rather than that nobody recorded one.
  it('reports fee as null when none was charged', async () => {
    const { client } = buildClient({
      transactions: [
        { ...PAGE.transactions[0], type: 'transfer_out', direction: 'out', amount: '10', fee: null },
        { ...PAGE.transactions[0], type: 'deposit', direction: 'in', amount: '10', fee: null }
      ],
      hasMore: false,
      nextCursor: null
    });
    const page = await client.wallet.getTransactions();
    expect(page.items[0].fee).toBe(null);
    expect(page.items[1].fee).toBe(null);
  });

  it('reports referenceId as null when the row carries none', async () => {
    const { client } = buildClient({
      transactions: [{ ...PAGE.transactions[0], referenceId: null }],
      hasMore: false,
      nextCursor: null
    });
    const page = await client.wallet.getTransactions();
    expect(page.items[0].referenceId).toBe(null);
  });

  it('keeps amounts as strings so precision is not lost', async () => {
    const { client } = buildClient({
      transactions: [
        {
          ...PAGE.transactions[0],
          amount: '9007199254740993.00000001',
          balanceAfter: '9007199254740993.00000001'
        }
      ],
      hasMore: false,
      nextCursor: null
    });
    const page = await client.wallet.getTransactions();

    // A value past Number.MAX_SAFE_INTEGER round-trips only as a string.
    expect(typeof page.items[0].amount).toBe('string');
    expect(page.items[0].amount).toBe('9007199254740993.00000001');
    expect(typeof page.items[0].balanceAfter).toBe('string');
  });

  it('tolerates an envelope with no transactions array', async () => {
    const { client } = buildClient({ hasMore: false });
    const page = await client.wallet.getTransactions();
    expect(page.items).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  // An envelope that omits hasMore must read as "no more", not "keep going".
  // Treating the absent field as truthy would walk a caller into an endless
  // loop against a server that never sends a cursor.
  it('treats a missing hasMore as the end of the walk', async () => {
    const { client } = buildClient({ transactions: [] });
    const page = await client.wallet.getTransactions();
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
  });
});
