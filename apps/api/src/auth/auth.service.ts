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
 * Session issuance, with refresh-reuse detection (phase 7.1).
 *
 * Access tokens are short-lived JWTs carrying the shop the caller is acting in.
 * Refresh tokens are opaque, stored hashed in Redis, and rotated on every use.
 *
 * Rotation alone is necessary and not sufficient. Consider the actual attack:
 * an advisor's laptop is compromised and a refresh token is copied. Both the
 * advisor and the attacker now hold the same token. Whoever refreshes first
 * gets a new one and the other's copy 404s — under rotation-only that is the
 * end of the story, and it is the *victim* who gets logged out and the attacker
 * who ends up with a live session. Nothing anywhere records that anything
 * happened.
 *
 * So every token belongs to a **family**, minted at sign-in and inherited by
 * each rotation, and a consumed token's hash is kept (as a tombstone naming its
 * family) for the remainder of the family's life. Presenting a consumed token
 * is proof that two parties hold tokens from one lineage, and the response is
 * to kill the entire family — both the attacker's token and the victim's. The
 * victim signs in again with a code sent to their phone, which the attacker
 * cannot intercept; the attacker gets nothing.
 *
 * Three Redis keys, all TTL'd to the refresh lifetime so nothing accumulates:
 *
 *   auth:refresh:<sha256(token)>   → live token, JSON RefreshRecord
 *   auth:used:<sha256(token)>      → tombstone, the family id
 *   auth:family:<familyId>         → SET of every live token hash in the family
 */

interface RefreshRecord {
  readonly staffId: string;
  readonly shopId: string;
  readonly familyId: string;
  readonly issuedAt: number;
}

const REFRESH_KEY = (token: string) => `auth:refresh:${sha256(token)}`;
const USED_KEY = (token: string) => `auth:used:${sha256(token)}`;
const FAMILY_KEY = (familyId: string) => `auth:family:${familyId}`;

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

  async issueSession(
    memberships: StaffMembership[],
    shopId?: string,
    /** Continues an existing lineage. Absent at sign-in, which starts one. */
    familyId?: string,
  ): Promise<IssuedSession> {
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
    const family = familyId ?? randomBytes(16).toString('hex');
    const record: RefreshRecord = {
      staffId: active.staffId,
      shopId: active.shopId,
      familyId: family,
      issuedAt: Date.now(),
    };

    // One round trip. Two separate writes would leave a window in which a token
    // is live but not a member of its family — and a token outside its family
    // is a token `killFamily` cannot revoke.
    await this.redis
      .multi()
      .set(REFRESH_KEY(refreshToken), JSON.stringify(record), 'EX', env.REFRESH_TTL_SECONDS)
      .sadd(FAMILY_KEY(family), sha256(refreshToken))
      .expire(FAMILY_KEY(family), env.REFRESH_TTL_SECONDS)
      .exec();

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

  /**
   * Rotates a refresh token: the presented one is consumed on use, and a
   * *second* presentation of the same token destroys the whole family.
   */
  async refresh(refreshToken: string): Promise<IssuedSession> {
    const env = getEnv();
    const raw = await this.redis.getdel(REFRESH_KEY(refreshToken));

    if (raw === null) {
      // Either an expired token, or one that has already been spent. The
      // tombstone tells the two apart, and they call for opposite responses:
      // an expiry is somebody who left a tab open for a month, and a reuse is
      // two parties holding one lineage.
      const familyId = await this.redis.get(USED_KEY(refreshToken));
      if (familyId !== null) {
        const killed = await this.killFamily(familyId);
        throw new UnauthorizedError(
          'That sign-in link has already been used. For your security every session on this account has been signed out — please sign in again.',
          { reason: 'REFRESH_REUSE_DETECTED', familyId, sessionsRevoked: killed },
        );
      }
      throw new UnauthorizedError('That session has expired. Sign in again.');
    }

    const record = JSON.parse(raw) as RefreshRecord;

    // Tombstone the spent token for the rest of the family's life. Written
    // after the GETDEL, so exactly one concurrent caller can reach here with
    // this token and the loser takes the reuse branch above.
    await this.redis
      .multi()
      .set(USED_KEY(refreshToken), record.familyId, 'EX', env.REFRESH_TTL_SECONDS)
      .srem(FAMILY_KEY(record.familyId), sha256(refreshToken))
      .exec();

    const memberships = await this.staff.findMembershipsByStaffId(record.staffId);
    if (memberships.length === 0) throw new UnauthorizedError('That account is no longer active.');

    return this.issueSession(memberships, record.shopId, record.familyId);
  }

  /**
   * Revokes every live token in a lineage. Returns how many were killed, which
   * the audit line and the test both read.
   *
   * The family set is deleted last: a crash between the deletes leaves orphaned
   * token keys that are still individually revoked, which is safe. Deleting the
   * set first would leave live tokens with nothing pointing at them.
   */
  private async killFamily(familyId: string): Promise<number> {
    const hashes = await this.redis.smembers(FAMILY_KEY(familyId));
    if (hashes.length > 0) {
      await this.redis.del(...hashes.map((hash) => `auth:refresh:${hash}`));
    }
    await this.redis.del(FAMILY_KEY(familyId));
    return hashes.length;
  }

  /** Re-issues a session scoped to another shop this person actually belongs to. */
  async switchShop(staffId: string, shopId: string): Promise<IssuedSession> {
    const memberships = await this.staff.findMembershipsByStaffId(staffId);
    if (memberships.length === 0) throw new UnauthorizedError('That account is no longer active.');
    return this.issueSession(memberships, shopId);
  }

  /**
   * Sign-out. Kills the whole family rather than the one token presented.
   *
   * "Sign me out" from a person means "end this session", and a session that
   * has rotated four times this morning is four spent tokens and one live one.
   * Deleting only the presented token would leave the lineage intact if the
   * browser had a rotation in flight — and, more to the point, somebody signing
   * out on a borrowed laptop means it.
   */
  async revoke(refreshToken: string): Promise<void> {
    const raw = await this.redis.get(REFRESH_KEY(refreshToken));
    if (raw !== null) {
      const record = JSON.parse(raw) as RefreshRecord;
      await this.killFamily(record.familyId);
      return;
    }
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
