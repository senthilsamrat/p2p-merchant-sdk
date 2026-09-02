// MerchantClient factory. Single entrypoint that wires the HTTP transport,
// clock-drift tracker, and resource classes. Shape kept stable so the
// parallel WebSocket client can attach its `client.stream` namespace
// without further refactor.

import { HttpTransport } from './transport/httpTransport.js';
import { ClockDriftTracker, clampRecvWindow } from './transport/recvWindow.js';
import { DEFAULT_RETRY_CONFIG, RetryConfig } from './transport/retry.js';

import { AccountResource } from './resources/account.js';
import { AvailabilityResource } from './resources/availability.js';
import { OrdersResource } from './resources/orders.js';
import { TradesResource } from './resources/trades.js';
import { WalletResource } from './resources/wallet.js';
import { MarketResource } from './resources/market.js';
import { PaymentMethodsResource } from './resources/paymentMethods.js';
import { WebhooksResource } from './resources/webhooks.js';
import { AnalyticsResource } from './resources/analytics.js';
import { TimeResource } from './resources/time.js';
import { PlatformNamespace } from './resources/platform/index.js';
import { MerchantStream } from './stream/MerchantStream.js';
import type { StreamOptions } from './stream/types.js';

const DEFAULT_BASE_URL = 'https://api.plantmewallet.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const SDK_VERSION = '0.3.0-beta.2';

export interface MerchantClientOptions {
  // Public API key identifier. pk_live_... or pk_test_...
  apiKey: string;
  // Base64 HMAC secret. Returned ONCE at API key creation. Never logged.
  hmacSecret: string;
  // Override the default base URL. Falls back to env MERCHANT_API_BASE_URL
  // and finally to the production default.
  baseUrl?: string;
  // Server-side recvWindow in ms. Server clamps to [1000, 30000]; default 5000.
  recvWindow?: number;
  // Request timeout in ms. Default 10000.
  timeout?: number;
  // Max retry attempts for retryable errors (5xx, network, 429, and 409s the
  // server marks as still settling). Default 3.
  maxRetries?: number;
  // Base delay for exponential backoff. Default 250ms.
  retryBaseDelayMs?: number;
  // Cap on a single backoff sleep. Default 30s.
  retryMaxDelayMs?: number;
  // User-Agent value. Useful for ops to attribute traffic by integration.
  userAgent?: string;
  // Internal seam for tests to skip the boot-time clock-drift sample.
  skipInitialClockSample?: boolean;
  // WebSocket stream options. Forwarded to MerchantStream verbatim. The
  // stream baseUrl defaults to a ws/wss-rewritten copy of the REST baseUrl
  // when omitted so callers only need to set one URL in most deployments.
  stream?: StreamOptions;
}

export class MerchantClient {
  public readonly account: AccountResource;
  public readonly availability: AvailabilityResource;
  public readonly orders: OrdersResource;
  public readonly trades: TradesResource;
  public readonly wallet: WalletResource;
  public readonly market: MarketResource;
  public readonly paymentMethods: PaymentMethodsResource;
  public readonly webhooks: WebhooksResource;
  public readonly analytics: AnalyticsResource;
  public readonly time: TimeResource;
  // SaaS-tier surface. Active when the API key has scope=platform_users
  // on a Merchant with accountType=saas_platform. Existing direct-merchant
  // keys see 403 Forbidden from these routes; the namespace itself stays
  // attached for type-checking parity across both key types.
  public readonly platform: PlatformNamespace;
  // WebSocket event stream client. Inbound only; ping/pong handled by ws.
  // Lazy-connect: caller must invoke client.stream.connect() to open.
  public readonly stream: MerchantStream;

  private readonly transport: HttpTransport;
  private readonly clock: ClockDriftTracker;
  private readonly options: Required<Pick<MerchantClientOptions, 'apiKey' | 'hmacSecret' | 'baseUrl' | 'recvWindow' | 'timeout' | 'userAgent'>> & {
    retry: RetryConfig;
  };

  constructor(options: MerchantClientOptions) {
    if (!options.apiKey || typeof options.apiKey !== 'string') {
      throw new Error('MerchantClient: apiKey is required');
    }
    if (!options.hmacSecret || typeof options.hmacSecret !== 'string') {
      throw new Error('MerchantClient: hmacSecret is required');
    }

    const baseUrl = (
      options.baseUrl ??
      process.env.MERCHANT_API_BASE_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/$/, '');

    const recvWindow = clampRecvWindow(options.recvWindow);
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const userAgent = options.userAgent ?? `plantme-merchant-sdk/${SDK_VERSION} node`;

    const retry: RetryConfig = {
      maxRetries: options.maxRetries ?? DEFAULT_RETRY_CONFIG.maxRetries,
      baseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_CONFIG.baseDelayMs,
      maxDelayMs: options.retryMaxDelayMs ?? DEFAULT_RETRY_CONFIG.maxDelayMs
    };

    this.options = {
      apiKey: options.apiKey,
      hmacSecret: options.hmacSecret,
      baseUrl,
      recvWindow,
      timeout,
      userAgent,
      retry
    };

    this.clock = new ClockDriftTracker();
    this.transport = new HttpTransport({
      apiKey: options.apiKey,
      hmacSecret: options.hmacSecret,
      baseUrl,
      recvWindowMs: recvWindow,
      timeoutMs: timeout,
      retry,
      clock: this.clock,
      userAgent
    });

    this.account = new AccountResource(this.transport);
    this.availability = new AvailabilityResource(this.transport);
    this.orders = new OrdersResource(this.transport);
    this.trades = new TradesResource(this.transport);
    this.wallet = new WalletResource(this.transport);
    this.market = new MarketResource(this.transport);
    this.paymentMethods = new PaymentMethodsResource(this.transport);
    this.webhooks = new WebhooksResource(this.transport);
    this.analytics = new AnalyticsResource(this.transport);
    this.time = new TimeResource(this.transport, this.clock);
    this.platform = new PlatformNamespace(this.transport);

    // WebSocket stream. Default the baseUrl to the rewritten REST baseUrl so
    // callers only have to configure one host. Override available via
    // options.stream.baseUrl when the WS endpoint is on a different domain.
    this.stream = new MerchantStream({
      apiKey: options.apiKey,
      hmacSecret: options.hmacSecret,
      baseUrl: options.stream?.baseUrl ?? baseUrl,
      options: options.stream,
    });

    // Fire-and-forget initial clock sample. We do not await so constructor
    // remains synchronous; the worst case is the first signed request uses
    // an uncalibrated timestamp and the server clamps via recvWindow.
    if (options.skipInitialClockSample !== true) {
      void this.time.sampleClockDrift(3).catch(() => {
        // Sampling failure is non-fatal. The client continues to function
        // with a zero drift assumption until the next manual sample.
      });
    }
  }

  // Tracks whether close() has run so repeat calls are no-ops.
  private closed = false;

  /**
   * Gracefully closes the SDK client, releasing the WS stream and any
   * keep-alive sockets. Safe to call multiple times.
   *
   * Pending in-flight HTTP requests are not cancelled by this call; pass
   * an AbortSignal via `RequestOptions.signal` if early cancellation is
   * required.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.stream.close();
    } catch {
      // Swallow; stream teardown is best-effort during shutdown.
    }
    this.transport.close();
  }

  // Reveal current configuration for debugging. hmacSecret is masked.
  describe(): Record<string, unknown> {
    return {
      apiKey: maskCredential(this.options.apiKey),
      hmacSecret: maskCredential(this.options.hmacSecret),
      baseUrl: this.options.baseUrl,
      recvWindow: this.options.recvWindow,
      timeout: this.options.timeout,
      userAgent: this.options.userAgent,
      retry: this.options.retry,
      clock: this.clock.current()
    };
  }

  // Internal access used by the parallel WebSocket client to share the
  // signing context with the upgrade handshake. Stable shape.
  _internalContext(): {
    apiKey: string;
    hmacSecret: string;
    baseUrl: string;
    clock: ClockDriftTracker;
    userAgent: string;
  } {
    return {
      apiKey: this.options.apiKey,
      hmacSecret: this.options.hmacSecret,
      baseUrl: this.options.baseUrl,
      clock: this.clock,
      userAgent: this.options.userAgent
    };
  }

  // Returns a request-scoped facade that injects X-PM-Owner-2FA on the next
  // call. Required for high-value platform fund-user transfers (>$10K USD-
  // equiv) when the API key holds `platform:wallet:fund_user:high_value`.
  //
  // Usage:
  //   await client.with2FA('123456').platform.wallet.fundUser({...});
  //
  // The facade reuses the live MerchantClient resources and threads the
  // header via RequestOptions.extraHeaders so SDK signing stays canonical.
  // The header is single-shot at the call site; subsequent calls on the
  // original client revert to standard headers.
  with2FA(totpToken: string): TwoFactorScopedClient {
    if (!totpToken || typeof totpToken !== 'string') {
      throw new Error('with2FA: totpToken is required');
    }
    return new TwoFactorScopedClient(this, totpToken);
  }
}

// Request-scoped facade that injects X-PM-Owner-2FA on every call dispatched
// through it. Implemented as a thin wrapper exposing only the surfaces that
// accept the 2FA header (today: client.platform.wallet); other resources are
// reachable via the underlying MerchantClient instance directly.
export class TwoFactorScopedClient {
  public readonly platform: TwoFactorPlatformFacade;

  constructor(client: MerchantClient, totpToken: string) {
    this.platform = new TwoFactorPlatformFacade(client, totpToken);
  }
}

export class TwoFactorPlatformFacade {
  public readonly wallet: TwoFactorPlatformWalletFacade;

  constructor(client: MerchantClient, totpToken: string) {
    this.wallet = new TwoFactorPlatformWalletFacade(client, totpToken);
  }
}

export class TwoFactorPlatformWalletFacade {
  constructor(private readonly client: MerchantClient, private readonly totpToken: string) {}

  // Mirrors PlatformWalletResource.fundUser but injects X-PM-Owner-2FA via
  // RequestOptions.extraHeaders. The transport's signing flow is unchanged;
  // the gateway forwards X-PM-Owner-2FA to merchant-service which validates
  // the TOTP against the API key owner's 2FA seed before honouring the call.
  async fundUser(
    input: Parameters<MerchantClient['platform']['wallet']['fundUser']>[0],
    opts: Parameters<MerchantClient['platform']['wallet']['fundUser']>[1] = {}
  ): ReturnType<MerchantClient['platform']['wallet']['fundUser']> {
    const merged = {
      ...opts,
      extraHeaders: {
        ...(opts.extraHeaders ?? {}),
        'X-PM-Owner-2FA': this.totpToken
      }
    };
    return this.client.platform.wallet.fundUser(input, merged);
  }
}

function maskCredential(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export const SDK_METADATA = {
  name: '@plantmewallet/merchant-sdk',
  version: SDK_VERSION
};
