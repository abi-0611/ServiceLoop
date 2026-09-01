/**
 * SSRF guard (phase 7.1).
 *
 * Every URL this system fetches on somebody else's say-so passes through here:
 * a media URL a provider hands us, a review link an owner typed into shop
 * config, a webhook target. The threat is specific and boring — a shop's own
 * console field pointed at `http://169.254.169.254/` turns our Cloud Run
 * service account into the attacker's, and `http://10.0.0.5:5432` turns it into
 * a port scanner inside the VPC.
 *
 * The guard is a *deny* list of network locations rather than an allow list of
 * hosts, because the hosts are not knowable in advance: Meta rotates media
 * CDNs, and a shop's Google review link is whatever Google minted for them.
 * What is knowable is that no legitimate destination is ever a loopback,
 * link-local, private or reserved address.
 *
 * DNS is deliberately *not* resolved here. A resolve-then-fetch check is a
 * TOCTOU hole — the name can answer differently on the second lookup — so the
 * literal-address rules below are enforced at parse time and the caller is
 * expected to pin the resolved address (see `assertPublicAddress`, which the
 * fetch path calls from its socket `lookup` hook).
 */

export interface SsrfPolicy {
  /** Schemes that may be fetched at all. */
  readonly allowedProtocols?: readonly string[];
  /** Ports that may be fetched. Empty means "the scheme's default only". */
  readonly allowedPorts?: readonly number[];
  /**
   * Permits loopback and private ranges. Only ever set by the dev stack, where
   * MinIO *is* on `localhost` and the sandbox WhatsApp adapter fetches from it.
   */
  readonly allowPrivate?: boolean;
}

export class SsrfBlockedError extends Error {
  constructor(
    readonly url: string,
    readonly rule: string,
  ) {
    super(`Refusing to fetch ${redactUrl(url)}: ${rule}`);
    this.name = 'SsrfBlockedError';
  }
}

const DEFAULT_PROTOCOLS = ['https:'] as const;
const DEFAULT_PORTS = [80, 443] as const;

/**
 * Parses and validates an outbound URL. Returns the parsed URL so the caller
 * cannot accidentally fetch a *different* string than the one that was checked.
 */
export function assertFetchableUrl(raw: string, policy: SsrfPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfBlockedError(raw, 'not a valid absolute URL');
  }

  const protocols = policy.allowedProtocols ?? DEFAULT_PROTOCOLS;
  if (!protocols.includes(url.protocol)) {
    throw new SsrfBlockedError(raw, `scheme ${url.protocol} is not in [${protocols.join(', ')}]`);
  }

  // Credentials in a URL are a redirect-laundering trick as often as they are a
  // convenience, and nothing this system fetches needs them.
  if (url.username !== '' || url.password !== '') {
    throw new SsrfBlockedError(raw, 'embedded credentials are not permitted');
  }

  const port = url.port === '' ? defaultPortFor(url.protocol) : Number(url.port);
  const ports = policy.allowedPorts ?? DEFAULT_PORTS;
  if (policy.allowPrivate !== true && !ports.includes(port)) {
    throw new SsrfBlockedError(raw, `port ${port} is not in [${ports.join(', ')}]`);
  }

  const host = hostnameOf(url);
  if (policy.allowPrivate !== true) {
    assertPublicHostname(host, raw);
  }

  return url;
}

/**
 * The socket-level half of the guard: called with the address DNS actually
 * returned, which is the only value that matters.
 */
export function assertPublicAddress(address: string, forUrl = address): void {
  if (isPrivateAddress(address)) {
    throw new SsrfBlockedError(forUrl, `${address} is a private, loopback or reserved address`);
  }
}

function assertPublicHostname(hostname: string, raw: string): void {
  if (hostname === '') throw new SsrfBlockedError(raw, 'empty host');

  // A bare literal is checked here and now; a name is checked at connect time.
  if (ipVersion(hostname) !== 0) {
    assertPublicAddress(hostname, raw);
    return;
  }

  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.internal')) {
    throw new SsrfBlockedError(raw, `host ${hostname} resolves inside the deployment`);
  }
  // Cloud metadata endpoints, by the names they answer to.
  if (lower === 'metadata' || lower === 'metadata.google.internal') {
    throw new SsrfBlockedError(raw, 'cloud metadata endpoints are never fetchable');
  }
}

/**
 * True for anything an outbound fetch must never reach.
 *
 * IPv4 rules are the IANA special-purpose registry's reserved blocks; the IPv6
 * rules cover loopback, unique-local, link-local, and — the one people forget —
 * IPv4-mapped addresses, which are how `::ffff:169.254.169.254` gets past a
 * naive v4-only check.
 */
export function isPrivateAddress(address: string): boolean {
  const version = ipVersion(address);
  if (version === 4) return isPrivateV4(address);
  if (version === 6) return isPrivateV6(address);
  return false;
}

/**
 * 4, 6, or 0 for "not a literal address".
 *
 * Hand-written rather than `node:net`'s `isIP`, and the reason is not
 * preference: `packages/shared` is imported by the Next console and bundled for
 * the browser, so a single `node:` import here fails the console build with a
 * webpack error four layers from its cause. That constraint is why this package
 * is dependency-free, and it applies to Node's own builtins too.
 *
 * The v6 test is deliberately loose — it accepts anything that looks like a
 * colon-separated hex address — because a *false positive* here is safe: it
 * sends the value to `isPrivateV6`, which refuses anything it cannot parse. The
 * failure direction that matters is the other one.
 */
function ipVersion(address: string): 0 | 4 | 6 {
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)) {
    // Octet range is checked here rather than in the regexp: `999.1.1.1` is not
    // an address, and treating it as one would send it to the v4 rules where
    // its first octet reads as "not private".
    return address.split('.').every((octet) => Number(octet) <= 255) ? 4 : 0;
  }
  if (/^[0-9a-f:]*:[0-9a-f:.]*$/i.test(address) && address.includes(':')) return 6;
  return 0;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
  const [a = 0, b = 0] = parts;

  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments / 192.0.2.0/24
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isPrivateV6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::' || lower === '::1') return true;

  // `::ffff:10.0.0.1` and `::ffff:0a00:0001` are the same address wearing two
  // spellings; only the first survives a v4 check written for dotted quads.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped?.[1] !== undefined) return isPrivateV4(mapped[1]);
  if (lower.startsWith('::ffff:')) return true;

  const first = lower.split(':')[0] ?? '';
  const group = Number.parseInt(first.padStart(4, '0'), 16);
  if (Number.isNaN(group)) return true;
  if ((group & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((group & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((group & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

function hostnameOf(url: URL): string {
  // `URL.hostname` keeps the brackets off an IPv6 literal already, but a caller
  // may hand us `host` instead; normalise both shapes.
  return url.hostname.replace(/^\[|\]$/g, '');
}

function defaultPortFor(protocol: string): number {
  return protocol === 'http:' ? 80 : 443;
}

/** Query strings carry signed media tokens; never log one whole. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '[unparseable-url]';
  }
}
