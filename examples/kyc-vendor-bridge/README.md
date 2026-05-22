# kyc-vendor-bridge

Receives a callback from an external KYC vendor (Sumsub, Onfido, Persona,
etc), maps the vendor's user identifier to the corresponding PlantMe end-
user, and kicks off our hosted KYC flow so all documents land inside the
regulated wallet account.

The bridge exposes:

- `POST /kyc-vendor/callback` accepts `{vendorUserId, requestedLevel?, returnUrl?}` and returns the hosted KYC page URL
- `GET  /kyc-vendor/status/:vendorUserId` returns the current KYC status

## Run

```bash
export MERCHANT_API_KEY=pk_live_...
export MERCHANT_HMAC_SECRET=...
export PORT=4000

npm install
npm start
```

## Notes

- The mapping from `vendorUserId` to PlantMe `userId` is hard-coded in
  this example. A real bridge stores both ids on the platform's user row
  (along with the parent merchant id).
- Vendor callbacks are usually signed; verify the vendor's signature
  before hitting our SDK so a forged callback cannot trigger a real KYC
  session.
- The `client.platform.users(uid).kyc.start` call automatically attaches
  the `X-PM-Acting-User` header so the merchant-service routes the
  request to the named end-user.
