// Deposit-address contract. `network` selects the chain the returned address
// lives on, so the published type has to make it impossible to call without
// one and impossible to pass a chain the server will not serve. The original
// defect survived a test suite that only asserted the field was a string.

import { describe, it, expect, vi, afterEach, assertType } from 'vitest';
import axios from 'axios';
import { MerchantClient, DEPOSIT_CURRENCIES, DEPOSIT_NETWORKS } from '../src/index.js';
import type {
  DepositAddress,
  DepositAddressInput,
  DepositNetwork
} from '../src/resources/platform/types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

interface CapturedRequest {
  method?: string;
  url?: string;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
}

function buildClient(responseBody: unknown = { ok: true }) {
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

describe('deposit network contract', () => {
  it('publishes exactly the networks the server resolves', () => {
    expect(DEPOSIT_NETWORKS).toEqual(['ERC20', 'TRC20', 'BEP20']);
  });

  it('requires network on the input type', () => {
    // Omitting network is a compile error, so the SDK cannot issue the request
    // that the server would refuse.
    // @ts-expect-error network is required
    assertType<DepositAddressInput>({ currency: 'USDT' });
  });

  it('rejects a network outside the supported set at the type level', () => {
    // @ts-expect-error SOLANA is not a DepositNetwork
    assertType<DepositAddressInput>({ currency: 'USDT', network: 'SOLANA' });
    // @ts-expect-error an arbitrary string is not a DepositNetwork
    assertType<DepositAddressInput>({ currency: 'USDT', network: 'erc20' });
  });

  it('accepts each supported network at the type level', () => {
    assertType<DepositAddressInput>({ currency: 'USDT', network: 'ERC20' });
    assertType<DepositAddressInput>({ currency: 'USDT', network: 'TRC20' });
    assertType<DepositAddressInput>({ currency: 'USDT', network: 'BEP20' });
  });

  it('publishes exactly the currencies the server issues an address for', () => {
    expect(DEPOSIT_CURRENCIES).toEqual(['USDT']);
  });

  it('rejects a currency the server will not issue an address for', () => {
    // The server refuses anything but USDT, so a call the type accepts must not
    // be one that fails at runtime.
    // @ts-expect-error BTC is not a DepositCurrency
    assertType<DepositAddressInput>({ currency: 'BTC', network: 'ERC20' });
    // @ts-expect-error an arbitrary string is not a DepositCurrency
    assertType<DepositAddressInput>({ currency: 'usdt', network: 'ERC20' });
  });

  it('narrows the returned network to the same union, not a bare string', () => {
    const returned: DepositAddress = {
      currency: 'USDT',
      network: 'TRC20',
      address: 'TQ5NMqJjW8kFRAjm3sDbPmnFHbrEaCkAcT'
    };
    assertType<DepositNetwork>(returned.network);
    // @ts-expect-error the response network is not a widened string
    assertType<'ERC20'>(returned.network);
  });
});

describe('client.platform.users(userId).wallet.getDepositAddress', () => {
  it('sends the requested network on the query string', async () => {
    const { client, captured } = buildClient({
      currency: 'USDT',
      network: 'TRC20',
      address: 'TQ5NMqJjW8kFRAjm3sDbPmnFHbrEaCkAcT'
    });

    await client.platform.users('user_abc').wallet.getDepositAddress({
      currency: 'USDT',
      network: 'TRC20'
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe('GET');
    const [path, queryString] = String(captured[0].url).split('?');
    expect(path).toBe('/api/v1/merchant/users/user_abc/wallet/deposit-address');
    const query = new URLSearchParams(queryString);
    expect(query.get('currency')).toBe('USDT');
    expect(query.get('network')).toBe('TRC20');
    expect(captured[0].headers?.['X-PM-Acting-User']).toBe('user_abc');
  });

  it('sends each supported network verbatim, uppercased as the server expects', async () => {
    for (const network of DEPOSIT_NETWORKS) {
      const { client, captured } = buildClient({
        currency: 'USDT',
        network,
        address: '0xabc'
      });

      await client.platform.users('user_abc').wallet.getDepositAddress({
        currency: 'USDT',
        network
      });

      const query = new URLSearchParams(String(captured[0].url).split('?')[1]);
      expect(query.get('network')).toBe(network);
      vi.restoreAllMocks();
    }
  });

  it('returns the network the server echoed, describing the address alongside it', async () => {
    const { client } = buildClient({
      currency: 'USDT',
      network: 'BEP20',
      address: '0x734a61f47de4395ebecd924a9f83a3590e4935c4'
    });

    const result = await client.platform.users('user_abc').wallet.getDepositAddress({
      currency: 'USDT',
      network: 'BEP20'
    });

    expect(result.network).toBe('BEP20');
    expect(result.address).toBe('0x734a61f47de4395ebecd924a9f83a3590e4935c4');
  });
});
