import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, apiBaseUrl } from '@/lib/api';

/**
 * Transition proxy. The access token stays in an httpOnly cookie, so the
 * browser cannot read it; this handler attaches it server-side.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const token = request.cookies.get(ACCESS_COOKIE)?.value;

  if (token === undefined) {
    return NextResponse.json({ code: 'UNAUTHORIZED', detail: 'Not signed in' }, { status: 401 });
  }

  const upstream = await fetch(`${apiBaseUrl()}/jobcards/${id}/transitions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: await request.text(),
    cache: 'no-store',
  });

  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}
