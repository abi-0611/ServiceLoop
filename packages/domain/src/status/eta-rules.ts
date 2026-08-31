import type { EtaConfig } from '@serviceloop/config';
import {
  addWorkingMinutes,
  crossesLocalDay,
  nextWorkingInstant,
  type EstimateLineKind,
  type EtaMateriality,
  type EtaReason,
  type WorkingWindow,
  type WorkItemState,
} from '@serviceloop/shared';

/**
 * The ETA engine's rules table (phase 4.3) — pure functions, no ports, no clock
 * of its own.
 *
 * Deterministic and explainable rather than predicted. That is a product
 * decision, not a modelling shortcut: every ETA the shop states is a promise a
 * customer will plan their day around, and "the model said so" is not something
 * an advisor can defend at the counter. Everything here is a sum of numbers the
 * owner configured, applied to work items the customer approved, laid onto the
 * hours the shop is actually open.
 *
 * Two things it deliberately does not do. It does not shorten an ETA because a
 * technician sounded confident, and it does not lengthen one to build in a
 * margin of safety beyond the configured buffer — a shop that quietly pads
 * every promise by two hours teaches its customers to stop believing it.
 */

/** A work item as the engine sees it: how long it takes, and whether it's live. */
export interface EtaWorkItem {
  readonly id: string;
  readonly state: WorkItemState;
  /** The technician's or advisor's own estimate. Preferred over any default. */
  readonly estimatedMinutes: number | null;
  /** The estimate line backing it, for the per-kind fallback. */
  readonly lineKind: EstimateLineKind | null;
}

export interface EtaComputation {
  readonly eta: Date;
  /** Working minutes of work the engine counted. */
  readonly remainingMinutes: number;
  readonly countedWorkItemIds: readonly string[];
  /** When work can next start — later than `from` if the shop is shut. */
  readonly startsAt: Date;
}

export interface EtaComputeInput {
  readonly from: Date;
  readonly timezone: string;
  readonly workingHours: WorkingWindow;
  readonly config: EtaConfig;
  readonly workItems: readonly EtaWorkItem[];
  readonly reason: EtaReason;
  /**
   * A time the technician named ("part varum 4 maniku"). Trusted over the
   * configured lead time, because they have spoken to the parts shop and the
   * configuration has not.
   */
  readonly partsAvailableAt?: Date | null;
  /** Whether the card still owes a quality check. */
  readonly includeQualityCheck: boolean;
}

/**
 * Work the shop has actually committed to.
 *
 * `PROPOSED` and `PENDING_APPROVAL` are excluded on purpose: nobody has agreed
 * to pay for them, so counting their time would produce an ETA built on work
 * that may never happen — and then a "slip" the moment the customer declines.
 * The approval itself is a recalculation trigger, which is where that time
 * enters the number.
 */
const COMMITTED_STATES: ReadonlySet<WorkItemState> = new Set<WorkItemState>([
  'APPROVED',
  'IN_PROGRESS',
]);

export function isCommitted(item: EtaWorkItem): boolean {
  return COMMITTED_STATES.has(item.state);
}

/** Minutes for one item: its own estimate, else the per-kind default. */
export function minutesFor(item: EtaWorkItem, config: EtaConfig): number {
  if (item.estimatedMinutes !== null && item.estimatedMinutes >= 0) return item.estimatedMinutes;
  return config.defaultMinutesByLineKind[item.lineKind ?? 'LABOUR'];
}

/**
 * The engine's answer: when this vehicle will be ready.
 *
 * `blocked_parts` is the one branch that leaves the shop floor. A part arriving
 * is wall-clock time — a courier does not wait for Monday — so the lead time is
 * added in real hours, and only the *fitting* is laid onto working hours after
 * it lands.
 */
export function computeEta(input: EtaComputeInput): EtaComputation {
  const committed = input.workItems.filter(isCommitted);
  const labourMinutes = committed.reduce((total, item) => total + minutesFor(item, input.config), 0);

  const withCheck =
    labourMinutes + (input.includeQualityCheck ? input.config.qualityCheckMinutes : 0);
  const buffered = Math.round(withCheck * (1 + input.config.bufferPercent / 100));

  const partsGate =
    input.reason === 'BLOCKED_PARTS'
      ? (input.partsAvailableAt ??
        new Date(input.from.getTime() + input.config.partsLeadTimeMinutes * 60_000))
      : input.from;

  // A part that lands at 03:00 is not fitted at 03:00.
  const startsAt = nextWorkingInstant(
    partsGate.getTime() > input.from.getTime() ? partsGate : input.from,
    input.timezone,
    input.workingHours,
  );

  return {
    eta: addWorkingMinutes(startsAt, input.timezone, input.workingHours, buffered),
    remainingMinutes: buffered,
    countedWorkItemIds: committed.map((item) => item.id),
    startsAt,
  };
}

export interface MaterialityInput {
  readonly previousEta: Date | null;
  readonly newEta: Date;
  readonly promisedAt: Date | null;
  readonly timezone: string;
  readonly thresholdMinutes: number;
}

export interface MaterialityVerdict {
  readonly materiality: EtaMateriality;
  /** Signed minutes against the baseline; negative means the car got earlier. */
  readonly deltaMinutes: number;
  /** True when this change is the first to push past the promised day. */
  readonly crossesPromisedDay: boolean;
}

/**
 * Is this change worth interrupting a customer for? (phase 4.3)
 *
 * The baseline is the previous ETA, or the counter promise when there is no
 * previous ETA — because the first thing a customer compares against is what
 * they were told when they handed over the keys.
 *
 * The day-crossing test fires **once**: the message that matters is "it will
 * not be ready today", and repeating it on every subsequent twenty-minute nudge
 * is how a shop trains someone to mute the thread.
 */
export function classifyEtaChange(input: MaterialityInput): MaterialityVerdict {
  const baseline = input.previousEta ?? input.promisedAt;
  const crossed = crossesPromisedDayNow(input);

  if (baseline === null) {
    // The very first ETA on a card with no counter promise. Nothing has moved,
    // so there is nothing to interrupt anyone about.
    return { materiality: 'IMMATERIAL', deltaMinutes: 0, crossesPromisedDay: crossed };
  }

  const deltaMinutes = Math.round((input.newEta.getTime() - baseline.getTime()) / 60_000);

  if (crossed || deltaMinutes > input.thresholdMinutes) {
    return { materiality: 'MATERIAL_SLIP', deltaMinutes, crossesPromisedDay: crossed };
  }
  if (deltaMinutes < -input.thresholdMinutes) {
    return { materiality: 'MATERIAL_GAIN', deltaMinutes, crossesPromisedDay: false };
  }
  return { materiality: 'IMMATERIAL', deltaMinutes, crossesPromisedDay: false };
}

function crossesPromisedDayNow(input: MaterialityInput): boolean {
  const promised = input.promisedAt;
  if (promised === null) return false;

  const isLate =
    input.newEta.getTime() > promised.getTime() &&
    crossesLocalDay(promised, input.newEta, input.timezone);
  if (!isLate) return false;

  const wasAlreadyLate =
    input.previousEta !== null &&
    input.previousEta.getTime() > promised.getTime() &&
    crossesLocalDay(promised, input.previousEta, input.timezone);

  return !wasAlreadyLate;
}

/**
 * The reasons that must reach a customer *immediately* rather than riding the
 * next natural touchpoint.
 *
 * The bad-news-early rule (phase 4.4): a part that has not arrived is the
 * single thing a customer most wants to hear about before they set out to
 * collect their car, and the shop's incentive is always to delay saying it.
 */
const ALWAYS_IMMEDIATE: ReadonlySet<EtaReason> = new Set<EtaReason>(['BLOCKED_PARTS']);

export function requiresImmediateNotice(
  reason: EtaReason,
  materiality: EtaMateriality,
): boolean {
  return ALWAYS_IMMEDIATE.has(reason) || materiality === 'MATERIAL_SLIP';
}
