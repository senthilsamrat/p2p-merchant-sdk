# platform-starter

End-to-end starter for SaaS-tier API keys (`scope=platform_users`). The
script provisions a new end-user, kicks off KYC, lists existing users, and
prints each user's wallet balance.

## Run

```bash
export MERCHANT_API_KEY=pk_live_...
export MERCHANT_HMAC_SECRET=...
export PLATFORM_USER_EXTERNAL_ID=tradekr_user_001
export PLATFORM_USER_EMAIL=user@tradekr.example     # optional
export PLATFORM_USER_DISPLAY_NAME='danny Choi'      # optional
export KYC_RETURN_URL=https://platform.example/kyc/done

npm install
npm start
```

## What it covers

- `client.platform.users.create` for end-user provisioning
- `client.platform.users(uid).kyc.start` to obtain a hosted KYC page URL
- `client.platform.users.list` for cursor-paginated user enumeration
- `client.platform.users(uid).wallet.getBalance` per-user balance lookup
- Automatic injection of `X-PM-Acting-User` on every per-user call
