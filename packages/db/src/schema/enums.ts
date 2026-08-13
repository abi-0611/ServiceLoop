import {
  APPROVAL_STATUSES,
  AUDIT_ACTOR_TYPES,
  CHANNEL_TYPES,
  CONSENT_PURPOSES,
  CONSENT_STATUSES,
  CONVERSATION_STATES,
  DECLINE_KINDS,
  ESCALATION_CHANNELS,
  ESCALATION_STATUSES,
  ESTIMATE_LINE_KINDS,
  ESTIMATE_STATUSES,
  JOB_CARD_SOURCES,
  JOB_CARD_STATES,
  LANGUAGES,
  LEDGER_STATUSES,
  MEDIA_KINDS,
  MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES,
  OBJECTIVES,
  OUTBOX_STATUSES,
  STAFF_ROLES,
  WORK_ITEM_STATES,
} from '@serviceloop/shared';
import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Postgres enums generated from the shared zod tuples (phase 1.3), so the
 * database and TypeScript literally cannot drift: adding a value in
 * `@serviceloop/shared` produces a migration here, and removing one breaks the
 * build before it breaks production.
 */

export const staffRoleEnum = pgEnum('staff_role', STAFF_ROLES);
export const languageEnum = pgEnum('language', LANGUAGES);
export const jobCardStateEnum = pgEnum('job_card_state', JOB_CARD_STATES);
export const jobCardSourceEnum = pgEnum('job_card_source', JOB_CARD_SOURCES);
export const workItemStateEnum = pgEnum('work_item_state', WORK_ITEM_STATES);
export const estimateStatusEnum = pgEnum('estimate_status', ESTIMATE_STATUSES);
export const estimateLineKindEnum = pgEnum('estimate_line_kind', ESTIMATE_LINE_KINDS);
export const approvalStatusEnum = pgEnum('approval_status', APPROVAL_STATUSES);
export const channelTypeEnum = pgEnum('channel_type', CHANNEL_TYPES);
export const messageDirectionEnum = pgEnum('message_direction', MESSAGE_DIRECTIONS);
export const messageStatusEnum = pgEnum('message_status', MESSAGE_STATUSES);
export const consentPurposeEnum = pgEnum('consent_purpose', CONSENT_PURPOSES);
export const consentStatusEnum = pgEnum('consent_status', CONSENT_STATUSES);
export const mediaKindEnum = pgEnum('media_kind', MEDIA_KINDS);
export const conversationStateEnum = pgEnum('conversation_state', CONVERSATION_STATES);
export const declineKindEnum = pgEnum('decline_kind', DECLINE_KINDS);
export const ledgerStatusEnum = pgEnum('ledger_status', LEDGER_STATUSES);
export const objectiveEnum = pgEnum('objective', OBJECTIVES);
export const escalationChannelEnum = pgEnum('escalation_channel', ESCALATION_CHANNELS);
export const escalationStatusEnum = pgEnum('escalation_status', ESCALATION_STATUSES);
export const auditActorTypeEnum = pgEnum('audit_actor_type', AUDIT_ACTOR_TYPES);
export const outboxStatusEnum = pgEnum('outbox_status', OUTBOX_STATUSES);
