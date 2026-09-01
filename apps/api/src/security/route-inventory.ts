import 'reflect-metadata';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { StaffRole } from '@serviceloop/shared';
import { PUBLIC_KEY, ROLES_KEY } from '../auth/auth.types';

/**
 * The route inventory (phase 7.1).
 *
 * Reads every controller's own Nest metadata and reports, for each route, the
 * HTTP method, the path, whether it is `@Public()`, and which roles `@Roles()`
 * admits. That is the *actual* access-control surface of this API — not a
 * document describing it, which is the thing that drifts.
 *
 * It exists so `rbac-matrix.test.ts` can compare it against a declared matrix,
 * and so an operator can print it. The two consumers matter equally: a matrix
 * test with no way to see what it is testing is a test people delete.
 *
 * Reflection rather than booting the app, deliberately. `NestFactory.create`
 * needs Postgres and Redis, and an access-control check that only runs when
 * infrastructure is up is a check that does not run on a pull request.
 */

export interface RouteDescriptor {
  readonly controller: string;
  readonly handler: string;
  readonly method: string;
  /** Full path with a leading slash and no trailing one. `/` for the root. */
  readonly path: string;
  readonly isPublic: boolean;
  /**
   * Roles the route admits. `null` means no `@Roles()` decorator, i.e. *any*
   * authenticated staff member — which is a real and often wrong answer, and
   * the matrix makes each such route state it on purpose.
   */
  readonly roles: readonly StaffRole[] | null;
}

type Constructor = new (...args: never[]) => object;

const METHOD_NAMES: Readonly<Record<number, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

export function describeRoutes(controllers: readonly Constructor[]): readonly RouteDescriptor[] {
  const routes: RouteDescriptor[] = [];

  for (const controller of controllers) {
    const base = normalise(readMetadata<string>(PATH_METADATA, controller) ?? '');
    const classPublic = readMetadata<boolean>(PUBLIC_KEY, controller) === true;
    const classRoles = readMetadata<StaffRole[]>(ROLES_KEY, controller);

    for (const handler of handlerNames(controller)) {
      const descriptor = Object.getOwnPropertyDescriptor(controller.prototype, handler);
      const fn = descriptor?.value as unknown;
      if (typeof fn !== 'function') continue;

      const verb = readMetadata<number>(METHOD_METADATA, fn as object);
      if (verb === undefined) continue;

      const suffix = normalise(readMetadata<string>(PATH_METADATA, fn as object) ?? '');
      // `@Roles()` on the handler overrides the class, matching how
      // `Reflector.getAllAndOverride` resolves it in `RolesGuard`.
      const handlerRoles = readMetadata<StaffRole[]>(ROLES_KEY, fn as object);
      const roles = handlerRoles ?? classRoles ?? null;

      routes.push({
        controller: controller.name,
        handler,
        method: METHOD_NAMES[verb] ?? `UNKNOWN(${verb})`,
        path: join(base, suffix),
        isPublic: readMetadata<boolean>(PUBLIC_KEY, fn as object) === true || classPublic,
        roles: roles === null || roles.length === 0 ? null : [...roles],
      });
    }
  }

  return routes.sort((a, b) =>
    `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`),
  );
}

/** Stable identity for a route in the declared matrix: `GET /jobcards/:id`. */
export function routeKey(route: Pick<RouteDescriptor, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

function handlerNames(controller: Constructor): string[] {
  return Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor');
}

function readMetadata<T>(key: string, target: object): T | undefined {
  return Reflect.getMetadata(key, target) as T | undefined;
}

function normalise(segment: string): string {
  const trimmed = segment.replace(/^\/+|\/+$/g, '');
  return trimmed === '/' ? '' : trimmed;
}

function join(base: string, suffix: string): string {
  const parts = [base, suffix].filter((part) => part !== '');
  return `/${parts.join('/')}`;
}
