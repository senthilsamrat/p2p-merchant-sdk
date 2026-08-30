const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    LOOPBACK_V4.test(normalized);
}

/** True only for plaintext HTTP/WS URLs whose URL hostname is loopback. */
export function isPlaintextLoopbackUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (url.protocol === 'http:' || url.protocol === 'ws:') && isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/** Reject credential-bearing plaintext transport outside local development. */
export function assertSecureTransportUrl(
  input: string,
  allowInsecureTransport: boolean,
  context: string
): void {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${context}: baseUrl must be an absolute URL`);
  }

  if (url.protocol === 'https:' || url.protocol === 'wss:') return;
  if (url.protocol !== 'http:' && url.protocol !== 'ws:') {
    throw new Error(`${context}: baseUrl must use HTTP(S) or WS(S)`);
  }
  if (isLoopbackHost(url.hostname) || allowInsecureTransport) return;

  throw new Error(
    `${context}: refusing plaintext ${url.protocol}// transport to non-loopback host; ` +
    'use HTTPS/WSS or set allowInsecureTransport: true for an explicitly trusted development environment'
  );
}
