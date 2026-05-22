// Minimal SDK consumer. Authenticates with API key + HMAC secret, places a
// sell ad, then iterates completed trades to print their IDs.
//
// Run:
//   MERCHANT_API_KEY=pk_live_... \
//   MERCHANT_HMAC_SECRET=... \
//   npx tsx index.ts

import { MerchantClient } from '@plantmewallet/merchant-sdk';

const apiKey = requireEnv('MERCHANT_API_KEY');
const hmacSecret = requireEnv('MERCHANT_HMAC_SECRET');

const client = new MerchantClient({
  apiKey,
  hmacSecret,
  baseUrl: process.env.MERCHANT_API_BASE_URL ?? 'https://api.plantmewallet.com'
});

async function main(): Promise<void> {
  // Auto-generates Idempotency-Key behind the scenes. Safe to retry.
  const order = await client.orders.create({
    type: 'sell',
    cryptocurrency: 'USDT',
    fiatCurrency: 'KRW',
    amount: '100.00000000',
    price: '1320.50',
    paymentMethodIds: [requireEnv('MERCHANT_PAYMENT_METHOD_ID')]
  });
  console.log('Created order:', order.orderId);

  for await (const trade of client.trades.listAll({ status: 'completed', limit: 50 })) {
    console.log('Completed trade:', trade.tradeId);
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
  console.error('simple-placer failed:', err.message);
  process.exit(1);
});
