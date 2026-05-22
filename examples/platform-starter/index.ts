// End-to-end starter for SaaS platforms. Creates a new end-user, kicks off
// KYC, lists existing users, and prints each user's wallet balance.
//
// Run:
//   MERCHANT_API_KEY=pk_live_... \
//   MERCHANT_HMAC_SECRET=... \
//   PLATFORM_USER_EXTERNAL_ID=tradekr_user_001 \
//   npx tsx index.ts

import { MerchantClient } from '@plantmewallet/merchant-sdk';

const apiKey = requireEnv('MERCHANT_API_KEY');
const hmacSecret = requireEnv('MERCHANT_HMAC_SECRET');
const externalUserId = requireEnv('PLATFORM_USER_EXTERNAL_ID');

const client = new MerchantClient({
  apiKey,
  hmacSecret,
  baseUrl: process.env.MERCHANT_API_BASE_URL ?? 'https://api.plantmewallet.com'
});

async function main(): Promise<void> {
  // Provision the end-user inside the platform's parent merchant account.
  const user = await client.platform.users.create({
    externalUserId,
    email: process.env.PLATFORM_USER_EMAIL,
    displayName: process.env.PLATFORM_USER_DISPLAY_NAME ?? 'New User',
    region: process.env.PLATFORM_USER_REGION ?? 'KR',
    kycLevelRequired: 1
  });
  console.log(`[platform] created user userId=${user.userId} status=${user.status}`);

  // Hand the end-user a hosted page to complete KYC level 1. The returnUrl
  // is where the vendor sends the browser after the upload step finishes.
  const kyc = await client.platform.users(user.userId).kyc.start({
    level: 1,
    returnUrl: process.env.KYC_RETURN_URL ?? 'https://platform.example/kyc/done'
  });
  console.log(`[platform] kyc session=${kyc.kycSessionId} url=${kyc.hostedPageUrl}`);

  // Enumerate the first page of platform end-users. SaaS dashboards
  // typically render this list with the search/cursor controls visible.
  const page = await client.platform.users.list({ limit: 20, status: 'active' });
  console.log(`[platform] listed ${page.users.length} active users (hasMore=${page.hasMore})`);

  // Show each user's primary balance. Real platforms cache balances to avoid
  // a network call per row; this is illustrative.
  for (const u of page.users.slice(0, 5)) {
    try {
      const balances = await client.platform.users(u.userId).wallet.getBalance({
        currency: 'KRW'
      });
      const total = balances.reduce((acc, b) => acc + Number(b.total), 0);
      console.log(`[platform]   ${u.userId} balance=${total.toFixed(2)} KRW`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.warn(`[platform]   ${u.userId} balance lookup failed: ${msg}`);
    }
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

main().catch((err: Error) => {
  console.error('platform-starter failed:', err.message);
  process.exit(1);
});
