// KYC vendor bridge. The platform's own backend receives a callback from
// an external KYC vendor (Sumsub, Onfido, Persona, etc) saying that an
// end-user has been pre-screened. The bridge maps the vendor's userId to
// the platform's PlantMe userId and kicks off our hosted KYC flow so the
// vendor's documents are escrowed inside the regulated wallet account.
//
// In production the vendor callback is itself signed; this example focuses
// on the SDK call into client.platform.users(uid).kyc.start.
//
// Run:
//   MERCHANT_API_KEY=pk_live_... \
//   MERCHANT_HMAC_SECRET=... \
//   PORT=4000 \
//   npx tsx index.ts

import express, { type Request, type Response } from 'express';
import { MerchantClient } from '@plantmewallet/merchant-sdk';

const apiKey = requireEnv('MERCHANT_API_KEY');
const hmacSecret = requireEnv('MERCHANT_HMAC_SECRET');

const client = new MerchantClient({
  apiKey,
  hmacSecret,
  baseUrl: process.env.MERCHANT_API_BASE_URL ?? 'https://api.plantmewallet.com'
});

// Toy in-memory mapping. A real bridge would read from the platform's user
// table where each row carries both the external vendor id and the
// PlantMe userId minted at signup time.
const externalToPlantmeUserId = new Map<string, string>([
  ['vendor_user_001', 'pmw_user_danny'],
  ['vendor_user_002', 'pmw_user_bob']
]);

const app = express();
app.use(express.json({ limit: '256kb' }));

app.post('/kyc-vendor/callback', async (req: Request, res: Response) => {
  const body = req.body as {
    vendorUserId?: string;
    requestedLevel?: 1 | 2 | 3;
    returnUrl?: string;
  };
  if (!body.vendorUserId) {
    res.status(400).json({ error: 'missing_vendorUserId' });
    return;
  }

  const plantmeUserId = externalToPlantmeUserId.get(body.vendorUserId);
  if (!plantmeUserId) {
    res.status(404).json({ error: 'unknown_vendor_user' });
    return;
  }

  try {
    const session = await client.platform.users(plantmeUserId).kyc.start({
      level: body.requestedLevel ?? 2,
      returnUrl: body.returnUrl ?? 'https://platform.example/kyc/done'
    });
    console.log(`[bridge] kicked KYC for vendor=${body.vendorUserId} pmw=${plantmeUserId} session=${session.kycSessionId}`);
    res.status(200).json({
      kycSessionId: session.kycSessionId,
      hostedPageUrl: session.hostedPageUrl,
      expiresAt: session.expiresAt
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    console.error(`[bridge] failed to start KYC for ${plantmeUserId}: ${msg}`);
    res.status(502).json({ error: 'kyc_start_failed' });
  }
});

// Convenience read so operators can poll the resulting status.
app.get('/kyc-vendor/status/:vendorUserId', async (req: Request, res: Response) => {
  const plantmeUserId = externalToPlantmeUserId.get(req.params.vendorUserId);
  if (!plantmeUserId) {
    res.status(404).json({ error: 'unknown_vendor_user' });
    return;
  }
  try {
    const status = await client.platform.users(plantmeUserId).kyc.get();
    res.status(200).json(status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    res.status(502).json({ error: 'kyc_status_failed', detail: msg });
  }
});

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`[bridge] kyc-vendor-bridge listening on :${port}`);
});
