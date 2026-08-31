// Public type contracts shared across resources. Field shapes mirror the
// merchant-service OpenAPI spec at openapi/merchant-public-v1.yaml. All monetary
// values are decimal strings to preserve BigNumber precision through JSON.

export type MerchantTier = 'none' | 'professional' | 'business' | 'enterprise';

export type OrderType = 'buy' | 'sell';
export type OrderStatus = 'active' | 'paused' | 'filled' | 'cancelled';

export type TradeStatus =
  | 'initiated'
  | 'payment_pending'
  | 'payment_sent'
  | 'completed'
  | 'disputed'
  | 'cancelled';

export type TradeSource = 'quick_trade' | 'marketplace';

export type MessageType = 'text' | 'image_url';

export interface MerchantAccount {
  merchantId: string;
  tier: MerchantTier;
  status: 'active' | 'suspended' | 'pending';
  expressEligible: boolean;
  expressAvailable: boolean;
  kycStatus: string;
  permissions: string[];
  createdAt: string;
}

export interface AvailabilityResponse {
  available: boolean;
  status: string;
  tier: MerchantTier;
}

export interface CreateOrderInput {
  type: OrderType;
  cryptocurrency: string;
  fiatCurrency: string;
  amount: string;
  price: string;
  // Display names as the server publishes them per fiat currency, for example
  // 'Bank Transfer' or 'PayNow', not identifiers. The set is validated against
  // fiatCurrency, and a value outside it is refused with the allowed list.
  paymentMethods: string[];
  // Minutes the buyer has to pay. Required: the server rejects an order
  // without it rather than applying a default.
  timeLimit: number;
  // Optional caps and constraints. The server applies tier-based defaults
  // when omitted.
  minAmount?: string;
  maxAmount?: string;
  terms?: string;
  autoReply?: string;
}

export interface UpdateOrderInput {
  price?: string;
  amount?: string;
  minAmount?: string;
  maxAmount?: string;
  status?: OrderStatus;
  // Same display-name form as CreateOrderInput.
  paymentMethods?: string[];
  timeLimit?: number;
  terms?: string;
  autoReply?: string;
}

export interface ListOrdersOptions {
  status?: OrderStatus;
  limit?: number;
  before?: string;
}

export interface Order {
  orderId: string;
  type: OrderType;
  cryptocurrency: string;
  fiatCurrency: string;
  amount: string;
  remainingAmount: string;
  price: string;
  status: OrderStatus;
  minAmount?: string;
  maxAmount?: string;
  paymentMethodIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ListTradesOptions {
  status?: TradeStatus;
  source?: TradeSource;
  limit?: number;
  before?: string;
}

export interface Trade {
  tradeId: string;
  orderId: string;
  type: OrderType;
  cryptocurrency: string;
  fiatCurrency: string;
  amount: string;
  price: string;
  fiatAmount: string;
  status: TradeStatus;
  source: TradeSource;
  buyerId: string;
  sellerId: string;
  paymentMethodId?: string;
  createdAt: string;
  updatedAt: string;
  paymentDeadline?: string;
}

export interface Message {
  messageId: string;
  tradeId: string;
  senderId: string;
  content: string;
  type: MessageType;
  createdAt: string;
}

export interface ListMessagesOptions {
  limit?: number;
  since?: number;
}

export interface ListMessagesResponse {
  messages: Message[];
  hasMore: boolean;
}

export interface WalletBalance {
  currency: string;
  available: string;
  total: string;
  locked: string;
}

export interface WalletHold {
  holdId: string;
  currency: string;
  amount: string;
  reason: string;
  tradeId?: string;
  createdAt: string;
  expiresAt?: string;
}

// One movement of funds in the merchant's own wallet. Deposits, withdrawals
// and transfers are rows of the same ledger, so `type` distinguishes them
// rather than each having its own shape.
export interface WalletTransaction {
  id: string;
  type: string;
  // Which way the money moved, decided by the server from the entry type and
  // the amount, so a caller never infers it from the sign of a number.
  direction: 'in' | 'out';
  // Decimal strings. These are BigNumber-safe on the server and a float parse
  // loses precision once a balance grows, so they stay strings end to end.
  //
  // `amount` is the magnitude and is never negative. The server stores a
  // withdrawal as a negative number and a transfer out as a positive one even
  // though both move funds out, so the SDK strips the sign and leaves
  // `direction` as the only thing that says which way the money went.
  amount: string;
  balanceAfter: string;
  currency: string;
  // Present when the movement came from that source, null otherwise. Use them
  // to join a row back to whatever caused it.
  tradeId: string | null;
  escrowId: string | null;
  withdrawalId: string | null;
  depositId: string | null;
  createdAt: string;
}

export interface ListWalletTransactionsOptions {
  // Entry types to include. Omit for every type.
  type?: string | string[];
  currency?: string;
  // ISO timestamps bounding the range.
  from?: string;
  to?: string;
  // Server caps this at 200.
  limit?: number;
  cursor?: string;
}

export interface PaymentMethod {
  paymentMethodId: string;
  type: string;
  bank?: string;
  accountNumberMasked?: string;
  accountHolder?: string;
  verified: boolean;
  createdAt: string;
}

export interface PriceQuote {
  orderId: string;
  price: string;
  amount: string;
  merchantId: string;
}

export interface BestPrices {
  bestBuy: PriceQuote | null;
  bestSell: PriceQuote | null;
  spread: string;
  spreadPercent: string;
}

export interface MarketAd {
  orderId: string;
  type: OrderType;
  price: string;
  amount: string;
  remainingAmount: string;
  minAmount?: string;
  maxAmount?: string;
  merchantId: string;
  merchantName?: string;
  merchantTier?: MerchantTier;
}

export interface ReferencePrice {
  price: string;
  source: string;
  timestamp: number;
}

export interface RankInfo {
  orderId: string;
  rank: number;
  totalCompetitors: number;
  score: number;
  factors: Record<string, number>;
}

export interface AnalyticsStats {
  window: string;
  totalTrades: number;
  completedTrades: number;
  cancelledTrades: number;
  disputedTrades: number;
  completionRate: number;
  averageReleaseSeconds: number;
  volume: Record<string, string>;
  fees: Record<string, string>;
}

export interface WebhookConfig {
  url?: string;
  events: string[];
  active: boolean;
  failureCount?: number;
  lastSuccessAt?: string;
  lastFailedAt?: string;
}

export interface UpdateWebhookConfigInput {
  url?: string;
  events?: string[];
  active?: boolean;
}

export interface WebhookLogEntry {
  logId: string;
  eventType: string;
  url: string;
  status: 'delivered' | 'failed' | 'pending';
  statusCode?: number;
  attempt: number;
  deliveredAt?: string;
  errorMessage?: string;
  createdAt: string;
}

export interface Paginated<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface ServerTime {
  serverTime: number;
  iso: string;
}

export interface ClockDriftSample {
  driftMs: number;
  rttMs: number;
}

export interface DisputeResponse {
  disputeId: string;
  status: string;
}

// Optional per-request overrides. Idempotency keys here let callers pin a
// retry-safe key chosen by their workflow rather than the auto-generated one.
export interface RequestOptions {
  idempotencyKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  // Forces signing-on or signing-off. Only the /time endpoint should ever
  // run unsigned. Defaults to signed for everything under /api/v1/merchant.
  unsigned?: boolean;
  // Extra request headers merged on top of the SDK-managed headers. Used by
  // the platform namespace to inject X-PM-Acting-User on per-end-user calls.
  // SDK-managed headers (X-API-Key, X-Signature, X-Timestamp, X-Nonce,
  // X-Recv-Window, Idempotency-Key, Content-Type) take precedence and cannot
  // be overridden; anything else is passed through verbatim.
  extraHeaders?: Record<string, string>;
}
