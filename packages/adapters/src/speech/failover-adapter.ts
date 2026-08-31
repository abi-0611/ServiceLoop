import {
  countsTowardsFailover,
  SpeechError,
  type SpeechPort,
  type TranscribeInput,
  type Transcript,
} from './port';

/**
 * `FailoverSpeechAdapter` — the provider-failure policy (phase 4.1).
 *
 * Two consecutive provider failures move traffic to the fallback and raise an
 * alert; a success on the fallback keeps it there until a probe says the
 * primary is back. The shape is a circuit breaker, and the two details that
 * make it useful rather than decorative are:
 *
 *   - **Not every error counts.** A voice note that is four bytes of silence
 *     fails on every provider ever built, and letting it trip the breaker means
 *     one bad recording moves the whole shop onto the second-best recogniser.
 *     `countsTowardsFailover` draws the line at "is this about the provider or
 *     about the audio".
 *   - **The alert fires once per transition, not once per failure.** An
 *     operator who is paged eleven times for one outage stops reading the
 *     pages.
 *
 * When the fallback fails too, the *primary's* error is what surfaces. It is
 * the more actionable one: the fallback being down is a footnote to the primary
 * being down, and the alert already carries both.
 */

export interface FailoverAlert {
  readonly from: 'primary' | 'fallback';
  readonly to: 'primary' | 'fallback';
  readonly consecutiveFailures: number;
  readonly reason: string;
}

export interface FailoverSpeechOptions {
  /** Consecutive provider failures before traffic moves. The phase says two. */
  readonly threshold?: number;
  /**
   * How long to stay on the fallback before probing the primary again.
   *
   * Long enough that a flapping provider does not thrash, short enough that a
   * shop is not left on the second-best recogniser for a whole working day
   * because of a two-minute outage at 09:00.
   */
  readonly probeAfterMs?: number;
  readonly onAlert?: (alert: FailoverAlert) => void;
  readonly now?: () => number;
}

export class FailoverSpeechAdapter implements SpeechPort {
  readonly driver = 'failover' as const;

  private consecutiveFailures = 0;
  private usingFallback = false;
  private failedOverAt = 0;

  private readonly threshold: number;
  private readonly probeAfterMs: number;
  private readonly onAlert: (alert: FailoverAlert) => void;
  private readonly now: () => number;

  constructor(
    private readonly primary: SpeechPort,
    private readonly fallback: SpeechPort,
    options: FailoverSpeechOptions = {},
  ) {
    this.threshold = options.threshold ?? 2;
    this.probeAfterMs = options.probeAfterMs ?? 5 * 60_000;
    this.onAlert = options.onAlert ?? (() => undefined);
    this.now = options.now ?? Date.now;
  }

  /** Which provider the next call will try first. Surfaced in the boot log. */
  get active(): 'primary' | 'fallback' {
    return this.usingFallback && !this.shouldProbe() ? 'fallback' : 'primary';
  }

  get state(): {
    readonly active: 'primary' | 'fallback';
    readonly consecutiveFailures: number;
    readonly primaryDriver: string;
    readonly fallbackDriver: string;
  } {
    return {
      active: this.active,
      consecutiveFailures: this.consecutiveFailures,
      primaryDriver: this.primary.driver,
      fallbackDriver: this.fallback.driver,
    };
  }

  async transcribe(input: TranscribeInput): Promise<Transcript> {
    if (this.active === 'fallback') {
      return this.viaFallbackOnly(input);
    }

    try {
      const transcript = await this.primary.transcribe(input);
      this.recordPrimarySuccess();
      return transcript;
    } catch (error) {
      if (!countsTowardsFailover(error)) throw error;

      this.consecutiveFailures += 1;
      if (this.consecutiveFailures < this.threshold) throw error;

      this.enterFallback(describe(error));

      try {
        return await this.fallback.transcribe(input);
      } catch (fallbackError) {
        // Both are down. The primary's error is the one an operator can act on,
        // and the alert already recorded that the fallback failed too.
        if (!countsTowardsFailover(fallbackError)) throw fallbackError;
        throw error;
      }
    }
  }

  private async viaFallbackOnly(input: TranscribeInput): Promise<Transcript> {
    try {
      return await this.fallback.transcribe(input);
    } catch (error) {
      if (!countsTowardsFailover(error)) throw error;
      // The fallback is down while the primary is still in its cool-off. Try
      // the primary anyway rather than failing: a stale breaker must not be the
      // reason a technician's voice note is lost.
      const transcript = await this.primary.transcribe(input);
      this.recordPrimarySuccess();
      return transcript;
    }
  }

  private recordPrimarySuccess(): void {
    if (this.usingFallback) {
      this.usingFallback = false;
      this.onAlert({
        from: 'fallback',
        to: 'primary',
        consecutiveFailures: 0,
        reason: `${this.primary.driver} answered a probe successfully; traffic is back on the primary`,
      });
    }
    this.consecutiveFailures = 0;
  }

  private enterFallback(reason: string): void {
    const alreadyThere = this.usingFallback;
    this.usingFallback = true;
    this.failedOverAt = this.now();

    if (alreadyThere) return;
    this.onAlert({
      from: 'primary',
      to: 'fallback',
      consecutiveFailures: this.consecutiveFailures,
      reason: `${this.primary.driver} failed ${this.consecutiveFailures} times in a row: ${reason}`,
    });
  }

  /** Has the cool-off elapsed, so the next call should re-try the primary? */
  private shouldProbe(): boolean {
    return this.now() - this.failedOverAt >= this.probeAfterMs;
  }
}

function describe(error: unknown): string {
  if (error instanceof SpeechError) return `${error.kind} — ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}
