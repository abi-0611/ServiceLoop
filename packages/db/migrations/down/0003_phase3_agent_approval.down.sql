-- Reverse of 0003_phase3_agent_approval.
--
-- Dropped in dependency order: check constraints, then the new tables (whose
-- foreign keys go with them), then the added columns and their indexes, then
-- the types. Nothing here refuses to run: unlike phase 2's conversation
-- reshape, every phase-3 row lives in a table or column this script removes, so
-- a rollback loses phase-3 data and nothing else — which is what a rollback of
-- phase 3 means.

ALTER TABLE "approval_requests" DROP CONSTRAINT IF EXISTS "approval_requests_decision_pairs_with_time";
--> statement-breakpoint
ALTER TABLE "approval_requests" DROP CONSTRAINT IF EXISTS "approval_requests_approved_within_requested";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_step_count_within_cap";
--> statement-breakpoint
ALTER TABLE "agent_runs" DROP CONSTRAINT IF EXISTS "agent_runs_finished_has_outcome";
--> statement-breakpoint
ALTER TABLE "message_reviews" DROP CONSTRAINT IF EXISTS "message_reviews_edit_has_body";
--> statement-breakpoint
ALTER TABLE "message_reviews" DROP CONSTRAINT IF EXISTS "message_reviews_reject_has_reason";
--> statement-breakpoint

DROP TABLE IF EXISTS "message_reviews";
--> statement-breakpoint
DROP TABLE IF EXISTS "advisor_tasks";
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_steps";
--> statement-breakpoint
DROP TABLE IF EXISTS "agent_runs";
--> statement-breakpoint
DROP TABLE IF EXISTS "llm_usage";
--> statement-breakpoint

DROP INDEX IF EXISTS "approval_requests_conversation_idx";
--> statement-breakpoint
ALTER TABLE "approval_requests" DROP CONSTRAINT IF EXISTS "approval_requests_customer_id_customers_id_fk";
--> statement-breakpoint
ALTER TABLE "approval_requests"
  DROP COLUMN IF EXISTS "agent_run_id",
  DROP COLUMN IF EXISTS "request_message_id",
  DROP COLUMN IF EXISTS "approved_amount_paise",
  DROP COLUMN IF EXISTS "approved_work_item_ids",
  DROP COLUMN IF EXISTS "decision",
  DROP COLUMN IF EXISTS "work_item_ids",
  DROP COLUMN IF EXISTS "ladder_ref",
  DROP COLUMN IF EXISTS "conversation_id",
  DROP COLUMN IF EXISTS "customer_id";
--> statement-breakpoint

ALTER TABLE "evidence_bundles"
  DROP COLUMN IF EXISTS "explanation_prompt_hash",
  DROP COLUMN IF EXISTS "explanation_model",
  DROP COLUMN IF EXISTS "created_by_run_id",
  DROP COLUMN IF EXISTS "source_notes",
  DROP COLUMN IF EXISTS "claims",
  DROP COLUMN IF EXISTS "estimate_id";
--> statement-breakpoint

DROP INDEX IF EXISTS "escalations_shop_subject_idx";
--> statement-breakpoint
ALTER TABLE "escalations"
  DROP COLUMN IF EXISTS "result_detail",
  DROP COLUMN IF EXISTS "cancelled_at",
  DROP COLUMN IF EXISTS "label",
  DROP COLUMN IF EXISTS "rung_type";
--> statement-breakpoint

DROP TYPE IF EXISTS "public"."review_action";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."task_urgency";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."advisor_task_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."advisor_task_kind";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."escalation_rung_type";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."customer_decision";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."agent_run_outcome";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."agent_run_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."agent_objective";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."llm_task_class";
