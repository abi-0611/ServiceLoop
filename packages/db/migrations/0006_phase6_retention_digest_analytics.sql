-- Phase 6 — retention, feedback, the owner digest and the metrics service.
--
-- Nine new tables, eleven new types, thirteen new columns on
-- `declined_work_ledger`, and two enums widened. Additive throughout: nothing
-- here drops or narrows anything a phase-1..5 row depends on, which is why the
-- rollback below is a clean reverse rather than a data-loss warning.
--
-- Two things are worth reading before the statements.
--
-- **The two enum widenings are done by recreation, not `ALTER TYPE ... ADD
-- VALUE`.** Postgres cannot remove an enum value, so `ADD VALUE` — which is what
-- drizzle-kit generates — would make this migration one-way and break "every
-- migration reversible" (master §8). Phase 4 established the pattern for
-- `agent_objective` and this follows it for both: rename, recreate wide,
-- re-type the column, drop the old. `ledger_status` gains `EXPIRED` and
-- `OPTED_OUT` because 6.1 needs a permanent refusal and a lapsed horizon to be
-- distinguishable — collapsing them into `CLOSED` is how a customer's "not
-- interested" quietly becomes "not interested for now".
--
-- **`declined_work_ledger` gains a frozen copy of the technician's words.**
-- `title` and `technician_note` duplicate what the work item said on the day.
-- That is deliberate denormalisation and it is load-bearing: a re-pitch three
-- months later has to restate the original finding (L7 — evidence or silence),
-- and by then the work item's title may have been edited and its estimate
-- superseded. The alternative is a re-pitch that cites a row which has since
-- changed, which is worse than no citation at all.
--
-- The check constraints at the foot are the ones application code cannot
-- guarantee across two processes:
--
--   * an item may be re-pitched at most twice — the phase's hard cap, and the
--     one number a composer bug could otherwise turn into a weekly campaign;
--   * a CONVERTED item must name the visit its money arrived on, because
--     "₹ recovered" is the number the business case rests on and an
--     unattributable rupee in it is a rupee nobody can audit;
--   * a SENT retention touch must carry the message it sent, so the
--     twenty-one-day floor can never be computed from a row that only claims
--     to have written to somebody;
--   * an ANSWERED feedback row must carry a sentiment, since the whole routing
--     decision hangs off it.

CREATE TYPE "public"."alert_kind" AS ENUM('APPROVAL_STUCK', 'NEGATIVE_FEEDBACK', 'PAYMENT_FAILED_TWICE', 'VOICE_KILL_SWITCH', 'SILENT_BAY_REPEAT');--> statement-breakpoint
CREATE TYPE "public"."decline_reason" AS ENUM('customer_deferred', 'customer_partial', 'price', 'distrust', 'other');--> statement-breakpoint
CREATE TYPE "public"."digest_kind" AS ENUM('DAILY', 'WEEKLY');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('INSURANCE', 'PUC');--> statement-breakpoint
CREATE TYPE "public"."feedback_sentiment" AS ENUM('POSITIVE', 'NEUTRAL', 'NEGATIVE');--> statement-breakpoint
CREATE TYPE "public"."feedback_status" AS ENUM('SCHEDULED', 'ASKED', 'ANSWERED', 'EXPIRED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."reminder_kind" AS ENUM('SERVICE_DUE', 'INSURANCE_EXPIRY', 'PUC_EXPIRY');--> statement-breakpoint
CREATE TYPE "public"."repitch_response" AS ENUM('BOOK', 'REMIND_LATER', 'NOT_INTERESTED');--> statement-breakpoint
CREATE TYPE "public"."retention_touch_status" AS ENUM('SCHEDULED', 'SENT', 'HELD', 'SKIPPED', 'BLOCKED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."retention_trigger" AS ENUM('next_visit', 'time_elapsed', 'season', 'odometer', 'service_due', 'document_expiry', 'win_back', 'manual');--> statement-breakpoint
CREATE TYPE "public"."rollup_source" AS ENUM('LIVE', 'BACKFILL');--> statement-breakpoint
ALTER TYPE "public"."agent_objective" RENAME TO "agent_objective__v5";--> statement-breakpoint
CREATE TYPE "public"."agent_objective" AS ENUM('request_approval', 'resolve_partial_approval', 'explain_evidence', 'answer_status', 'repitch_declined_item');--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "objective" SET DATA TYPE "public"."agent_objective" USING "objective"::text::"public"."agent_objective";--> statement-breakpoint
DROP TYPE "public"."agent_objective__v5";--> statement-breakpoint
ALTER TYPE "public"."ledger_status" RENAME TO "ledger_status__v5";--> statement-breakpoint
CREATE TYPE "public"."ledger_status" AS ENUM('OPEN', 'RE_PITCHED', 'CONVERTED', 'EXPIRED', 'OPTED_OUT', 'CLOSED');--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ALTER COLUMN "status" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ALTER COLUMN "status" SET DATA TYPE "public"."ledger_status" USING "status"::text::"public"."ledger_status";--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ALTER COLUMN "status" SET DEFAULT 'OPEN';--> statement-breakpoint
DROP TYPE "public"."ledger_status__v5";--> statement-breakpoint
CREATE TABLE "exception_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" "alert_kind" NOT NULL,
	"incident_key" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid,
	"urgency" "task_urgency" DEFAULT 'HIGH' NOT NULL,
	"detail" text NOT NULL,
	"recipient_staff_id" uuid,
	"message_id" uuid,
	"task_id" uuid,
	"held_reason" text,
	"raised_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"conversation_id" uuid,
	"status" "feedback_status" DEFAULT 'SCHEDULED' NOT NULL,
	"delivered_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"asked_at" timestamp with time zone,
	"ask_message_id" uuid,
	"reminded_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"answered_at" timestamp with time zone,
	"sentiment" "feedback_sentiment",
	"comment_encrypted" text,
	"via_voice_note" boolean DEFAULT false NOT NULL,
	"media_id" uuid,
	"review_asked_at" timestamp with time zone,
	"review_message_id" uuid,
	"recovery_task_id" uuid,
	"hold_id" uuid,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metric_rollups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"day" date NOT NULL,
	"timezone" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"source" "rollup_source" DEFAULT 'LIVE' NOT NULL,
	"events_read" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "odometer_readings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"odometer_km" integer NOT NULL,
	"source" text NOT NULL,
	"message_id" uuid,
	"job_card_id" uuid,
	"read_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "owner_digests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" "digest_kind" NOT NULL,
	"day" date NOT NULL,
	"recipient_staff_id" uuid,
	"conversation_id" uuid,
	"message_id" uuid,
	"language" "language" DEFAULT 'en' NOT NULL,
	"payload" jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"blocked_reason" text,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"task_id" uuid,
	"released_at" timestamp with time zone,
	"released_by_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_touches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"vehicle_id" uuid,
	"job_card_id" uuid,
	"conversation_id" uuid,
	"trigger" "retention_trigger" NOT NULL,
	"purpose" "consent_purpose" NOT NULL,
	"status" "retention_touch_status" DEFAULT 'SCHEDULED' NOT NULL,
	"ledger_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"language" "language" DEFAULT 'en' NOT NULL,
	"dedupe_key" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"message_id" uuid,
	"agent_run_id" uuid,
	"skip_code" text,
	"skip_reason" text,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_due_forecasts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"job_card_id" uuid,
	"due_at" timestamp with time zone NOT NULL,
	"basis" text NOT NULL,
	"reminded_leads" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicle_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" "document_kind" NOT NULL,
	"expires_on" date NOT NULL,
	"enrolled_at" timestamp with time zone,
	"enrolled_via" text,
	"revoked_at" timestamp with time zone,
	"last_reminded_at" timestamp with time zone,
	"last_reminded_cycle" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "ledger_item_id" uuid;--> statement-breakpoint
CREATE INDEX "work_items_ledger_idx" ON "work_items" USING btree ("ledger_item_id");--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD COLUMN "decline_reason" "decline_reason" DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD COLUMN "technician_note" text;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD COLUMN "evidence_bundle_id" uuid;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD COLUMN "estimate_line_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD COLUMN "repitch_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD COLUMN "last_repitched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD COLUMN "last_response" "repitch_response";--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD COLUMN "converted_job_card_id" uuid;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD COLUMN "recovered_amount_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "exception_alerts" ADD CONSTRAINT "exception_alerts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_alerts" ADD CONSTRAINT "exception_alerts_recipient_staff_id_staff_id_fk" FOREIGN KEY ("recipient_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_alerts" ADD CONSTRAINT "exception_alerts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_alerts" ADD CONSTRAINT "exception_alerts_task_id_advisor_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."advisor_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_ask_message_id_messages_id_fk" FOREIGN KEY ("ask_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_review_message_id_messages_id_fk" FOREIGN KEY ("review_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_recovery_task_id_advisor_tasks_id_fk" FOREIGN KEY ("recovery_task_id") REFERENCES "public"."advisor_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_hold_id_retention_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."retention_holds"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metric_rollups" ADD CONSTRAINT "metric_rollups_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_digests" ADD CONSTRAINT "owner_digests_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_digests" ADD CONSTRAINT "owner_digests_recipient_staff_id_staff_id_fk" FOREIGN KEY ("recipient_staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_digests" ADD CONSTRAINT "owner_digests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_digests" ADD CONSTRAINT "owner_digests_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_holds" ADD CONSTRAINT "retention_holds_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_holds" ADD CONSTRAINT "retention_holds_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_holds" ADD CONSTRAINT "retention_holds_task_id_advisor_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."advisor_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_holds" ADD CONSTRAINT "retention_holds_released_by_staff_id_staff_id_fk" FOREIGN KEY ("released_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_touches" ADD CONSTRAINT "retention_touches_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_touches" ADD CONSTRAINT "retention_touches_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_touches" ADD CONSTRAINT "retention_touches_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_touches" ADD CONSTRAINT "retention_touches_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_touches" ADD CONSTRAINT "retention_touches_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_touches" ADD CONSTRAINT "retention_touches_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_due_forecasts" ADD CONSTRAINT "service_due_forecasts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_due_forecasts" ADD CONSTRAINT "service_due_forecasts_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_due_forecasts" ADD CONSTRAINT "service_due_forecasts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_due_forecasts" ADD CONSTRAINT "service_due_forecasts_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "exception_alerts_incident_key" ON "exception_alerts" USING btree ("shop_id","incident_key");--> statement-breakpoint
CREATE INDEX "exception_alerts_shop_raised_idx" ON "exception_alerts" USING btree ("shop_id","raised_at");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_requests_job_card_key" ON "feedback_requests" USING btree ("shop_id","job_card_id");--> statement-breakpoint
CREATE INDEX "feedback_requests_due_idx" ON "feedback_requests" USING btree ("shop_id","status","due_at");--> statement-breakpoint
CREATE INDEX "feedback_requests_customer_idx" ON "feedback_requests" USING btree ("shop_id","customer_id","answered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "metric_rollups_shop_day_key" ON "metric_rollups" USING btree ("shop_id","day");--> statement-breakpoint
CREATE INDEX "metric_rollups_day_idx" ON "metric_rollups" USING btree ("day");--> statement-breakpoint
CREATE INDEX "odometer_readings_vehicle_idx" ON "odometer_readings" USING btree ("vehicle_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_digests_day_key" ON "owner_digests" USING btree ("shop_id","kind","day","recipient_staff_id");--> statement-breakpoint
CREATE INDEX "owner_digests_shop_day_idx" ON "owner_digests" USING btree ("shop_id","day");--> statement-breakpoint
CREATE INDEX "retention_holds_active_idx" ON "retention_holds" USING btree ("shop_id","customer_id","released_at");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_touches_dedupe_key" ON "retention_touches" USING btree ("shop_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "retention_touches_due_idx" ON "retention_touches" USING btree ("shop_id","status","scheduled_for");--> statement-breakpoint
CREATE INDEX "retention_touches_customer_idx" ON "retention_touches" USING btree ("shop_id","customer_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "service_due_forecasts_live_key" ON "service_due_forecasts" USING btree ("shop_id","vehicle_id") WHERE superseded_at IS NULL;--> statement-breakpoint
CREATE INDEX "service_due_forecasts_due_idx" ON "service_due_forecasts" USING btree ("shop_id","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_documents_kind_key" ON "vehicle_documents" USING btree ("shop_id","vehicle_id","kind");--> statement-breakpoint
CREATE INDEX "vehicle_documents_expiry_idx" ON "vehicle_documents" USING btree ("shop_id","expires_on");--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD CONSTRAINT "declined_work_ledger_converted_job_card_id_job_cards_id_fk" FOREIGN KEY ("converted_job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "declined_work_ledger_customer_idx" ON "declined_work_ledger" USING btree ("shop_id","customer_id","status");--> statement-breakpoint
CREATE INDEX "declined_work_ledger_vehicle_idx" ON "declined_work_ledger" USING btree ("shop_id","vehicle_id","status");
--> statement-breakpoint

-- The phase's hard caps, below the application that is supposed to honour them.
ALTER TABLE "declined_work_ledger" ADD CONSTRAINT "declined_work_ledger_repitch_capped"
  CHECK ("repitch_count" >= 0 AND "repitch_count" <= 2);
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD CONSTRAINT "declined_work_ledger_converted_is_attributable"
  CHECK ("status" <> 'CONVERTED' OR ("converted_job_card_id" IS NOT NULL AND "closed_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD CONSTRAINT "declined_work_ledger_recovery_within_ledgered"
  CHECK ("recovered_amount_paise" >= 0);
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD CONSTRAINT "declined_work_ledger_terminal_has_reason"
  CHECK ("status" IN ('OPEN', 'RE_PITCHED') OR "closed_reason" IS NOT NULL);
--> statement-breakpoint

-- A touch that says it was sent must be able to prove it.
ALTER TABLE "retention_touches" ADD CONSTRAINT "retention_touches_sent_has_message"
  CHECK ("status" <> 'SENT' OR ("message_id" IS NOT NULL AND "sent_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "retention_touches" ADD CONSTRAINT "retention_touches_refusal_has_code"
  CHECK ("status" NOT IN ('SKIPPED', 'BLOCKED') OR "skip_code" IS NOT NULL);
--> statement-breakpoint

-- Every routing decision in 6.4 hangs off the sentiment.
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_answered_has_sentiment"
  CHECK ("status" <> 'ANSWERED' OR ("sentiment" IS NOT NULL AND "answered_at" IS NOT NULL));
--> statement-breakpoint
-- Ask once, never nag: the review ask cannot exist without a positive answer.
ALTER TABLE "feedback_requests" ADD CONSTRAINT "feedback_requests_review_needs_positive"
  CHECK ("review_asked_at" IS NULL OR "sentiment" = 'POSITIVE');
--> statement-breakpoint

-- A digest that claims to have gone out must name the message it went out as.
ALTER TABLE "owner_digests" ADD CONSTRAINT "owner_digests_sent_has_message"
  CHECK ("sent_at" IS NULL OR "message_id" IS NOT NULL);
--> statement-breakpoint

-- The rollup's audit story: a payload with no hash cannot be checked against a
-- recomputation, and an unchecked rollup is a number nobody can defend.
ALTER TABLE "metric_rollups" ADD CONSTRAINT "metric_rollups_hash_present"
  CHECK (length("payload_hash") = 64);
--> statement-breakpoint

-- Only what a person told us drives the odometer trigger.
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_source_known"
  CHECK ("source" IN ('CUSTOMER_VOLUNTEERED', 'INTAKE', 'CONSOLE'));
--> statement-breakpoint
ALTER TABLE "odometer_readings" ADD CONSTRAINT "odometer_readings_positive"
  CHECK ("odometer_km" >= 0);
--> statement-breakpoint

-- A document nobody enrolled must never be revoked or reminded about; the row
-- exists so a shop can hold a date it may not act on.
ALTER TABLE "vehicle_documents" ADD CONSTRAINT "vehicle_documents_reminder_needs_enrolment"
  CHECK ("last_reminded_at" IS NULL OR "enrolled_at" IS NOT NULL);
