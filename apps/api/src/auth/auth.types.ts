import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import { UnauthorizedError, type StaffRole } from '@serviceloop/shared';
import type { Request } from 'express';

/** The authenticated principal attached to every request by `JwtAuthGuard`. */
export interface AuthenticatedStaff {
  readonly staffId: string;
  readonly shopId: string;
  readonly role: StaffRole;
  readonly fullName: string;
}

export interface AccessTokenClaims {
  readonly sub: string;
  readonly shopId: string;
  readonly role: StaffRole;
  readonly name: string;
}

export const ACCESS_COOKIE = 'sl_access';
export const REFRESH_COOKIE = 'sl_refresh';

export const ROLES_KEY = 'serviceloop:roles';
/** `@Roles('OWNER')` — enforced by `RolesGuard`. */
export const Roles = (...roles: StaffRole[]) => SetMetadata(ROLES_KEY, roles);

export const PUBLIC_KEY = 'serviceloop:public';
/** Opts a route out of authentication. Used only by health and the OTP flow. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

export const CurrentStaff = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedStaff => {
    const request = context.switchToHttp().getRequest<Request & { staff?: AuthenticatedStaff }>();
    if (request.staff === undefined) throw new UnauthorizedError();
    return request.staff;
  },
);
