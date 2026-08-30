// Express webhook receiver example.
// Verifies the HMAC signature on each delivery, rejects forgeries, and
// echoes the parsed payload to stdout.
//
// IMPORTANT: the body parser must give us the RAW request body so the
// signature verifier sees the exact bytes the server signed. JSON-parsed
// bodies will not verify because the canonical string includes whitespace
// and key ordering.

import express, { type Request, type Response } from 'express';
import { verifyWebhook } from '@plantmewallet/merchant-sdk/webhooks';

const app = express();

// Capture the raw body for any application/json POST. The verifier reads it
// directly; downstream handlers can JSON.parse it themselves.
app.use(express.raw({ type: 'application/json', limit: '1mb' }));

app.post('/webhook', (req: Request, res: Response) => {
  const signature = req.header('X-Webhook-Signature');
  const timestamp = req.header('X-Webhook-Timestamp');

  if (!signature || !timestamp) {
    res.status(400).json({ error: 'missing_signature_or_timestamp' });
    return;
  }

  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'server_not_configured' });
    return;
  }

  const body = req.body as Buffer;
  const result = verifyWebhook({
    payload: body,
    signature,
    secret,
    timestamp,
  });

  if (!result.valid) {
    console.warn('[webhook] rejected:', result.reason);
    res.status(401).json({ error: result.reason });
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(body.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'malformed_json' });
    return;
  }

  console.log('[webhook] received:', event);
  res.status(200).json({ received: true });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`[webhook] listening on :${port}`);
});
