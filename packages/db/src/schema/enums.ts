import {
  ADVISOR_TASK_KINDS,
  CASCADE_ACTIONS,
  DATA_REQUEST_KINDS,
  DATA_REQUEST_STATUSES,
  DATA_REQUEST_VERIFICATIONS,
  ADVISOR_TASK_STATUSES,
  ALERT_KINDS,
  AGENT_OBJECTIVES,
  AGENT_RUN_OUTCOMES,
  AGENT_RUN_STATUSES,
  APPROVAL_STATUSES,
  AUDIT_ACTOR_TYPES,
  CALL_CONSENT_FACTS,
  CALL_DIRECTIONS,
  CALL_END_REASONS,
  CALL_INPUT_MODES,
  CALL_OUTCOMES,
  CALL_STATUSES,
  CALL_TURN_ROLES,
  CHANNEL_TYPES,
  CONSENT_PURPOSES,
  CONSENT_SOURCES,
  CONSENT_STATUSES,
  CONVERSATION_CATEGORIES,
  CONVERSATION_KINDS,
  CONVERSATION_STATES,
  CUSTOMER_DECISIONS,
  DECLINE_KINDS,
  DECLINE_REASONS,
  DELIVERY_BOOKING_STATUSES,
  DIGEST_KINDS,
  DOCUMENT_KINDS,
  ESCALATION_CHANNELS,
  ESCALATION_RUNG_TYPES,
  ESCALATION_STATUSES,
  ESTIMATE_LINE_KINDS,
  ESTIMATE_STATUSES,
  ETA_MATERIALITIES,
  ETA_REASONS,
  FEEDBACK_SENTIMENTS,
  FEEDBACK_STATUSES,
  GATE_PASS_STATUSES,
  GATE_PASS_VERIFY_RESULTS,
  INTAKE_DRAFT_STATUSES,
  INTAKE_SOURCES,
  INVOICE_STATUSES,
  JOB_CARD_SOURCES,
  JOB_CARD_STATES,
  LANGUAGES,
  LEDGER_STATUSES,
  LLM_TASK_CLASSES,
  MEDIA_KINDS,
  MEDIA_ORIGINS,
  MERGE_SUGGESTION_KINDS,
  MERGE_SUGGESTION_STATUSES,
  MESSAGE_DIRECTIONS,
  MESSAGE_KINDS,
  MESSAGE_STATUSES,
  OBJECTIVES,
  OUTBOX_STATUSES,
  PAYMENT_EVENT_KINDS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  REMINDER_KINDS,
  REPITCH_RESPONSES,
  RETENTION_TOUCH_STATUSES,
  RETENTION_TRIGGERS,
  REVIEW_ACTIONS,
  ROLLUP_SOURCES,
  STAFF_ROLES,
  STATUS_SIGNAL_ROUTES,
  STATUS_SIGNAL_SOURCES,
  STATUS_SIGNAL_TYPES,
  TASK_URGENCIES,
  TEMPLATE_APPROVAL_STATUSES,
  VOICE_INTENTS,
  WA_TEMPLATE_CATEGORIES,
  WA_TEMPLATE_STATUSES,
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

/* Phase 2 — channels & intake. */
export const conversationKindEnum = pgEnum('conversation_kind', CONVERSATION_KINDS);
export const messageKindEnum = pgEnum('message_kind', MESSAGE_KINDS);
export const conversationCategoryEnum = pgEnum('conversation_category', CONVERSATION_CATEGORIES);
export const waTemplateCategoryEnum = pgEnum('wa_template_category', WA_TEMPLATE_CATEGORIES);
export const waTemplateStatusEnum = pgEnum('wa_template_status', WA_TEMPLATE_STATUSES);
export const intakeSourceEnum = pgEnum('intake_source', INTAKE_SOURCES);
export const intakeDraftStatusEnum = pgEnum('intake_draft_status', INTAKE_DRAFT_STATUSES);
export const mergeSuggestionKindEnum = pgEnum('merge_suggestion_kind', MERGE_SUGGESTION_KINDS);
export const mergeSuggestionStatusEnum = pgEnum('merge_suggestion_status', MERGE_SUGGESTION_STATUSES);
export const mediaOriginEnum = pgEnum('media_origin', MEDIA_ORIGINS);
export const consentSourceEnum = pgEnum('consent_source', CONSENT_SOURCES);

/* Phase 4 — status sentinel, delivery & payments. */
export const statusSignalTypeEnum = pgEnum('status_signal_type', STATUS_SIGNAL_TYPES);
export const statusSignalSourceEnum = pgEnum('status_signal_source', STATUS_SIGNAL_SOURCES);
export const statusSignalRouteEnum = pgEnum('status_signal_route', STATUS_SIGNAL_ROUTES);
export const etaReasonEnum = pgEnum('eta_reason', ETA_REASONS);
export const etaMaterialityEnum = pgEnum('eta_materiality', ETA_MATERIALITIES);
export const paymentStatusEnum = pgEnum('payment_status', PAYMENT_STATUSES);
export const paymentEventKindEnum = pgEnum('payment_event_kind', PAYMENT_EVENT_KINDS);
export const paymentMethodEnum = pgEnum('payment_method', PAYMENT_METHODS);
export const invoiceStatusEnum = pgEnum('invoice_status', INVOICE_STATUSES);
export const deliveryBookingStatusEnum = pgEnum(
  'delivery_booking_status',
  DELIVERY_BOOKING_STATUSES,
);
export const gatePassStatusEnum = pgEnum('gate_pass_status', GATE_PASS_STATUSES);
export const gatePassVerifyResultEnum = pgEnum(
  'gate_pass_verify_result',
  GATE_PASS_VERIFY_RESULTS,
);

/* Phase 3 — agent runtime & approval autopilot. */
export const llmTaskClassEnum = pgEnum('llm_task_class', LLM_TASK_CLASSES);
export const agentObjectiveEnum = pgEnum('agent_objective', AGENT_OBJECTIVES);
export const agentRunStatusEnum = pgEnum('agent_run_status', AGENT_RUN_STATUSES);
export const agentRunOutcomeEnum = pgEnum('agent_run_outcome', AGENT_RUN_OUTCOMES);
export const customerDecisionEnum = pgEnum('customer_decision', CUSTOMER_DECISIONS);
export const escalationRungTypeEnum = pgEnum('escalation_rung_type', ESCALATION_RUNG_TYPES);
export const advisorTaskKindEnum = pgEnum('advisor_task_kind', ADVISOR_TASK_KINDS);
export const advisorTaskStatusEnum = pgEnum('advisor_task_status', ADVISOR_TASK_STATUSES);
export const taskUrgencyEnum = pgEnum('task_urgency', TASK_URGENCIES);
export const reviewActionEnum = pgEnum('review_action', REVIEW_ACTIONS);

/* Phase 5 — the voice layer. */
export const callDirectionEnum = pgEnum('call_direction', CALL_DIRECTIONS);
export const callStatusEnum = pgEnum('call_status', CALL_STATUSES);
export const callOutcomeEnum = pgEnum('call_outcome', CALL_OUTCOMES);
export const callEndReasonEnum = pgEnum('call_end_reason', CALL_END_REASONS);
export const callTurnRoleEnum = pgEnum('call_turn_role', CALL_TURN_ROLES);
export const callInputModeEnum = pgEnum('call_input_mode', CALL_INPUT_MODES);
export const callConsentFactEnum = pgEnum('call_consent_fact', CALL_CONSENT_FACTS);
export const voiceIntentEnum = pgEnum('voice_intent', VOICE_INTENTS);

/* Phase 6 — retention, feedback, digest & analytics. */
export const declineReasonEnum = pgEnum('decline_reason', DECLINE_REASONS);
export const retentionTriggerEnum = pgEnum('retention_trigger', RETENTION_TRIGGERS);
export const retentionTouchStatusEnum = pgEnum(
  'retention_touch_status',
  RETENTION_TOUCH_STATUSES,
);
export const repitchResponseEnum = pgEnum('repitch_response', REPITCH_RESPONSES);
export const feedbackSentimentEnum = pgEnum('feedback_sentiment', FEEDBACK_SENTIMENTS);
export const feedbackStatusEnum = pgEnum('feedback_status', FEEDBACK_STATUSES);
export const documentKindEnum = pgEnum('document_kind', DOCUMENT_KINDS);
export const reminderKindEnum = pgEnum('reminder_kind', REMINDER_KINDS);
export const digestKindEnum = pgEnum('digest_kind', DIGEST_KINDS);
export const alertKindEnum = pgEnum('alert_kind', ALERT_KINDS);
export const rollupSourceEnum = pgEnum('rollup_source', ROLLUP_SOURCES);

/* Phase 7 — DPDP data-principal workflows. */
export const dataRequestKindEnum = pgEnum('data_request_kind', DATA_REQUEST_KINDS);
export const dataRequestStatusEnum = pgEnum('data_request_status', DATA_REQUEST_STATUSES);
export const dataRequestVerificationEnum = pgEnum(
  'data_request_verification',
  DATA_REQUEST_VERIFICATIONS,
);
export const cascadeActionEnum = pgEnum('cascade_action', CASCADE_ACTIONS);
export const templateApprovalStatusEnum = pgEnum(
  'template_approval_status',
  TEMPLATE_APPROVAL_STATUSES,
);
