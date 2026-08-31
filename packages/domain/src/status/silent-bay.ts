import type { ShopConfig } from '@serviceloop/config';
import {
  systemClock,
  t,
  uuidv7,
  workingMinutesBetween,
  type Clock,
  type EventEnvelope,
  type JobCardState,
  type Language,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { ConversationStore } from '../messaging/ports';
import type { OutboundGate } from '../messaging/outbound-gate';
import type { AuditAppender, OutboxWriter, UnitOfWork } from '../ports';
import type { SilentBayStore, SilentCard } from './ports';

/**
 * The silent-bay sentinel (phase 4.6).
 *
 * A vehicle on a lift that nobody has touched for three working hours is idle
 * capacity and, more to the point, a customer about to be told a time that is
 * no longer true. This scans for those and puts one message in the staff group.
 *
 * Two properties matter more than the arithmetic:
 *
 *   - **Working hours, not wall clock.** A card last touched at 18:50 on
 *     Saturday has been quiet for two days and about ten minutes of shop time.
 *     Nudging about it at 09:05 on Monday would train the staff group to ignore
 *     the channel, which costs the shop the one thing this feature has.
 *   - **Exactly one nudge per window, enforced by a unique index.** The scan
 *     claims `(jobCardId, windowStart)` and sends about what it claimed, so two
 *     workers, a restart, or a scan that runs every five minutes all produce
 *     one message per window rather than one per scan.
 */

export interface SilentBayDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly bays: SilentBayStore<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  readonly clock?: Clock;
}

export interface ScanInput {
  readonly shopId: string;
  /** The staff group thread. Without one there is nobody to nudge. */
  readonly staffConversationId: string | null;
  readonly language?: Language;
  readonly actor: Actor;
  readonly traceId: string;
}

export interface ScanResult {
  readonly examined: number;
  readonly silent: readonly SilentCard[];
  /** Cards claimed in this window — the ones actually named in the message. */
  readonly nudged: readonly string[];
  readonly escalated: readonly string[];
  readonly messageId: string | null;
  readonly windowStart: Date;
  readonly detail: string;
}

/** States in which a vehicle is the shop's problem and should be moving. */
const ACTIVE_STATES: ReadonlySet<JobCardState> = new Set<JobCardState>([
  'IN_DIAGNOSIS',
  'IN_PROGRESS',
  'QUALITY_CHECK',
]);

export function isActiveForSilence(state: JobCardState): boolean {
  return ACTIVE_STATES.has(state);
}

/**
 * `AWAITING_PARTS` and `AWAITING_APPROVAL` are deliberately absent.
 *
 * Both are cards that are *supposed* to be sitting still: one is waiting on a
 * courier and the other on a customer, and neither is a technician failing to
 * work. They have their own chases — the approval ladder and the ETA engine's
 * parts lead time — and nudging a technician about them would be blaming the
 * wrong person for the right delay.
 */

export class SilentBaySentinel<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: SilentBayDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  async scan(input: ScanInput): Promise<ScanResult> {
    const now = this.clock.now();

    const loaded = await this.deps.uow.transaction(async (tx) => {
      const config = await this.deps.loadConfig(tx, input.shopId);
      const cards = await this.deps.bays.activeCards(tx, input.shopId);
      return { config, cards };
    });

    const { config } = loaded;
    const thresholdMinutes = Math.round(config.statusComms.silentBayAfterWorkingHours * 60);
    const windowStart = truncateToWindow(now, config.statusComms.silentBayAfterWorkingHours);

    const silent = loaded.cards
      .filter((card) => isActiveForSilence(card.state))
      .map((card) => ({
        card,
        quietForMinutes: workingMinutesBetween(
          card.lastSignalAt,
          now,
          config.quietHours.timezone,
          config.workingHours,
        ),
      }))
      .filter((entry) => entry.quietForMinutes > thresholdMinutes);

    const claimed: {
      readonly nudgeId: string;
      readonly card: SilentCard;
      readonly quietForMinutes: number;
      readonly consecutiveWindows: number;
    }[] = [];

    for (const entry of silent) {
      const claim = await this.deps.uow.transaction(async (tx) => {
        // How many windows this card has already been reported in. Counted
        // from a bounded lookback so a card that sat over a long weekend does
        // not accumulate a history nobody will read.
        const previous = await this.deps.bays.consecutiveWindows(
          tx,
          input.shopId,
          entry.card.jobCardId,
          new Date(now.getTime() - LOOKBACK_MS),
        );
        const nudgeId = uuidv7();
        const claimedId = await this.deps.bays.claimWindow(tx, {
          id: nudgeId,
          shopId: input.shopId,
          jobCardId: entry.card.jobCardId,
          windowStart,
          state: entry.card.state,
          quietForMinutes: entry.quietForMinutes,
          consecutiveWindows: previous + 1,
        });
        return claimedId === null
          ? null
          : { nudgeId: claimedId, consecutiveWindows: previous + 1 };
      });

      if (claim === null) continue;
      claimed.push({
        nudgeId: claim.nudgeId,
        card: entry.card,
        quietForMinutes: entry.quietForMinutes,
        consecutiveWindows: claim.consecutiveWindows,
      });
    }

    if (claimed.length === 0) {
      return {
        examined: loaded.cards.length,
        silent: silent.map((entry) => entry.card),
        nudged: [],
        escalated: [],
        messageId: null,
        windowStart,
        detail:
          silent.length === 0
            ? 'No card has been quiet past the threshold'
            : 'Every silent card was already nudged in this window',
      };
    }

    const language = input.language ?? config.languages.default;
    const messageId = await this.sendNudge(input, claimed, language, thresholdMinutes);

    const escalated: string[] = [];
    await this.deps.uow.transaction(async (tx) => {
      for (const entry of claimed) {
        await this.deps.bays.attachMessage(tx, entry.nudgeId, messageId);

        const envelope: EventEnvelope = {
          id: uuidv7(),
          occurredAt: now.toISOString(),
          shopId: input.shopId,
          traceId: input.traceId,
          type: 'silent_bay.detected',
          payload: {
            jobCardId: entry.card.jobCardId,
            code: entry.card.code,
            state: entry.card.state,
            quietForMinutes: entry.quietForMinutes,
            consecutiveWindows: entry.consecutiveWindows,
            assignedTechnicianId: entry.card.assignedTechnicianId,
            actor: { type: input.actor.type, id: input.actor.id },
          },
        };
        await this.deps.outbox.enqueue(tx, envelope);

        if (entry.consecutiveWindows >= config.statusComms.silentWindowsBeforeEscalation) {
          escalated.push(entry.card.jobCardId);
        }
      }

      if (escalated.length > 0) {
        await this.deps.bays.markEscalated(
          tx,
          claimed
            .filter((entry) => escalated.includes(entry.card.jobCardId))
            .map((entry) => entry.nudgeId),
        );
      }

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'silent_bay.scanned',
        entityType: 'shop',
        entityId: input.shopId,
        payload: {
          windowStart: windowStart.toISOString(),
          thresholdMinutes,
          examined: loaded.cards.length,
          nudged: claimed.map((entry) => entry.card.code),
          escalated,
          messageId,
        },
        traceId: input.traceId,
      });
    });

    return {
      examined: loaded.cards.length,
      silent: silent.map((entry) => entry.card),
      nudged: claimed.map((entry) => entry.card.jobCardId),
      escalated,
      messageId,
      windowStart,
      detail: `${claimed.length} silent card(s) nudged in the staff group`,
    };
  }

  /**
   * One message listing every card claimed in this window.
   *
   * One message rather than one per card, because a staff group that receives
   * six notifications in a row is a staff group that mutes the thread — and a
   * muted staff group breaks the evidence channel, the intake trigger and the
   * status loop all at once.
   */
  private async sendNudge(
    input: ScanInput,
    claimed: readonly {
      readonly card: SilentCard;
      readonly quietForMinutes: number;
      readonly consecutiveWindows: number;
    }[],
    language: Language,
    thresholdMinutes: number,
  ): Promise<string | null> {
    if (input.staffConversationId === null) return null;

    const header = t(language, 'staff.silent_bay_header', {
      count: claimed.length,
      hours: Math.round((thresholdMinutes / 60) * 10) / 10,
    });

    const lines = claimed.map((entry) =>
      t(language, 'staff.silent_bay_line', {
        code: entry.card.code,
        registration: entry.card.registration,
        state: entry.card.state,
        hours: Math.round((entry.quietForMinutes / 60) * 10) / 10,
        technician: entry.card.assignedTechnicianName ?? '—',
      }),
    );

    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: input.staffConversationId,
      customerId: null,
      purpose: 'SERVICE',
      content: { kind: 'text', body: [header, ...lines].join('\n') },
      actor: input.actor,
      traceId: input.traceId,
      flow: 'status',
      language,
      // Internal, and the shop has no discretion over whether its own staff are
      // told a bay has gone quiet. Quiet hours still apply — technicians sleep.
      systemReply: true,
      templated: true,
    });

    return outcome.status === 'BLOCKED' ? null : outcome.messageId;
  }
}

/** Two days of windows is enough history to call silence "repeated". */
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * The window a moment belongs to.
 *
 * Fixed buckets from the epoch rather than "since the last scan", so two
 * workers with slightly different clocks compute the same bucket and the unique
 * index does its job. The bucket length is the silence threshold, which is what
 * makes "one nudge per window" mean "at most one nudge per threshold-length
 * stretch of quiet".
 */
export function truncateToWindow(now: Date, windowHours: number): Date {
  const windowMs = Math.max(Math.round(windowHours * 60 * 60 * 1000), 60_000);
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}
