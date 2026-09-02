// Public type contracts shared across resources. Field shapes mirror the
// merchant-service OpenAPI spec at openapi/merchant-public-v1.yaml. All monetary
// values are decimal strings to preserve BigNumber precision through JSON.

export type MerchantTier = 'none' | 'professional' | 'business' | 'enterprise';

export type OrderType = 'buy' | 'sell';
export type OrderStatus =
  | 'active'
  | 'paused'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'expired'
  | 'completed'
  | 'suspended';

export type TradeStatus =
  | 'initiated'
  | 'payment_pending'
  | 'payment_sent'
  | 'payment_confirmed'
  | 'completed'
  | 'disputed'
  | 'cancelled'
  | 'switching';

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
  // Listing lifetime in minutes (15..43200). When it elapses the order
  // advertisement expires; this is not the buyer's trade-payment window.
  // Required: the server rejects an order without it.
  timeLimit: number;
  // Optional caps and constraints. The server applies tier-based defaults
  // when omitted.
  minTradeAmount?: string;
  maxTradeAmount?: string;
  terms?: string;
  autoReply?: string;
}

export interface UpdateOrderFieldsInput {
  price?: string;
  amount?: string;
  minTradeAmount?: string;
  maxTradeAmount?: string;
  // Same display-name form as CreateOrderInput.
  paymentMethods?: string[];
  // Replacement listing lifetime in minutes (15..43200), counted from the
  // update. This does not alter any already-created trade payment window.
  timeLimit?: number;
  terms?: string;
  autoReply?: string;
  status?: never;
}

// Lifecycle transitions are intentionally separate from field edits. This
// prevents a generic PATCH from bypassing pause/reactivate/cancel invariants.
export type UpdateOrderStatusInput =
  | { status: 'active'; price?: never; amount?: never; minTradeAmount?: never; maxTradeAmount?: never; paymentMethods?: never; timeLimit?: never; terms?: never; autoReply?: never }
  | { status: 'paused'; price?: never; amount?: never; minTradeAmount?: never; maxTradeAmount?: never; paymentMethods?: never; timeLimit?: never; terms?: never; autoReply?: never };

export type UpdateOrderInput = UpdateOrderFieldsInput | UpdateOrderStatusInput;

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
  minTradeAmount?: string;
  maxTradeAmount?: string;
  paymentMethods: string[];
  timeLimit?: number;
  terms?: string;
  autoReply?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CancelOrderResult {
  orderId: string;
  message: string;
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
  totalValue: string;
  status: TradeStatus;
  source: TradeSource;
  buyerId: string;
  sellerId: string;
  paymentMethod: string;
  paymentMethodId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

export interface TradeActionResult {
  tradeId: string;
  status: TradeStatus;
  source?: TradeSource;
  amount?: string;
  totalValue?: string;
  paymentMethod?: string;
  role?: 'buyer' | 'seller';
  updatedAt?: string;
  completedAt?: string;
  expiresAt?: string;
  escrowId?: string;
  escrowStatus?: string;
  sagaId?: string;
}

export interface Message {
  messageId: string;
  tradeId: string;
  senderId: string;
  senderRole?: string;
  content: string;
  type: MessageType;
  timestamp: string;
}

export interface ListMessagesOptions {
  limit?: number;
  // Opaque cursor returned as nextCursor by the previous page.
  before?: string;
}

export interface ListMessagesResponse {
  messages: Message[];
  hasMore: boolean;
  nextCursor?: string;
  // Kept for compatibility with older merchant-service responses. Use
  // nextCursor for traversal; oldestMessageId is not an offset cursor.
  oldestMessageId?: string;
}

export interface WalletBalance {
  currency: string;
  available: string;
  total: string;
  locked: string;
}

export interface WalletHold {
  id: string;
  currency: string;
  amount: string;
  reason: string;
  tradeId: string | null;
  escrowId: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface VerifyTransferInput {
  type: 'transfer_in' | 'transfer_out';
  reference: string;
  counterparty?: string;
  amount?: string;
}

export interface VerifyTransferResult {
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

export interface PaymentMethod {
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

export interface PriceQuote {
  price: string;
  lastUpdated: string;
}

export interface BestPrices {
  crypto: string;
  fiat: string;
  bestBuy: PriceQuote | null;
  bestSell: PriceQuote | null;
  spread: string | null;
  spreadPercent: string | null;
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
  tradeCount: number | null;
  completionRate: number | null;
  volumeUsdt: string;
  revenueUsdt: string | null;
  avgTradeTimeSeconds: number | null;
  disputeRate: number | null;
  topCurrencies: Array<{ code: string; volumeUsdt: string }>;
  gaps?: string[];
}

export interface WebhookConfig {
  url: string | null;
  events: string[];
  active: boolean;
  retryEnabled?: boolean;
  maxRetries?: number;
  headers?: Record<string, string>;
  secretMasked?: string | null;
  successCount?: number;
  failureCount?: number;
  lastDeliveredAt?: string | null;
}

export interface UpdateWebhookConfigInput {
  url?: string;
  events?: string[];
  active?: boolean;
  retryEnabled?: boolean;
  maxRetries?: number;
  headers?: Record<string, string>;
}

export interface UpdateWebhookConfigResult extends WebhookConfig {
  message: string;
  // Returned once when the service generates the initial signing secret.
  secret?: string;
  secretWarning?: string;
}

export interface WebhookLogEntry {
  id: string;
  eventType: string;
  status: 'delivered' | 'failed' | 'pending' | 'dead_letter';
  responseCode: number | null;
  durationMs: number | null;
  retryCount: number;
  deliveredAt: string | null;
  errorMessage: string | null;
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
