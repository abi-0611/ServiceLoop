import type {
  ConsentPurpose,
  DeclineKind,
  DeclineReason,
  DocumentKind,
  FeedbackSentiment,
  FeedbackStatus,
  Language,
  LedgerStatus,
  Paise,
  RepitchResponse,
  RetentionTouchStatus,
  RetentionTrigger,
} from '@serviceloop/shared';

/**
 * The retention module's vocabulary (phase 6).
 *
 * One shape is worth explaining before the rest. A `LedgerItem` carries a
 * *snapshot* of what the technician said and what the estimate charged, not
 * references to rows that will answer that question later. That is deliberate:
 * a re-pitch three months on has to restate the original finding to satisfy L7,
 * and by then the work item may have been retitled, the estimate superseded and
 * the media pruned. A ledger that pointed at live rows would produce re-pitches
 * whose evidence had quietly changed underneath them.
 */

export interface LedgerItem {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string;
  readonly workItemId: string;
  readonly customerId: string | null;
  readonly vehicleId: string | null;
  readonly kind: DeclineKind;
  /** Why the customer said no — the four reasons that need four follow-ups. */
  readonly declineReason: DeclineReason;
  /** The free-text reason the technician or advisor gave at decline time. */
  readonly reason: string;
  readonly amountPaise: Paise;
  /** Shop-KB category, which picks the horizon. Null when uncategorised. */
  readonly category: string | null;
  /** The work item's title, frozen at decline time. */
  readonly title: string | null;
  /** The technician's own words, frozen at decline time (L7). */
  readonly technicianNote: string | null;
  readonly evidenceBundleId: string | null;
  readonly estimateLineIds: readonly string[];
  readonly followUpAfter: Date | null;
  readonly triggerTags: readonly string[];
  readonly status: LedgerStatus;
  readonly repitchCount: number;
  readonly lastRepitchedAt: Date | null;
  readonly lastResponse: RepitchResponse | null;
  readonly closedAt: Date | null;
  readonly closedReason: string | null;
  readonly convertedJobCardId: string | null;
  readonly recoveredAmountPaise: Paise;
  readonly createdAt: Date;
}

/** What `openLedgerItem` is told when a work item is declined or deferred. */
export interface OpenLedgerItemInput {
  readonly shopId: string;
  readonly jobCardId: string;
  readonly workItemId: string;
  readonly customerId: string | null;
  readonly vehicleId: string | null;
  readonly kind: DeclineKind;
  readonly declineReason: DeclineReason;
  readonly reason: string;
  readonly amountPaise: Paise;
  readonly category: string | null;
  readonly title: string | null;
  readonly technicianNote: string | null;
  readonly evidenceBundleId: string | null;
  readonly estimateLineIds: readonly string[];
  /**
   * An explicit promise the customer made ("call me after Diwali").
   *
   * Beats the category default, because a date the customer named is worth more
   * than a table: a shop that re-pitches brakes on day 75 to somebody who said
   * "after the monsoon" has ignored them in order to follow a rule.
   */
  readonly customerPromisedAt?: Date | null;
}

export interface TouchSnapshot {
  readonly id: string;
  readonly shopId: string;
  readonly customerId: string;
  readonly vehicleId: string | null;
  readonly jobCardId: string | null;
  readonly conversationId: string | null;
  readonly trigger: RetentionTrigger;
  readonly purpose: ConsentPurpose;
  readonly status: RetentionTouchStatus;
  readonly ledgerItemIds: readonly string[];
  readonly amountPaise: Paise;
  readonly language: Language;
  readonly dedupeKey: string;
  readonly scheduledFor: Date;
  readonly sentAt: Date | null;
  readonly messageId: string | null;
  readonly skipCode: string | null;
  readonly skipReason: string | null;
}

/**
 * A candidate the trigger engine produced, before anything has been written.
 *
 * Pure data with no side effects, which is what makes 6.2 testable against a
 * fake clock: `evaluateTriggers` answers "what is due" and the service answers
 * "and may we".
 */
export interface TriggerHit {
  readonly ledgerItemId: string;
  readonly trigger: RetentionTrigger;
  /** Why this fired, in words, for the audit row and the composer's rationale. */
  readonly rationale: TriggerRationale;
  readonly dueAt: Date;
}

export type TriggerRationale =
  | { readonly kind: 'time_elapsed'; readonly months: number }
  | { readonly kind: 'season'; readonly season: string }
  | { readonly kind: 'next_visit'; readonly jobCardId: string }
  | { readonly kind: 'odometer'; readonly kmSince: number }
  | { readonly kind: 'manual' };

export interface FeedbackRecord {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string;
  readonly customerId: string;
  readonly conversationId: string | null;
  readonly status: FeedbackStatus;
  readonly deliveredAt: Date;
  readonly dueAt: Date;
  readonly askedAt: Date | null;
  readonly remindedAt: Date | null;
  readonly expiresAt: Date;
  readonly answeredAt: Date | null;
  readonly sentiment: FeedbackSentiment | null;
  readonly comment: string | null;
  readonly viaVoiceNote: boolean;
  readonly reviewAskedAt: Date | null;
  readonly recoveryTaskId: string | null;
  readonly holdId: string | null;
}

export interface ServiceDueForecast {
  readonly id: string;
  readonly shopId: string;
  readonly vehicleId: string;
  readonly customerId: string;
  readonly jobCardId: string | null;
  readonly dueAt: Date;
  /** `interval_days` or `odometer` — which rule produced this date. */
  readonly basis: string;
  readonly remindedLeads: readonly number[];
}

export interface VehicleDocument {
  readonly id: string;
  readonly shopId: string;
  readonly vehicleId: string;
  readonly customerId: string;
  readonly kind: DocumentKind;
  /** `YYYY-MM-DD`. A date, not an instant — nobody's PUC expires at 14:32. */
  readonly expiresOn: string;
  readonly enrolledAt: Date | null;
  readonly revokedAt: Date | null;
  readonly lastRemindedAt: Date | null;
  readonly lastRemindedCycle: string | null;
}

/** A customer-volunteered odometer reading (phase 6.2). */
export interface OdometerReading {
  readonly vehicleId: string;
  readonly odometerKm: number;
  readonly source: 'CUSTOMER_VOLUNTEERED' | 'INTAKE' | 'CONSOLE';
  readonly readAt: Date;
}

/** The "while it's here" line an advisor sees in the card drawer (6.2). */
export interface NextVisitPrompt {
  readonly ledgerItemId: string;
  readonly title: string;
  readonly technicianNote: string | null;
  readonly amountPaise: Paise;
  readonly declinedAt: Date;
  readonly declineReason: DeclineReason;
  readonly repitchCount: number;
}

export interface RetentionOutcome {
  readonly touchId: string;
  readonly status: RetentionTouchStatus;
  readonly messageId: string | null;
  readonly detail: string;
}
