import { z } from 'zod';

/**
 * Single source of truth for every enumerated value in the system.
 *
 * Each enum is declared once as a readonly tuple, then projected into:
 *   - a zod schema (validation at every boundary), and
 *   - a Postgres enum (`packages/db/src/schema/enums.ts` consumes the tuples).
 *
 * TS types and DB types therefore cannot drift.
 */

function enumOf<const T extends readonly [string, ...string[]]>(values: T) {
  return { values, schema: z.enum(values) } as const;
}

export const STAFF_ROLES = ['OWNER', 'ADVISOR', 'TECHNICIAN'] as const;
export const StaffRoleSchema = enumOf(STAFF_ROLES).schema;
export type StaffRole = z.infer<typeof StaffRoleSchema>;

export const LANGUAGES = ['en', 'ta', 'hi'] as const;
export const LanguageSchema = enumOf(LANGUAGES).schema;
export type Language = z.infer<typeof LanguageSchema>;

export const JOB_CARD_STATES = [
  'DRAFT',
  'OPEN',
  'IN_DIAGNOSIS',
  'AWAITING_APPROVAL',
  'IN_PROGRESS',
  'AWAITING_PARTS',
  'QUALITY_CHECK',
  'READY_FOR_DELIVERY',
  'AWAITING_PAYMENT',
  'DELIVERED',
  'CLOSED',
  'CANCELLED',
] as const;
export const JobCardStateSchema = enumOf(JOB_CARD_STATES).schema;
export type JobCardState = z.infer<typeof JobCardStateSchema>;

export const JOB_CARD_EVENTS = [
  'OPEN_CARD',
  'BEGIN_DIAGNOSIS',
  'REQUEST_APPROVAL',
  'APPROVAL_GRANTED',
  'PARTS_AWAITED',
  'PARTS_RECEIVED',
  'WORK_COMPLETED',
  'QUALITY_PASSED',
  'PAYMENT_REQUESTED',
  'PAYMENT_SETTLED',
  'VEHICLE_DELIVERED',
  'CLOSE',
  'CANCEL',
] as const;
export const JobCardEventSchema = enumOf(JOB_CARD_EVENTS).schema;
export type JobCardEvent = z.infer<typeof JobCardEventSchema>;

export const WORK_ITEM_STATES = [
  'PROPOSED',
  'PENDING_APPROVAL',
  'APPROVED',
  'DECLINED',
  'DEFERRED',
  'IN_PROGRESS',
  'DONE',
] as const;
export const WorkItemStateSchema = enumOf(WORK_ITEM_STATES).schema;
export type WorkItemState = z.infer<typeof WorkItemStateSchema>;

export const WORK_ITEM_EVENTS = [
  'SUBMIT_FOR_APPROVAL',
  'APPROVE',
  'DECLINE',
  'DEFER',
  'START',
  'COMPLETE',
] as const;
export const WorkItemEventSchema = enumOf(WORK_ITEM_EVENTS).schema;
export type WorkItemEvent = z.infer<typeof WorkItemEventSchema>;

export const ESTIMATE_STATUSES = ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'SUPERSEDED'] as const;
export const EstimateStatusSchema = enumOf(ESTIMATE_STATUSES).schema;
export type EstimateStatus = z.infer<typeof EstimateStatusSchema>;

export const ESTIMATE_LINE_KINDS = ['LABOUR', 'PART', 'CONSUMABLE', 'FEE'] as const;
export const EstimateLineKindSchema = enumOf(ESTIMATE_LINE_KINDS).schema;
export type EstimateLineKind = z.infer<typeof EstimateLineKindSchema>;

export const APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'PARTIAL',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
] as const;
export const ApprovalStatusSchema = enumOf(APPROVAL_STATUSES).schema;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const CHANNEL_TYPES = ['WHATSAPP', 'SMS', 'VOICE', 'CONSOLE'] as const;
export const ChannelTypeSchema = enumOf(CHANNEL_TYPES).schema;
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

export const MESSAGE_DIRECTIONS = ['INBOUND', 'OUTBOUND'] as const;
export const MessageDirectionSchema = enumOf(MESSAGE_DIRECTIONS).schema;
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

export const MESSAGE_STATUSES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'QUEUED',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'BLOCKED',
] as const;
export const MessageStatusSchema = enumOf(MESSAGE_STATUSES).schema;
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

export const CONSENT_PURPOSES = ['SERVICE', 'MARKETING'] as const;
export const ConsentPurposeSchema = enumOf(CONSENT_PURPOSES).schema;
export type ConsentPurpose = z.infer<typeof ConsentPurposeSchema>;

export const CONSENT_STATUSES = ['PENDING', 'GRANTED', 'REVOKED'] as const;
export const ConsentStatusSchema = enumOf(CONSENT_STATUSES).schema;
export type ConsentStatus = z.infer<typeof ConsentStatusSchema>;

export const MEDIA_KINDS = ['PHOTO', 'VIDEO', 'AUDIO', 'DOCUMENT'] as const;
export const MediaKindSchema = enumOf(MEDIA_KINDS).schema;
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const CONVERSATION_STATES = ['OPEN', 'SNOOZED', 'CLOSED'] as const;
export const ConversationStateSchema = enumOf(CONVERSATION_STATES).schema;
export type ConversationState = z.infer<typeof ConversationStateSchema>;

export const DECLINE_KINDS = ['DECLINED', 'DEFERRED'] as const;
export const DeclineKindSchema = enumOf(DECLINE_KINDS).schema;
export type DeclineKind = z.infer<typeof DeclineKindSchema>;

export const LEDGER_STATUSES = ['OPEN', 'RE_PITCHED', 'CONVERTED', 'CLOSED'] as const;
export const LedgerStatusSchema = enumOf(LEDGER_STATUSES).schema;
export type LedgerStatus = z.infer<typeof LedgerStatusSchema>;

/** The customer-facing objectives that own an escalation ladder (L3). */
export const OBJECTIVES = [
  'APPROVAL',
  'STATUS',
  'DELIVERY',
  'PAYMENT',
  'RETENTION',
  'FEEDBACK',
] as const;
export const ObjectiveSchema = enumOf(OBJECTIVES).schema;
export type Objective = z.infer<typeof ObjectiveSchema>;

export const ESCALATION_CHANNELS = ['WHATSAPP', 'SMS', 'VOICE', 'HUMAN'] as const;
export const EscalationChannelSchema = enumOf(ESCALATION_CHANNELS).schema;
export type EscalationChannel = z.infer<typeof EscalationChannelSchema>;

export const ESCALATION_STATUSES = ['SCHEDULED', 'EXECUTED', 'CANCELLED', 'SKIPPED'] as const;
export const EscalationStatusSchema = enumOf(ESCALATION_STATUSES).schema;
export type EscalationStatus = z.infer<typeof EscalationStatusSchema>;

export const AUDIT_ACTOR_TYPES = ['STAFF', 'CUSTOMER', 'AGENT', 'SYSTEM'] as const;
export const AuditActorTypeSchema = enumOf(AUDIT_ACTOR_TYPES).schema;
export type AuditActorType = z.infer<typeof AuditActorTypeSchema>;

export const OUTBOX_STATUSES = ['PENDING', 'DISPATCHED', 'FAILED'] as const;
export const OutboxStatusSchema = enumOf(OUTBOX_STATUSES).schema;
export type OutboxStatus = z.infer<typeof OutboxStatusSchema>;

/** L2: a photographed paper job card is a first-class intake source, forever. */
export const JOB_CARD_SOURCES = ['PAPER_CARD', 'WHATSAPP', 'WALK_IN', 'PHONE', 'CONSOLE'] as const;
export const JobCardSourceSchema = enumOf(JOB_CARD_SOURCES).schema;
export type JobCardSource = z.infer<typeof JobCardSourceSchema>;

/** Autonomy ladder (master §6). Every flow starts at L0 for a new shop. */
export const AUTONOMY_LEVELS = [
  'L0_SHADOW',
  'L1_TEMPLATED',
  'L2_CONVERSATIONAL',
  'L3_VOICE',
] as const;
export const AutonomyLevelSchema = enumOf(AUTONOMY_LEVELS).schema;
export type AutonomyLevel = z.infer<typeof AutonomyLevelSchema>;

export const AUTONOMY_FLOWS = ['approval', 'status', 'delivery', 'retention', 'voice'] as const;
export const AutonomyFlowSchema = enumOf(AUTONOMY_FLOWS).schema;
export type AutonomyFlow = z.infer<typeof AutonomyFlowSchema>;
