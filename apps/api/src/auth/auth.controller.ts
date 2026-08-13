import { Controller, Get, Inject, Post, Req, Res } from '@nestjs/common';
import { getEnv } from '@serviceloop/config';
import type { StaffRepository } from '@serviceloop/db';
import {
  type OtpRequest,
  OtpRequestSchema,
  type OtpRequestResponse,
  type OtpVerify,
  OtpVerifySchema,
  type Session,
  SwitchShopSchema,
  UnauthorizedError,
  type SwitchShop,
} from '@serviceloop/shared';
import type { CookieOptions, Request, Response } from 'express';
import { rootLogger } from '../common/logger';
import { ZodBody } from '../common/zod';
import { STAFF_REPOSITORY } from '../infra/tokens';
import { AuthService, type IssuedSession } from './auth.service';
import {
  ACCESS_COOKIE,
  CurrentStaff,
  Public,
  REFRESH_COOKIE,
  type AuthenticatedStaff,
} from './auth.types';
import { OtpService } from './otp.service';

/**
 * Staff authentication (phase 1.8).
 *
 * Requesting a code never reveals whether the number belongs to a staff member:
 * the response is identical either way, and only a real member is actually
 * messaged. That keeps the endpoint from becoming a staff-directory oracle.
 */
@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
  ) {}

  @Public()
  @Post('otp/request')
  async requestOtp(@ZodBody(OtpRequestSchema) body: OtpRequest): Promise<OtpRequestResponse> {
    const memberships = await this.auth.memberships(body.phone);
    const env = getEnv();

    if (memberships.length === 0) {
      rootLogger.info('otp requested for a number with no staff membership');
      return { sent: true, expiresInSeconds: env.OTP_TTL_SECONDS };
    }

    // L4: the code is delivered in the staff member's own language.
    const issued = await this.otp.issue(body.phone, memberships[0]?.preferredLanguage ?? 'en');
    return {
      sent: true,
      expiresInSeconds: issued.expiresInSeconds,
      ...(issued.demoCode === undefined ? {} : { demoCode: issued.demoCode }),
    };
  }

  @Public()
  @Post('otp/verify')
  async verifyOtp(
    @ZodBody(OtpVerifySchema) body: OtpVerify,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Session> {
    await this.otp.verify(body.phone, body.code);

    const memberships = await this.auth.memberships(body.phone);
    if (memberships.length === 0) {
      throw new UnauthorizedError('That number is not registered with any shop.');
    }

    const issued = await this.auth.issueSession(memberships);
    setSessionCookies(response, issued);
    return issued.session;
  }

  @Public()
  @Post('refresh')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Session> {
    const token = readCookie(request, REFRESH_COOKIE);
    if (token === null) throw new UnauthorizedError('No refresh token presented.');

    const issued = await this.auth.refresh(token);
    setSessionCookies(response, issued);
    return issued.session;
  }

  @Post('logout')
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ ok: true }> {
    const token = readCookie(request, REFRESH_COOKIE);
    if (token !== null) await this.auth.revoke(token);
    clearSessionCookies(response);
    return { ok: true };
  }

  @Post('switch-shop')
  async switchShop(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(SwitchShopSchema) body: SwitchShop,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Session> {
    const issued = await this.auth.switchShop(staff.staffId, body.shopId);
    setSessionCookies(response, issued);
    return issued.session;
  }

  @Get('me')
  async me(
    @CurrentStaff() staff: AuthenticatedStaff,
  ): Promise<Session['staff'] & { shops: Session['shops'] }> {
    const memberships = await this.staff.findMembershipsByStaffId(staff.staffId);
    return {
      id: staff.staffId,
      fullName: staff.fullName,
      role: staff.role,
      shopId: staff.shopId,
      shops: memberships.map((membership) => ({
        id: membership.shopId,
        name: membership.shopName,
        city: membership.shopCity,
        role: membership.role,
      })),
    };
  }
}

function cookieOptions(maxAgeSeconds: number): CookieOptions {
  const env = getEnv();
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  };
}

function setSessionCookies(response: Response, issued: IssuedSession): void {
  const env = getEnv();
  response.cookie(
    ACCESS_COOKIE,
    issued.session.accessToken,
    cookieOptions(env.JWT_ACCESS_TTL_SECONDS),
  );
  response.cookie(REFRESH_COOKIE, issued.refreshToken, cookieOptions(env.REFRESH_TTL_SECONDS));
}

function clearSessionCookies(response: Response): void {
  response.clearCookie(ACCESS_COOKIE, { path: '/' });
  response.clearCookie(REFRESH_COOKIE, { path: '/' });
}

function readCookie(request: Request, name: string): string | null {
  const cookies = (request as { cookies?: Record<string, string> }).cookies;
  const value = cookies?.[name];
  return value !== undefined && value.length > 0 ? value : null;
}
