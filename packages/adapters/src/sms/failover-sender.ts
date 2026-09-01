import type {
  ChannelSender,
  ChannelSendRequest,
  ChannelSendResult,
} from '@serviceloop/domain';
import type { ChannelType } from '@serviceloop/shared';

/**
 * Primary channel with an SMS understudy (phase 7.3).
 *
 * The OutboundGate holds exactly one `ChannelSender` and that is deliberate —
 * it is what makes "every send passes the gate" checkable. Channel *selection*
 * therefore has to live below the gate, in a sender that is itself a sender.
 * This is that object.
 *
 * Three properties it was built to have, each learned from a way this goes
 * wrong:
 *
 * **It never retries the primary on a rejection.** A Meta 400 (bad template, no
 * consent on their side, invalid number) will be a 400 the second time too;
 * only a transport failure — a timeout, a 5xx, a DNS failure — means "try the
 * other rung". Falling back on a business rejection would send over SMS a
 * message WhatsApp refused for a reason.
 *
 * **It opens a circuit rather than probing per message.** After
 * `threshold` consecutive transport failures the primary is marked down for
 * `probeAfterMs`, and every send in that window goes straight to SMS. Without
 * this, a WhatsApp outage means every single message waits out a full HTTP
 * timeout before falling back, which turns a degraded channel into a stalled
 * queue.
 *
 * **A fallback failure re-raises the primary's error.** The operator's question
 * during an incident is "why is WhatsApp broken", and answering it with
 * `SMS_TEMPLATE_NOT_REGISTERED` sends them down the wrong hole for an hour. The
 * SMS reason is attached, not substituted.
 */

export interface ChannelFailoverOptions {
  readonly threshold: number;
  readonly probeAfterMs: number;
  readonly onStateChange?: (event: ChannelFailoverEvent) => void;
  readonly now?: () => Date;
}

export interface ChannelFailoverEvent {
  readonly state: 'DOWN' | 'PROBING' | 'RECOVERED';
  readonly channel: ChannelType;
  readonly consecutiveFailures: number;
  readonly detail: string;
}

export class ChannelFailoverSender implements ChannelSender {
  private consecutiveFailures = 0;
  private downUntil: Date | null = null;
  private readonly now: () => Date;

  constructor(
    private readonly primary: ChannelSender,
    private readonly fallback: ChannelSender,
    private readonly options: ChannelFailoverOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The channel the *message row* is written with, which is the primary even
   * while it is down. The row records what the system meant to do; the sent
   * event and the row's final `channel` record what happened.
   */
  get channel(): ChannelType {
    return this.primary.channel;
  }

  /** Exposed for the health endpoint and the outage drill's assertions. */
  get primaryDown(): boolean {
    return this.downUntil !== null && this.downUntil.getTime() > this.now().getTime();
  }

  async send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    if (this.primaryDown) {
      return this.sendFallback(
        request,
        new Error(`${this.primary.channel} is marked down until ${this.downUntil?.toISOString()}`),
      );
    }

    try {
      const result = await this.primary.send(request);
      this.recordSuccess();
      return result;
    } catch (error) {
      if (!isTransportFailure(error)) {
        // A business rejection. The primary is healthy; this message is not.
        throw error;
      }
      this.recordFailure(error);
      return this.sendFallback(request, error);
    }
  }

  private async sendFallback(request: ChannelSendRequest, cause: unknown): Promise<ChannelSendResult> {
    try {
      const result = await this.fallback.send(request);
      // Stamped here rather than trusted from the delegate. *This* object is
      // the one that knows the message did not go out on the primary, and a
      // fallback sender that forgot to set it would produce a `message.sent`
      // event claiming WhatsApp carried a message WhatsApp never saw.
      return { ...result, channel: result.channel ?? this.fallback.channel };
    } catch (fallbackError) {
      const primaryReason = cause instanceof Error ? cause.message : String(cause);
      const fallbackReason =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      const combined = new Error(
        `${this.primary.channel} failed (${primaryReason}); the ${this.fallback.channel} fallback also failed (${fallbackReason})`,
      );
      // Keep the original for `extractErrorKind`, so the message row's
      // `errorCode` still names the primary's failure rather than the SMS one.
      (combined as { cause?: unknown }).cause = cause;
      throw combined;
    }
  }

  private recordSuccess(): void {
    if (this.downUntil !== null || this.consecutiveFailures > 0) {
      this.options.onStateChange?.({
        state: 'RECOVERED',
        channel: this.primary.channel,
        consecutiveFailures: this.consecutiveFailures,
        detail: `${this.primary.channel} answered again`,
      });
    }
    this.consecutiveFailures = 0;
    this.downUntil = null;
  }

  private recordFailure(error: unknown): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.options.threshold) return;

    this.downUntil = new Date(this.now().getTime() + this.options.probeAfterMs);
    this.options.onStateChange?.({
      state: 'DOWN',
      channel: this.primary.channel,
      consecutiveFailures: this.consecutiveFailures,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  /** Drill seam: forces the circuit open without waiting for real failures. */
  forceDown(forMs: number, reason = 'forced by an operator drill'): void {
    this.consecutiveFailures = this.options.threshold;
    this.downUntil = new Date(this.now().getTime() + forMs);
    this.options.onStateChange?.({
      state: 'DOWN',
      channel: this.primary.channel,
      consecutiveFailures: this.consecutiveFailures,
      detail: reason,
    });
  }

  /** Drill seam: closes the circuit immediately. */
  forceUp(): void {
    this.recordSuccess();
  }
}

/**
 * Is this a "the channel is unreachable" failure, or a "this message is wrong"
 * failure?
 *
 * Conservative on purpose: an unrecognised error is *not* treated as transport,
 * so a new error shape from the Meta adapter fails the send rather than
 * silently starting to route customer traffic over SMS. Adding a case here is a
 * diff a reviewer sees.
 */
function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const kind = (error as { kind?: unknown }).kind;
  if (typeof kind === 'string') {
    // `WhatsAppError.kind` — the adapter's own taxonomy.
    //
    // `PROVIDER_UNAVAILABLE` is the outage. `RATE_LIMITED` is included because
    // a throttle that persists past the send queue's own backoff is, from the
    // customer's point of view, an outage; `AUTH_FAILED` deliberately is not,
    // because an expired token would route every message in the shop to SMS
    // until somebody noticed the bill.
    return ['PROVIDER_UNAVAILABLE', 'RATE_LIMITED'].includes(kind);
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    return [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'EAI_AGAIN',
      'ENOTFOUND',
      'EPIPE',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
    ].includes(code);
  }

  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  return false;
}
