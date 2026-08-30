// Axios-based HTTP transport. Owns the request lifecycle:
// - Build canonical signing string and HMAC headers.
// - Inject Idempotency-Key on mutating methods.
// - Adjust timestamp for measured server-clock drift.
// - Translate axios errors into typed SDK errors.
// - Retry network failures, 429s, 5xx, and still-settling 409s with
//   exponential backoff + jitter.
//
// Critical contract: the body must be serialized once on the SDK side and
// passed to axios as a string with the correct Content-Type so axios does
// not re-serialize it. Re-serialization would reorder JSON keys and break
// the signature, since the gateway verifies against the raw bytes from the
// wire.

import axios, {
  AxiosError,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosResponse
} from 'axios';

import { signHmac } from './signing.js';
import { generateNonce } from './nonce.js';
import { generateIdempotencyKey, requiresIdempotencyKey } from './idempotency.js';
import {
  computeDelayMs,
  delay,
  isRetryableConflict,
  isRetryableNetworkCode,
  isRetryableStatus,
  parseRetryAfter,
  RetryConfig,
  DEFAULT_RETRY_CONFIG
} from './retry.js';
import { ClockDriftTracker, clampRecvWindow } from './recvWindow.js';
import { buildProxyAgents } from './proxyAgent.js';
import { assertSecureTransportUrl } from './urlSafety.js';
import {
  AuthenticationError,
  FUND_USER_ERROR_CODES,
  IdempotencyConflictError,
  MerchantSdkError,
  NetworkError,
  NotFoundError,
  NotImplementedError,
  PermissionDeniedError,
  PlatformFundUser2FARequiredError,
  PlatformFundUserAmlError,
  PlatformFundUserRateLimitError,
  PlatformMarketplaceNotEligibleError,
  PlatformPiiInMemoError,
  PlatformRefundRequiresTradeError,
  PlatformSelfFundError,
  RateLimitError,
  ServerError,
  TimeoutError,
  ValidationError
} from '../errors/index.js';
import type { RequestOptions } from '../types/common.js';

export interface HttpTransportConfig {
  apiKey: string;
  hmacSecret: string;
  baseUrl: string;
  recvWindowMs: number;
  timeoutMs: number;
  retry: RetryConfig;
  clock: ClockDriftTracker;
  userAgent: string;
  allowInsecureTransport?: boolean;
}

export interface RequestSpec<TBody = unknown> {
  method: string;
  path: string;
  body?: TBody;
  query?: Record<string, string | number | boolean | undefined | null>;
}

export class HttpTransport {
  private readonly axios: AxiosInstance;
  private readonly config: HttpTransportConfig;
  // Persistent keep-alive agent. Held for lifecycle teardown via close().
  // Undefined when no proxy is in play (axios uses its own per-request socket).
  private readonly httpsAgent: import('node:https').Agent | undefined;
  private closed = false;

  constructor(config: HttpTransportConfig) {
    assertSecureTransportUrl(
      config.baseUrl,
      config.allowInsecureTransport === true,
      'HttpTransport'
    );
    this.config = config;
    // Honour HTTP_PROXY / HTTPS_PROXY / NO_PROXY for corporate VPN setups.
    // axios's bundled proxy handling cannot tunnel HTTPS through an HTTP
    // proxy (it falls back to plain-HTTP forward, which would expose signed
    // payloads in cleartext); we wire dedicated CONNECT-tunnelling agents
    // and disable the bundled support via `proxy: false` to take over.
    const proxyAgents = buildProxyAgents({ targetUrl: config.baseUrl });
    this.httpsAgent = proxyAgents.httpsAgent;
    this.axios = axios.create({
      baseURL: config.baseUrl,
      timeout: config.timeoutMs,
      // We send Buffer or string bodies preserialized so axios does not
      // touch them. validateStatus disables axios's default 2xx-only throw
      // because we own status interpretation in handleAxiosError.
      transformRequest: [(data) => data],
      transformResponse: [(data) => data],
      validateStatus: () => true,
      headers: {
        Accept: 'application/json',
        'User-Agent': config.userAgent
      },
      ...(proxyAgents.disableAxiosProxy ? { proxy: false as const } : {}),
      ...(proxyAgents.httpsAgent ? { httpsAgent: proxyAgents.httpsAgent } : {})
    });
  }

  // Direct axios access for the time sampler. The clock-drift tracker calls
  // GET /api/v1/merchant/time without auth headers and needs a parsed JSON
  // body, which is the only place we let axios do response parsing for us.
  rawAxios(): AxiosInstance {
    return this.axios;
  }

  /**
   * Releases transport-owned resources.
   *
   * Destroys the keep-alive HTTPS agent if one was created for proxy
   * tunnelling. Idempotent: safe to call more than once. Subsequent
   * requests through this transport may fail if the underlying agent is
   * required by the deployment.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.httpsAgent && typeof this.httpsAgent.destroy === 'function') {
      try {
        this.httpsAgent.destroy();
      } catch {
        // Swallow; agent teardown is best-effort during shutdown.
      }
    }
  }

  async request<TResp, TBody = unknown>(
    spec: RequestSpec<TBody>,
    opts: RequestOptions = {}
  ): Promise<TResp> {
    const method = spec.method.toUpperCase();
    const pathWithQuery = buildPathWithQuery(spec.path, spec.query);
    let rawBody = serializeBody(spec.body);
    // Fastify rejects write-method requests where Content-Type is JSON but body is empty.
    // Send {} so both sides see the same canonical empty-object body.
    if (rawBody === '' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      rawBody = '{}';
    }

    const idempotencyKey =
      opts.idempotencyKey ??
      (requiresIdempotencyKey(method) ? generateIdempotencyKey() : undefined);

    let attempt = 0;
    // attempt 0 is the initial call; retries continue while attempt < maxRetries.
    while (true) {
      try {
        const response = await this.executeOnce({
          method,
          pathWithQuery,
          rawBody,
          idempotencyKey,
          opts
        });

        const status = response.status;
        if (status >= 200 && status < 300) {
          return parseJsonBody<TResp>(response);
        }

        // Non-2xx. Decide whether to retry or throw a typed error.
        // A 409 is only replayable when the server names it as still-settling
        // money and the same Idempotency-Key goes back out, so the body is
        // read for the code on that status alone.
        const retryable =
          isRetryableStatus(status) ||
          isRetryableConflict({
            status,
            code: status === 409 ? safeJson(response.data)?.code : undefined,
            idempotencyKey
          });
        if (retryable && attempt < this.config.retry.maxRetries) {
          const retryAfterMs = parseRetryAfter(response.headers['retry-after']);
          const wait = computeDelayMs({
            attempt,
            config: this.config.retry,
            retryAfterMs
          });
          await delay(wait);
          attempt++;
          continue;
        }

        throw mapHttpError(status, response);
      } catch (err) {
        // Already a typed SDK error from mapHttpError. Re-throw verbatim.
        if (err instanceof MerchantSdkError) {
          throw err;
        }

        const axiosErr = err as AxiosError;
        const code = axiosErr.code;

        if (axiosErr.code === 'ECONNABORTED' || axiosErr.message?.includes('timeout')) {
          if (attempt < this.config.retry.maxRetries) {
            const wait = computeDelayMs({ attempt, config: this.config.retry });
            await delay(wait);
            attempt++;
            continue;
          }
          throw new TimeoutError('Request timed out', { cause: err });
        }

        if (isRetryableNetworkCode(code)) {
          if (attempt < this.config.retry.maxRetries) {
            const wait = computeDelayMs({ attempt, config: this.config.retry });
            await delay(wait);
            attempt++;
            continue;
          }
          throw new NetworkError(axiosErr.message || 'Network failure', {
            code: code ?? 'NETWORK_ERROR',
            cause: err
          });
        }

        // Non-retryable infra error. Wrap and rethrow.
        throw new NetworkError(axiosErr.message || 'Unexpected transport error', {
          code: code ?? 'NETWORK_ERROR',
          cause: err
        });
      }
    }
  }

  private async executeOnce(args: {
    method: string;
    pathWithQuery: string;
    rawBody: string;
    idempotencyKey: string | undefined;
    opts: RequestOptions;
  }): Promise<AxiosResponse<string>> {
    const { method, pathWithQuery, rawBody, idempotencyKey, opts } = args;
    const headers = this.buildHeaders({
      method,
      pathWithQuery,
      rawBody,
      idempotencyKey,
      opts
    });

    const reqConfig: AxiosRequestConfig = {
      method: method as AxiosRequestConfig['method'],
      url: pathWithQuery,
      data: rawBody === '' ? undefined : rawBody,
      headers,
      timeout: opts.timeoutMs ?? this.config.timeoutMs,
      signal: opts.signal,
      // Signed credentials must never be forwarded to a redirect target.
      // The public time endpoint is unsigned and retains normal redirect
      // behavior because it carries no API key or HMAC headers.
      ...(opts.unsigned === true ? {} : { maxRedirects: 0 }),
      // Force string response so we own JSON parsing and can return raw
      // text on parse failure with a useful error message.
      responseType: 'text'
    };

    return this.axios.request<string>(reqConfig);
  }

  private buildHeaders(args: {
    method: string;
    pathWithQuery: string;
    rawBody: string;
    idempotencyKey: string | undefined;
    opts: RequestOptions;
  }): Record<string, string> {
    const { method, pathWithQuery, rawBody, idempotencyKey, opts } = args;
    // Start from caller-supplied extras so SDK-managed headers always win.
    // The platform namespace uses extraHeaders to attach X-PM-Acting-User
    // without being able to clobber X-API-Key, X-Signature, etc.
    const headers: Record<string, string> = {
      ...(opts.extraHeaders ?? {}),
      Accept: 'application/json',
      'User-Agent': this.config.userAgent
    };

    // Force JSON content-type on write methods; body-less POSTs otherwise hit FST_ERR_CTP_INVALID_MEDIA_TYPE.
    const isWriteMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
    if (rawBody !== '' || isWriteMethod) {
      headers['Content-Type'] = 'application/json';
    }

    if (opts.unsigned === true) {
      // /time is the only documented unsigned path. Caller asserts that
      // this request targets such an endpoint.
      return headers;
    }

    const timestamp = this.config.clock.signedTimestampMs();
    const nonce = generateNonce();
    const path = stripQueryFromUrl(pathWithQuery);
    // Bind X-PM-Acting-User into the signed payload when present so a
    // replayed request cannot have the header swapped to another end-user
    // under the same parent merchant without invalidating the HMAC.
    const actingUserId = readActingUser(headers);
    // Gateway HMAC verify treats {} (empty parsed body) as empty for signing;
    // mirror that here so body-less write methods stay sign-verifiable.
    const signedBody = rawBody === '{}' ? '' : rawBody;
    const signature = signHmac({
      method,
      path,
      timestamp,
      nonce,
      body: signedBody,
      hmacSecret: this.config.hmacSecret,
      actingUserId
    });

    headers['X-API-Key'] = this.config.apiKey;
    headers['X-Signature'] = signature;
    headers['X-Timestamp'] = timestamp;
    headers['X-Nonce'] = nonce;
    headers['X-Recv-Window'] = String(clampRecvWindow(this.config.recvWindowMs));

    if (idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    return headers;
  }
}

function serializeBody(body: unknown): string {
  if (body === undefined || body === null) {
    return '';
  }
  if (typeof body === 'string') {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body.toString('utf8');
  }
  return JSON.stringify(body);
}

function buildPathWithQuery(
  path: string,
  query: Record<string, string | number | boolean | undefined | null> | undefined
): string {
  if (!query) return path;
  const parts: string[] = [];
  for (const key of Object.keys(query)) {
    const value = query[key];
    if (value === undefined || value === null) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  if (parts.length === 0) return path;
  return path.includes('?') ? `${path}&${parts.join('&')}` : `${path}?${parts.join('&')}`;
}

function stripQueryFromUrl(url: string): string {
  const idx = url.indexOf('?');
  return idx === -1 ? url : url.slice(0, idx);
}

// Locate X-PM-Acting-User in a header bag without depending on the caller's
// case convention. The platform namespace inserts the header through
// extraHeaders so the canonical capitalised form is what the SDK ships, but
// custom callers may use any case. Trim and treat empty values as absent so
// downstream signing logic only ever sees a non-empty id or undefined.
function readActingUser(headers: Record<string, string>): string | undefined {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === 'x-pm-acting-user') {
      const value = headers[key];
      if (typeof value !== 'string') return undefined;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
  }
  return undefined;
}

function parseJsonBody<T>(response: AxiosResponse<string>): T {
  const status = response.status;
  if (status === 204 || !response.data) {
    return undefined as unknown as T;
  }
  const text = typeof response.data === 'string' ? response.data : String(response.data);
  if (text.length === 0) {
    return undefined as unknown as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    // Server returned a 2xx with non-JSON body. Surface the raw text rather
    // than throwing so the caller can decide.
    return text as unknown as T;
  }
}

function mapHttpError(status: number, response: AxiosResponse<string>): MerchantSdkError {
  const requestId =
    (response.headers['x-request-id'] as string | undefined) ??
    (response.headers['x-trace-id'] as string | undefined);

  const body = safeJson(response.data);
  const message =
    body?.message ?? body?.error ?? `HTTP ${status} from merchant API`;
  const code = body?.code ?? `HTTP_${status}`;

  const baseOpts = { code, status, requestId, details: body };

  switch (status) {
    case 400:
      // Promote known validation codes to dedicated subclasses so callers
      // can branch on instanceof without parsing .code strings.
      if (code === FUND_USER_ERROR_CODES.REFUND_REQUIRES_TRADE_ID) {
        return new PlatformRefundRequiresTradeError(message, baseOpts);
      }
      if (code === FUND_USER_ERROR_CODES.PII_IN_MEMO) {
        return new PlatformPiiInMemoError(message, baseOpts);
      }
      return new ValidationError(message, baseOpts);
    case 401:
      return new AuthenticationError(message, baseOpts);
    case 403:
      // Promote fund-user 2FA / self-fund codes to dedicated subclasses.
      if (code === FUND_USER_ERROR_CODES.TWO_FA_REQUIRED) {
        return new PlatformFundUser2FARequiredError(message, baseOpts);
      }
      if (code === FUND_USER_ERROR_CODES.SELF_FUND_NOT_ALLOWED) {
        return new PlatformSelfFundError(message, baseOpts);
      }
      return new PermissionDeniedError(message, baseOpts);
    case 404:
      return new NotFoundError(message, baseOpts);
    case 409:
      // The gateway uses code IDEMPOTENCY_KEY_CONFLICT for replayed keys
      // with mismatched payloads. Anything else 409 is a generic conflict.
      if (code === 'IDEMPOTENCY_KEY_CONFLICT') {
        return new IdempotencyConflictError(message, baseOpts);
      }
      if (code === FUND_USER_ERROR_CODES.MARKETPLACE_NOT_ELIGIBLE) {
        return new PlatformMarketplaceNotEligibleError(message, baseOpts);
      }
      return new MerchantSdkError(message, baseOpts);
    case 429: {
      const retryAfterMs = parseRetryAfter(response.headers['retry-after']);
      // AML structuring trip is a distinct compliance signal vs ordinary
      // throttling; surface as its own subclass so dashboards can call out
      // suspicious behaviour without log-mining.
      if (code === FUND_USER_ERROR_CODES.AML_STRUCTURING_DETECTED) {
        return new PlatformFundUserAmlError(message, { ...baseOpts, retryAfterMs });
      }
      // The remaining fund-user codes are bucket-style throttles; grouped
      // under a single subclass so callers can branch once.
      if (
        code === FUND_USER_ERROR_CODES.RECIPIENT_LIMIT ||
        code === FUND_USER_ERROR_CODES.REFUND_LIMIT ||
        code === FUND_USER_ERROR_CODES.PLATFORM_LIMIT ||
        code === FUND_USER_ERROR_CODES.NEW_USER_COOLDOWN
      ) {
        return new PlatformFundUserRateLimitError(message, { ...baseOpts, retryAfterMs });
      }
      return new RateLimitError(message, { ...baseOpts, retryAfterMs });
    }
    case 501:
      return new NotImplementedError(message, baseOpts);
    default:
      if (status >= 500) {
        return new ServerError(message, baseOpts);
      }
      return new MerchantSdkError(message, baseOpts);
  }
}

function safeJson(data: unknown): { code?: string; message?: string; error?: string } | undefined {
  if (data === undefined || data === null) return undefined;
  if (typeof data === 'object') return data as { code?: string; message?: string; error?: string };
  if (typeof data === 'string' && data.length > 0) {
    try {
      return JSON.parse(data) as { code?: string; message?: string; error?: string };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const DEFAULT_TRANSPORT_CONFIG = {
  retry: DEFAULT_RETRY_CONFIG
};
