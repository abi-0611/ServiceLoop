import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, apiBaseUrl } from '@/lib/api';

/** Guardrail write proxy; the API remains the only place the patch is validated. */
export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  if (token === undefined) {
    return NextResponse.json({ code: 'UNAUTHORIZED', detail: 'Not signed in' }, { status: 401 });
  }

  const upstream = await fetch(`${apiBaseUrl()}/config/guardrails`, {
    method: 'PATCH',
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
