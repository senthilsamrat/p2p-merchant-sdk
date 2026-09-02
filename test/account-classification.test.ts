import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { MerchantClient } from '../src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('merchant account classification', () => {
  it('exposes account type and API-key scope as separate fields', async () => {
    const response = {
      merchantId: 'SAAS-ONE',
      tier: 'enterprise',
      accountType: 'saas_platform',
      apiKeyScope: 'platform_users',
      status: 'active',
      expressEligible: true,
      expressAvailable: false,
      kycStatus: 'verified',
      permissions: ['account:read', 'platform:users:read'],
      createdAt: '2026-09-03T00:00:00.000Z'
    } as const;
    const fakeInstance = {
      request: vi.fn(async () => ({
        status: 200,
        headers: {},
        data: JSON.stringify(response)
      })),
      get: vi.fn()
    } as any;
    vi.spyOn(axios, 'create').mockReturnValue(fakeInstance);

    const client = new MerchantClient({
      apiKey: 'pk_test_account',
      hmacSecret: 'test-secret',
      baseUrl: 'https://api.example.test',
      skipInitialClockSample: true
    });

    const account = await client.account.get();
    expect(account.accountType).toBe('saas_platform');
    expect(account.apiKeyScope).toBe('platform_users');
  });
});
