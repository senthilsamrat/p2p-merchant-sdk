// Minimal market-maker bot example.
// Opens the merchant WebSocket stream, subscribes to trade and balance
// events, and prints structured updates to stdout. No order placement.
// Real bots layer their pricing logic on top of these event streams; this
// example shows the shape of a robust, reconnect-aware consumer.

import { MerchantClient } from '@plantmewallet/merchant-sdk';

async function main(): Promise<void> {
  const apiKey = process.env.MERCHANT_API_KEY;
  const hmacSecret = process.env.MERCHANT_HMAC_SECRET;
  if (!apiKey || !hmacSecret) {
    console.error('MERCHANT_API_KEY and MERCHANT_HMAC_SECRET must be set in env');
    process.exit(1);
  }

  const baseUrl = process.env.MERCHANT_API_BASE_URL ?? 'https://api.plantmewallet.com';

  const client = new MerchantClient({
    apiKey,
    hmacSecret,
    baseUrl,
    skipInitialClockSample: true,
  });

  // Lifecycle observability. Keeps ops honest about reconnect storms.
  client.stream.on('connected', (sessionId: string) => {
    console.log(`[stream] connected session=${sessionId}`);
  });

  client.stream.on('disconnected', (info) => {
    console.log(
      `[stream] disconnected code=${info.code} reason=${info.reason} willReconnect=${info.willReconnect}`,
    );
  });

  client.stream.on('reconnecting', (info) => {
    console.log(`[stream] reconnecting attempt=${info.attempt} delayMs=${info.nextDelayMs}`);
  });

  client.stream.on('error', (err: Error) => {
    console.error(`[stream] error: ${err.message}`);
  });

  // Trade lifecycle. A real market maker would read these to update its
  // running PnL and outstanding-trade map.
  client.stream.on('merchant.trades.completed', (evt) => {
    console.log(`[trade.completed] ${evt.eventId} seq=${evt.sequence}`, evt.data);
  });
  client.stream.on('merchant.trades.disputed', (evt) => {
    console.warn(`[trade.disputed] ${evt.eventId} seq=${evt.sequence}`, evt.data);
  });
  client.stream.on('merchant.trades.payment_confirmed', (evt) => {
    console.log(`[trade.payment_confirmed] ${evt.eventId} seq=${evt.sequence}`, evt.data);
  });

  // Balance changes. These trigger order resizing decisions in real bots.
  client.stream.on('merchant.wallet.balance_changed', (evt) => {
    console.log(`[balance.changed] seq=${evt.sequence}`, evt.data);
  });
  client.stream.on('merchant.wallet.hold_created', (evt) => {
    console.log(`[hold.created] seq=${evt.sequence}`, evt.data);
  });
  client.stream.on('merchant.wallet.hold_released', (evt) => {
    console.log(`[hold.released] seq=${evt.sequence}`, evt.data);
  });

  // Catch-all so we see anything new the server adds.
  client.stream.on('event', (evt) => {
    if (
      !evt.eventType.startsWith('merchant.trades.') &&
      !evt.eventType.startsWith('merchant.wallet.')
    ) {
      console.log(`[event] ${evt.eventType} seq=${evt.sequence}`);
    }
  });

  await client.stream.connect();
  console.log('[main] market-maker is running, press Ctrl+C to exit');

  const shutdown = async () => {
    console.log('[main] shutting down');
    await client.stream.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

void main().catch((err) => {
  console.error('[main] fatal:', err);
  process.exit(1);
});
