-- Reverse of 0006_phase6_retention_digest_analytics.
--
-- Phase 6 added only new tables, new types, new columns and two widened enums;
-- it altered no phase-1..5 semantics. So this rollback drops what it created
-- and narrows what it widened, in dependency order: constraints, then the nine
-- new tables (whose foreign keys and indexes go with them), then the columns on
-- `declined_work_ledger`, then the types.
--
-- Two guards refuse rather than destroy, and both are the same shape as the one
-- phase 4 left behind. Narrowing an enum is impossible while a row holds the
-- value being removed, and the honest options are to refuse or to silently
-- relabel. Relabelling here would be the worse of the two by some distance:
--
--   * an `agent_runs` row that pursued `repitch_declined_item` is phase-3 data
--     that phase 6 merely widened, and rewriting its objective would make the
--     agent's own history lie about what it was asked to do;
--   * a ledger item marked `OPTED_OUT` is a customer who said "not interested".
--     There is no phase-5 value that means that. Mapping it to `CLOSED` would
--     turn a permanent refusal into an ordinary closure, and the next time the
--     retention engine ran it would pitch that item again — which is the single
--     worst thing this phase could do to somebody.
--
-- What *is* destroyed, correctly, is every phase-6 record: retention touches,
-- feedback and its comments, digests, alerts and the metric rollups. The
-- rollups are the only ones worth a sentence, and they are the least costly:
-- they are a derived value with exactly one correct answer, so a re-migration
-- plus `recompute --from` reproduces them from the event log, which is the
-- whole point of the fold being event-sourced.

DO $$
DECLARE
  offending bigint;
BEGIN
  SELECT count(*) INTO offending FROM "agent_runs" WHERE "objective" = 'repitch_declined_item';
  IF offending > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back phase 6: % agent_runs row(s) pursued the repitch_declined_item objective, which has no representation in the phase-5 enum. Delete or re-label them first.',
      offending;
  END IF;

  SELECT count(*) INTO offending
  FROM "declined_work_ledger"
  WHERE "status" IN ('EXPIRED', 'OPTED_OUT');
  IF offending > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back phase 6: % declined_work_ledger row(s) are EXPIRED or OPTED_OUT, and neither has a phase-5 representation. An OPTED_OUT item silently rewritten to CLOSED would be re-pitched to a customer who asked us not to. Resolve them first.',
      offending;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "vehicle_documents" DROP CONSTRAINT IF EXISTS "vehicle_documents_reminder_needs_enrolment";
--> statement-breakpoint
ALTER TABLE "odometer_readings" DROP CONSTRAINT IF EXISTS "odometer_readings_positive";
--> statement-breakpoint
ALTER TABLE "odometer_readings" DROP CONSTRAINT IF EXISTS "odometer_readings_source_known";
--> statement-breakpoint
ALTER TABLE "metric_rollups" DROP CONSTRAINT IF EXISTS "metric_rollups_hash_present";
--> statement-breakpoint
ALTER TABLE "owner_digests" DROP CONSTRAINT IF EXISTS "owner_digests_sent_has_message";
--> statement-breakpoint
ALTER TABLE "feedback_requests" DROP CONSTRAINT IF EXISTS "feedback_requests_review_needs_positive";
--> statement-breakpoint
ALTER TABLE "feedback_requests" DROP CONSTRAINT IF EXISTS "feedback_requests_answered_has_sentiment";
--> statement-breakpoint
ALTER TABLE "retention_touches" DROP CONSTRAINT IF EXISTS "retention_touches_refusal_has_code";
--> statement-breakpoint
ALTER TABLE "retention_touches" DROP CONSTRAINT IF EXISTS "retention_touches_sent_has_message";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP CONSTRAINT IF EXISTS "declined_work_ledger_terminal_has_reason";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP CONSTRAINT IF EXISTS "declined_work_ledger_recovery_within_ledgered";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP CONSTRAINT IF EXISTS "declined_work_ledger_converted_is_attributable";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP CONSTRAINT IF EXISTS "declined_work_ledger_repitch_capped";
--> statement-breakpoint

-- `feedback_requests` before `retention_holds`: the hold is what a negative
-- answer raised, and the feedback row points at it.
DROP TABLE IF EXISTS "feedback_requests";
--> statement-breakpoint
DROP TABLE IF EXISTS "retention_holds";
--> statement-breakpoint
DROP TABLE IF EXISTS "retention_touches";
--> statement-breakpoint
DROP TABLE IF EXISTS "service_due_forecasts";
--> statement-breakpoint
DROP TABLE IF EXISTS "vehicle_documents";
--> statement-breakpoint
DROP TABLE IF EXISTS "odometer_readings";
--> statement-breakpoint
DROP TABLE IF EXISTS "owner_digests";
--> statement-breakpoint
DROP TABLE IF EXISTS "exception_alerts";
--> statement-breakpoint
DROP TABLE IF EXISTS "metric_rollups";
--> statement-breakpoint

DROP INDEX IF EXISTS "work_items_ledger_idx";
--> statement-breakpoint
ALTER TABLE "work_items" DROP COLUMN IF EXISTS "ledger_item_id";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP CONSTRAINT IF EXISTS "declined_work_ledger_converted_job_card_id_job_cards_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "declined_work_ledger_vehicle_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "declined_work_ledger_customer_idx";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP COLUMN IF EXISTS "recovered_amount_paise";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP COLUMN IF EXISTS "converted_job_card_id";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP COLUMN IF EXISTS "closed_reason";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP COLUMN IF EXISTS "closed_at";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP COLUMN IF EXISTS "last_response";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP COLUMN IF EXISTS "last_repitched_at";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP COLUMN IF EXISTS "repitch_count";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP COLUMN IF EXISTS "estimate_line_ids";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP COLUMN IF EXISTS "evidence_bundle_id";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP COLUMN IF EXISTS "technician_note";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP COLUMN IF EXISTS "title";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP COLUMN IF EXISTS "category";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" DROP COLUMN IF EXISTS "decline_reason";
--> statement-breakpoint

-- The two widened enums, narrowed back by the same recreate-and-retype dance
-- the forward migration used. The guards above have already proved no row holds
-- a value that is about to stop existing.
ALTER TYPE "public"."ledger_status" RENAME TO "ledger_status__v6";
--> statement-breakpoint
CREATE TYPE "public"."ledger_status" AS ENUM('OPEN', 'RE_PITCHED', 'CONVERTED', 'CLOSED');
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ALTER COLUMN "status" SET DATA TYPE "public"."ledger_status" USING "status"::text::"public"."ledger_status";
--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ALTER COLUMN "status" SET DEFAULT 'OPEN';
--> statement-breakpoint
DROP TYPE "public"."ledger_status__v6";
--> statement-breakpoint

ALTER TYPE "public"."agent_objective" RENAME TO "agent_objective__v6";
--> statement-breakpoint
CREATE TYPE "public"."agent_objective" AS ENUM('request_approval', 'resolve_partial_approval', 'explain_evidence', 'answer_status');
--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "objective" SET DATA TYPE "public"."agent_objective" USING "objective"::text::"public"."agent_objective";
--> statement-breakpoint
DROP TYPE "public"."agent_objective__v6";
--> statement-breakpoint

DROP TYPE IF EXISTS "public"."rollup_source";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."alert_kind";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."digest_kind";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."reminder_kind";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."document_kind";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."feedback_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."feedback_sentiment";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."retention_touch_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."retention_trigger";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."repitch_response";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."decline_reason";
