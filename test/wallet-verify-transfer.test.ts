// Coverage for client.wallet.verifyTransfer. Verifies that
// 1. it POSTs the claim to the merchant-scoped path with no acting-user header
// 2. optional fields are omitted rather than sent as undefined
// 3. a fully matching claim reads as matched
// 4. a settled-but-wrong-amount claim fails on that check alone
// 5. an unsettled transfer never reads as money received
// 6. an unknown counterparty is reported apart from a wrong one
// 7. an ambiguous receipt code is refused rather than resolved

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

function buildClient(responseBody: unknown) {
  const captured: CapturedRequest[] = [];
  const fakeInstance = {
    request: vi.fn(async (cfg: any) => {
      captured.push({ method: cfg.method, url: cfg.url, data: cfg.data, headers: cfg.headers });
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

const MATCHED = {
  matched: true,
  type: 'transfer_in',
  status: 'completed',
  counterpartyKnown: true,
  ambiguousReference: false,
  checks: {
    referenceFound: true,
    counterpartyMatches: true,
    amountMatches: true,
    confirmed: true
  },
  transaction: {
    id: 'le_1',
    referenceId: 'int-transfer-transfer-69da5fee',
    type: 'transfer_in',
    amount: '653.50',
    currency: 'USDT',
    createdAt: '2026-09-01T00:35:00.000Z'
  }
};

describe('client.wallet.verifyTransfer', () => {
  it('POSTs the claim to the merchant wallet path', async () => {
    const { client, captured } = buildClient(MATCHED);
    await client.wallet.verifyTransfer({
      type: 'transfer_in',
      reference: '#3A6W2S391R',
      counterparty: 'alice',
      amount: '653.50'
    });

    expect(captured).toHaveLength(1);
    const req = captured[0];
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/api/v1/merchant/wallet/transfers/verify');
    expect(req.headers?.['X-Signature']).toMatch(/^[0-9a-f]{64}$/);
    // The merchant's own wallet has no end-user subject to name.
    expect(req.headers?.['X-PM-Acting-User']).toBeUndefined();

    const sent = JSON.parse(req.data as string);
    expect(sent).toEqual({
      type: 'transfer_in',
      reference: '#3A6W2S391R',
      counterparty: 'alice',
      amount: '653.50'
    });
  });

  // An omitted field means "do not check this", which is different from
  // checking it against undefined.
  it('omits counterparty and amount when they were not supplied', async () => {
    const { client, captured } = buildClient(MATCHED);
    await client.wallet.verifyTransfer({ type: 'transfer_out', reference: 'int-transfer-abc' });

    const sent = JSON.parse(captured[0].data as string);
    expect(sent).toEqual({ type: 'transfer_out', reference: 'int-transfer-abc' });
    expect('counterparty' in sent).toBe(false);
    expect('amount' in sent).toBe(false);
  });

  it('reads a fully matching claim as matched', async () => {
    const { client } = buildClient(MATCHED);
    const r = await client.wallet.verifyTransfer({
      type: 'transfer_in',
      reference: '#3A6W2S391R',
      counterparty: 'alice',
      amount: '653.50'
    });

    expect(r.matched).toBe(true);
    expect(r.status).toBe('completed');
    expect(r.transaction?.amount).toBe('653.50');
  });

  it('fails on the amount alone when everything else agrees', async () => {
    const { client } = buildClient({
      ...MATCHED,
      matched: false,
      checks: { ...MATCHED.checks, amountMatches: false }
    });
    const r = await client.wallet.verifyTransfer({
      type: 'transfer_in',
      reference: '#3A6W2S391R',
      amount: '999.00'
    });

    expect(r.matched).toBe(false);
    expect(r.checks.amountMatches).toBe(false);
    // The transfer is real and settled; only the claimed figure is wrong.
    expect(r.checks.referenceFound).toBe(true);
    expect(r.checks.confirmed).toBe(true);
  });

  // A transfer that never settled must not read as money received, however
  // well the rest of the claim matches.
  it('never reads an unsettled transfer as matched', async () => {
    const { client } = buildClient({
      ...MATCHED,
      matched: false,
      status: 'failed',
      checks: { ...MATCHED.checks, confirmed: false }
    });
    const r = await client.wallet.verifyTransfer({ type: 'transfer_in', reference: 'int-transfer-abc' });

    expect(r.matched).toBe(false);
    expect(r.checks.confirmed).toBe(false);
    expect(r.status).toBe('failed');
  });

  // "We cannot say who sent it" is a different answer from "somebody else
  // sent it", and a merchant chasing a payment needs to tell them apart.
  it('separates an unknown counterparty from a wrong one', async () => {
    const { client } = buildClient({
      ...MATCHED,
      matched: false,
      counterpartyKnown: false,
      checks: { ...MATCHED.checks, counterpartyMatches: false }
    });
    const r = await client.wallet.verifyTransfer({
      type: 'transfer_in',
      reference: 'int-transfer-abc',
      counterparty: 'alice'
    });

    expect(r.matched).toBe(false);
    expect(r.checks.counterpartyMatches).toBe(false);
    expect(r.counterpartyKnown).toBe(false);
  });

  // The receipt code is a lossy view of the reference, so two rows can share
  // one. Confirming a payment on a guess is worse than declining to answer.
  it('refuses an ambiguous receipt code rather than resolving it', async () => {
    const { client } = buildClient({
      matched: false,
      type: 'transfer_in',
      status: null,
      counterpartyKnown: false,
      ambiguousReference: true,
      checks: {
        referenceFound: false,
        counterpartyMatches: false,
        amountMatches: false,
        confirmed: false
      },
      transaction: null
    });
    const r = await client.wallet.verifyTransfer({ type: 'transfer_in', reference: '#3A6W2S391R' });

    expect(r.matched).toBe(false);
    expect(r.ambiguousReference).toBe(true);
    expect(r.transaction).toBe(null);
  });
});
