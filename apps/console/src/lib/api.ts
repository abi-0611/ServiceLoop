import { cookies } from 'next/headers';
import { ProblemSchema, type Problem } from '@serviceloop/shared';
import type { z } from 'zod';

/**
 * Typed API client.
 *
 * Responses are parsed with the same zod schemas the API validates against
 * (`@serviceloop/shared/contracts`), so a drift between the two is a build
 * error in the console rather than a runtime surprise in a workshop.
 */

export const ACCESS_COOKIE = 'sl_access';
export const REFRESH_COOKIE = 'sl_refresh';

export function apiBaseUrl(): string {
  return process.env['API_BASE_URL'] ?? 'http://localhost:3001';
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem,
  ) {
    super(problem.detail);
    this.name = 'ApiError';
  }
}

export interface FetchOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  readonly accessToken?: string;
  readonly cookieHeader?: string;
}

async function callApi(path: string, options: FetchOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.accessToken !== undefined) headers['authorization'] = `Bearer ${options.accessToken}`;
  if (options.cookieHeader !== undefined) headers['cookie'] = options.cookieHeader;

  return fetch(`${apiBaseUrl()}${path}`, {
    method: options.method ?? 'GET',
    headers,
    cache: 'no-store',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function toProblem(response: Response): Promise<Problem> {
  try {
    const parsed = ProblemSchema.safeParse(await response.json());
    if (parsed.success) return parsed.data;
  } catch {
    // fall through to the generic problem below
  }
  return {
    type: 'https://serviceloop.dev/errors/unknown',
    title: 'RequestFailed',
    status: response.status,
    code: 'REQUEST_FAILED',
    detail: `The API returned ${response.status}`,
  };
}

export async function apiFetch<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
  options: FetchOptions = {},
): Promise<z.infer<T>> {
  const response = await callApi(path, options);
  if (!response.ok) throw new ApiError(response.status, await toProblem(response));
  return schema.parse(await response.json()) as z.infer<T>;
}

/** Server-component helper: authenticates with the browser's session cookie. */
export async function serverApiFetch<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
  options: Omit<FetchOptions, 'accessToken'> = {},
): Promise<z.infer<T>> {
  const token = await readAccessToken();
  return apiFetch(path, schema, {
    ...options,
    ...(token === null ? {} : { accessToken: token }),
  });
}

export async function readAccessToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACCESS_COOKIE)?.value ?? null;
}

export async function isSignedIn(): Promise<boolean> {
  return (await readAccessToken()) !== null;
}
