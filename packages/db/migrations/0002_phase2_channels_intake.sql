CREATE TYPE "public"."consent_source" AS ENUM('INTERACTIVE_REPLY', 'KEYWORD', 'COUNTER_HANDOVER', 'CONSOLE', 'SEED');--> statement-breakpoint
CREATE TYPE "public"."conversation_category" AS ENUM('SERVICE', 'UTILITY', 'MARKETING', 'AUTHENTICATION');--> statement-breakpoint
CREATE TYPE "public"."conversation_kind" AS ENUM('CUSTOMER', 'STAFF_GROUP', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."intake_draft_status" AS ENUM('AWAITING_CONFIRMATION', 'CONFIRMED', 'DISCARDED', 'SUPERSEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."intake_source" AS ENUM('PHOTO', 'FORWARDED_TEXT', 'VOICE_NOTE', 'CONSOLE_FORM');--> statement-breakpoint
CREATE TYPE "public"."media_origin" AS ENUM('INBOUND_WHATSAPP', 'CONSOLE_UPLOAD', 'GENERATED', 'SEED');--> statement-breakpoint
CREATE TYPE "public"."merge_suggestion_kind" AS ENUM('CUSTOMER', 'VEHICLE');--> statement-breakpoint
CREATE TYPE "public"."merge_suggestion_status" AS ENUM('OPEN', 'MERGED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'STICKER', 'LOCATION', 'CONTACTS', 'BUTTON_REPLY', 'LIST_REPLY', 'REACTION', 'TEMPLATE', 'INTERACTIVE', 'SYSTEM', 'UNSUPPORTED');--> statement-breakpoint
CREATE TYPE "public"."wa_template_category" AS ENUM('UTILITY', 'MARKETING', 'AUTHENTICATION');--> statement-breakpoint
CREATE TYPE "public"."wa_template_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED');--> statement-breakpoint
CREATE TABLE "wa_templates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"name" text NOT NULL,
	"language" text NOT NULL,
	"category" "wa_template_category" NOT NULL,
	"status" "wa_template_status" DEFAULT 'PENDING' NOT NULL,
	"provider_template_id" text,
	"header_text" text,
	"body_text" text NOT NULL,
	"footer_text" text,
	"buttons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"variable_count" integer DEFAULT 0 NOT NULL,
	"rejection_reason" text,
	"approved_at" timestamp with time zone,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_card_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"source" "intake_source" NOT NULL,
	"status" "intake_draft_status" DEFAULT 'AWAITING_CONFIRMATION' NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"media_id" uuid,
	"submitted_by_staff_id" uuid,
	"raw_input" text,
	"draft" jsonb NOT NULL,
	"corrections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence_milli" integer DEFAULT 0 NOT NULL,
	"low_confidence_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extractor_model" text,
	"extractor_prompt_hash" text,
	"extraction_ms" integer,
	"resolved_customer_id" uuid,
	"resolved_vehicle_id" uuid,
	"job_card_id" uuid,
	"failure_reason" text,
	"confirmed_at" timestamp with time zone,
	"discarded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "merge_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"kind" "merge_suggestion_kind" NOT NULL,
	"status" "merge_suggestion_status" DEFAULT 'OPEN' NOT NULL,
	"primary_entity_id" uuid NOT NULL,
	"candidate_entity_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"score_milli" integer DEFAULT 0 NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"draft_id" uuid,
	"resolved_by_staff_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "conversations_shop_customer_channel_key";--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "customer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "source" "consent_source" DEFAULT 'INTERACTIVE_REPLY' NOT NULL;--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "captured_by_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "kind" "conversation_kind" DEFAULT 'CUSTOMER' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "external_address_encrypted" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "unread_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "human_override_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "kind" "message_kind" DEFAULT 'TEXT' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "template_language" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "template_variables" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "interactive" jsonb;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "conversation_category" "conversation_category";--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "provider_conversation_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_to_message_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "is_human_reply" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_staff_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "blocked_reason" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "blocked_code" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "origin" "media_origin" DEFAULT 'CONSOLE_UPLOAD' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "thumbnail_key" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "width_px" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "height_px" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "duration_ms" integer;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "derived_key" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "derived_content_type" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "provider_media_id" text;--> statement-breakpoint
ALTER TABLE "wa_templates" ADD CONSTRAINT "wa_templates_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_drafts" ADD CONSTRAINT "job_card_drafts_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_drafts" ADD CONSTRAINT "job_card_drafts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_drafts" ADD CONSTRAINT "job_card_drafts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_drafts" ADD CONSTRAINT "job_card_drafts_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_drafts" ADD CONSTRAINT "job_card_drafts_submitted_by_staff_id_staff_id_fk" FOREIGN KEY ("submitted_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_drafts" ADD CONSTRAINT "job_card_drafts_resolved_customer_id_customers_id_fk" FOREIGN KEY ("resolved_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_drafts" ADD CONSTRAINT "job_card_drafts_resolved_vehicle_id_vehicles_id_fk" FOREIGN KEY ("resolved_vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_card_drafts" ADD CONSTRAINT "job_card_drafts_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_suggestions" ADD CONSTRAINT "merge_suggestions_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_suggestions" ADD CONSTRAINT "merge_suggestions_draft_id_job_card_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."job_card_drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_suggestions" ADD CONSTRAINT "merge_suggestions_resolved_by_staff_id_staff_id_fk" FOREIGN KEY ("resolved_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wa_templates_shop_name_lang_key" ON "wa_templates" USING btree ("shop_id","name","language");--> statement-breakpoint
CREATE INDEX "wa_templates_shop_status_idx" ON "wa_templates" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "job_card_drafts_shop_status_idx" ON "job_card_drafts" USING btree ("shop_id","status","created_at");--> statement-breakpoint
CREATE INDEX "job_card_drafts_conversation_idx" ON "job_card_drafts" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_card_drafts_message_key" ON "job_card_drafts" USING btree ("shop_id","message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "merge_suggestions_pair_key" ON "merge_suggestions" USING btree ("shop_id","kind","primary_entity_id","candidate_entity_id");--> statement-breakpoint
CREATE INDEX "merge_suggestions_shop_status_idx" ON "merge_suggestions" USING btree ("shop_id","status","created_at");--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_captured_by_staff_id_staff_id_fk" FOREIGN KEY ("captured_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_staff_id_staff_id_fk" FOREIGN KEY ("sender_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_shop_channel_thread_key" ON "conversations" USING btree ("shop_id","channel","external_thread_id");--> statement-breakpoint
CREATE INDEX "conversations_shop_customer_idx" ON "conversations" USING btree ("shop_id","customer_id","channel");--> statement-breakpoint
CREATE INDEX "conversations_shop_kind_idx" ON "conversations" USING btree ("shop_id","kind","updated_at");--> statement-breakpoint
CREATE INDEX "messages_shop_customer_sent_idx" ON "messages" USING btree ("shop_id","direction","sent_at");--> statement-breakpoint
CREATE INDEX "messages_scheduled_idx" ON "messages" USING btree ("status","scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_provider_key" ON "media_assets" USING btree ("shop_id","provider_media_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Phase 2 invariants the database enforces itself, in the spirit of 0001:
-- rules the application must never be able to talk itself out of.
-- ---------------------------------------------------------------------------

-- A refused send must always say why. `message.blocked` is surfaced in the
-- console and audited; a BLOCKED row with no reason would be a silent drop.
ALTER TABLE "messages"
  ADD CONSTRAINT "messages_blocked_carries_reason"
  CHECK (status <> 'BLOCKED' OR (blocked_reason IS NOT NULL AND blocked_code IS NOT NULL));
--> statement-breakpoint

-- A thread classified as a customer thread must name its customer. UNKNOWN and
-- STAFF_GROUP threads legitimately have none.
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_customer_thread_has_customer"
  CHECK (kind <> 'CUSTOMER' OR customer_id IS NOT NULL);
--> statement-breakpoint

-- Confidence is a probability; the extractor cannot report 140%.
ALTER TABLE "job_card_drafts"
  ADD CONSTRAINT "job_card_drafts_confidence_range"
  CHECK (confidence_milli BETWEEN 0 AND 1000);
--> statement-breakpoint

-- A merge suggestion between a row and itself is meaningless.
ALTER TABLE "merge_suggestions"
  ADD CONSTRAINT "merge_suggestions_distinct_entities"
  CHECK (primary_entity_id <> candidate_entity_id);
--> statement-breakpoint

ALTER TABLE "wa_templates"
  ADD CONSTRAINT "wa_templates_variable_count_sane"
  CHECK (variable_count BETWEEN 0 AND 20);
