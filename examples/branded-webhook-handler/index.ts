// Express webhook receiver for SaaS-tier deliveries. Verifies the HMAC
// signature on every payload and dispatches by event type. Two handler
// branches are wired up:
//   merchant.user.kyc_updated         end-user KYC progressed
//   merchant.revshare.commission.earned   platform earned a fee split
// Other event types are logged and acked with 200 so the server stops
// retrying.
//
// Run:
//   WEBHOOK_SECRET=whsec_... \
//   PORT=3000 \
//   npx tsx index.ts

import express, { type Request, type Response } from 'express';
import { verifyWebhook } from '@plantmewallet/merchant-sdk/webhooks';
import type {
  WebhookEnvelope,
  WebhookEventType
} from '@plantmewallet/merchant-sdk';

const app = express();

// Capture the raw body so the verifier sees the exact bytes the server
// signed. Whitespace and key ordering matter for HMAC verification.
app.use(express.raw({ type: 'application/json', limit: '1mb' }));

app.post('/webhook', (req: Request, res: Response) => {
  const signature = req.header('X-Webhook-Signature');
  const timestamp = req.header('X-Webhook-Timestamp');
  const secret = process.env.WEBHOOK_SECRET;

  if (!signature || !secret) {
    res.status(400).json({ error: 'missing_signature_or_secret' });
    return;
  }

  const body = req.body as Buffer;
  const result = verifyWebhook({
    payload: body,
    signature,
    secret,
    timestamp: timestamp ?? undefined
  });

  if (!result.valid) {
    console.warn(`[webhook] rejected: ${result.reason}`);
    res.status(401).json({ error: result.reason });
    return;
  }

  let envelope: WebhookEnvelope<unknown>;
  try {
    envelope = JSON.parse(body.toString('utf8')) as WebhookEnvelope<unknown>;
  } catch {
    res.status(400).json({ error: 'malformed_json' });
    return;
  }

  // Dispatch by event type. Keep handlers fast; do real work async via a
  // queue so the receiver always replies under the server's delivery
  // timeout. Returning 5xx tells the server to retry with exponential
  // backoff.
  try {
    handleEvent(envelope);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[webhook] handler threw: ${msg}`);
    res.status(500).json({ error: 'handler_failed' });
    return;
  }

  res.status(200).json({ received: true });
});

function handleEvent(envelope: WebhookEnvelope<unknown>): void {
  const eventType = envelope.type as WebhookEventType;
  switch (eventType) {
    case 'merchant.user.kyc_updated':
      handleKycUpdated(envelope);
      break;
    case 'merchant.revshare.commission.earned':
      handleCommissionEarned(envelope);
      break;
    default:
      console.log(`[webhook] ${envelope.id} type=${envelope.type}`);
  }
}

function handleKycUpdated(envelope: WebhookEnvelope<unknown>): void {
  const data = envelope.data as {
    userId?: string;
    parentMerchantId?: string;
    kycLevel?: number;
    kycStatus?: string;
  };
  console.log(`[kyc] ${data.userId} parent=${data.parentMerchantId} level=${data.kycLevel} status=${data.kycStatus}`);
  // Real platforms would mark the user as eligible for higher-limit trades,
  // unlock fiat ramps, etc. Mirror the change to the platform's own DB so
  // the dashboard reflects the new tier without re-querying the SDK.
}

function handleCommissionEarned(envelope: WebhookEnvelope<unknown>): void {
  const data = envelope.data as {
    rewardId?: string;
    payoutId?: string;
    amount?: string;
    currency?: string;
  };
  console.log(`[revshare] commission earned reward=${data.rewardId} amount=${data.amount} ${data.currency}`);
  // Append to the platform's revenue ledger. The matching payout webhook
  // will arrive once funds actually settle to the platform's wallet.
}

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`[webhook] branded-webhook-handler listening on :${port}`);
});
