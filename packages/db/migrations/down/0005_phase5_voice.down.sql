-- Reverse of 0005_phase5_voice.
--
-- Clean, and that is worth a sentence rather than a shrug. Phase 5 added only
-- new tables and new types: it altered nothing that phases 1–4 wrote, because
-- `escalations.rung_type` has carried `VOICE_OR_ADVISOR` since phase 3 and
-- teaching that rung to place a call needed no schema change. So unlike phases
-- 2 and 4, this rollback has no data it must refuse to destroy and no enum it
-- has to narrow — dropping the four tables takes their foreign keys, indexes,
-- constraints and the recording trigger with them.
--
-- What *is* destroyed is every call recording reference, transcript and usage
-- row. That is the correct behaviour for rolling back the phase that created
-- them, and it is the reason the recordings themselves live in object storage
-- behind `media_assets` rather than in a bytea column here: the rows go, the
-- media stays reachable, and phase 7's deletion cascade is what removes it
-- deliberately rather than as a side effect of a rollback.

DROP TRIGGER IF EXISTS "calls_recording_needs_notice" ON "calls";
--> statement-breakpoint
DROP FUNCTION IF EXISTS calls_reject_recording_without_notice();
--> statement-breakpoint

DROP TABLE IF EXISTS "call_usage";
--> statement-breakpoint
DROP TABLE IF EXISTS "call_consent_events";
--> statement-breakpoint
DROP TABLE IF EXISTS "call_turns";
--> statement-breakpoint
DROP TABLE IF EXISTS "calls";
--> statement-breakpoint

DROP TYPE IF EXISTS "public"."voice_intent";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."call_consent_fact";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."call_input_mode";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."call_turn_role";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."call_end_reason";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."call_outcome";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."call_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."call_direction";
