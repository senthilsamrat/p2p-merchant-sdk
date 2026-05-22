// HTTP/HTTPS proxy support for corporate VPN environments.
//
// axios's bundled proxy handling cannot tunnel HTTPS through an HTTP
// proxy: it rewrites the request to absolute-URI plain HTTP, which both
// fails to reach the upstream HTTPS server and exposes the signed payload
// in cleartext to anyone in path between the SDK and the proxy. To make
// the SDK safe behind mandatory corporate proxies, this module builds a
// CONNECT-tunnelling https.Agent for HTTPS targets and feeds it to axios,
// with axios's bundled proxy support disabled via `proxy: false`.
//
// Implementation uses only `node:` standard library so the SDK gains no
// new runtime dependencies.
//
// Env vars honoured (case-insensitive form):
//   HTTPS_PROXY / https_proxy : proxy for HTTPS targets
//   HTTP_PROXY  / http_proxy  : proxy for HTTP targets (delegated to axios)
//   ALL_PROXY   / all_proxy   : fallback for either protocol
//   NO_PROXY    / no_proxy    : comma-separated host patterns to bypass
//
// NO_PROXY pattern matching: exact host, leading-dot suffix match, and the
// wildcard `*` value to disable proxying for everything.

import http from 'node:http';
import https, { Agent as HttpsAgent } from 'node:https';
import { TLSSocket, connect as tlsConnect } from 'node:tls';
import { URL } from 'node:url';

export interface ProxyAgents {
  httpsAgent?: HttpsAgent;
  // True when the SDK should pass `proxy: false` to axios so the bundled
  // proxy detection does not double-wrap our agents.
  disableAxiosProxy: boolean;
  // Diagnostic: the proxy URL the agents target, undefined when no proxy
  // applies (env unset or NO_PROXY exempted target).
  proxyUrl?: string;
}

export interface BuildProxyAgentsArgs {
  // Target base URL the SDK will issue requests against. Used to evaluate
  // NO_PROXY rules and to pick HTTPS vs HTTP env vars.
  targetUrl: string;
  // Optional override of process.env. Tests inject a custom map; production
  // callers omit and the live process.env is used.
  env?: NodeJS.ProcessEnv;
}

export function buildProxyAgents(args: BuildProxyAgentsArgs): ProxyAgents {
  const env = args.env ?? process.env;
  let target: URL;
  try {
    target = new URL(args.targetUrl);
  } catch {
    return { disableAxiosProxy: false };
  }
  const isHttps = target.protocol === 'https:';
  if (!isHttps) {
    // HTTP targets work correctly through axios's bundled proxy support
    // (absolute-URI forward is the right wire format for HTTP) so we leave
    // axios in charge for that path and only intervene on HTTPS where the
    // bundled support is unsafe.
    return { disableAxiosProxy: false };
  }

  const proxyUrlString = pickProxyEnv(env);
  if (!proxyUrlString) return { disableAxiosProxy: false };

  if (isBypassed(target.hostname, env)) return { disableAxiosProxy: false };

  let proxyUrl: URL;
  try {
    proxyUrl = new URL(proxyUrlString);
  } catch {
    return { disableAxiosProxy: false };
  }

  const proxyHost = proxyUrl.hostname;
  const proxyPort = proxyUrl.port
    ? Number.parseInt(proxyUrl.port, 10)
    : proxyUrl.protocol === 'https:'
      ? 443
      : 80;
  const proxyAuth = proxyUrl.username
    ? `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password || '')}`
    : undefined;

  const httpsAgent = new ConnectTunnelHttpsAgent({
    keepAlive: true,
    proxyHost,
    proxyPort,
    proxyProtocol: proxyUrl.protocol,
    proxyAuth,
  });

  return {
    httpsAgent: httpsAgent as unknown as HttpsAgent,
    disableAxiosProxy: true,
    proxyUrl: proxyUrlString,
  };
}

interface ConnectAgentOptions extends https.AgentOptions {
  proxyHost: string;
  proxyPort: number;
  proxyProtocol: string;
  proxyAuth: string | undefined;
}

// HTTPS-via-CONNECT agent. https.Agent.createConnection is the documented
// extension point; returning a TLSSocket here makes Node use the tunnel as
// the secure socket for the actual https.request. Each request opens its
// own CONNECT (no tunnel reuse) which is acceptable for keep-alive and
// keeps the implementation simple.
class ConnectTunnelHttpsAgent extends HttpsAgent {
  private readonly proxyHost: string;
  private readonly proxyPort: number;
  private readonly proxyProtocol: string;
  private readonly proxyAuth: string | undefined;

  constructor(options: ConnectAgentOptions) {
    super(options);
    this.proxyHost = options.proxyHost;
    this.proxyPort = options.proxyPort;
    this.proxyProtocol = options.proxyProtocol;
    this.proxyAuth = options.proxyAuth;
  }

  // Async-callback form. We always invoke the callback later, so the
  // synchronous return is undefined; the request waits until the tunnel
  // is established and the TLS handshake completes before proceeding.
  createConnection(
    options: http.ClientRequestArgs,
    callback?: (err: Error | null, stream: TLSSocket) => void,
  ): undefined {
    if (!callback) {
      throw new Error('ConnectTunnelHttpsAgent requires the async-callback form');
    }
    const wrap = (err: Error | null, socket?: TLSSocket): void => {
      if (err) callback(err, undefined as unknown as TLSSocket);
      else callback(null, socket as TLSSocket);
    };
    this.connectThroughProxy(options, wrap);
    return undefined;
  }

  private connectThroughProxy(
    options: http.ClientRequestArgs,
    callback: (err: Error | null, socket?: TLSSocket) => void,
  ): void {
    const targetHost = String(options.host ?? options.hostname ?? '');
    const targetPort =
      typeof options.port === 'number'
        ? options.port
        : options.port
          ? Number.parseInt(String(options.port), 10)
          : 443;

    const headers: Record<string, string> = {
      Host: `${targetHost}:${targetPort}`,
    };
    if (this.proxyAuth) {
      headers['Proxy-Authorization'] =
        'Basic ' + Buffer.from(this.proxyAuth, 'utf8').toString('base64');
    }

    const transport = this.proxyProtocol === 'https:' ? https : http;
    const proxyReq = transport.request({
      method: 'CONNECT',
      host: this.proxyHost,
      port: this.proxyPort,
      path: `${targetHost}:${targetPort}`,
      headers,
      // `agent: false` avoids pooling on the proxy hop; Node opens a fresh
      // TCP socket for each CONNECT so tunnels never alias each other.
      agent: false,
    });

    proxyReq.once('connect', (res, socket, _head) => {
      if (res.statusCode !== 200) {
        const err = new Error(
          `Proxy CONNECT to ${targetHost}:${targetPort} failed with status ${res.statusCode}`,
        );
        socket.destroy();
        callback(err);
        return;
      }
      const servernameRaw =
        (options as { servername?: string }).servername ?? targetHost;
      const servername = stripIPv6Brackets(servernameRaw);
      const tlsSocket: TLSSocket = tlsConnect({
        socket,
        servername,
        ALPNProtocols: ['http/1.1'],
        rejectUnauthorized: this.options.rejectUnauthorized,
      });
      tlsSocket.once('error', (err) => callback(err));
      tlsSocket.once('secureConnect', () => callback(null, tlsSocket));
    });
    proxyReq.once('error', (err) => callback(err));
    proxyReq.end();
  }
}

function pickProxyEnv(env: NodeJS.ProcessEnv): string | undefined {
  const candidates = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
  for (const key of candidates) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function isBypassed(hostname: string, env: NodeJS.ProcessEnv): boolean {
  const noProxy = (env.NO_PROXY ?? env.no_proxy ?? '').trim();
  if (!noProxy) return false;
  if (noProxy === '*') return true;
  const host = hostname.toLowerCase();
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    const stripped = entry.startsWith('.') ? entry.slice(1) : entry;
    if (host === stripped) return true;
    if (host.endsWith('.' + stripped)) return true;
  }
  return false;
}

function stripIPv6Brackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}
