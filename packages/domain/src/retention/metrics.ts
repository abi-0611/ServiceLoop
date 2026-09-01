import { createHash } from 'node:crypto';
import {
  canonicalJson,
  localDay,
  localDayBounds,
  type EventEnvelope,
  type IsoDay,
  type Paise,
} from '@serviceloop/shared';

/**
 * The metrics fold (phase 6.9).
 *
 * A **pure function of an event stream**, and that purity is the phase's whole
 * audit story rather than a stylistic preference. The claim the business rests
 * on is "₹ recovered from previously declined work", and the only way to make
 * that claim defensible is for it to be reproducible: `recompute --from`
 * replays the same events through the same function and must produce the same
 * number, byte for byte. A rollup assembled from live tables could not do that,
 * because the tables have moved on since.
 *
 * Three consequences follow, and each of them looks like an inefficiency until
 * you want to defend a number:
 *
 *   - **Turnaround samples are kept, not just their median.** A median cannot
 *     be merged, recomputed incrementally, or re-derived at a different
 *     percentile. The samples are bounded by the day's approvals, which for a
 *     workshop is tens.
 *   - **Cohort figures are carried on the closing event**, so the 90-day
 *     recovery rate is a single pass. `ledger.item_closed` states what the item
 *     was ledgered at and when, which means a conversion in September can be
 *     attributed to its June cohort without a join.
 *   - **The window is explicit.** `computeRollup` is told which events it may
 *     see and which day it is folding; it filters internally rather than
 *     trusting a caller's slice. Two runs handed the same range therefore agree
 *     even if one of them was handed extra events.
 */

export interface RollupWindows {
  /** Cohort length for the declined-work recovery rate. Shop config, 90 days. */
  readonly recoveryCohortDays: number;
  /** How far back a previous visit counts as making this one a repeat. */
  readonly repeatVisitWindowDays: number;
  /** How long an approval may go unanswered before the digest lists it. */
  readonly approvalStuckHours: number;
}

export interface PendingApproval {
  readonly approvalId: string;
  readonly jobCardId: string;
  readonly amountPaise: Paise;
  readonly requestedAt: string;
  readonly waitedMinutes: number;
}

/**
 * One shop-day of KPIs.
 *
 * Every field is either a count, a sum, or a bounded list — nothing here is an
 * average, because an average cannot be merged across days and the console's
 * week view needs to. Percentages are computed at the edge from the pair of
 * numbers that produced them, which also means a rate over an empty day reads
 * as "no data" rather than as zero.
 */
export interface DailyRollup {
  readonly day: IsoDay;
  readonly timezone: string;
  readonly windows: RollupWindows;

  /* --- the loop ------------------------------------------------------- */
  readonly vehiclesIn: number;
  readonly vehiclesOut: number;

  /* --- approvals ------------------------------------------------------ */
  readonly approvalsRequested: number;
  readonly approvalsDecided: number;
  readonly requestedValuePaise: Paise;
  readonly approvedValuePaise: Paise;
  /** Minutes from request to decision, for every approval decided today. */
  readonly turnaroundMinutes: readonly number[];
  /** Still unanswered at the end of the day, past the stuck threshold. */
  readonly pendingApprovals: readonly PendingApproval[];

  /* --- deflection ----------------------------------------------------- */
  readonly statusQueriesAnswered: number;
  readonly statusQueriesHandedOff: number;

  /* --- delivery ------------------------------------------------------- */
  readonly deliveriesOnTime: number;
  readonly deliveriesLate: number;
  /** Delivered with nothing ever promised — not a failure, but not a success. */
  readonly deliveriesUnpromised: number;

  /* --- the declined-work ledger --------------------------------------- */
  readonly ledgeredPaise: Paise;
  readonly ledgeredCount: number;
  readonly recoveredPaise: Paise;
  readonly recoveredCount: number;
  /** Ledgered inside the cohort window ending today — the recovery denominator. */
  readonly cohortLedgeredPaise: Paise;
  /** Recovered today from items ledgered inside that window — the numerator. */
  readonly cohortRecoveredPaise: Paise;
  readonly optedOutCount: number;
  readonly repitchesSent: number;

  /* --- retention traffic ---------------------------------------------- */
  readonly retentionTouchesSent: number;
  readonly retentionTouchesSkipped: number;

  /* --- repeat business ------------------------------------------------ */
  readonly visits: number;
  readonly repeatVisits: number;

  /* --- feedback and reviews ------------------------------------------- */
  readonly feedbackPositive: number;
  readonly feedbackNeutral: number;
  readonly feedbackNegative: number;
  readonly reviewAsks: number;

  /* --- the agent ------------------------------------------------------ */
  readonly agentRuns: number;
  readonly agentObjectiveMet: number;
  readonly agentHandoffs: number;
  readonly agentBlocked: number;
  readonly draftsApprovedWithoutEdit: number;
  readonly draftsEdited: number;
  readonly draftsRejected: number;

  /* --- voice ---------------------------------------------------------- */
  readonly callsPlaced: number;
  readonly callsContained: number;
  readonly callsHandedOff: number;

  /* --- guardrails ----------------------------------------------------- */
  readonly messagesBlocked: number;
  readonly consentRevocations: number;
  readonly silentBays: number;
  readonly alertsRaised: number;
}

export interface ComputeRollupInput {
  readonly shopId: string;
  readonly day: IsoDay;
  readonly timezone: string;
  readonly windows: RollupWindows;
  /**
   * Every event for this shop from the start of the lookback window to the end
   * of `day`. The function filters; the caller need only guarantee the range is
   * *at least* wide enough — extra events change nothing.
   */
  readonly events: readonly EventEnvelope[];
}

/** Empty is a real answer: a shop with no traffic has a rollup of zeroes. */
export function emptyRollup(
  day: IsoDay,
  timezone: string,
  windows: RollupWindows,
): DailyRollup {
  return {
    day,
    timezone,
    windows,
    vehiclesIn: 0,
    vehiclesOut: 0,
    approvalsRequested: 0,
    approvalsDecided: 0,
    requestedValuePaise: 0,
    approvedValuePaise: 0,
    turnaroundMinutes: [],
    pendingApprovals: [],
    statusQueriesAnswered: 0,
    statusQueriesHandedOff: 0,
    deliveriesOnTime: 0,
    deliveriesLate: 0,
    deliveriesUnpromised: 0,
    ledgeredPaise: 0,
    ledgeredCount: 0,
    recoveredPaise: 0,
    recoveredCount: 0,
    cohortLedgeredPaise: 0,
    cohortRecoveredPaise: 0,
    optedOutCount: 0,
    repitchesSent: 0,
    retentionTouchesSent: 0,
    retentionTouchesSkipped: 0,
    visits: 0,
    repeatVisits: 0,
    feedbackPositive: 0,
    feedbackNeutral: 0,
    feedbackNegative: 0,
    reviewAsks: 0,
    agentRuns: 0,
    agentObjectiveMet: 0,
    agentHandoffs: 0,
    agentBlocked: 0,
    draftsApprovedWithoutEdit: 0,
    draftsEdited: 0,
    draftsRejected: 0,
    callsPlaced: 0,
    callsContained: 0,
    callsHandedOff: 0,
    messagesBlocked: 0,
    consentRevocations: 0,
    silentBays: 0,
    alertsRaised: 0,
  };
}

/**
 * Folds one shop-day.
 *
 * Events outside the day still matter and are read for context — the approval
 * requested last Tuesday and answered this morning contributes a turnaround to
 * *today*, and a customer's previous visit six weeks ago is what makes today's
 * a repeat. What they never do is contribute a count to a day they did not
 * happen on.
 */
export function computeRollup(input: ComputeRollupInput): DailyRollup {
  const { start, end } = localDayBounds(input.day, input.timezone);
  const startMs = start.getTime();
  const endMs = end.getTime();

  const inDay = (iso: string): boolean => {
    const at = Date.parse(iso);
    return at >= startMs && at < endMs;
  };

  // A stable order. The reducers below build arrays (turnaround samples, the
  // pending list) whose contents are hashed, so two runs that saw the same
  // events in different orders would otherwise produce different hashes for
  // identical data.
  const events = [...input.events].sort(compareEvents);

  const draft = { ...emptyRollup(input.day, input.timezone, input.windows) } as Mutable<DailyRollup>;

  /* Cross-event state the fold carries. Each of these exists because a KPI
   * genuinely spans two events, and none of them is a cache of a table. */
  const approvalRequestedAt = new Map<string, { at: number; amount: Paise; jobCardId: string }>();
  const approvalDecided = new Set<string>();
  const ledgerOpenedAt = new Map<string, number>();
  const promisedByCard = new Map<string, number>();
  const etaByCard = new Map<string, number>();
  const visitsByCustomer = new Map<string, number[]>();

  const turnaround: number[] = [];
  const cohortStart = startMs - input.windows.recoveryCohortDays * 86_400_000;
  const repeatWindowMs = input.windows.repeatVisitWindowDays * 86_400_000;

  for (const event of events) {
    const at = Date.parse(event.occurredAt);
    const today = inDay(event.occurredAt);

    switch (event.type) {
      case 'intake.draft_confirmed': {
        // The canonical "a visit started": it carries the customer and the
        // vehicle, which `job_card.created` does not.
        const previous = visitsByCustomer.get(event.payload.customerId) ?? [];
        if (today) {
          draft.vehiclesIn += 1;
          draft.visits += 1;
          if (previous.some((earlier) => at - earlier <= repeatWindowMs)) {
            draft.repeatVisits += 1;
          }
        }
        visitsByCustomer.set(event.payload.customerId, [...previous, at]);
        break;
      }

      case 'job_card.state_changed': {
        if (event.payload.to !== 'DELIVERED') break;
        if (!today) break;
        draft.vehiclesOut += 1;

        // On time against the promise the customer was actually given: the
        // latest ETA if one was ever issued, else the intake promise, else
        // nothing — and "nothing" is its own bucket rather than a free pass.
        const target =
          etaByCard.get(event.payload.jobCardId) ?? promisedByCard.get(event.payload.jobCardId);
        if (target === undefined) draft.deliveriesUnpromised += 1;
        else if (at <= target) draft.deliveriesOnTime += 1;
        else draft.deliveriesLate += 1;
        break;
      }

      case 'eta.changed': {
        etaByCard.set(event.payload.jobCardId, Date.parse(event.payload.newEta));
        if (event.payload.promisedAt !== null) {
          promisedByCard.set(event.payload.jobCardId, Date.parse(event.payload.promisedAt));
        }
        break;
      }

      case 'approval.requested': {
        approvalRequestedAt.set(event.payload.approvalId, {
          at,
          amount: event.payload.amountPaise,
          jobCardId: event.payload.jobCardId,
        });
        if (today) {
          draft.approvalsRequested += 1;
          draft.requestedValuePaise += event.payload.amountPaise;
        }
        break;
      }

      case 'approval.decided': {
        approvalDecided.add(event.payload.approvalId);
        if (!today) break;
        draft.approvalsDecided += 1;
        draft.approvedValuePaise += event.payload.approvedAmountPaise;
        const requested = approvalRequestedAt.get(event.payload.approvalId);
        if (requested !== undefined) {
          turnaround.push(Math.max(0, Math.round((at - requested.at) / 60_000)));
        }
        break;
      }

      case 'agent.run_finished': {
        if (!today) break;
        draft.agentRuns += 1;
        if (event.payload.outcome === 'objective_met') draft.agentObjectiveMet += 1;
        if (event.payload.outcome === 'handoff') draft.agentHandoffs += 1;
        if (event.payload.outcome === 'blocked') draft.agentBlocked += 1;

        // The deflection proxy: status questions the agent answered itself,
        // over the total including the ones that reached a person.
        if (event.payload.objective === 'answer_status') {
          if (event.payload.outcome === 'objective_met') draft.statusQueriesAnswered += 1;
          else draft.statusQueriesHandedOff += 1;
        }
        break;
      }

      case 'message.review_decided': {
        if (!today) break;
        if (event.payload.action === 'REJECT') draft.draftsRejected += 1;
        else if (event.payload.edited) draft.draftsEdited += 1;
        else draft.draftsApprovedWithoutEdit += 1;
        break;
      }

      case 'ledger.item_opened': {
        ledgerOpenedAt.set(event.payload.ledgerItemId, at);
        if (today) {
          draft.ledgeredCount += 1;
          draft.ledgeredPaise += event.payload.amountPaise;
        }
        if (at >= cohortStart && at < endMs) {
          draft.cohortLedgeredPaise += event.payload.amountPaise;
        }
        break;
      }

      case 'ledger.item_closed': {
        if (!today) break;
        if (event.payload.status === 'CONVERTED') {
          draft.recoveredCount += 1;
          draft.recoveredPaise += event.payload.recoveredAmountPaise;
          // Attributed to the cohort the item was *ledgered* in, which is why
          // `openedAt` travels on the event.
          const openedAt = Date.parse(event.payload.openedAt);
          if (openedAt >= cohortStart && openedAt < endMs) {
            draft.cohortRecoveredPaise += event.payload.recoveredAmountPaise;
          }
        }
        if (event.payload.status === 'OPTED_OUT') draft.optedOutCount += 1;
        break;
      }

      case 'ledger.repitched': {
        if (today) draft.repitchesSent += 1;
        break;
      }

      case 'retention.touch_sent': {
        if (today) draft.retentionTouchesSent += 1;
        break;
      }

      case 'retention.touch_skipped': {
        if (today) draft.retentionTouchesSkipped += 1;
        break;
      }

      case 'feedback.recorded': {
        if (!today) break;
        if (event.payload.sentiment === 'POSITIVE') draft.feedbackPositive += 1;
        if (event.payload.sentiment === 'NEUTRAL') draft.feedbackNeutral += 1;
        if (event.payload.sentiment === 'NEGATIVE') draft.feedbackNegative += 1;
        if (event.payload.reviewAsked) draft.reviewAsks += 1;
        break;
      }

      case 'call.originated': {
        if (today && event.payload.blocked === null) draft.callsPlaced += 1;
        break;
      }

      case 'call.ended': {
        if (!today) break;
        if (event.payload.handedOff) draft.callsHandedOff += 1;
        else if (
          event.payload.outcome === 'DECISION_RECORDED' ||
          event.payload.outcome === 'ANSWERED_FROM_STATE' ||
          event.payload.outcome === 'BOOKING_DRAFTED'
        ) {
          draft.callsContained += 1;
        }
        break;
      }

      case 'message.blocked': {
        if (today) draft.messagesBlocked += 1;
        break;
      }

      case 'consent.updated': {
        if (today && event.payload.to === 'REVOKED') draft.consentRevocations += 1;
        break;
      }

      case 'silent_bay.detected': {
        if (today) draft.silentBays += 1;
        break;
      }

      case 'alert.raised': {
        if (today) draft.alertsRaised += 1;
        break;
      }

      default:
        break;
    }
  }

  /* The stuck-approval list is a *point-in-time* fact folded from the same
   * stream: requested before the threshold, never decided by the end of the
   * day. Computing it here rather than querying live tables is what lets the
   * digest be a projection of the rollup — one source of numeric truth, which
   * is the phase's own requirement. */
  const stuckBefore = endMs - input.windows.approvalStuckHours * 3_600_000;
  const pending: PendingApproval[] = [];
  for (const [approvalId, requested] of approvalRequestedAt) {
    if (approvalDecided.has(approvalId)) continue;
    if (requested.at > stuckBefore) continue;
    pending.push({
      approvalId,
      jobCardId: requested.jobCardId,
      amountPaise: requested.amount,
      requestedAt: new Date(requested.at).toISOString(),
      waitedMinutes: Math.round((endMs - requested.at) / 60_000),
    });
  }
  pending.sort((a, b) => b.waitedMinutes - a.waitedMinutes || a.approvalId.localeCompare(b.approvalId));

  return {
    ...draft,
    turnaroundMinutes: [...turnaround].sort((a, b) => a - b),
    pendingApprovals: pending,
  };
}

/**
 * A total order over events.
 *
 * `occurredAt` then id, and the id tiebreak is load-bearing rather than
 * defensive: two events written in one transaction share a timestamp to the
 * millisecond, and a fold whose sample array depended on which of them the
 * database happened to return first would hash differently on every run.
 */
function compareEvents(a: EventEnvelope, b: EventEnvelope): number {
  const at = Date.parse(a.occurredAt) - Date.parse(b.occurredAt);
  return at !== 0 ? at : a.id.localeCompare(b.id);
}

/* -------------------------------------------------------------------------- *
 * Derived figures
 * -------------------------------------------------------------------------- */

/**
 * Percentiles from the day's own samples.
 *
 * Nearest-rank, on a sorted array, with `null` for an empty day. Not zero: a
 * shop that had no approvals yesterday did not have a zero-minute turnaround,
 * and a chart that draws one is a chart that lies on quiet days.
 */
export function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

export interface RollupKpis {
  readonly approvalTurnaroundMedianMinutes: number | null;
  readonly approvalTurnaroundP90Minutes: number | null;
  /** Approved value over requested value. Null when nothing was requested. */
  readonly approvalConversionRate: number | null;
  readonly statusDeflectionRate: number | null;
  readonly onTimeDeliveryRate: number | null;
  readonly declinedWorkRecoveryRate: number | null;
  readonly repeatVisitRate: number | null;
  readonly agentContainmentRate: number | null;
  readonly draftAcceptedWithoutEditRate: number | null;
  readonly voiceContainmentRate: number | null;
}

/** Every rate the console and the digest quote, computed in exactly one place. */
export function rollupKpis(rollup: DailyRollup): RollupKpis {
  return {
    approvalTurnaroundMedianMinutes: percentile(rollup.turnaroundMinutes, 0.5),
    approvalTurnaroundP90Minutes: percentile(rollup.turnaroundMinutes, 0.9),
    approvalConversionRate: ratio(rollup.approvedValuePaise, rollup.requestedValuePaise),
    statusDeflectionRate: ratio(
      rollup.statusQueriesAnswered,
      rollup.statusQueriesAnswered + rollup.statusQueriesHandedOff,
    ),
    onTimeDeliveryRate: ratio(
      rollup.deliveriesOnTime,
      rollup.deliveriesOnTime + rollup.deliveriesLate,
    ),
    declinedWorkRecoveryRate: ratio(rollup.cohortRecoveredPaise, rollup.cohortLedgeredPaise),
    repeatVisitRate: ratio(rollup.repeatVisits, rollup.visits),
    agentContainmentRate: ratio(rollup.agentObjectiveMet, rollup.agentRuns),
    draftAcceptedWithoutEditRate: ratio(
      rollup.draftsApprovedWithoutEdit,
      rollup.draftsApprovedWithoutEdit + rollup.draftsEdited + rollup.draftsRejected,
    ),
    voiceContainmentRate: ratio(
      rollup.callsContained,
      rollup.callsContained + rollup.callsHandedOff,
    ),
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * Sums a run of daily rollups into one.
 *
 * How the console's week and month views, and the weekly digest, are computed:
 * from the same daily rollups, never from a second fold over a wider window.
 * The daily rollup is therefore the only thing that has to be right.
 *
 * `pendingApprovals` is taken from the **last** day rather than concatenated,
 * because it is a point-in-time list and a week's worth of them concatenated
 * would list the same stuck approval seven times.
 */
export function mergeRollups(
  days: readonly DailyRollup[],
  windows: RollupWindows,
): DailyRollup | null {
  const first = days[0];
  const last = days[days.length - 1];
  if (first === undefined || last === undefined) return null;

  const merged = { ...emptyRollup(last.day, first.timezone, windows) } as Mutable<DailyRollup>;
  const turnaround: number[] = [];

  for (const day of days) {
    merged.vehiclesIn += day.vehiclesIn;
    merged.vehiclesOut += day.vehiclesOut;
    merged.approvalsRequested += day.approvalsRequested;
    merged.approvalsDecided += day.approvalsDecided;
    merged.requestedValuePaise += day.requestedValuePaise;
    merged.approvedValuePaise += day.approvedValuePaise;
    turnaround.push(...day.turnaroundMinutes);
    merged.statusQueriesAnswered += day.statusQueriesAnswered;
    merged.statusQueriesHandedOff += day.statusQueriesHandedOff;
    merged.deliveriesOnTime += day.deliveriesOnTime;
    merged.deliveriesLate += day.deliveriesLate;
    merged.deliveriesUnpromised += day.deliveriesUnpromised;
    merged.ledgeredPaise += day.ledgeredPaise;
    merged.ledgeredCount += day.ledgeredCount;
    merged.recoveredPaise += day.recoveredPaise;
    merged.recoveredCount += day.recoveredCount;
    merged.optedOutCount += day.optedOutCount;
    merged.repitchesSent += day.repitchesSent;
    merged.retentionTouchesSent += day.retentionTouchesSent;
    merged.retentionTouchesSkipped += day.retentionTouchesSkipped;
    merged.visits += day.visits;
    merged.repeatVisits += day.repeatVisits;
    merged.feedbackPositive += day.feedbackPositive;
    merged.feedbackNeutral += day.feedbackNeutral;
    merged.feedbackNegative += day.feedbackNegative;
    merged.reviewAsks += day.reviewAsks;
    merged.agentRuns += day.agentRuns;
    merged.agentObjectiveMet += day.agentObjectiveMet;
    merged.agentHandoffs += day.agentHandoffs;
    merged.agentBlocked += day.agentBlocked;
    merged.draftsApprovedWithoutEdit += day.draftsApprovedWithoutEdit;
    merged.draftsEdited += day.draftsEdited;
    merged.draftsRejected += day.draftsRejected;
    merged.callsPlaced += day.callsPlaced;
    merged.callsContained += day.callsContained;
    merged.callsHandedOff += day.callsHandedOff;
    merged.messagesBlocked += day.messagesBlocked;
    merged.consentRevocations += day.consentRevocations;
    merged.silentBays += day.silentBays;
    merged.alertsRaised += day.alertsRaised;
  }

  // The cohort figures are not sums. A 90-day cohort rate is already a window
  // over the past; adding seven of them would count June's ledgered rupees
  // seven times and quietly divide the recovery rate by seven. The last day's
  // view of the cohort is the correct one for any range ending on that day.
  merged.cohortLedgeredPaise = last.cohortLedgeredPaise;
  merged.cohortRecoveredPaise = days.reduce((sum, day) => sum + day.cohortRecoveredPaise, 0);

  return {
    ...merged,
    turnaroundMinutes: turnaround.sort((a, b) => a - b),
    pendingApprovals: last.pendingApprovals,
  };
}

/**
 * The rollup's identity.
 *
 * sha256 of the canonical JSON. A backfill that produces a different hash for a
 * day already folded is a regression somebody can find, and the assertion is
 * one string comparison rather than a diff of forty fields.
 */
export function hashRollup(rollup: DailyRollup): string {
  return createHash('sha256').update(canonicalJson(rollup)).digest('hex');
}

/** The shop-local day an instant falls on — the key a rollup is filed under. */
export function rollupDayFor(at: Date, timezone: string): IsoDay {
  return localDay(at, timezone);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
