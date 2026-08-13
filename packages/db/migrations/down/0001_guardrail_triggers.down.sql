-- Reverses 0001_guardrail_triggers.sql
DROP INDEX IF EXISTS events_outbox_dispatch_idx;
--> statement-breakpoint
ALTER TABLE job_cards DROP CONSTRAINT IF EXISTS job_cards_version_positive;
--> statement-breakpoint
ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_version_positive;
--> statement-breakpoint
ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_totals_non_negative;
--> statement-breakpoint
ALTER TABLE estimate_lines DROP CONSTRAINT IF EXISTS estimate_lines_prices_non_negative;
--> statement-breakpoint
ALTER TABLE estimate_lines DROP CONSTRAINT IF EXISTS estimate_lines_quantity_positive;
--> statement-breakpoint
DROP TRIGGER IF EXISTS estimate_lines_immutable_when_accepted ON estimate_lines;
--> statement-breakpoint
DROP FUNCTION IF EXISTS estimate_lines_reject_frozen_mutation();
--> statement-breakpoint
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_seq_positive;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
--> statement-breakpoint
DROP FUNCTION IF EXISTS audit_events_reject_mutation();
