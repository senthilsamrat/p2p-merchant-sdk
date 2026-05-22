// Internal user-to-user transfer within a single SaaS platform. Reads two
// end-user identifiers from env, checks danny's balance, transfers a small
// amount to Bob, and prints the resulting balances.
//
// The destination userId must belong to the same parentMerchantId; the
// gateway rejects cross-platform transfers with a 403 by default. Platforms
// that opt into cross-tenant trades enable that flag separately.
//
// Run:
//   MERCHANT_API_KEY=pk_live_... \
//   MERCHANT_HMAC_SECRET=... \
//   FROM_USER_ID=user_danny \
//   TO_USER_ID=user_bob \
//   TRANSFER_AMOUNT=10.00 \
//   TRANSFER_CURRENCY=KRW \
//   npx tsx index.ts

import { MerchantClient } from '@plantmewallet/merchant-sdk';

const apiKey = requireEnv('MERCHANT_API_KEY');
const hmacSecret = requireEnv('MERCHANT_HMAC_SECRET');
const fromUserId = requireEnv('FROM_USER_ID');
const toUserId = requireEnv('TO_USER_ID');
const amount = requireEnv('TRANSFER_AMOUNT');
const currency = requireEnv('TRANSFER_CURRENCY');

const client = new MerchantClient({
  apiKey,
  hmacSecret,
  baseUrl: process.env.MERCHANT_API_BASE_URL ?? 'https://api.plantmewallet.com'
});

async function main(): Promise<void> {
  // Pre-flight balance read so the operator sees what is about to move.
  const fromBefore = await client.platform.users(fromUserId).wallet.getBalance({ currency });
  const toBefore = await client.platform.users(toUserId).wallet.getBalance({ currency });
  console.log(`[transfer] before: ${fromUserId}=${pickAvailable(fromBefore, currency)} ${currency}, ${toUserId}=${pickAvailable(toBefore, currency)} ${currency}`);

  // Stable workflow-scoped idempotency key. A retry under the same key
  // returns the cached transfer record rather than executing twice.
  const idempotencyKey = `transfer:${fromUserId}:${toUserId}:${amount}:${currency}:${new Date().toISOString().slice(0, 10)}`;

  const transfer = await client.platform.users(fromUserId).wallet.transfer({
    toUserId,
    amount,
    currency,
    memo: process.env.TRANSFER_MEMO ?? 'internal transfer demo',
    idempotencyKey
  });
  console.log(`[transfer] ${transfer.transferId} status=${transfer.status} ${transfer.amount} ${transfer.currency}`);

  // Post-transfer balance read. Real platforms wait for a wallet event over
  // the WebSocket stream rather than polling REST.
  const fromAfter = await client.platform.users(fromUserId).wallet.getBalance({ currency });
  const toAfter = await client.platform.users(toUserId).wallet.getBalance({ currency });
  console.log(`[transfer] after:  ${fromUserId}=${pickAvailable(fromAfter, currency)} ${currency}, ${toUserId}=${pickAvailable(toAfter, currency)} ${currency}`);
}

function pickAvailable(balances: Array<{ currency: string; available: string }>, want: string): string {
  const row = balances.find((b) => b.currency === want);
  return row ? row.available : '0';
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

main().catch((err: Error) => {
  console.error('internal-transfer failed:', err.message);
  process.exit(1);
});
