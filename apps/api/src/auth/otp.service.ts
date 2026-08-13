import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { NotifierPort } from '@serviceloop/adapters';
import { getEnv } from '@serviceloop/config';
import { ConflictError, UnauthorizedError, type Language } from '@serviceloop/shared';
import type Redis from 'ioredis';
import { NOTIFIER, REDIS } from '../infra/tokens';

/**
 * Phone-OTP for staff sign-in (phase 1.8).
 *
 * Codes live in Redis, hashed, with a TTL and an attempt counter, so a code is
 * never readable from a database dump and cannot be brute-forced. Delivery goes
 * through `NotifierPort`; in DEMO_MODE the code is also returned to the caller
 * so the console can display it.
 */

const CODE_KEY = (phone: string) => `otp:code:${sha256(phone)}`;
const ATTEMPTS_KEY = (phone: string) => `otp:attempts:${sha256(phone)}`;
const COOLDOWN_KEY = (phone: string) => `otp:cooldown:${sha256(phone)}`;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface OtpIssueResult {
  readonly expiresInSeconds: number;
  readonly demoCode?: string;
}

@Injectable()
export class OtpService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(NOTIFIER) private readonly notifier: NotifierPort,
  ) {}

  async issue(phone: string, language: Language): Promise<OtpIssueResult> {
    const env = getEnv();

    const cooling = await this.redis.get(COOLDOWN_KEY(phone));
    if (cooling !== null) {
      throw new ConflictError('A code was just sent. Wait before requesting another.', {
        retryAfterSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
      });
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');

    await this.redis.set(CODE_KEY(phone), sha256(code), 'EX', env.OTP_TTL_SECONDS);
    await this.redis.set(ATTEMPTS_KEY(phone), '0', 'EX', env.OTP_TTL_SECONDS);
    if (env.OTP_RESEND_COOLDOWN_SECONDS > 0) {
      await this.redis.set(COOLDOWN_KEY(phone), '1', 'EX', env.OTP_RESEND_COOLDOWN_SECONDS);
    }

    await this.notifier.deliver({
      kind: 'STAFF_OTP',
      to: phone,
      code,
      ttlSeconds: env.OTP_TTL_SECONDS,
      language,
    });

    return {
      expiresInSeconds: env.OTP_TTL_SECONDS,
      ...(env.DEMO_MODE ? { demoCode: code } : {}),
    };
  }

  async verify(phone: string, code: string): Promise<void> {
    const env = getEnv();

    const stored = await this.redis.get(CODE_KEY(phone));
    if (stored === null) {
      throw new UnauthorizedError('That code has expired. Request a new one.');
    }

    const attempts = await this.redis.incr(ATTEMPTS_KEY(phone));
    if (attempts > env.OTP_MAX_ATTEMPTS) {
      await this.clear(phone);
      throw new UnauthorizedError('Too many attempts. Request a new code.');
    }

    const expected = Buffer.from(stored, 'hex');
    const provided = Buffer.from(sha256(code), 'hex');
    if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
      throw new UnauthorizedError('That code is not valid.');
    }

    await this.clear(phone);
  }

  private async clear(phone: string): Promise<void> {
    await this.redis.del(CODE_KEY(phone), ATTEMPTS_KEY(phone));
  }
}
