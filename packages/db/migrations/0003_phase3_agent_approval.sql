CREATE TYPE "public"."llm_task_class" AS ENUM('AGENT', 'CLASSIFY', 'EXTRACT', 'JUDGE');--> statement-breakpoint
CREATE TYPE "public"."agent_objective" AS ENUM('request_approval', 'resolve_partial_approval', 'explain_evidence');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('RUNNING', 'FINISHED', 'ABORTED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."agent_run_outcome" AS ENUM('objective_met', 'handoff', 'blocked', 'budget_exhausted');--> statement-breakpoint
CREATE TYPE "public"."customer_decision" AS ENUM('FULL', 'PARTIAL', 'DEFERRED', 'DECLINED');--> statement-breakpoint
CREATE TYPE "public"."escalation_rung_type" AS ENUM('WHATSAPP', 'SMS', 'VOICE_OR_ADVISOR', 'OWNER_DIGEST', 'HUMAN');--> statement-breakpoint
CREATE TYPE "public"."advisor_task_kind" AS ENUM('CALL_CUSTOMER', 'REVIEW_MESSAGE', 'HANDOFF', 'OWNER_EXCEPTION', 'FOLLOW_UP');--> statement-breakpoint
CREATE TYPE "public"."advisor_task_status" AS ENUM('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."task_urgency" AS ENUM('LOW', 'NORMAL', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."review_action" AS ENUM('APPROVE_SEND', 'EDIT_AND_SEND', 'REJECT');--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid,
	"task_class" "llm_task_class" NOT NULL,
	"model" text NOT NULL,
	"driver" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"cost_usd_micros" bigint,
	"error_kind" text,
	"agent_run_id" uuid,
	"prompt_hash" text NOT NULL,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"objective" "agent_objective" NOT NULL,
	"status" "agent_run_status" DEFAULT 'RUNNING' NOT NULL,
	"outcome" "agent_run_outcome",
	"conversation_id" uuid NOT NULL,
	"job_card_id" uuid,
	"customer_id" uuid,
	"approval_request_id" uuid,
	"trigger_message_id" uuid,
	"step_count" integer DEFAULT 0 NOT NULL,
	"max_steps" integer NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"prompt_context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_index" integer NOT NULL,
	"prompt_hash" text NOT NULL,
	"model" text NOT NULL,
	"response_text" text,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tool_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checker_verdicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "advisor_tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" "advisor_task_kind" NOT NULL,
	"status" "advisor_task_status" DEFAULT 'OPEN' NOT NULL,
	"urgency" "task_urgency" DEFAULT 'NORMAL' NOT NULL,
	"brief" text NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"job_card_id" uuid,
	"conversation_id" uuid,
	"customer_id" uuid,
	"approval_request_id" uuid,
	"agent_run_id" uuid,
	"assigned_staff_id" uuid,
	"dedupe_key" text,
	"due_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by_staff_id" uuid,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"action" "review_action" NOT NULL,
	"reviewer_staff_id" uuid,
	"body_before" text NOT NULL,
	"body_after" text,
	"diff" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejection_reason" text,
	"checker_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"waited_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_trigger_message_id_messages_id_fk" FOREIGN KEY ("trigger_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_tasks" ADD CONSTRAINT "advisor_tasks_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_tasks" ADD CONSTRAINT "advisor_tasks_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_tasks" ADD CONSTRAINT "advisor_tasks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_tasks" ADD CONSTRAINT "advisor_tasks_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_tasks" ADD CONSTRAINT "advisor_tasks_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_tasks" ADD CONSTRAINT "advisor_tasks_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_tasks" ADD CONSTRAINT "advisor_tasks_assigned_staff_id_staff_id_fk" FOREIGN KEY ("assigned_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advisor_tasks" ADD CONSTRAINT "advisor_tasks_resolved_by_staff_id_staff_id_fk" FOREIGN KEY ("resolved_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reviews" ADD CONSTRAINT "message_reviews_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reviews" ADD CONSTRAINT "message_reviews_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reviews" ADD CONSTRAINT "message_reviews_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reviews" ADD CONSTRAINT "message_reviews_reviewer_staff_id_staff_id_fk" FOREIGN KEY ("reviewer_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reviews" ADD CONSTRAINT "message_reviews_agent_run_id_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_usage_shop_created_idx" ON "llm_usage" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "llm_usage_run_idx" ON "llm_usage" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "agent_runs_shop_status_idx" ON "agent_runs" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "agent_runs_conversation_idx" ON "agent_runs" USING btree ("conversation_id","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_approval_idx" ON "agent_runs" USING btree ("approval_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_trigger_message_key" ON "agent_runs" USING btree ("shop_id","trigger_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_steps_run_index_key" ON "agent_steps" USING btree ("run_id","step_index");--> statement-breakpoint
CREATE INDEX "advisor_tasks_shop_status_idx" ON "advisor_tasks" USING btree ("shop_id","status","urgency");--> statement-breakpoint
CREATE INDEX "advisor_tasks_job_card_idx" ON "advisor_tasks" USING btree ("job_card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "advisor_tasks_dedupe_key" ON "advisor_tasks" USING btree ("shop_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "message_reviews_shop_created_idx" ON "message_reviews" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "message_reviews_message_key" ON "message_reviews" USING btree ("message_id");--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "rung_type" "escalation_rung_type" DEFAULT 'WHATSAPP' NOT NULL;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "escalations" ADD COLUMN "result_detail" text;--> statement-breakpoint
CREATE INDEX "escalations_shop_subject_idx" ON "escalations" USING btree ("shop_id","subject_id","status");--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD COLUMN "estimate_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD COLUMN "claims" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD COLUMN "source_notes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD COLUMN "created_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD COLUMN "explanation_model" text;--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD COLUMN "explanation_prompt_hash" text;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "ladder_ref" text DEFAULT 'APPROVAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "work_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "decision" "customer_decision";--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "approved_work_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "approved_amount_paise" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "request_message_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "agent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_conversation_idx" ON "approval_requests" USING btree ("conversation_id","status");--> statement-breakpoint

-- Guardrail constraints (the phase-1 doctrine: invariants live in the database
-- too, not only in the service that happens to write the row today).

-- A blocked-to-HITL review must say why it was rejected. An advisor who rejects
-- a candidate without a reason leaves the graduation report unable to
-- distinguish "the agent was wrong" from "the advisor was busy".
ALTER TABLE "message_reviews" ADD CONSTRAINT "message_reviews_reject_has_reason"
  CHECK ("action" <> 'REJECT' OR ("rejection_reason" IS NOT NULL AND length(btrim("rejection_reason")) > 0));
--> statement-breakpoint

-- An edited send must carry the edited body, or the diff is a lie.
ALTER TABLE "message_reviews" ADD CONSTRAINT "message_reviews_edit_has_body"
  CHECK ("action" <> 'EDIT_AND_SEND' OR "body_after" IS NOT NULL);
--> statement-breakpoint

-- A finished run has an outcome; a running one does not.
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_finished_has_outcome"
  CHECK (("status" = 'FINISHED') = ("outcome" IS NOT NULL));
--> statement-breakpoint

-- The step cap is a guardrail, not a suggestion: the database refuses to record
-- a run that claims to have taken more steps than it was allowed.
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_step_count_within_cap"
  CHECK ("step_count" <= "max_steps");
--> statement-breakpoint

-- An approved amount can never exceed what was actually put to the customer.
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_approved_within_requested"
  CHECK ("approved_amount_paise" <= "amount_paise");
--> statement-breakpoint

-- A decided request records what was decided, and an undecided one does not
-- pretend to. This is the row a dispute is settled from.
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_decision_pairs_with_time"
  CHECK (("decision" IS NULL) = ("decided_at" IS NULL));
