import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { MerchantClient, SDK_METADATA } from '../src/index.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string };

describe('SDK release version', () => {
  it('keeps runtime metadata and the default User-Agent aligned with package.json', async () => {
    const client = new MerchantClient({
      apiKey: 'pk_test_version',
      hmacSecret: 'test-hmac-secret',
      skipInitialClockSample: true
    });

    expect(SDK_METADATA.version).toBe(packageJson.version);
    expect(client.describe().userAgent).toBe(
      `plantme-merchant-sdk/${packageJson.version} node`
    );

    await client.close();
  });
});
