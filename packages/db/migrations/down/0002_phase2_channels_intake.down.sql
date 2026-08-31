-- Reverse of 0002_phase2_channels_intake.
--
-- Dropped in dependency order: constraints, then indexes, then the new tables,
-- then the added columns, then the types. The pre-phase-2 unique index on
-- (shop_id, customer_id, channel) is restored, which means a rollback fails
-- loudly if a staff-group or unidentified thread exists — correct, because
-- those rows have no home in the phase 1 shape.

ALTER TABLE "wa_templates" DROP CONSTRAINT IF EXISTS "wa_templates_variable_count_sane";
--> statement-breakpoint
ALTER TABLE "merge_suggestions" DROP CONSTRAINT IF EXISTS "merge_suggestions_distinct_entities";
--> statement-breakpoint
ALTER TABLE "job_card_drafts" DROP CONSTRAINT IF EXISTS "job_card_drafts_confidence_range";
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_customer_thread_has_customer";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_blocked_carries_reason";
--> statement-breakpoint

DROP TABLE IF EXISTS "merge_suggestions";
--> statement-breakpoint
DROP TABLE IF EXISTS "job_card_drafts";
--> statement-breakpoint
DROP TABLE IF EXISTS "wa_templates";
--> statement-breakpoint

DROP INDEX IF EXISTS "media_assets_provider_key";
--> statement-breakpoint
DROP INDEX IF EXISTS "messages_scheduled_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "messages_shop_customer_sent_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "conversations_shop_kind_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "conversations_shop_customer_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "conversations_shop_channel_thread_key";
--> statement-breakpoint

ALTER TABLE "messages" DROP CONSTRAINT IF EXISTS "messages_sender_staff_id_staff_id_fk";
--> statement-breakpoint
ALTER TABLE "consents" DROP CONSTRAINT IF EXISTS "consents_captured_by_staff_id_staff_id_fk";
--> statement-breakpoint
ALTER TABLE "consents" DROP CONSTRAINT IF EXISTS "consents_message_id_messages_id_fk";
--> statement-breakpoint

ALTER TABLE "media_assets"
  DROP COLUMN IF EXISTS "provider_media_id",
  DROP COLUMN IF EXISTS "derived_content_type",
  DROP COLUMN IF EXISTS "derived_key",
  DROP COLUMN IF EXISTS "duration_ms",
  DROP COLUMN IF EXISTS "height_px",
  DROP COLUMN IF EXISTS "width_px",
  DROP COLUMN IF EXISTS "thumbnail_key",
  DROP COLUMN IF EXISTS "origin";
--> statement-breakpoint

ALTER TABLE "messages"
  DROP COLUMN IF EXISTS "error_code",
  DROP COLUMN IF EXISTS "blocked_code",
  DROP COLUMN IF EXISTS "blocked_reason",
  DROP COLUMN IF EXISTS "scheduled_for",
  DROP COLUMN IF EXISTS "sender_staff_id",
  DROP COLUMN IF EXISTS "is_human_reply",
  DROP COLUMN IF EXISTS "reply_to_message_id",
  DROP COLUMN IF EXISTS "provider_conversation_id",
  DROP COLUMN IF EXISTS "conversation_category",
  DROP COLUMN IF EXISTS "interactive",
  DROP COLUMN IF EXISTS "template_variables",
  DROP COLUMN IF EXISTS "template_language",
  DROP COLUMN IF EXISTS "kind";
--> statement-breakpoint

ALTER TABLE "conversations"
  DROP COLUMN IF EXISTS "human_override_at",
  DROP COLUMN IF EXISTS "unread_count",
  DROP COLUMN IF EXISTS "display_name",
  DROP COLUMN IF EXISTS "external_address_encrypted",
  DROP COLUMN IF EXISTS "kind";
--> statement-breakpoint

ALTER TABLE "consents"
  DROP COLUMN IF EXISTS "captured_by_staff_id",
  DROP COLUMN IF EXISTS "message_id",
  DROP COLUMN IF EXISTS "source";
--> statement-breakpoint

ALTER TABLE "conversations" ALTER COLUMN "customer_id" SET NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_shop_customer_channel_key"
  ON "conversations" USING btree ("shop_id","customer_id","channel");
--> statement-breakpoint

DROP TYPE IF EXISTS "public"."wa_template_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."wa_template_category";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."message_kind";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."merge_suggestion_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."merge_suggestion_kind";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."media_origin";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."intake_source";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."intake_draft_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."conversation_kind";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."conversation_category";
--> statement-breakpoint
DROP TYPE IF EXISTS "public"."consent_source";
