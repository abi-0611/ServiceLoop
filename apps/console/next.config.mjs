/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship compiled CJS; Next transpiles them for the client.
  transpilePackages: ['@serviceloop/shared', '@serviceloop/config'],

  /**
   * Traces exactly the files the server needs into `.next/standalone`
   * (phase 7.7).
   *
   * Without it the container image carries the whole monorepo's
   * `node_modules` — close to a gigabyte for a Next app in a pnpm workspace —
   * and Cloud Run pays that on every cold start of a service that scales to
   * zero.
   */
  output: 'standalone',
  /**
   * The tracing root has to be the workspace root, not the app directory.
   *
   * pnpm puts the real packages in `<root>/node_modules/.pnpm` and leaves
   * symlinks in `apps/console/node_modules`. Next's file tracer follows the
   * symlinks, finds the files outside the app directory, and — without this —
   * silently omits them, producing a standalone build that fails at runtime
   * with a module-not-found for a package that is plainly installed.
   */
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,

  /**
   * Security headers for the console (phase 7.1).
   *
   * The API has its own set via helmet; this covers the pages a browser
   * actually renders. `frame-ancestors 'none'` is the one that matters most:
   * the console can release a vehicle and change a guardrail, so clickjacking
   * it has real consequences.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Next injects inline bootstrap scripts and Tailwind emits a
              // stylesheet; `unsafe-inline` for styles is Next's documented
              // requirement and is not a script vector.
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              // Media comes from object storage over signed URLs, and the QR
              // codes are inline data URIs.
              "img-src 'self' data: blob: https:",
              "font-src 'self' data:",
              // The console talks to exactly one API.
              "connect-src 'self' " + (process.env.API_BASE_URL ?? 'http://localhost:3001'),
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
