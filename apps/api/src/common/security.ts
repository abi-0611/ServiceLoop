import { getEnv } from '@serviceloop/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

/**
 * HTTP security headers and CORS lockdown (phase 7.1).
 *
 * The API serves JSON to one origin — the console — and receives signed
 * webhooks from three providers. It renders no HTML of its own, which is what
 * makes the policy below as tight as it is: `default-src 'none'` is normally
 * unworkable and here it is simply true.
 */

export function applySecurityHeaders(app: NestExpressApplication): void {
  const env = getEnv();

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          // Nothing loads from this origin, because nothing is served from it.
          // A CSP on a pure JSON API matters for one case that is easy to
          // forget: an error page, a redirect, or a future `/privacy` route
          // rendered here would otherwise inherit the browser's defaults.
          'default-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'none'"],
          'form-action': ["'none'"],
        },
      },
      // Cloud Run terminates TLS in front of us; a year of HSTS with
      // subdomains is the setting the go-live checklist signs off.
      hsts: env.NODE_ENV === 'production'
        ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
        : false,
      // The API is never framed, never sniffed, and never a referrer source.
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
      // `X-Powered-By` and the version banner tell an attacker which CVE list
      // to start from.
      hidePoweredBy: true,
    }),
  );

  /**
   * Trust exactly the proxies in front of us.
   *
   * `true` would trust any `X-Forwarded-For` a client cared to send, which
   * turns the per-address rate limit into a per-header rate limit — i.e. no
   * limit at all. `0` would rate-limit the load balancer as one client, which
   * throttles the whole shop the moment two advisors refresh a board.
   */
  app.set('trust proxy', env.TRUST_PROXY_HOPS);
}

/**
 * Origins the API answers CORS for.
 *
 * The console by default; `CORS_ALLOWED_ORIGINS` adds staging and preview
 * origins. Never `*`, and the env schema refuses it in production, because the
 * API answers with credentials and a wildcard plus credentials is either
 * rejected by the browser or — if a future change swaps the cookie for a
 * bearer token in a header — a working cross-origin read of every shop's data.
 */
export function allowedOrigins(): readonly string[] {
  const env = getEnv();
  const configured = env.CORS_ALLOWED_ORIGINS;
  return configured.length > 0 ? configured : [env.CONSOLE_URL];
}
