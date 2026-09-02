import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';

/**
 * The phase-aware form of the config, because one header below has to differ
 * between `next dev` and everything else — and `process.env.NODE_ENV` cannot
 * make that call here. CI runs the whole workspace with `NODE_ENV=test`, which
 * `next dev` honours, so a `NODE_ENV === 'development'` test is false in
 * exactly the situation it needs to be true. The phase comes from Next itself
 * and says what is actually running.
 *
 * @param {string} phase
 * @returns {import('next').NextConfig}
 */
const buildConfig = (phase) => ({
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
  // Left as `.pathname` deliberately. `fileURLToPath` is the correct spelling
  // and on Linux — every build that ships — the two agree exactly. On Windows
  // `.pathname` yields `/D:/…`, and Next traces from the wrong root and drops a
  // stray standalone bundle inside the working tree; that directory is
  // gitignored rather than fixed here, because the correct path makes Next
  // attempt the real symlink tracing that Windows refuses without Developer
  // Mode, turning a cosmetic annoyance into a local build failure.
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
              //
              // `unsafe-eval` is added in development and *only* in
              // development, because `next dev` compiles the client bundle with
              // eval-based source maps. Without it the browser refuses to
              // execute the bundle at all: React never hydrates, every form
              // falls back to a native submit, and the console silently stops
              // working — for the e2e suite and for anybody running
              // `pnpm dev` alike. A production build uses no eval, so the
              // shipped policy stays as strict as it reads here.
              phase === PHASE_DEVELOPMENT_SERVER
                ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
                : "script-src 'self' 'unsafe-inline'",
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
});

export default buildConfig;
