-- Reverse of 0004_phase4_status_delivery_payments.
--
-- Dropped in dependency order: check constraints, then the new tables (whose
-- foreign keys go with them), then the columns added to `job_cards`, then the
-- types.
--
-- One guard, and it is the same shape as phase 2's: `agent_objective` is
-- narrowed back to its three phase-3 values, which is impossible while a run
-- pursued `answer_status`. Rather than silently rewriting those rows to some
-- other objective — which would make the agent's own history lie about what it
-- was asked to do — this refuses and says which rows are in the way. Phase-4
-- *data* is expendable on a phase-4 rollback; phase-3 data is not, and an
-- `agent_runs` row is phase-3 data that phase 4 merely widened.

DO $$
DECLARE
  offending bigint;
BEGIN
  SELECT count(*) INTO offending FROM "agent_runs" WHERE "objective" = 'answer_status';
  IF offending > 0 THEN
    RAISE EXCEPTION
      'Refusing to roll back phase 4: % agent_runs row(s) pursued the answer_status objective, which has no representation in the phase-3 enum. Delete or re-label them first.',
      offending;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "gate_passes" DROP CONSTRAINT IF EXISTS "gate_passes_used_has_time";
--> statement-breakpoint
ALTER TABLE "gate_passes" DROP CONSTRAINT IF EXISTS "gate_passes_expires_after_issue";
--> statement-breakpoint
ALTER TABLE "delivery_bookings" DROP CONSTRAINT IF EXISTS "delivery_bookings_chosen_has_slot";
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_reminders_capped";
--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT IF EXISTS "payments_paid_covers_amount";
--> statement-breakpoint
ALTER TABLE "invoice_lines" DROP CONSTRAINT IF EXISTS "invoice_lines_tax_split_exclusive";
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_total_is_sum";
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_tax_split_exclusive";
--> statement-breakpoint
ALTER TABLE "eta_entries" DROP CONSTRAINT IF EXISTS "eta_entries_version_positive";
--> statement-breakpoint
ALTER TABLE "status_signals" DROP CONSTRAINT IF EXISTS "status_signals_applied_has_card";
--> statement-breakpoint
ALTER TABLE "status_signals" DROP CONSTRAINT IF EXISTS "status_signals_confidence_in_range";
--> statement-breakpoint

-- Tables, children first so no foreign key outlives its parent.
DROP TABLE IF EXISTS "gate_passes";
--> statement-breakpoint
DROP TABLE IF EXISTS "payment_events";
--> statement-breakpoint
DROP TABLE IF EXISTS "payments";
--> statement-breakpoint
DROP TABLE IF EXISTS "invoice_lines";
--> statement-breakpoint
DROP TABLE IF EXISTS "invoices";
--> statement-breakpoint
DROP TABLE IF EXISTS "delivery_bookings";
--> statement-breakpoint
DROP TABLE IF EXISTS "silent_bay_nudges";
--> statement-breakpoint
DROP TABLE IF EXISTS "eta_entries";
--> statement-breakpoint
DROP TABLE IF EXISTS "status_signals";
--> statement-breakpoint

DROP INDEX IF EXISTS "job_cards_shop_state_changed_idx";
--> statement-breakpoint
ALTER TABLE "job_cards"
  DROP COLUMN IF EXISTS "eta_reason",
  DROP COLUMN IF EXISTS "eta_version",
  DROP COLUMN IF EXISTS "current_eta";
--> statement-breakpoint

-- Narrow `agent_objective` back to its three phase-3 values. Safe because of
-- the guard at the top of this file.
ALTER TYPE "public"."agent_objective" RENAME TO "agent_objective__v4";
--> statement-breakpoint
CREATE TYPE "public"."agent_objective" AS ENUM('request_approval', 'resolve_partial_approval', 'explain_evidence');
--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "objective" SET DATA TYPE "public"."agent_objective" USING "objective"::text::"public"."agent_objective";
--> statement-breakpoint
DROP TYPE "public"."agent_objective__v4";
--> statement-breakpoint

DROP TYPE IF EXISTS "public"."status_signal_type";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."status_signal_source";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."status_signal_route";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."payment_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."payment_method";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."payment_event_kind";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."invoice_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."gate_pass_verify_result";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."gate_pass_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."eta_reason";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."eta_materiality";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."delivery_booking_status";
