import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { getEnv } from '@serviceloop/config';
import { type StaffRepository, type StaffMembership } from '@serviceloop/db';
import { ForbiddenError, UnauthorizedError, type Session } from '@serviceloop/shared';
import type Redis from 'ioredis';
import { REDIS, STAFF_REPOSITORY } from '../infra/tokens';
import type { AccessTokenClaims, AuthenticatedStaff } from './auth.types';

/**
 * Session issuance.
 *
 * Access tokens are short-lived JWTs carrying the shop the caller is acting in;
 * refresh tokens are opaque, stored hashed in Redis, and rotated on every use —
 * a replayed refresh token is rejected because its hash is already gone.
 */

interface RefreshRecord {
  readonly staffId: string;
  readonly shopId: string;
}

const REFRESH_KEY = (token: string) => `auth:refresh:${sha256(token)}`;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface IssuedSession {
  readonly session: Session;
  readonly refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(STAFF_REPOSITORY) private readonly staff: StaffRepository,
  ) {}

  async memberships(phone: string): Promise<StaffMembership[]> {
    return this.staff.findMembershipsByPhone(phone);
  }

  async issueSession(memberships: StaffMembership[], shopId?: string): Promise<IssuedSession> {
    const active =
      shopId === undefined
        ? memberships[0]
        : memberships.find((membership) => membership.shopId === shopId);

    if (active === undefined) {
      throw new ForbiddenError('You do not have access to that shop');
    }

    const env = getEnv();
    const claims: AccessTokenClaims = {
      sub: active.staffId,
      shopId: active.shopId,
      role: active.role,
      name: active.fullName,
    };

    const accessToken = await this.jwt.signAsync(claims, {
      expiresIn: env.JWT_ACCESS_TTL_SECONDS,
    });

    const refreshToken = randomBytes(32).toString('base64url');
    await this.redis.set(
      REFRESH_KEY(refreshToken),
      JSON.stringify({ staffId: active.staffId, shopId: active.shopId } satisfies RefreshRecord),
      'EX',
      env.REFRESH_TTL_SECONDS,
    );

    return {
      refreshToken,
      session: {
        accessToken,
        expiresInSeconds: env.JWT_ACCESS_TTL_SECONDS,
        staff: {
          id: active.staffId,
          fullName: active.fullName,
          role: active.role,
          shopId: active.shopId,
        },
        shops: memberships.map((membership) => ({
          id: membership.shopId,
          name: membership.shopName,
          city: membership.shopCity,
          role: membership.role,
        })),
      },
    };
  }

  /** Rotates a refresh token: the presented one is consumed on use. */
  async refresh(refreshToken: string): Promise<IssuedSession> {
    const raw = await this.redis.getdel(REFRESH_KEY(refreshToken));
    if (raw === null) throw new UnauthorizedError('That session has expired. Sign in again.');

    const record = JSON.parse(raw) as RefreshRecord;
    const memberships = await this.staff.findMembershipsByStaffId(record.staffId);
    if (memberships.length === 0) throw new UnauthorizedError('That account is no longer active.');

    return this.issueSession(memberships, record.shopId);
  }

  /** Re-issues a session scoped to another shop this person actually belongs to. */
  async switchShop(staffId: string, shopId: string): Promise<IssuedSession> {
    const memberships = await this.staff.findMembershipsByStaffId(staffId);
    if (memberships.length === 0) throw new UnauthorizedError('That account is no longer active.');
    return this.issueSession(memberships, shopId);
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.redis.del(REFRESH_KEY(refreshToken));
  }

  async verifyAccessToken(token: string): Promise<AuthenticatedStaff> {
    try {
      const claims = await this.jwt.verifyAsync<AccessTokenClaims>(token);
      return {
        staffId: claims.sub,
        shopId: claims.shopId,
        role: claims.role,
        fullName: claims.name,
      };
    } catch {
      throw new UnauthorizedError('Your session has expired. Sign in again.');
    }
  }

  async membershipsForStaffId(staffId: string): Promise<StaffMembership[]> {
    return this.staff.findMembershipsByStaffId(staffId);
  }
}
