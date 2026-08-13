import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ForbiddenError, UnauthorizedError, type StaffRole } from '@serviceloop/shared';
import type { Request } from 'express';
import { currentContext } from '../common/request-context';
import { AuthService } from './auth.service';
import { ACCESS_COOKIE, type AuthenticatedStaff, PUBLIC_KEY, ROLES_KEY } from './auth.types';

type AuthedRequest = Request & { staff?: AuthenticatedStaff };

/**
 * Authentication.
 *
 * The access token may arrive as a bearer header (API clients, tests) or as an
 * httpOnly cookie (the console). Public routes are opt-in through `@Public()`
 * and are limited to health and the OTP exchange.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = extractToken(request);
    if (token === null) throw new UnauthorizedError();

    const staff = await this.auth.verifyAccessToken(token);
    request.staff = staff;

    // Carry the principal into logs and audit rows for this request.
    const ctx = currentContext();
    if (ctx !== undefined) {
      ctx.staffId = staff.staffId;
      ctx.shopId = staff.shopId;
    }

    return true;
  }
}

function extractToken(request: AuthedRequest): string | null {
  const header = request.header('authorization');
  if (header !== undefined && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }

  const cookies = (request as { cookies?: Record<string, string> }).cookies;
  const cookie = cookies?.[ACCESS_COOKIE];
  return cookie !== undefined && cookie.length > 0 ? cookie : null;
}

/** `@Roles('OWNER')`. Absent metadata means any authenticated role may call. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<StaffRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const staff = request.staff;
    if (staff === undefined) throw new UnauthorizedError();

    if (!required.includes(staff.role)) {
      throw new ForbiddenError(`This action requires one of: ${required.join(', ')}`, {
        requiredRoles: required,
        actualRole: staff.role,
      });
    }
    return true;
  }
}
