import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, apiBaseUrl } from '@/lib/api';

/**
 * Server-side proxy for the console's client components.
 *
 * The access token lives in an httpOnly cookie on the console's own origin, so
 * a browser script cannot read it and cannot call the API directly. This
 * handler attaches it server-side, which is what keeps the token out of reach
 * of anything running in the page.
 *
 * The allowlist is the point. A blanket "forward whatever the browser asks for"
 * proxy would turn the console origin into an open credentialled gateway to
 * every API route, including ones the console has no business calling. Adding a
 * prefix here is a deliberate act that shows up in a diff.
 */
const ALLOWED_PREFIXES = [
  'conversations',
  'intake',
  'sandbox',
  'media',
  'review',
  // Phase 4: the status confirm queue, the delivery panel and the gate screen.
  'status',
  'delivery',
  'gate-pass',
  // Phase 5: the softphone's handset and the console's call list. One prefix
  // covers both `voice/softphone/...` and `voice/calls/...`, which is the whole
  // of the voice surface the browser is allowed to reach.
  'voice',
  // Phase 6: the analytics export and the owner's "check these numbers", plus
  // the card drawer's next-visit prompt. The read pages are server components
  // and do not come through here; these three are the browser-side calls.
  'analytics',
  'retention',
  // Phase 7: the DPDP request workflow (verify, approve, execute, cancel,
  // reject) and the template ops screen's "record what Meta said". Both are
  // browser-side writes from a signed-in member of staff; the read pages are
  // server components and never come through here.
  'privacy',
  'ops',
] as const;

/** Statuses the fetch spec forbids a body on. */
const BODYLESS_STATUSES = new Set([204, 205, 304]);

function isAllowed(segments: readonly string[]): boolean {
  const head = segments[0];
  return head !== undefined && ALLOWED_PREFIXES.includes(head as (typeof ALLOWED_PREFIXES)[number]);
}

async function forward(
  request: NextRequest,
  segments: readonly string[],
  method: 'GET' | 'POST',
): Promise<NextResponse> {
  if (!isAllowed(segments)) {
    return NextResponse.json(
      { code: 'NOT_FOUND', detail: 'No such console API route' },
      { status: 404 },
    );
  }

  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  if (token === undefined) {
    return NextResponse.json({ code: 'UNAUTHORIZED', detail: 'Not signed in' }, { status: 401 });
  }

  const search = request.nextUrl.search;
  const headers: Record<string, string> = {
    accept: request.headers.get('accept') ?? 'application/json',
    authorization: `Bearer ${token}`,
  };

  let body: string | undefined;
  if (method === 'POST') {
    body = await request.text();
    headers['content-type'] = 'application/json';
  }

  const upstream = await fetch(
    `${apiBaseUrl()}/${segments.map(encodeURIComponent).join('/')}${search}`,
    { method, headers, cache: 'no-store', ...(body === undefined ? {} : { body }) },
  );

  const contentType = upstream.headers.get('content-type') ?? 'application/json';

  // 204/205/304 must not carry a body. `new Response(body, { status: 204 })`
  // throws, which turned "mark this thread read" into a silent no-op and left
  // the unread badge on for ever.
  if (BODYLESS_STATUSES.has(upstream.status)) {
    return new NextResponse(null, { status: upstream.status });
  }

  // Media is bytes, not JSON: streaming it through `text()` would corrupt it.
  if (!contentType.includes('json')) {
    // `content-disposition` travels too, or the analytics CSV export renders
    // as a wall of text in the tab instead of saving with its filename.
    const disposition = upstream.headers.get('content-disposition');
    return new NextResponse(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers: {
        'content-type': contentType,
        'cache-control': upstream.headers.get('cache-control') ?? 'private, max-age=3600',
        ...(disposition === null ? {} : { 'content-disposition': disposition }),
      },
    });
  }

  return new NextResponse(await upstream.text(), {
    status: upstream.status,
    headers: { 'content-type': contentType },
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await context.params;
  return forward(request, path, 'GET');
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const { path } = await context.params;
  return forward(request, path, 'POST');
}
