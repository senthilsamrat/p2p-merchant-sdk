import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { MerchantClient } from '../src/index.js';

afterEach(() => vi.restoreAllMocks());

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
    id: 'entry-1',
    referenceId: 'int-transfer-1',
    type: 'transfer_in',
    amount: '653.50',
    currency: 'USDT',
    createdAt: '2026-09-01T00:35:00.000Z'
  }
};

function buildClient(responseBody: unknown) {
  const requests: any[] = [];
  vi.spyOn(axios, 'create').mockReturnValue({
    request: vi.fn(async (config: any) => {
      requests.push(config);
      return { status: 200, headers: {}, data: JSON.stringify(responseBody) };
    }),
    get: vi.fn()
  } as any);
  return {
    client: new MerchantClient({
      apiKey: 'pk_test_verify',
      hmacSecret: 'test-secret',
      baseUrl: 'https://api.example.test',
      skipInitialClockSample: true
    }),
    requests
  };
}

describe('client.wallet.verifyTransfer', () => {
  it('posts a merchant-level transfer claim without an acting-user header', async () => {
    const { client, requests } = buildClient(MATCHED);
    await client.wallet.verifyTransfer({
      type: 'transfer_in',
      reference: '#3A6W2S391R',
      counterparty: 'alice',
      amount: '653.50'
    });

    expect(requests[0].method).toBe('POST');
    expect(requests[0].url).toBe('/api/v1/merchant/wallet/transfers/verify');
    expect(requests[0].headers['X-PM-Acting-User']).toBeUndefined();
    expect(JSON.parse(requests[0].data)).toEqual({
      type: 'transfer_in',
      reference: '#3A6W2S391R',
      counterparty: 'alice',
      amount: '653.50'
    });
    await client.close();
  });

  it('omits optional claim fields when they are not supplied', async () => {
    const { client, requests } = buildClient(MATCHED);
    await client.wallet.verifyTransfer({ type: 'transfer_out', reference: 'int-transfer-1' });
    expect(JSON.parse(requests[0].data)).toEqual({
      type: 'transfer_out',
      reference: 'int-transfer-1'
    });
    await client.close();
  });

  it('returns the structured verification verdict', async () => {
    const { client } = buildClient(MATCHED);
    const result = await client.wallet.verifyTransfer({
      type: 'transfer_in',
      reference: 'int-transfer-1',
      amount: '653.50'
    });
    expect(result).toEqual(MATCHED);
    await client.close();
  });
});
