-- Phase 5 — the voice layer.
--
-- Four new tables and eight new types, all additive: nothing here alters a
-- phase-1..4 table, so the rollback is a clean drop and no earlier data is at
-- risk. That is a deliberate consequence of how the phase was shaped —
-- `escalations.rung_type` already carried `VOICE_OR_ADVISOR` (phase 3), so
-- teaching that rung to place a call needed no schema change at all.
--
-- The check constraints at the foot are the ones the guardrails depend on and
-- which application code alone could not guarantee across two processes:
--
--   * a BLOCKED call must say why it was blocked (a rung that decided not to
--     dial is a fact, and an unexplained one is useless);
--   * a recording may not be attached to a call whose consent events do not
--     contain a recording notice — enforced in the application at write time
--     and *here* as the backstop, because "no media persisted before the
--     notice" is a legal obligation rather than a preference;
--   * usage figures cannot be negative, which is how a cost cap gets talked
--     around by a bad subtraction.

CREATE TYPE "public"."call_consent_fact" AS ENUM('AI_DISCLOSURE_PLAYED', 'RECORDING_NOTICE_PLAYED', 'RECORDING_STARTED', 'RECORDING_STOPPED', 'CALLER_OBJECTED_TO_RECORDING');--> statement-breakpoint
CREATE TYPE "public"."call_direction" AS ENUM('OUTBOUND', 'INBOUND');--> statement-breakpoint
CREATE TYPE "public"."call_end_reason" AS ENUM('OBJECTIVE_MET', 'CALLER_HUNG_UP', 'HANDOFF_BRIDGED', 'GRACEFUL_EXIT', 'STEP_CAP', 'TIME_CAP', 'PIPELINE_FAILURE', 'KILL_SWITCH', 'PROVIDER_ERROR');--> statement-breakpoint
CREATE TYPE "public"."call_input_mode" AS ENUM('SPEECH', 'DTMF', 'NONE');--> statement-breakpoint
CREATE TYPE "public"."call_outcome" AS ENUM('DECISION_RECORDED', 'ANSWERED_FROM_STATE', 'BOOKING_DRAFTED', 'BRIDGED', 'ADVISOR_TASK_RAISED', 'NO_ANSWER', 'BUSY', 'CUSTOMER_HUNG_UP', 'PIPELINE_FAILURE', 'BUDGET_EXHAUSTED', 'NOT_PLACED');--> statement-breakpoint
CREATE TYPE "public"."call_status" AS ENUM('BLOCKED', 'ORIGINATING', 'RINGING', 'IN_PROGRESS', 'BRIDGING', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."call_turn_role" AS ENUM('AGENT', 'CALLER', 'SYSTEM', 'ADVISOR');--> statement-breakpoint
CREATE TYPE "public"."voice_intent" AS ENUM('STATUS', 'APPROVAL_RESPONSE', 'BOOKING', 'OTHER');--> statement-breakpoint
CREATE TABLE "call_consent_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"fact" "call_consent_fact" NOT NULL,
	"turn_index" integer,
	"detail" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_turns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"turn_index" integer NOT NULL,
	"role" "call_turn_role" NOT NULL,
	"input_mode" "call_input_mode" DEFAULT 'NONE' NOT NULL,
	"text" text NOT NULL,
	"dtmf_digit" text,
	"confidence_bp" integer,
	"language_tag" text,
	"mandatory_segment" boolean DEFAULT false NOT NULL,
	"script_key" text,
	"barged_in" boolean DEFAULT false NOT NULL,
	"played_ms" integer,
	"latency_ms" integer,
	"latency_stages" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checker_verdicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_run_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"telco_seconds" integer DEFAULT 0 NOT NULL,
	"stt_seconds" integer DEFAULT 0 NOT NULL,
	"tts_seconds" integer DEFAULT 0 NOT NULL,
	"llm_input_tokens" integer DEFAULT 0 NOT NULL,
	"llm_output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost_paise" bigint DEFAULT 0 NOT NULL,
	"cap_breached" text,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"direction" "call_direction" NOT NULL,
	"status" "call_status" DEFAULT 'ORIGINATING' NOT NULL,
	"driver" text NOT NULL,
	"provider_call_sid" text,
	"to_encrypted" text,
	"to_masked" text NOT NULL,
	"from_number" text NOT NULL,
	"job_card_id" uuid,
	"customer_id" uuid,
	"conversation_id" uuid,
	"approval_request_id" uuid,
	"escalation_id" uuid,
	"agent_run_id" uuid,
	"objective" text NOT NULL,
	"language" "language" DEFAULT 'en' NOT NULL,
	"intent" "voice_intent",
	"outcome" "call_outcome",
	"end_reason" "call_end_reason",
	"blocked_reason" text,
	"blocked_code" text,
	"ringing_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"handed_off" boolean DEFAULT false NOT NULL,
	"bridged_to_staff_id" uuid,
	"whisper_text" text,
	"advisor_task_id" uuid,
	"degraded_to_ivr" boolean DEFAULT false NOT NULL,
	"poor_turn_count" integer DEFAULT 0 NOT NULL,
	"barge_in_count" integer DEFAULT 0 NOT NULL,
	"max_turn_latency_ms" integer DEFAULT 0 NOT NULL,
	"recording_media_id" uuid,
	"retention_until" timestamp with time zone,
	"retry_of_call_id" uuid,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_consent_events" ADD CONSTRAINT "call_consent_events_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_consent_events" ADD CONSTRAINT "call_consent_events_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_turns" ADD CONSTRAINT "call_turns_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_turns" ADD CONSTRAINT "call_turns_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_usage" ADD CONSTRAINT "call_usage_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_usage" ADD CONSTRAINT "call_usage_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_bridged_to_staff_id_staff_id_fk" FOREIGN KEY ("bridged_to_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_recording_media_id_media_assets_id_fk" FOREIGN KEY ("recording_media_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "call_consent_events_call_fact_key" ON "call_consent_events" USING btree ("call_id","fact");--> statement-breakpoint
CREATE INDEX "call_consent_events_shop_idx" ON "call_consent_events" USING btree ("shop_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "call_turns_call_index_key" ON "call_turns" USING btree ("call_id","turn_index");--> statement-breakpoint
CREATE INDEX "call_turns_shop_created_idx" ON "call_turns" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "call_usage_call_key" ON "call_usage" USING btree ("call_id");--> statement-breakpoint
CREATE INDEX "call_usage_shop_created_idx" ON "call_usage" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "calls_shop_created_idx" ON "calls" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "calls_shop_status_idx" ON "calls" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "calls_job_card_idx" ON "calls" USING btree ("shop_id","job_card_id");--> statement-breakpoint
CREATE INDEX "calls_customer_idx" ON "calls" USING btree ("shop_id","customer_id","created_at");--> statement-breakpoint
CREATE INDEX "calls_approval_idx" ON "calls" USING btree ("approval_request_id");--> statement-breakpoint
CREATE INDEX "calls_retention_idx" ON "calls" USING btree ("retention_until");--> statement-breakpoint
CREATE UNIQUE INDEX "calls_provider_sid_key" ON "calls" USING btree ("shop_id","provider_call_sid");--> statement-breakpoint

-- A call that was never placed has to say why. `BLOCKED` is the honest record
-- of a rung that refused to dial — revoked consent, a cost cap, the kill
-- switch — and one without a reason is indistinguishable from a bug.
ALTER TABLE "calls" ADD CONSTRAINT "calls_blocked_has_reason"
  CHECK ("status" <> 'BLOCKED' OR "blocked_reason" IS NOT NULL);--> statement-breakpoint

-- An answered call has a time; an ended one has a duration that cannot precede
-- its start.
ALTER TABLE "calls" ADD CONSTRAINT "calls_ended_after_answered"
  CHECK ("ended_at" IS NULL OR "answered_at" IS NULL OR "ended_at" >= "answered_at");--> statement-breakpoint

ALTER TABLE "calls" ADD CONSTRAINT "calls_duration_non_negative"
  CHECK ("duration_seconds" >= 0 AND "turn_count" >= 0 AND "poor_turn_count" >= 0);--> statement-breakpoint

-- The phase-5.6 backstop.
--
-- A stored recording requires a recording-notice event on the same call. This
-- has to be a trigger rather than a CHECK: Postgres does not permit subqueries
-- in check constraints, and the fact being asserted lives in another table by
-- design (the consent record is an ordered sequence, because the question is
-- never "was the notice given" but "was it given *before* the recorder
-- started").
--
-- The application already refuses to start the recorder before the notice.
-- This is what makes the claim true of the *database* rather than of one code
-- path — the same reasoning that made the audit chain append-only in 0001.
CREATE OR REPLACE FUNCTION calls_reject_recording_without_notice() RETURNS trigger AS $$
DECLARE
  notice_at timestamptz;
BEGIN
  IF NEW.recording_media_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT occurred_at INTO notice_at
    FROM call_consent_events
   WHERE call_id = NEW.id AND fact = 'RECORDING_NOTICE_PLAYED'
   LIMIT 1;

  IF notice_at IS NULL THEN
    RAISE EXCEPTION
      'call % has a recording but no RECORDING_NOTICE_PLAYED consent event; recording may not be persisted before the notice',
      NEW.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER calls_recording_needs_notice
  BEFORE INSERT OR UPDATE OF recording_media_id ON calls
  FOR EACH ROW EXECUTE FUNCTION calls_reject_recording_without_notice();--> statement-breakpoint

ALTER TABLE "call_usage" ADD CONSTRAINT "call_usage_non_negative"
  CHECK (
    "telco_seconds" >= 0 AND "stt_seconds" >= 0 AND "tts_seconds" >= 0
    AND "llm_input_tokens" >= 0 AND "llm_output_tokens" >= 0
    AND "estimated_cost_paise" >= 0
  );--> statement-breakpoint

ALTER TABLE "call_turns" ADD CONSTRAINT "call_turns_dtmf_has_digit"
  CHECK ("input_mode" <> 'DTMF' OR "dtmf_digit" IS NOT NULL);
