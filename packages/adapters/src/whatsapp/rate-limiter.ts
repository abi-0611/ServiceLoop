/**
 * Per-shop outbound rate limiting.
 *
 * Meta throttles per business phone number and, separately, per (business,
 * recipient) pair. Hitting either produces a 130429/131056 that the send queue
 * would then retry — so a burst of ready-for-delivery alerts can spiral into a
 * throttle storm. Shaping the burst *before* it leaves is cheaper than
 * recovering from one, and it keeps the error taxonomy meaningful: a
 * `RATE_LIMITED` that reaches us is then genuinely the provider's, not ours.
 *
 * The algorithm is a token bucket, so a quiet shop keeps its full burst
 * allowance and a busy one degrades to a steady rate rather than a cliff.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Whole tokens left after this call. */
  readonly remaining: number;
  /** When denied, how long until one token is available. */
  readonly retryAfterMs: number;
}

export interface RateLimitPolicy {
  /** Burst size: how many messages may go out back-to-back. */
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export const DEFAULT_SEND_POLICY: RateLimitPolicy = { capacity: 20, refillPerSecond: 10 };

export interface TokenBucketStore {
  consume(key: string, policy: RateLimitPolicy, now: number): Promise<RateLimitDecision>;
}

interface BucketState {
  tokens: number;
  updatedAt: number;
}

/** Process-local bucket. Correct for a single worker, and what tests use. */
export class InMemoryTokenBucketStore implements TokenBucketStore {
  private readonly buckets = new Map<string, BucketState>();

  consume(key: string, policy: RateLimitPolicy, now: number): Promise<RateLimitDecision> {
    const state = this.buckets.get(key) ?? { tokens: policy.capacity, updatedAt: now };
    const elapsedSeconds = Math.max(0, now - state.updatedAt) / 1000;
    const tokens = Math.min(policy.capacity, state.tokens + elapsedSeconds * policy.refillPerSecond);

    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedAt: now });
      return Promise.resolve({
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.ceil(((1 - tokens) / policy.refillPerSecond) * 1000),
      });
    }

    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return Promise.resolve({ allowed: true, remaining: Math.floor(tokens - 1), retryAfterMs: 0 });
  }

  reset(): void {
    this.buckets.clear();
  }
}

/**
 * Minimal Redis surface, so this package does not depend on a client library.
 * `ioredis`' `Redis` satisfies it structurally.
 */
export interface EvalCapableRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Refill-and-take in one round trip. Doing it in Lua is what makes the limit
 * hold across every API instance and worker rather than per process.
 */
const CONSUME_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local bucket = redis.call('HMGET', key, 'tokens', 'updated')
local tokens = tonumber(bucket[1])
local updated = tonumber(bucket[2])
if tokens == nil then
  tokens = capacity
  updated = now
end

local elapsed = math.max(0, now - updated) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)

local allowed = 0
local retry = 0
if tokens >= 1 then
  allowed = 1
  tokens = tokens - 1
else
  retry = math.ceil(((1 - tokens) / refill) * 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'updated', now)
-- Idle buckets are indistinguishable from full ones, so they can expire.
redis.call('PEXPIRE', key, math.ceil((capacity / refill) * 1000) + 1000)

return { allowed, math.floor(tokens), retry }
`;

export class RedisTokenBucketStore implements TokenBucketStore {
  constructor(
    private readonly redis: EvalCapableRedis,
    private readonly prefix = 'wa:ratelimit',
  ) {}

  async consume(key: string, policy: RateLimitPolicy, now: number): Promise<RateLimitDecision> {
    const raw = (await this.redis.eval(
      CONSUME_SCRIPT,
      1,
      `${this.prefix}:${key}`,
      policy.capacity,
      policy.refillPerSecond,
      now,
    )) as [number, number, number];

    return { allowed: raw[0] === 1, remaining: raw[1], retryAfterMs: raw[2] };
  }
}

export interface RateLimiterOptions {
  readonly policy?: RateLimitPolicy;
  /** Injected for tests; defaults to the wall clock. */
  readonly now?: () => number;
  /** How long to wait for a token before giving up and failing the send. */
  readonly maxWaitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a token rather than rejecting immediately: an outbound send is
 * already running on a queue, so a short wait is the cheapest correct answer.
 * Past `maxWaitMs` it gives up so a wedged bucket cannot pin a worker.
 */
export class WhatsAppRateLimiter {
  private readonly policy: RateLimitPolicy;
  private readonly now: () => number;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly store: TokenBucketStore = new InMemoryTokenBucketStore(),
    options: RateLimiterOptions = {},
  ) {
    this.policy = options.policy ?? DEFAULT_SEND_POLICY;
    this.now = options.now ?? Date.now;
    this.maxWaitMs = options.maxWaitMs ?? 5_000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Resolves once this shop may send. Rejects when the wait would be too long. */
  async acquire(shopId: string): Promise<RateLimitDecision> {
    let waited = 0;

    for (;;) {
      const decision = await this.store.consume(shopId, this.policy, this.now());
      if (decision.allowed) return decision;

      if (waited + decision.retryAfterMs > this.maxWaitMs) return decision;
      await this.sleep(decision.retryAfterMs);
      waited += decision.retryAfterMs;
    }
  }
}
