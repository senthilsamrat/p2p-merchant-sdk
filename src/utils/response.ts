import { MerchantSdkError } from '../errors/index.js';
import type {
  AnalyticsStats,
  BestPrices,
  CancelOrderResult,
  DisputeResponse,
  Message,
  MerchantAccount,
  MerchantTier,
  Order,
  OrderStatus,
  PaymentMethod,
  Trade,
  TradeActionResult,
  TradeSource,
  TradeStatus,
  WalletBalance,
  WalletHold,
  WebhookConfig,
  WebhookLogEntry,
} from '../types/common.js';

export type JsonObject = Record<string, unknown>;

const ORDER_STATUSES = new Set<OrderStatus>([
  'active',
  'paused',
  'partially_filled',
  'filled',
  'cancelled',
  'expired',
  'completed',
  'suspended',
]);

const TRADE_STATUSES = new Set<TradeStatus>([
  'initiated',
  'payment_pending',
  'payment_sent',
  'payment_confirmed',
  'completed',
  'disputed',
  'cancelled',
  'switching',
]);

export function expectObject(value: unknown, context: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidResponse(context, 'expected an object');
  }
  return value as JsonObject;
}

export function unwrapObject(
  response: unknown,
  context: string,
  keys: readonly string[],
): JsonObject {
  const outer = expectObject(response, context);
  for (const key of keys) {
    if (outer[key] !== undefined) {
      return expectObject(outer[key], `${context}.${key}`);
    }
  }
  // Bare objects are accepted for backwards compatibility. The resource
  // normalizer below still validates every required public field.
  return outer;
}

export function normalizeMerchantAccount(value: unknown): MerchantAccount {
  const context = 'merchant account response';
  const raw = expectObject(value, context);
  const tier = requiredString(raw, 'tier', context) as MerchantTier;
  if (!['none', 'professional', 'business', 'enterprise'].includes(tier)) {
    throw invalidResponse(context, `unknown merchant tier: ${tier}`);
  }
  const status = requiredString(raw, 'status', context);
  if (!['active', 'suspended', 'pending'].includes(status)) {
    throw invalidResponse(context, `unknown merchant status: ${status}`);
  }
  if (!Array.isArray(raw.permissions) || raw.permissions.some((item) => typeof item !== 'string')) {
    throw invalidResponse(context, 'permissions must be a string array');
  }
  return {
    merchantId: requiredString(raw, 'merchantId', context),
    tier,
    status: status as MerchantAccount['status'],
    expressEligible: requiredBoolean(raw, 'expressEligible', context),
    expressAvailable: requiredBoolean(raw, 'expressAvailable', context),
    kycStatus: requiredString(raw, 'kycStatus', context),
    permissions: [...raw.permissions] as string[],
    createdAt: requiredString(raw, 'createdAt', context),
  };
}

export function normalizeBestPrices(value: unknown): BestPrices {
  const context = 'best prices response';
  const raw = expectObject(value, context);
  const normalizeQuote = (quote: unknown, field: string): BestPrices['bestBuy'] => {
    if (quote === null) return null;
    const parsed = expectObject(quote, `${context}.${field}`);
    return {
      price: decimalString(parsed.price, `${context}.${field}.price`),
      lastUpdated: requiredString(parsed, 'lastUpdated', `${context}.${field}`),
    };
  };
  return {
    crypto: requiredString(raw, 'crypto', context),
    fiat: requiredString(raw, 'fiat', context),
    bestBuy: normalizeQuote(raw.bestBuy, 'bestBuy'),
    bestSell: normalizeQuote(raw.bestSell, 'bestSell'),
    spread: raw.spread === null ? null : decimalString(raw.spread, `${context}.spread`),
    spreadPercent:
      raw.spreadPercent === null
        ? null
        : decimalString(raw.spreadPercent, `${context}.spreadPercent`),
  };
}

export function normalizeOrder(value: unknown, context = 'order response'): Order {
  const raw = expectObject(value, context);
  const status = requiredString(raw, 'status', context) as OrderStatus;
  if (!ORDER_STATUSES.has(status)) {
    throw invalidResponse(context, `unknown order status: ${status}`);
  }

  const paymentMethods = raw.paymentMethods;
  if (!Array.isArray(paymentMethods) || paymentMethods.some((item) => typeof item !== 'string')) {
    throw invalidResponse(context, 'paymentMethods must be a string array');
  }

  const type = requiredString(raw, 'type', context);
  if (type !== 'buy' && type !== 'sell') {
    throw invalidResponse(context, `unknown order type: ${type}`);
  }

  return {
    orderId: requiredString(raw, 'orderId', context),
    type,
    cryptocurrency: requiredString(raw, 'cryptocurrency', context),
    fiatCurrency: requiredString(raw, 'fiatCurrency', context),
    amount: decimalString(raw.amount, `${context}.amount`),
    remainingAmount: decimalString(raw.remainingAmount, `${context}.remainingAmount`),
    price: decimalString(raw.price, `${context}.price`),
    status,
    ...(optionalDecimal(raw.minTradeAmount, `${context}.minTradeAmount`) !== undefined
      ? { minTradeAmount: optionalDecimal(raw.minTradeAmount, `${context}.minTradeAmount`) }
      : {}),
    ...(optionalDecimal(raw.maxTradeAmount, `${context}.maxTradeAmount`) !== undefined
      ? { maxTradeAmount: optionalDecimal(raw.maxTradeAmount, `${context}.maxTradeAmount`) }
      : {}),
    paymentMethods: [...paymentMethods],
    ...(optionalFiniteNumber(raw.timeLimit, `${context}.timeLimit`) !== undefined
      ? { timeLimit: optionalFiniteNumber(raw.timeLimit, `${context}.timeLimit`) }
      : {}),
    ...(optionalString(raw.terms, `${context}.terms`) !== undefined
      ? { terms: optionalString(raw.terms, `${context}.terms`) }
      : {}),
    ...(optionalString(raw.autoReply, `${context}.autoReply`) !== undefined
      ? { autoReply: optionalString(raw.autoReply, `${context}.autoReply`) }
      : {}),
    ...(optionalString(raw.expiresAt, `${context}.expiresAt`) !== undefined
      ? { expiresAt: optionalString(raw.expiresAt, `${context}.expiresAt`) }
      : {}),
    createdAt: requiredString(raw, 'createdAt', context),
    updatedAt: requiredString(raw, 'updatedAt', context),
  };
}

export function normalizeTrade(value: unknown, context = 'trade response'): Trade {
  const raw = expectObject(value, context);
  const status = normalizeTradeStatus(raw.status, `${context}.status`);
  const source = raw.source;
  if (source !== 'quick_trade' && source !== 'marketplace') {
    throw invalidResponse(context, `unknown trade source: ${String(source)}`);
  }
  const type = requiredString(raw, 'type', context);
  if (type !== 'buy' && type !== 'sell') {
    throw invalidResponse(context, `unknown trade type: ${type}`);
  }

  return {
    tradeId: requiredString(raw, 'tradeId', context),
    orderId: requiredString(raw, 'orderId', context),
    type,
    cryptocurrency: requiredString(raw, 'cryptocurrency', context),
    fiatCurrency: requiredString(raw, 'fiatCurrency', context),
    amount: decimalString(raw.amount, `${context}.amount`),
    price: decimalString(raw.price, `${context}.price`),
    totalValue: decimalString(raw.totalValue, `${context}.totalValue`),
    status,
    source,
    buyerId: requiredString(raw, 'buyerId', context),
    sellerId: requiredString(raw, 'sellerId', context),
    paymentMethod: requiredString(raw, 'paymentMethod', context),
    ...(optionalString(raw.paymentMethodId, `${context}.paymentMethodId`) !== undefined
      ? { paymentMethodId: optionalString(raw.paymentMethodId, `${context}.paymentMethodId`) }
      : {}),
    createdAt: requiredString(raw, 'createdAt', context),
    updatedAt: requiredString(raw, 'updatedAt', context),
    ...(optionalString(raw.expiresAt, `${context}.expiresAt`) !== undefined
      ? { expiresAt: optionalString(raw.expiresAt, `${context}.expiresAt`) }
      : {}),
  };
}

export function normalizeTradeAction(
  value: unknown,
  context = 'trade action response',
): TradeActionResult {
  const raw = expectObject(value, context);
  const out: TradeActionResult = {
    tradeId: requiredString(raw, 'tradeId', context),
    status: normalizeTradeStatus(raw.status, `${context}.status`),
  };

  const source = optionalString(raw.source, `${context}.source`);
  if (source !== undefined) {
    if (source !== 'quick_trade' && source !== 'marketplace') {
      throw invalidResponse(context, `unknown trade source: ${source}`);
    }
    out.source = source as TradeSource;
  }
  const amount = optionalDecimal(raw.amount, `${context}.amount`);
  if (amount !== undefined) out.amount = amount;
  const totalValue = optionalDecimal(raw.totalValue, `${context}.totalValue`);
  if (totalValue !== undefined) out.totalValue = totalValue;
  const paymentMethod = optionalString(raw.paymentMethod, `${context}.paymentMethod`);
  if (paymentMethod !== undefined) out.paymentMethod = paymentMethod;
  const role = optionalString(raw.role, `${context}.role`);
  if (role !== undefined) {
    if (role !== 'buyer' && role !== 'seller') {
      throw invalidResponse(context, `unknown trade role: ${role}`);
    }
    out.role = role;
  }
  const optionalFields = [
    'updatedAt',
    'completedAt',
    'expiresAt',
    'escrowId',
    'escrowStatus',
    'sagaId',
  ] as const;
  for (const key of optionalFields) {
    const parsed = optionalString(raw[key], `${context}.${key}`);
    if (parsed !== undefined) out[key] = parsed;
  }
  return out;
}

export function normalizeCancelOrder(value: unknown): CancelOrderResult {
  const raw = expectObject(value, 'cancel order response');
  return {
    orderId: requiredString(raw, 'orderId', 'cancel order response'),
    message: requiredString(raw, 'message', 'cancel order response'),
  };
}

export function normalizeDisputeResponse(value: unknown): DisputeResponse {
  const raw = unwrapObject(value, 'dispute response', ['dispute']);
  return {
    disputeId: requiredString(raw, 'disputeId', 'dispute response.dispute'),
    status: requiredString(raw, 'status', 'dispute response.dispute'),
  };
}

export function normalizeMessage(value: unknown, tradeId: string, context = 'message response'): Message {
  const raw = expectObject(value, context);
  const wireType = requiredString(raw, 'type', context);
  const type = wireType === 'attachment' || wireType === 'image' ? 'image_url' : wireType;
  if (type !== 'text' && type !== 'image_url') {
    throw invalidResponse(context, `unknown message type: ${wireType}`);
  }
  return {
    messageId: requiredString(raw, 'messageId', context),
    tradeId: optionalString(raw.tradeId, `${context}.tradeId`) ?? tradeId,
    senderId: requiredString(raw, 'senderId', context),
    ...(optionalString(raw.senderRole, `${context}.senderRole`) !== undefined
      ? { senderRole: optionalString(raw.senderRole, `${context}.senderRole`) }
      : {}),
    content: requiredString(raw, 'content', context),
    type,
    timestamp: requiredString(raw, 'timestamp', context),
  };
}

export function normalizeWalletBalance(
  value: unknown,
  context = 'wallet balance response',
): WalletBalance {
  const raw = expectObject(value, context);
  return {
    currency: requiredString(raw, 'currency', context),
    available: decimalString(raw.available, `${context}.available`),
    total: decimalString(raw.total, `${context}.total`),
    locked: decimalString(raw.locked, `${context}.locked`),
  };
}

export function normalizeWalletHold(value: unknown, context = 'wallet hold response'): WalletHold {
  const raw = expectObject(value, context);
  return {
    id: requiredString(raw, 'id', context),
    currency: requiredString(raw, 'currency', context),
    amount: decimalString(raw.amount, `${context}.amount`),
    reason: requiredString(raw, 'reason', context),
    tradeId: nullableString(raw.tradeId, `${context}.tradeId`),
    escrowId: nullableString(raw.escrowId, `${context}.escrowId`),
    createdAt: requiredString(raw, 'createdAt', context),
    expiresAt: nullableString(raw.expiresAt, `${context}.expiresAt`),
  };
}

export function normalizePaymentMethod(
  value: unknown,
  context = 'payment method response',
): PaymentMethod {
  const raw = expectObject(value, context);
  const label = optionalString(raw.label, `${context}.label`);
  const country = optionalString(raw.country, `${context}.country`);
  const currency = optionalString(raw.currency, `${context}.currency`);
  return {
    id: requiredString(raw, 'id', context),
    methodType: requiredString(raw, 'methodType', context),
    ...(label !== undefined ? { label } : {}),
    maskedAccount: nullableString(raw.maskedAccount, `${context}.maskedAccount`),
    bankName: nullableString(raw.bankName, `${context}.bankName`),
    isVerified: requiredBoolean(raw, 'isVerified', context),
    readyForTrading: requiredBoolean(raw, 'readyForTrading', context),
    ...(country !== undefined ? { country } : {}),
    ...(currency !== undefined ? { currency } : {}),
    isDefault: requiredBoolean(raw, 'isDefault', context),
    createdAt: nullableString(raw.createdAt, `${context}.createdAt`),
  };
}

export function normalizeAnalyticsStats(value: unknown): AnalyticsStats {
  const context = 'analytics stats response';
  const raw = expectObject(value, context);
  if (!Array.isArray(raw.topCurrencies)) {
    throw invalidResponse(context, 'topCurrencies must be an array');
  }
  const gaps = raw.gaps;
  if (
    gaps !== undefined &&
    (!Array.isArray(gaps) || gaps.some((item) => typeof item !== 'string'))
  ) {
    throw invalidResponse(context, 'gaps must be a string array when present');
  }
  return {
    window: requiredString(raw, 'window', context),
    tradeCount: nullableFiniteNumber(raw.tradeCount, `${context}.tradeCount`),
    completionRate: nullableFiniteNumber(raw.completionRate, `${context}.completionRate`),
    volumeUsdt: decimalString(raw.volumeUsdt, `${context}.volumeUsdt`),
    revenueUsdt:
      raw.revenueUsdt === null
        ? null
        : decimalString(raw.revenueUsdt, `${context}.revenueUsdt`),
    avgTradeTimeSeconds: nullableFiniteNumber(
      raw.avgTradeTimeSeconds,
      `${context}.avgTradeTimeSeconds`,
    ),
    disputeRate: nullableFiniteNumber(raw.disputeRate, `${context}.disputeRate`),
    topCurrencies: raw.topCurrencies.map((item, index) => {
      const currency = expectObject(item, `${context}.topCurrencies[${index}]`);
      return {
        code: requiredString(currency, 'code', `${context}.topCurrencies[${index}]`),
        volumeUsdt: decimalString(
          currency.volumeUsdt,
          `${context}.topCurrencies[${index}].volumeUsdt`,
        ),
      };
    }),
    ...(Array.isArray(gaps) ? { gaps: [...gaps] as string[] } : {}),
  };
}

export function normalizeWebhookConfig(
  value: unknown,
  context = 'webhook configuration response',
): WebhookConfig {
  const raw = expectObject(value, context);
  if (!Array.isArray(raw.events) || raw.events.some((event) => typeof event !== 'string')) {
    throw invalidResponse(context, 'events must be a string array');
  }
  const config: WebhookConfig = {
    url: nullableString(raw.url, `${context}.url`),
    events: [...raw.events] as string[],
    active: requiredBoolean(raw, 'active', context),
  };
  if (raw.retryEnabled !== undefined && raw.retryEnabled !== null) {
    if (typeof raw.retryEnabled !== 'boolean') {
      throw invalidResponse(`${context}.retryEnabled`, 'expected a boolean when present');
    }
    config.retryEnabled = raw.retryEnabled;
  }
  const maxRetries = optionalFiniteNumber(raw.maxRetries, `${context}.maxRetries`);
  if (maxRetries !== undefined) config.maxRetries = maxRetries;
  if (raw.headers !== undefined) {
    const headers = expectObject(raw.headers, `${context}.headers`);
    if (Object.values(headers).some((header) => typeof header !== 'string')) {
      throw invalidResponse(context, 'headers values must be strings');
    }
    config.headers = { ...headers } as Record<string, string>;
  }
  if (raw.secretMasked !== undefined) {
    config.secretMasked = nullableString(raw.secretMasked, `${context}.secretMasked`);
  }
  const successCount = optionalFiniteNumber(raw.successCount, `${context}.successCount`);
  if (successCount !== undefined) config.successCount = successCount;
  const failureCount = optionalFiniteNumber(raw.failureCount, `${context}.failureCount`);
  if (failureCount !== undefined) config.failureCount = failureCount;
  if (raw.lastDeliveredAt !== undefined) {
    config.lastDeliveredAt = nullableString(raw.lastDeliveredAt, `${context}.lastDeliveredAt`);
  }
  return config;
}

export function normalizeWebhookLog(
  value: unknown,
  context = 'webhook log response',
): WebhookLogEntry {
  const raw = expectObject(value, context);
  const status = requiredString(raw, 'status', context);
  if (!['delivered', 'failed', 'pending', 'dead_letter'].includes(status)) {
    throw invalidResponse(context, `unknown webhook log status: ${status}`);
  }
  return {
    id: requiredString(raw, 'id', context),
    eventType: requiredString(raw, 'eventType', context),
    status: status as WebhookLogEntry['status'],
    responseCode: nullableFiniteNumber(raw.responseCode, `${context}.responseCode`),
    durationMs: nullableFiniteNumber(raw.durationMs, `${context}.durationMs`),
    retryCount: requiredFiniteNumber(raw, 'retryCount', context),
    deliveredAt: nullableString(raw.deliveredAt, `${context}.deliveredAt`),
    errorMessage: nullableString(raw.errorMessage, `${context}.errorMessage`),
    createdAt: requiredString(raw, 'createdAt', context),
  };
}

export function requiredString(raw: JsonObject, key: string, context: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidResponse(context, `${key} must be a non-empty string`);
  }
  return value;
}

export function optionalString(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw invalidResponse(context, 'expected a string when present');
  }
  return value;
}

export function nullableString(value: unknown, context: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw invalidResponse(context, 'expected a string or null');
  }
  return value;
}

export function decimalString(value: unknown, context: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) {
    return value;
  }
  throw invalidResponse(context, 'expected a finite decimal number or decimal string');
}

export function optionalDecimal(value: unknown, context: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return decimalString(value, context);
}

export function optionalFiniteNumber(value: unknown, context: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidResponse(context, 'expected a finite number when present');
  }
  return value;
}

function requiredBoolean(raw: JsonObject, key: string, context: string): boolean {
  const value = raw[key];
  if (typeof value !== 'boolean') {
    throw invalidResponse(context, `${key} must be a boolean`);
  }
  return value;
}

function requiredFiniteNumber(raw: JsonObject, key: string, context: string): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidResponse(context, `${key} must be a finite number`);
  }
  return value;
}

function nullableFiniteNumber(value: unknown, context: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidResponse(context, 'expected a finite number or null');
  }
  return value;
}

function normalizeTradeStatus(value: unknown, context: string): TradeStatus {
  if (typeof value !== 'string' || !TRADE_STATUSES.has(value as TradeStatus)) {
    throw invalidResponse(context, `unknown trade status: ${String(value)}`);
  }
  return value as TradeStatus;
}

function invalidResponse(context: string, detail: string): MerchantSdkError {
  return new MerchantSdkError(`Invalid ${context}: ${detail}`, {
    code: 'INVALID_RESPONSE',
  });
}
