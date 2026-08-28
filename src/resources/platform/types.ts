// Platform-namespace type contracts. Mirrors the SaaS end-user and revshare
// shapes from merchant-service. All monetary values are decimal strings so
// callers preserve BigNumber precision over JSON.

export type PlatformUserStatus = 'active' | 'suspended' | 'inactive';
export type KycLevel = 1 | 2 | 3;

export interface CreatePlatformUserInput {
  // Stable identifier from the calling platform's own user database. The
  // merchant-service stores it for reverse lookup but does not interpret it.
  externalUserId?: string;
  email?: string;
  displayName?: string;
  region?: string;
  kycLevelRequired?: KycLevel;
  metadata?: Record<string, unknown>;
}

export interface PlatformUser {
  userId: string;
  email?: string;
  displayName?: string;
  status: PlatformUserStatus;
  kycLevel: number;
  kycStatus?: string;
  externalUserId?: string;
  parentMerchantId: string;
  createdAt: string;
  lastLoginAt?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdatePlatformUserInput {
  displayName?: string;
  email?: string;
  metadata?: Record<string, unknown>;
}

export interface ListPlatformUsersOptions {
  limit?: number;
  cursor?: string;
  status?: PlatformUserStatus;
  kycLevel?: number;
  search?: string;
}

export interface ListPlatformUsersResponse {
  users: PlatformUser[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface SuspendUserInput {
  reason?: string;
}

export interface SoftDeleteUserInput {
  deletionReason?: string;
}

// KYC orchestration on behalf of an end-user. The hosted page lets the
// end-user upload documents directly to the KYC vendor.
export interface StartKycInput {
  level: KycLevel;
  returnUrl?: string;
}

export interface StartKycResponse {
  // Null until the vendor creates an applicant, which happens when the
  // end-user actually opens the flow rather than when the session is created.
  kycSessionId: string | null;
  // Redirect the end-user here. Honours returnUrl and needs no vendor code in
  // your frontend. Null only if the vendor could not mint a link, in which
  // case sdkToken is still usable.
  hostedPageUrl: string | null;
  // For platforms that would rather embed the vendor widget and keep the
  // end-user inside their own page.
  sdkToken: string;
  levelName: string;
  expiresAt: string;
}

// Accepting an order from the marketplace, which opens a trade against it.
export interface AcceptOrderInput {
  // The order to accept. Must be open, must not belong to this end-user, and
  // must have room for the amount.
  orderId: string;
  // Crypto amount to trade, as a decimal string. Has to sit inside the order's
  // own min and max, and inside the end-user's KYC per-trade cap.
  amount: string;
  // One of the payment methods the order accepts, by the display name the
  // order lists, for example 'Bank Transfer'.
  paymentMethod: string;
  // Required. Opening a trade commits funds, so a retry must not create a
  // second one. Re-sending the same key returns the original trade rather than
  // opening another.
  idempotencyKey: string;
}

export interface KycStatus {
  status: string;
  level: number;
  expiresAt?: string;
  lastUpdated: string;
}

// Per-end-user wallet shapes. Mirror the top-level WalletBalance/WalletHold
// types but live under the user-scoped path /merchant/users/:userId/wallet/*.
export interface ScopedWalletBalance {
  currency: string;
  available: string;
  total: string;
  locked: string;
}

export interface ScopedWalletHold {
  id: string;
  currency: string;
  amount: string;
  reason: string;
  tradeId: string | null;
  escrowId: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface ScopedLedgerEntry {
  entryId: string;
  type: string;
  // Which way the money moved. Derived from the entry type rather than the
  // sign of the amount, because the sign is not consistent across the paths
  // that write these rows.
  direction: 'in' | 'out';
  currency: string;
  amount: string;
  balanceAfter: string;
  // The identifier for whichever flow produced the row. Exactly one is set
  // on any given entry and the rest are null.
  tradeId: string | null;
  escrowId: string | null;
  withdrawalId: string | null;
  depositId: string | null;
  createdAt: string;
  // The same instant as createdAt, kept because the server has always sent it.
  timestamp: string;
}

export interface ListLedgerOptions {
  currency?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface ListLedgerResponse {
  entries: ScopedLedgerEntry[];
  hasMore: boolean;
  nextCursor?: string;
}

// Internal user-to-user transfer within the same parent platform.
export interface TransferInput {
  toUserId: string;
  amount: string;
  currency: string;
  memo?: string;
  // Optional client-supplied idempotency key. The transport will also
  // generate one automatically when omitted, but callers running long
  // workflows usually want a deterministic key.
  idempotencyKey?: string;
}

export interface TransferResult {
  transferId: string;
  fromUserId: string;
  toUserId: string;
  amount: string;
  currency: string;
  status: string;
  createdAt: string;
  // Same instant as createdAt, kept for callers already reading it.
  timestamp?: string;
  // A settled replay is answered with the stored 2xx body, which is
  // indistinguishable from the original, so nothing marks it as one. A
  // still-settling call is a 409 the transport replays on the same key.
  // replay?: boolean;
}

export interface WithdrawInput {
  amount: string;
  currency: string;
  address: string;
  network?: string;
  idempotencyKey?: string;
}

export interface WithdrawResult {
  withdrawalId: string;
  status: string;
  amount: string;
  currency: string;
  address: string;
  createdAt: string;
  // Same instant as createdAt, kept for callers already reading it.
  timestamp?: string;
  // A settled replay is answered with the stored 2xx body, which is
  // indistinguishable from the original, so nothing marks it as one. A
  // still-settling call is a 409 the transport replays on the same key.
  // replay?: boolean;
}

// Networks an end-user deposit address can be issued on. ERC20 and BEP20 share
// one EVM address; TRC20 is a separate address entirely.
export const DEPOSIT_NETWORKS = ['ERC20', 'TRC20', 'BEP20'] as const;

export type DepositNetwork = (typeof DEPOSIT_NETWORKS)[number];

// Currencies an end-user deposit address can be issued for. Anything else is
// refused, so the type names the set rather than leaving it to a runtime error.
export const DEPOSIT_CURRENCIES = ['USDT'] as const;

export type DepositCurrency = (typeof DEPOSIT_CURRENCIES)[number];

export interface DepositAddressInput {
  currency: DepositCurrency;
  // Required and without a default. The address returned belongs to this chain
  // and no other, so an omitted or unrecognised value is refused rather than
  // answered with whichever address the user happens to have.
  network: DepositNetwork;
}

export interface DepositAddress {
  currency: DepositCurrency;
  // Always describes the address in this same response.
  network: DepositNetwork;
  address: string;
  memo?: string;
  qrCodeUrl?: string;
}

// Per-end-user payment methods. The platform owns the bank-account record
// on behalf of its end-users; the SaaS API surfaces add/list/remove.
export interface ScopedPaymentMethod {
  id: string;
  methodType: string;
  label?: string;
  maskedAccount: string | null;
  bankName: string | null;
  isVerified: boolean;
  readyForTrading: boolean;
  country?: string;
  currency?: string;
  isDefault: boolean;
  createdAt: string | null;
}

// Marketplace publishing state for a single end-user. Mirrors the response
// of GET /api/v1/merchant/users/:userId/marketplace.
export interface PlatformMarketplaceState {
  // True when the user's KYC level + tenant config let them publish at all.
  // Eligibility is a precondition for enable(); the server returns 409
  // MARKETPLACE_NOT_ELIGIBLE when callers try to enable without it.
  eligible: boolean;
  // True when the user's ads currently appear in the public marketplace.
  publishEnabled: boolean;
  // ISO timestamp of the last enable() that took effect. null when never on.
  publishedAt: string | null;
  // when eligible=false (e.g., kyc_level_below_2).
  reason?: string;
}

export interface MarketplaceEnableResult {
  publishEnabled: true;
  publishedAt: string;
}

export interface MarketplaceDisableResult {
  publishEnabled: false;
}

// Source tag attached to every fund-user audit row. Used by compliance to
// segment outbound platform transfers in reporting (bonus vs refund vs
// affiliate vs other). 'refund' additionally requires linkedTradeId so the
// audit trail can resolve which trade was refunded.
export type PlatformFundUserSource = 'bonus' | 'refund' | 'affiliate' | 'other';

// Currency set restricted at launch. Matches wallet-service supported coins.
export type PlatformFundUserCurrency = 'USDT' | 'ETH' | 'TRX';

export interface PlatformFundUserInput {
  // Recipient end-user. MUST belong to the calling tenant.
  toUserId: string;
  // Decimal string. wallet-service applies BigNumber + per-currency precision
  // validation. Negative values are rejected.
  amount: string;
  currency: PlatformFundUserCurrency;
  // Audit source tag. 'refund' requires linkedTradeId.
  source: PlatformFundUserSource;
  // Optional client idempotency key. The transport auto-generates a uuid v4
  // when omitted. The server caches the response for 24h on first call so
  // retries with the same key return the stored response rather than
  // re-executing.
  idempotencyKey?: string;
  // Optional free-form note attached to the audit row. Server-side PII filter
  // rejects strings that look like card numbers, IBANs, SSNs, etc, with code
  // PII_IN_MEMO. Max length 200.
  memo?: string;
  // 24-char hex ObjectId. REQUIRED when source='refund'; the server returns
  // 400 FUND_USER_REFUND_REQUIRES_TRADE_ID otherwise.
  linkedTradeId?: string;
}

export interface PlatformFundUserResult {
  // wallet-service transfer id from the platform owner -> end-user move.
  transferId: string;
  // LedgerEntry id of the credit posted on the recipient's wallet.
  ledgerEntryId: string;
  // Recipient's available balance after the credit. Decimal string.
  balanceAfter: string;
  // Hash-chained immutable audit row id. Lookup via the admin
  // /admin/saas/wallet/fund-user/audit-trail endpoint.
  auditId: string;
  status: 'completed';
}

export interface AddPaymentMethodInput {
  type: string;
  bank?: string;
  accountNumber?: string;
  accountHolder?: string;
  metadata?: Record<string, unknown>;
}

// Revshare reporting under /api/v1/merchant/revshare/*.
export type FeeSplitTarget = 'merchant' | 'platform' | 'house';

export interface FeeSplitLeg {
  target: FeeSplitTarget;
  basisPoints: number;
  // String share of the trade fee that ends up at this target. Decimal.
  amount?: string;
}

export interface EnterpriseMerchantConfig {
  configId: string;
  merchantId: string;
  version: number;
  effectiveAt: string;
  splits: FeeSplitLeg[];
  status: 'active' | 'pending_approval' | 'superseded';
  approvedBy?: string;
  createdAt: string;
}

export interface PreviewConfigInput {
  tradeAmount: string;
  tradeFee: string;
}

export interface PreviewConfigResponse {
  totalCommission: string;
  breakdown: Array<{
    target: FeeSplitTarget;
    basisPoints: number;
    amount: string;
  }>;
}

export interface ProposeConfigChangeInput {
  splits: FeeSplitLeg[];
  effectiveAt?: string;
  rationale?: string;
}

export interface ConfigProposal {
  proposalId: string;
  merchantId: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired';
  proposedSplits: FeeSplitLeg[];
  proposedBy: string;
  reviewedBy?: string;
  rationale?: string;
  rejectionReason?: string;
  createdAt: string;
  decidedAt?: string;
  expiresAt?: string;
  // True when the change took effect without manual review (within
  // tier-defined auto-approve bounds).
  autoApplied?: boolean;
}

export interface ListProposalsOptions {
  status?: ConfigProposal['status'];
  limit?: number;
  cursor?: string;
}

export interface ListConfigHistoryOptions {
  limit?: number;
  cursor?: string;
}

export interface RevshareEarnings {
  windowFrom: string;
  windowTo: string;
  currency: string;
  totalEarned: string;
  totalPaidOut: string;
  pendingPayout: string;
  clawbackTotal: string;
  tradeCount: number;
}

export interface GetEarningsOptions {
  from?: string;
  to?: string;
  currency?: string;
}

export interface RevshareReward {
  rewardId: string;
  tradeId: string;
  basisPoints: number;
  amount: string;
  currency: string;
  status: 'pending' | 'paid' | 'clawed_back';
  earnedAt: string;
  paidAt?: string;
  payoutId?: string;
}

export interface ListRewardsOptions {
  status?: RevshareReward['status'];
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface RevsharePayout {
  payoutId: string;
  merchantId: string;
  amount: string;
  currency: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  rewardCount: number;
  windowFrom: string;
  windowTo: string;
  createdAt: string;
  completedAt?: string;
  failureReason?: string;
}

export interface ListPayoutsOptions {
  status?: RevsharePayout['status'];
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface ReconciliationFinding {
  findingId: string;
  type: string;
  severity: 'info' | 'warning' | 'error';
  description: string;
  rewardId?: string;
  payoutId?: string;
  detectedAt: string;
}

export interface RevshareWebhookTestResult {
  delivered: boolean;
  statusCode?: number;
  latencyMs: number;
  errorMessage?: string;
}

export interface PaginatedPlatform<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
}

// SaaS quick-trade auto-match. Mirrors the consumer-facing /api/quick/*
// surface but routed under /api/v1/merchant/{users/:userId/quick,quick}/*
// so SaaS platforms can drive the matcher with HMAC keys on behalf of their
// end-users.

// Trade direction for the matcher. 'buy' means the acting user wants to
// receive crypto, 'sell' means the acting user wants to send crypto.
export type QuickTradeType = 'buy' | 'sell';

// Counterparty merchant returned alongside the matched order. Tier is the
// canonical merchant tier (none excluded; matcher only returns paid tiers).
export interface QuickTradeMerchant {
  id: string;
  username: string;
  tier: 'professional' | 'business' | 'enterprise';
  rating: number;
  completionRate: number;
  avgResponseTime: number;
  totalTrades: number;
  isOnline: boolean;
  // SaaS tenancy ownership of this counterparty. Same parentMerchantId as
  // the acting user when the match is intra-tenant (the default isolation
  // mode); a different value indicates the tenant has crossPlatformTrade
  // enabled and the matcher returned a cross-tenant counterparty.
  parentMerchantId?: string;
}

export interface QuickTradeMatchedOrder {
  orderId: string;
  price: number;
  availableAmount: number;
  minTradeAmount: number;
  maxTradeAmount: number;
  paymentMethods: string[];
}

export interface QuickTradeQuote {
  youPay: number;
  youReceive: number;
  rate: number;
  fees: {
    platform: number;
    total: number;
  };
}

// Best-match envelope returned by GET .../quick/best-match. Server normalises
// {success, data: {merchant, order, quote, priorityScore}}; the SDK extracts
// data and surfaces the inner shape with `matchedOrder` (alias of `order`)
// so callers can ignore the wrapper.
export interface QuickTradeBestMatchInput {
  cryptocurrency: string;
  fiatCurrency: string;
  type: QuickTradeType;
  amount: string;
  paymentMethod?: string;
}

export interface QuickTradeBestMatch {
  merchant: QuickTradeMerchant;
  // Matched order. Aliased on `matchedOrder` for callers who prefer the
  // disambiguating name; both fields are populated and identical.
  order: QuickTradeMatchedOrder;
  matchedOrder: QuickTradeMatchedOrder;
  quote: QuickTradeQuote;
  priorityScore: number;
}

// Initiate against a matched order. The SDK accepts either a discrete
// orderId (when the caller already knows which order to lock) or an
// auto-match flow where caller passes the same triple as best-match and
// the server resolves the order itself. The backend route accepts both.
export interface QuickTradeInitiateInput {
  cryptocurrency: string;
  fiatCurrency: string;
  type: QuickTradeType;
  amount: string;
  paymentMethod: string;
  // Specific order to lock. When omitted the server runs best-match itself
  // and locks the resolved candidate.
  orderId?: string;
  // Free-form terms attached to the resulting trade (compliance audit).
  terms?: string;
  // Phase-1 minutes window override. Server clamps to [15, 43200].
  timeLimit?: number;
  // Optional client idempotency key. When omitted the transport generates
  // a uuid v4. Re-issuing with the same key returns the cached response
  // for 24h instead of creating a duplicate trade.
  idempotencyKey?: string;
}

export interface QuickTradeInitiateResult {
  tradeId: string;
  orderId: string;
  buyerId: string;
  sellerId: string;
  cryptocurrency: string;
  fiatCurrency: string;
  amount: string;
  price: string;
  totalValue: string;
  status: string;
  paymentMethod: string;
  timeLimit?: number;
  expiresAt?: string;
  fees?: {
    platform: number;
    total: number;
  };
  source?: string;
  sagaId?: string;
}

// Read-only browsing surfaces returned by /api/v1/merchant/quick/*. These
// are merchant-scope (HMAC only, no acting user) so SaaS platforms can
// render market data to end-users client-side without proxying.
export interface QuickTradePair {
  cryptocurrency: string;
  fiatCurrency: string;
  bestBuyPrice: number;
  bestSellPrice: number;
  spread: number;
  volume24h: number;
  activeOrders: number;
}

export interface QuickTradeFeaturedMerchant {
  merchantId: string;
  username: string;
  tier: 'professional' | 'business' | 'enterprise';
  rating: number;
  completionRate: number;
  totalTrades: number;
  isOnline: boolean;
  bestBuyPrice?: number;
  bestSellPrice?: number;
  priorityScore: number;
}

export interface QuickTradeRecentActivity {
  tradeId: string;
  type: QuickTradeType;
  cryptocurrency: string;
  fiatCurrency: string;
  amount: number;
  price: number;
  completedAt: string;
  buyerRating?: number;
  sellerRating?: number;
}

export interface QuickTradePlatformStats {
  volume24h: number;
  totalCompletedTrades: number;
  avgCompletionTimeMinutes: number;
  activeOrdersCount: number;
  onlineMerchantsCount: number;
  lastUpdated: string;
}

export interface QuickTradeFeaturedMerchantsInput {
  cryptocurrency: string;
  fiatCurrency: string;
}
