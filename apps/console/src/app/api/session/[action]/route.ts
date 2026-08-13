import { NextResponse, type NextRequest } from 'next/server';
import { apiBaseUrl } from '@/lib/api';

/**
 * Session proxy.
 *
 * The browser never talks to the API directly for authentication: it posts
 * here, this handler forwards to the API, and the API's `Set-Cookie` headers
 * are relayed to the browser. That keeps the httpOnly session cookies on the
 * console's own origin and keeps tokens out of client-side JavaScript.
 */

const ROUTES: Readonly<Record<string, string>> = {
  'otp-request': '/auth/otp/request',
  'otp-verify': '/auth/otp/verify',
  refresh: '/auth/refresh',
  logout: '/auth/logout',
  'switch-shop': '/auth/switch-shop',
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ action: string }> },
): Promise<NextResponse> {
  const { action } = await context.params;
  const target = ROUTES[action];

  if (target === undefined) {
    return NextResponse.json(
      { code: 'NOT_FOUND', detail: 'Unknown session action' },
      { status: 404 },
    );
  }

  const body = await request.text();
  const upstream = await fetch(`${apiBaseUrl()}${target}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      cookie: request.headers.get('cookie') ?? '',
    },
    body: body.length > 0 ? body : '{}',
    cache: 'no-store',
  });

  const payload = await upstream.text();
  const response = new NextResponse(payload, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });

  for (const cookie of upstream.headers.getSetCookie()) {
    response.headers.append('set-cookie', cookie);
  }

  return response;
}
