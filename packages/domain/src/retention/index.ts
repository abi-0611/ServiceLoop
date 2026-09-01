/**
 * The retention module's public surface (phase 6).
 *
 * The loop that starts after the vehicle has left: the declined-work ledger and
 * its triggers, the re-pitch, post-service feedback and service recovery,
 * reminders, the MARKETING consent ask, the owner digest, the realtime alert
 * stream, and the event-sourced metrics service every one of those numbers
 * comes from.
 *
 * Note what is *not* exported: nothing here can put a message on a channel. Every
 * service in this module takes an `OutboundGate` and has no other way out, which
 * is what makes "every retention touch passes the consent, purpose and frequency
 * checks" a property of the code rather than a policy somebody follows.
 */

export {
  evaluateTriggers,
  horizonFor,
  purposeFor,
  rationaleKey,
  repitchDedupeKey,
  triggerTagsFor,
  NEXT_VISIT_TAG,
  ODOMETER_TAG_PREFIX,
  SEASON_TAG_PREFIX,
  type TriggerContext,
} from './horizon';

export { LedgerService, type LedgerServiceDeps, type OpenResult } from './ledger-service';

export {
  RetentionService,
  composeRepitch,
  type ComposedRepitch,
  type RetentionServiceDeps,
  type RetentionScanResult,
} from './retention-service';

export {
  FeedbackService,
  type AnswerResult,
  type AskResult,
  type FeedbackServiceDeps,
  type NegativeFeedbackAlerter,
} from './feedback-service';

export { ReminderService, type ReminderServiceDeps } from './reminder-service';

export {
  MarketingConsentService,
  type MarketingAskResult,
  type MarketingConsentDeps,
} from './marketing-consent';

export {
  DigestService,
  type DigestClaimResult,
  type DigestPayload,
  type DigestResult,
  type DigestServiceDeps,
} from './digest-service';

export {
  AlertService,
  type AlertResult,
  type AlertServiceDeps,
  type RaiseAlertInput,
} from './alert-service';

export {
  computeRollup,
  emptyRollup,
  hashRollup,
  mergeRollups,
  percentile,
  rollupDayFor,
  rollupKpis,
  type ComputeRollupInput,
  type DailyRollup,
  type PendingApproval,
  type RollupKpis,
  type RollupWindows,
} from './metrics';

export {
  MetricsService,
  windowsFrom,
  type MetricsServiceDeps,
  type RollupResult,
} from './metrics-service';

export type {
  AlertStore,
  EventLogReader,
  FeedbackStore,
  LedgerStore,
  OdometerStore,
  OwnerDigestStore,
  RetentionDirectory,
  RetentionFrequencyReader,
  RetentionGateFacts,
  RetentionHoldStore,
  RetentionTouchStore,
  RollupStore,
  ServiceDueStore,
  VehicleDocumentStore,
} from './ports';

export type {
  FeedbackRecord,
  LedgerItem,
  NextVisitPrompt,
  OdometerReading,
  OpenLedgerItemInput,
  RetentionOutcome,
  ServiceDueForecast,
  TouchSnapshot,
  TriggerHit,
  TriggerRationale,
  VehicleDocument,
} from './types';
