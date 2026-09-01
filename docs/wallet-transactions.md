# Wallet transactions

Reads the movements behind a merchant's own balance: deposits, withdrawals,
internal transfers, escrow locks and releases, refunds and adjustments.

Deposits, withdrawals and transfers are rows of one ledger, so a single call
with a `type` filter serves all of them rather than each having its own
endpoint.

```ts
const page = await client.wallet.getTransactions({ type: 'deposit', limit: 200 });
```

## Requirements

| | |
|---|---|
| Scope | `wallet:transactions:read` |
| Endpoint | `GET /api/v1/merchant/wallet/transactions` |
| SDK | `>= 0.3.0-beta.1` |

The subject is the merchant the API key belongs to. The user id is taken from
the gateway-verified identity and never from anything the caller sends, so a
key can only reach the wallet it was issued for.

This is not the end-user wallet. A SaaS platform reading one of its own users'
history uses `client.platform.users(userId).getLedger()`, which is a different
route and a different scope.

## Options

```ts
interface ListWalletTransactionsOptions {
  type?: string | string[];   // omit for every type
  currency?: string;          // USDT
  from?: string;              // ISO timestamp, inclusive
  to?: string;                // ISO timestamp, inclusive
  limit?: number;             // default 50, server caps at 200
  cursor?: string;            // nextCursor from the previous page
}
```

`type` takes a single value or an array. An array is sent as the comma
separated list the server reads, so both of these are the same request:

```ts
await client.wallet.getTransactions({ type: 'deposit,withdrawal' });
await client.wallet.getTransactions({ type: ['deposit', 'withdrawal'] });
```

### Accepted `type` values

Money crossing the platform boundary:

| Type | Dir | What it is |
|---|---|---|
| `deposit` | in | Funds arrived on chain and were credited to the wallet |
| `withdrawal` | out | Funds sent to an external address |
| `withdrawal_refund` | in | A withdrawal failed and the funds were returned |

Money moving between users on the platform:

| Type | Dir | What it is |
|---|---|---|
| `transfer_in` | in | Received from another user |
| `transfer_out` | out | Sent to another user |
| `reverse_transfer_debit` | out | A completed transfer was reversed, taking the funds back from the side that received them |
| `reverse_transfer_credit` | in | The other half of that reversal, restoring the side that sent them |

Trade settlement:

| Type | Dir | What it is |
|---|---|---|
| `escrow_lock` | out | A trade opened and the seller's funds were locked into escrow. Still owned, not available |
| `escrow_release` | in | Escrow settled and the funds moved to the counterparty |
| `compensation_relock` | in | A release failed partway and the funds were locked again rather than left loose |
| `fee_refund` | in | A trade was cancelled after its fee was taken, so the fee came back |

Operational and treasury:

| Type | Dir | What it is |
|---|---|---|
| `adjustment` | by sign | A manual correction. Rare, and worth asking about if you see one |

Referrals:

| Type | Dir | What it is |
|---|---|---|
| `referral_reward` | in | Commission earned on a referred user's activity |
| `referral_payout` | by sign | Commission paid out to an external wallet |
| `referral_settlement` | by sign | Internal settlement from the fee wallet to the referral payout wallet |

Anything else is refused with `400 UNSUPPORTED_TYPE`. That is a client error,
not a service failure, so it is not worth retrying.

`fee` is deliberately absent. Fee rows are internal accounting rather than a
movement of the merchant's funds, and an unfiltered page withholds them for the
same reason.

**How `direction` is decided.** Eight types carry an explicit direction:
`deposit`, `transfer_in`, `escrow_release` and `referral_reward` are always
`in`; `withdrawal`, `transfer_out`, `escrow_lock` and `fee` are always `out`.
The rest, marked "by sign" above, take their direction from the sign of the
stored amount. That mapping exists because the stored sign alone would be
wrong for some types, `transfer_out` being the clearest case: it is held as a
positive number while moving funds out.

**A note on reading a balance.** `escrow_lock` leaves the wallet but the funds
are still the merchant's, held against an open trade. Treating it as money gone
understates what is owed. Pair it with `escrow_release` and
`compensation_relock` to see the round trip, or read `client.wallet.getHolds()`
for what is locked right now.

## Signature

```ts
async getTransactions(
  opts?: ListWalletTransactionsOptions,
  requestOpts?: RequestOptions
): Promise<Paginated<WalletTransaction>>
```

Every type is exported from the package root:

```ts
import type {
  WalletTransaction,
  ListWalletTransactionsOptions,
  Paginated,
  RequestOptions
} from '@plantmewallet/merchant-sdk';
```

## Response

`Paginated<T>` is the envelope every list method in the SDK returns, so the same
iteration works here as on orders and trades.

```ts
interface Paginated<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;   // absent on the last page
}
```

```ts
interface WalletTransaction {
  id: string;
  type: string;
  direction: 'in' | 'out';
  amount: string;
  balanceAfter: string;
  currency: string;
  tradeId: string | null;
  escrowId: string | null;
  withdrawalId: string | null;
  depositId: string | null;
  referenceId: string | null;
  counterparty: string | null;
  fee: string | null;
  createdAt: string;
}
```

### Field reference

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | This ledger row. The other party's leg of the same transfer has a different one |
| `type` | `string` | One of the entry types listed above |
| `direction` | `'in' \| 'out'` | Authoritative. Never infer direction from the amount |
| `amount` | `string` | Decimal, magnitude, never negative |
| `balanceAfter` | `string` | Decimal. The balance immediately after this row |
| `currency` | `string` | `USDT`, `ETH` or `TRX` |
| `tradeId` | `string \| null` | Set when a trade caused the movement |
| `escrowId` | `string \| null` | Set on escrow lock and release |
| `withdrawalId` | `string \| null` | Set on a withdrawal |
| `depositId` | `string \| null` | Set on a deposit |
| `referenceId` | `string \| null` | The operation this row belongs to. Carried on every type |
| `counterparty` | `string \| null` | Display name of the other party. Transfers only |
| `fee` | `string \| null` | What the platform took. Transfers only |
| `createdAt` | `string` | ISO 8601 |

The four join ids are populated when the movement came from that source and null
otherwise, so a `withdrawal` row can be matched to the withdrawal record a
customer is asking about.

`referenceId` identifies the operation rather than the row. Both legs of a
transfer carry the same one, so a debit can be paired with the credit that
answered it: two rows sharing a `referenceId` are two sides of one movement, not
one movement listed twice.

Null is meaningful and differs by field. `fee: null` says no fee was charged.
`counterparty: null` says no name was recorded, which happens on a little over
half of transfers. Neither is an error.

## Transfers

An internal transfer writes two rows, one per party. You see the leg that
belongs to your wallet and never the other, because the other belongs to
someone else's.

```jsonc
// You sent. Debited the gross.
{
  "id":           "6a5c1f9b2e4d7a3c81b09e14",
  "type":         "transfer_out",
  "direction":    "out",
  "amount":       "1",
  "currency":     "USDT",
  "balanceAfter": "1967931.369632",
  "tradeId":      null,
  "escrowId":     null,
  "withdrawalId": null,
  "depositId":    null,
  "referenceId":  "int-transfer-transfer-69da5feea9b6f794c86d54",
  "counterparty": "danny",
  "fee":          "0.01",
  "createdAt":    "2026-08-30T15:55:20.436Z"
}
```

```jsonc
// You received. Credited the net.
{
  "id":           "6a5c1f9b2e4d7a3c81b09e1a",
  "type":         "transfer_in",
  "direction":    "in",
  "amount":       "0.99",
  "currency":     "USDT",
  "balanceAfter": "1968037.469632",
  "tradeId":      null,
  "escrowId":     null,
  "withdrawalId": null,
  "depositId":    null,
  "referenceId":  "int-transfer-transfer-69da5feea9b6f794c86d54",
  "counterparty": "senthil",
  "fee":          "0.01",
  "createdAt":    "2026-08-30T15:55:20.436Z"
}
```

Same `referenceId`, different `id`. `counterparty` reads from whichever side the
row sits on: who you paid on the debit, who paid you on the credit.

### How the fee works

The sender is debited the gross and the recipient credited the net. The
difference goes to the platform wallet, which is neither party's, so no row in
either history accounts for it:

```
amount 0.99  +  fee 0.01  =  1     what the sender was debited
```

`fee` is therefore informational on both legs rather than a charge against the
row's owner. On a `transfer_out` it is what the recipient absorbed; on a
`transfer_in` it is what you absorbed. Neither is money debited from you, so do
not sum it as a cost you paid.

About half of transfers carry no fee at all, and report `fee: null`. Platform
funding of an end user is one of those.

### Telling a transfer apart from trade settlement

Trade settlement does not use transfer types. It moves funds through
`escrow_lock` and `escrow_release`, so the type alone separates them.

The exception is a saga compensation: a settlement that failed partway and was
reversed by moving funds directly. It is written as a `transfer_out` and carries
a `tradeId` and an `escrowId`, which is what distinguishes it.

```ts
const isUserTransfer =
  (tx.type === 'transfer_out' || tx.type === 'transfer_in') &&
  tx.tradeId === null &&
  tx.escrowId === null;
```

## Reading amounts

**`amount` is a magnitude and is never negative. `direction` is the only thing
that says which way the funds moved.**

This matters because the service stores the sign inconsistently: a withdrawal
is held as a negative number while a transfer out is held positive, though both
move funds out. The SDK strips the sign so the two fields always agree.

```ts
const net = page.items.reduce(
  (sum, tx) => tx.direction === 'out' ? sum - Number(tx.amount) : sum + Number(tx.amount),
  0
);
```

If you call the HTTP endpoint directly rather than through the SDK you will see
the raw signs, and the reduction above would add a withdrawal instead of
subtracting it. Take the magnitude yourself in that case.

**Amounts are strings, not numbers.** They are BigNumber-safe on the service and
a float parse loses precision once a balance grows. The `Number()` above is fine
for a small illustration; feed real reconciliation through a decimal library and
keep the strings intact end to end.

## Pagination

Paging is by cursor, not offset. The ledger grows at the head, so an offset walk
skips or repeats rows as new entries land mid-iteration.

```ts
let cursor: string | undefined;
const all: WalletTransaction[] = [];

do {
  const page = await client.wallet.getTransactions({ limit: 200, cursor });
  all.push(...page.items);
  cursor = page.nextCursor;
} while (cursor);
```

Stop when `nextCursor` is absent. `hasMore` reports the same thing and is
`false` when the field is missing entirely, so neither will walk you into a
loop against a service that has stopped sending cursors.

## Verifying a page

Every row carries `balanceAfter`, the balance immediately after that movement.
Walking a page in order, each `balanceAfter` should equal the previous one plus
or minus the signed amount. A break in that chain localises a discrepancy to one
entry rather than leaving a total that is merely wrong.

## Examples

Deposits and withdrawals for one currency in a date range:

```ts
const page = await client.wallet.getTransactions({
  type: ['deposit', 'withdrawal'],
  currency: 'USDT',
  from: '2026-09-01T00:00:00Z',
  to: '2026-09-30T23:59:59Z',
  limit: 200
});
```

Everything that moved funds out, across pages:

```ts
const OUTBOUND = ['withdrawal', 'transfer_out', 'escrow_lock'];
let cursor: string | undefined;
let total = 0;

do {
  const page = await client.wallet.getTransactions({ type: OUTBOUND, limit: 200, cursor });
  total += page.items.reduce((sum, tx) => sum + Number(tx.amount), 0);
  cursor = page.nextCursor;
} while (cursor);
```

Per-request overrides work as they do elsewhere in the SDK:

```ts
await client.wallet.getTransactions(
  { limit: 50 },
  { signal: controller.signal, headers: { 'X-Request-Id': traceId } }
);
```

## Confirming a claimed transfer

A customer says they sent money and quotes what their receipt showed. Rather
than paging the history and comparing by eye, ask whether the claim matches:

```ts
const result = await client.wallet.verifyTransfer({
  type: 'transfer_in',
  reference: '#3A6W2S391R',
  counterparty: 'alice',
  amount: '653.50'
});

if (result.matched) {
  // The transfer exists, settled, and matches the name and figure claimed.
}
```

| | |
|---|---|
| Scope | `wallet:transactions:read` |
| Endpoint | `POST /api/v1/merchant/wallet/transfers/verify` |
| SDK | `>= 0.3.0-beta.2` |

Only `transfer_in` and `transfer_out` can be confirmed. No other movement has
two parties who could disagree about it.

### Input

```ts
interface VerifyTransferInput {
  type: 'transfer_in' | 'transfer_out';
  reference: string;
  counterparty?: string;
  amount?: string;
}
```

`type` is required rather than inferred. The counterparty is the sender on a
received transfer and the recipient on a sent one, so without it the endpoint
would have to guess which question was being asked, and answering the wrong one
would report a payment that did arrive as missing.

`counterparty` and `amount` are optional. Omitting one means it is not checked,
which is how you confirm a transfer exists and settled without asserting who
sent it or for how much.

### What `reference` accepts

Either form of the same value:

```
int-transfer-transfer-69da5feea9b6f794c86d54    the referenceId on a row
#3A6W2S391R                                     the code on the receipt
3A6W2S391R                                      the same, without the hash
```

The receipt shows the last ten characters of the reference, upper cased with
the dashes removed. It is what a customer has in front of them, so it is
accepted, but it is a lossy view: ten characters can put two rows on one code.
When that happens the claim is refused with `ambiguousReference` rather than
resolved to whichever matched first, because a payment confirmed on a guess is
worse than one the service declines to answer. Pass the full `referenceId` when
you have it.

### Result

```ts
interface VerifyTransferResult {
  matched: boolean;
  type: 'transfer_in' | 'transfer_out';
  status: string | null;
  counterpartyKnown: boolean;
  ambiguousReference: boolean;
  checks: {
    referenceFound: boolean;
    counterpartyMatches: boolean;
    amountMatches: boolean;
    confirmed: boolean;
  };
  transaction: {
    id: string;
    referenceId: string | null;
    type: string;
    amount: string;
    currency: string;
    createdAt: string;
  } | null;
}
```

`matched` is true only when every check passed. The individual checks are
reported so a wrong figure can be told from a wrong sender, which discloses
nothing new: the same scope can already read all of it off the transactions
page.

### The four checks

| Check | Fails when |
|---|---|
| `referenceFound` | No row of that direction in your wallet carries that reference |
| `counterpartyMatches` | The recorded name differs from the one claimed, or none was recorded |
| `amountMatches` | The figure claimed differs from this row's own amount |
| `confirmed` | The transfer did not settle |

`confirmed` is the one that matters most. A transfer that failed or is still
pending must never read as money received, however well the rest of the claim
matches.

Amounts are compared as decimals, so `0.99` and `0.990` agree, and against
**this side's own figure**: the gross on a sent transfer, the net on a received
one. Claiming the gross while verifying a `transfer_in` is the likeliest source
of a false negative.

### When the sender is unknown

The ledger records the counterparty's name on about half of received transfers.
When it is missing you get both:

```ts
result.checks.counterpartyMatches === false
result.counterpartyKnown === false
```

Read together those say "the ledger cannot tell us who sent this", which is a
different answer from "somebody else sent it". A merchant chasing a payment
needs to tell them apart, so the flag is reported rather than the check quietly
passing.

The other leg cannot supply the missing name. A row records its counterparty,
never its own owner, so the sender's own `transfer_out` does not name them
either.

### Without the SDK

```js
const body = JSON.stringify({
  type: 'transfer_in',
  reference: '#3A6W2S391R',
  counterparty: 'alice',
  amount: '653.50'
});

const path = '/api/v1/merchant/wallet/transfers/verify';
const timestamp = String(Date.now() + clockOffsetMs);
const nonce = randomBytes(16).toString('hex');
const canonical = `POST:${path}:${timestamp}:${nonce}:${body}`;
const signature = createHmac('sha256', HMAC_SECRET).update(canonical).digest('hex');
```

The body is signed exactly as sent, so serialise once and use that same string
for both the signature and the request.

## Errors

| Status | Code | Meaning |
|---|---|---|
| `400` | `UNSUPPORTED_TYPE` | `type` names a value the service does not accept |
| `400` | `X_PM_ACTING_USER_REQUIRED` | see below |
| `401` | `AUTHENTICATION_FAILED` | signature, timestamp or key rejected |
| `403` | `PERMISSION_DENIED` | key lacks `wallet:transactions:read`; the body names it in `required` |

### A note on `X_PM_ACTING_USER_REQUIRED`

A key with `scope=platform_users` is refused this way unless the service is at
a build that lists `/wallet/transactions` as a tenant level route. The header
that error asks for names an end user, and this route reads the merchant's own
wallet, so there is no value that would satisfy it.

A key with `scope=self`, which is what a direct merchant holds, is not affected
and works regardless.

## Complete example, with the SDK

Credentials come from the API key creation screen and are shown once. Keep them
in the environment, never in source.

```ts
import { MerchantClient, type WalletTransaction } from '@plantmewallet/merchant-sdk';

const client = new MerchantClient({
  apiKey: process.env.MERCHANT_API_KEY!,       // pk_live_...
  hmacSecret: process.env.MERCHANT_HMAC_SECRET!,
  baseUrl: 'https://api.plantmewallet.com'
});

// Every deposit and withdrawal in September, across all pages.
async function septemberMovements(): Promise<WalletTransaction[]> {
  const rows: WalletTransaction[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.wallet.getTransactions({
      type: ['deposit', 'withdrawal'],
      currency: 'USDT',
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T23:59:59Z',
      limit: 200,
      cursor
    });
    rows.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);

  return rows;
}

const rows = await septemberMovements();

const deposited = rows
  .filter((t) => t.type === 'deposit')
  .reduce((sum, t) => sum + Number(t.amount), 0);

const withdrawn = rows
  .filter((t) => t.type === 'withdrawal')
  .reduce((sum, t) => sum + Number(t.amount), 0);

console.log(`in ${deposited}, out ${withdrawn}, net ${deposited - withdrawn}`);
```

`Number()` is used here for brevity. Real reconciliation should keep the
strings and use a decimal library, because a float sum drifts once balances
grow past what a double represents exactly.

Handling the errors worth distinguishing:

```ts
import { AuthenticationError, ValidationError } from '@plantmewallet/merchant-sdk';

try {
  await client.wallet.getTransactions({ type: 'deposit' });
} catch (err: any) {
  if (err instanceof AuthenticationError) {
    // Key, signature or clock. Not retryable without fixing something.
  } else if (err instanceof ValidationError) {
    // A rejected filter, for example an unknown type.
  } else if (err?.status === 403) {
    // Key lacks wallet:transactions:read. err.required names it.
  } else {
    throw err;
  }
}
```

## Complete example, without the SDK

The endpoint is an ordinary signed GET. Sign
`METHOD:PATH:TIMESTAMP:NONCE:BODY`, with the querystring excluded from the path
and an empty body for a GET:

```
GET:/api/v1/merchant/wallet/transactions:1788190000000:a1b2c3d4e5f6:
```

```js
const { createHmac, randomBytes } = require('node:crypto');

const BASE_URL = 'https://api.plantmewallet.com';
const API_KEY = process.env.MERCHANT_API_KEY;
const HMAC_SECRET = process.env.MERCHANT_HMAC_SECRET;

// Measured once at startup against GET /api/v1/merchant/time, which needs no
// signature. A clock more than the receive window out of step is rejected.
let clockOffsetMs = 0;

async function syncClock() {
  const started = Date.now();
  const res = await fetch(`${BASE_URL}/api/v1/merchant/time`);
  const { serverTime } = await res.json();
  const roundTrip = Date.now() - started;
  clockOffsetMs = serverTime - (started + roundTrip / 2);
}

async function signedGet(pathWithQuery) {
  // The querystring travels on the url but is not part of the signature.
  const path = pathWithQuery.split('?')[0];
  const body = '';
  const timestamp = String(Date.now() + clockOffsetMs);
  // Single use. The server rejects a repeat, so generate a fresh one per
  // attempt including retries.
  const nonce = randomBytes(16).toString('hex');

  const canonical = `GET:${path}:${timestamp}:${nonce}:${body}`;
  const signature = createHmac('sha256', HMAC_SECRET).update(canonical).digest('hex');

  const res = await fetch(`${BASE_URL}${pathWithQuery}`, {
    method: 'GET',
    headers: {
      'X-API-Key': API_KEY,
      'X-Signature': signature,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
      'X-Recv-Window': '5000'
    }
  });

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(payload.message || payload.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = payload.code;
    err.required = payload.required;
    throw err;
  }
  return payload;
}

async function allTransactions(type) {
  await syncClock();
  const rows = [];
  let cursor;

  do {
    const query = new URLSearchParams({ limit: '200', type });
    if (cursor) query.set('cursor', cursor);

    const page = await signedGet(`/api/v1/merchant/wallet/transactions?${query}`);
    rows.push(...(page.transactions || []));
    cursor = page.nextCursor || undefined;
  } while (cursor);

  return rows;
}

// The raw endpoint returns the stored sign, so a withdrawal arrives negative
// while a transfer out arrives positive. Take the magnitude and let direction
// decide, or a total drifts by twice each withdrawal.
const rows = await allTransactions('deposit,withdrawal');
const net = rows.reduce((sum, tx) => {
  const magnitude = Math.abs(Number(tx.amount));
  return tx.direction === 'out' ? sum - magnitude : sum + magnitude;
}, 0);
```

Four things the SDK does for you that this code has to do itself: measuring
clock drift, generating a fresh nonce per attempt, excluding the querystring
from the signature, and normalising the amount sign.
`src/transport/signing.ts` is the authoritative definition if you are porting
to another language.
