import type { ShopConfig } from '@serviceloop/config';
import {
  systemClock,
  uuidv7,
  type Clock,
  type EtaReason,
  type EventEnvelope,
  type JobCardState,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { AuditAppender, OutboxWriter, UnitOfWork } from '../ports';
import type { JobCardContextReader } from '../agent/ports';
import { classifyEtaChange, computeEta, type EtaWorkItem } from './eta-rules';
import type { EtaEntry, EtaStore } from './ports';

/**
 * `EtaService` — the write side of the ETA engine (phase 4.3).
 *
 * `eta-rules.ts` decides *what* the answer is; this decides *when to ask* and
 * writes the versioned history. Three properties carry the weight:
 *
 *   - **The head is locked before the recalculation runs.** An approval landing
 *     at the same instant as a technician's "done" produces version 4 and
 *     version 5, in some order — not two rows both claiming to be version 4.
 *   - **The history entry and the card's denormalised head are one write.** The
 *     board reads `job_cards.current_eta` and the drawer reads the history; a
 *     shop where those two disagree is a shop where nobody trusts either.
 *   - **Materiality is decided here and travels on the event.** The
 *     proactive-comms worker consumes the verdict rather than re-deriving it,
 *     so there is exactly one definition of "worth interrupting someone for".
 */

export interface EtaServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly eta: EtaStore<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  /** Loads the shop's guardrail document, migrated forward on read. */
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  readonly clock?: Clock;
}

export interface RecalculateInput {
  readonly shopId: string;
  readonly jobCardId: string;
  readonly reason: EtaReason;
  readonly actor: Actor;
  readonly traceId: string;
  /** The signal that triggered this, when a technician did. */
  readonly statusSignalId?: string | null;
  /** A time the technician named, for `BLOCKED_PARTS`. */
  readonly partsAvailableAt?: Date | null;
  /** An advisor typing a time by hand; skips the computation entirely. */
  readonly overrideEta?: Date | null;
  /** Free text appended to the stored reason, e.g. the part's name. */
  readonly note?: string;
}

export type RecalculateResult =
  | { readonly ok: true; readonly entry: EtaEntry; readonly unchanged: boolean }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/**
 * States in which an ETA is meaningless.
 *
 * A delivered car has no "ready by", and a cancelled one has no work. Writing
 * an entry for either would put a future time on the board next to a vehicle
 * that left yesterday.
 */
const TERMINAL_STATES: ReadonlySet<JobCardState> = new Set<JobCardState>([
  'DELIVERED',
  'CLOSED',
  'CANCELLED',
]);

/** After this point the work is done; only the handover remains. */
const POST_WORK_STATES: ReadonlySet<JobCardState> = new Set<JobCardState>([
  'READY_FOR_DELIVERY',
  'AWAITING_PAYMENT',
]);

export class EtaService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: EtaServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Recalculates a card's ETA and appends a history entry.
   *
   * Returns `unchanged: true` when the answer is the same minute it already
   * was. The entry is still written — the *reason* changed even though the time
   * did not, and "we re-checked at 15:40 after the part arrived and it is still
   * 17:00" is the answer to a question a customer will ask.
   */
  async recalculate(input: RecalculateInput): Promise<RecalculateResult> {
    const now = this.clock.now();

    return this.deps.uow.transaction(async (tx) => {
      const head = await this.deps.eta.lockHead(tx, input.shopId, input.jobCardId);
      if (head === null) {
        return { ok: false as const, code: 'NO_JOB_CARD', reason: 'That job card is not in this shop' };
      }
      if (TERMINAL_STATES.has(head.state)) {
        return {
          ok: false as const,
          code: 'CARD_TERMINAL',
          reason: `A card in ${head.state} has no remaining work to estimate`,
        };
      }

      const card = await this.deps.cards.load(tx, input.shopId, input.jobCardId);
      if (card === null) {
        return { ok: false as const, code: 'NO_JOB_CARD', reason: 'Job card context is unavailable' };
      }

      const config = await this.deps.loadConfig(tx, input.shopId);
      const workItems = toEtaWorkItems(card);

      const computation =
        input.overrideEta != null
          ? {
              eta: input.overrideEta,
              remainingMinutes: 0,
              countedWorkItemIds: [] as readonly string[],
              startsAt: now,
            }
          : computeEta({
              from: now,
              timezone: config.quietHours.timezone,
              workingHours: config.workingHours,
              config: config.eta,
              workItems,
              reason: input.reason,
              partsAvailableAt: input.partsAvailableAt ?? null,
              includeQualityCheck: !POST_WORK_STATES.has(head.state),
            });

      const verdict = classifyEtaChange({
        previousEta: head.currentEta,
        newEta: computation.eta,
        promisedAt: head.promisedAt,
        timezone: config.quietHours.timezone,
        thresholdMinutes: config.eta.materialSlipMinutes,
      });

      const entry: EtaEntry = {
        id: uuidv7(),
        shopId: input.shopId,
        jobCardId: input.jobCardId,
        version: head.version + 1,
        previousEta: head.currentEta,
        eta: computation.eta,
        promisedAt: head.promisedAt,
        reason: input.reason,
        materiality: verdict.materiality,
        deltaMinutes: verdict.deltaMinutes,
        detail: describeChange({
          reason: input.reason,
          note: input.note ?? null,
          remainingMinutes: computation.remainingMinutes,
          countedItems: computation.countedWorkItemIds.length,
          crossesPromisedDay: verdict.crossesPromisedDay,
          overridden: input.overrideEta != null,
        }),
        statusSignalId: input.statusSignalId ?? null,
        notifiedAt: null,
        createdAt: now,
      };

      await this.deps.eta.append(tx, entry);

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'eta.recalculated',
        entityType: 'job_card',
        entityId: input.jobCardId,
        payload: {
          version: entry.version,
          previousEta: entry.previousEta?.toISOString() ?? null,
          eta: entry.eta.toISOString(),
          reason: entry.reason,
          materiality: entry.materiality,
          deltaMinutes: entry.deltaMinutes,
          remainingMinutes: computation.remainingMinutes,
          countedWorkItemIds: computation.countedWorkItemIds,
          detail: entry.detail,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        type: 'eta.changed',
        payload: {
          jobCardId: input.jobCardId,
          previousEta: entry.previousEta?.toISOString() ?? null,
          newEta: entry.eta.toISOString(),
          promisedAt: entry.promisedAt?.toISOString() ?? null,
          reason: entry.reason,
          materiality: entry.materiality,
          version: entry.version,
          deltaMinutes: entry.deltaMinutes,
          detail: entry.detail,
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);

      return {
        ok: true as const,
        entry,
        unchanged:
          head.currentEta !== null &&
          Math.abs(head.currentEta.getTime() - entry.eta.getTime()) < 60_000,
      };
    });
  }

  async history(shopId: string, jobCardId: string, limit = 20): Promise<readonly EtaEntry[]> {
    return this.deps.uow.transaction((tx) => this.deps.eta.history(tx, shopId, jobCardId, limit));
  }

  async latest(shopId: string, jobCardId: string): Promise<EtaEntry | null> {
    return this.deps.uow.transaction((tx) => this.deps.eta.latest(tx, shopId, jobCardId));
  }

  async markNotified(entryId: string, messageId: string | null): Promise<void> {
    const at = this.clock.now();
    await this.deps.uow.transaction((tx) =>
      this.deps.eta.markNotified(tx, { entryId, messageId, at }),
    );
  }
}

/**
 * Job-card context → the engine's view of the work.
 *
 * The line kind comes from the estimate line that bills the item, which is the
 * only place it exists. An item with no line falls back to `LABOUR`, which is
 * the honest default for work somebody is doing by hand.
 */
export function toEtaWorkItems(card: {
  readonly workItems: readonly {
    readonly id: string;
    readonly state: string;
    readonly estimatedMinutes: number | null;
  }[];
  readonly estimate: {
    readonly lines: readonly { readonly workItemId: string | null; readonly kind: string }[];
  } | null;
}): readonly EtaWorkItem[] {
  const kindByWorkItem = new Map<string, string>();
  for (const line of card.estimate?.lines ?? []) {
    if (line.workItemId !== null) kindByWorkItem.set(line.workItemId, line.kind);
  }

  return card.workItems.map((item) => ({
    id: item.id,
    state: item.state as EtaWorkItem['state'],
    estimatedMinutes: item.estimatedMinutes,
    lineKind: (kindByWorkItem.get(item.id) ?? null) as EtaWorkItem['lineKind'],
  }));
}

/**
 * The explainable half.
 *
 * Every ETA message states its reason, so every entry carries one in words. It
 * is written for an advisor's eye and for the audit row; the *customer's*
 * sentence is generated from `reason` through the i18n catalogue, in their
 * language, by the comms service.
 */
export function describeChange(input: {
  readonly reason: EtaReason;
  readonly note: string | null;
  readonly remainingMinutes: number;
  readonly countedItems: number;
  readonly crossesPromisedDay: boolean;
  readonly overridden: boolean;
}): string {
  const parts: string[] = [REASON_PHRASE[input.reason]];

  if (input.overridden) {
    parts.push('set by hand by an advisor');
  } else {
    parts.push(
      `${input.remainingMinutes} working minutes remaining across ${input.countedItems} approved item(s)`,
    );
  }
  if (input.note !== null && input.note.trim().length > 0) parts.push(input.note.trim());
  if (input.crossesPromisedDay) parts.push('now falls after the promised day');

  return parts.join('; ');
}

const REASON_PHRASE: Readonly<Record<EtaReason, string>> = {
  INTAKE_PROMISE: 'Initial estimate from intake',
  WORK_APPROVED: 'Customer approved additional work',
  WORK_DECLINED: 'Customer declined work that was in the estimate',
  BLOCKED_PARTS: 'Waiting on a part',
  PARTS_RECEIVED: 'Part arrived and fitting resumed',
  TECHNICIAN_HINT: 'Technician gave a time',
  WORK_DONE: 'Technician reported work complete',
  QUALITY_PASSED: 'Quality check passed',
  ADVISOR_OVERRIDE: 'Advisor set the time',
};
