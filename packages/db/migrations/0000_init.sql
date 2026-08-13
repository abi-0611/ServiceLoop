CREATE TYPE "public"."approval_status" AS ENUM('PENDING', 'APPROVED', 'PARTIAL', 'DECLINED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('STAFF', 'CUSTOMER', 'AGENT', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."channel_type" AS ENUM('WHATSAPP', 'SMS', 'VOICE', 'CONSOLE');--> statement-breakpoint
CREATE TYPE "public"."consent_purpose" AS ENUM('SERVICE', 'MARKETING');--> statement-breakpoint
CREATE TYPE "public"."consent_status" AS ENUM('PENDING', 'GRANTED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."conversation_state" AS ENUM('OPEN', 'SNOOZED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."decline_kind" AS ENUM('DECLINED', 'DEFERRED');--> statement-breakpoint
CREATE TYPE "public"."escalation_channel" AS ENUM('WHATSAPP', 'SMS', 'VOICE', 'HUMAN');--> statement-breakpoint
CREATE TYPE "public"."escalation_status" AS ENUM('SCHEDULED', 'EXECUTED', 'CANCELLED', 'SKIPPED');--> statement-breakpoint
CREATE TYPE "public"."estimate_line_kind" AS ENUM('LABOUR', 'PART', 'CONSUMABLE', 'FEE');--> statement-breakpoint
CREATE TYPE "public"."estimate_status" AS ENUM('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."job_card_source" AS ENUM('PAPER_CARD', 'WHATSAPP', 'WALK_IN', 'PHONE', 'CONSOLE');--> statement-breakpoint
CREATE TYPE "public"."job_card_state" AS ENUM('DRAFT', 'OPEN', 'IN_DIAGNOSIS', 'AWAITING_APPROVAL', 'IN_PROGRESS', 'AWAITING_PARTS', 'QUALITY_CHECK', 'READY_FOR_DELIVERY', 'AWAITING_PAYMENT', 'DELIVERED', 'CLOSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."language" AS ENUM('en', 'ta', 'hi');--> statement-breakpoint
CREATE TYPE "public"."ledger_status" AS ENUM('OPEN', 'RE_PITCHED', 'CONVERTED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('PHOTO', 'VIDEO', 'AUDIO', 'DOCUMENT');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('INBOUND', 'OUTBOUND');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('DRAFT', 'PENDING_APPROVAL', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."objective" AS ENUM('APPROVAL', 'STATUS', 'DELIVERY', 'PAYMENT', 'RETENTION', 'FEEDBACK');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'DISPATCHED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('OWNER', 'ADVISOR', 'TECHNICIAN');--> statement-breakpoint
CREATE TYPE "public"."work_item_state" AS ENUM('PROPOSED', 'PENDING_APPROVAL', 'APPROVED', 'DECLINED', 'DEFERRED', 'IN_PROGRESS', 'DONE');--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"purpose" "consent_purpose" NOT NULL,
	"status" "consent_status" DEFAULT 'PENDING' NOT NULL,
	"channel" "channel_type" NOT NULL,
	"evidence" text,
	"granted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"channel" "channel_type" NOT NULL,
	"external_thread_id" text,
	"state" "conversation_state" DEFAULT 'OPEN' NOT NULL,
	"language" "language" DEFAULT 'en' NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"window_expires_at" timestamp with time zone,
	"assigned_staff_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"job_card_id" uuid,
	"direction" "message_direction" NOT NULL,
	"status" "message_status" DEFAULT 'DRAFT' NOT NULL,
	"channel" "channel_type" NOT NULL,
	"language" "language" DEFAULT 'en' NOT NULL,
	"body" text NOT NULL,
	"template_name" text,
	"purpose" "consent_purpose" DEFAULT 'SERVICE' NOT NULL,
	"media_id" uuid,
	"provider_message_id" text,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_agent" boolean DEFAULT false NOT NULL,
	"agent_run_id" uuid,
	"approved_by_staff_id" uuid,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"full_name_encrypted" text NOT NULL,
	"phone_encrypted" text NOT NULL,
	"phone_hash" text NOT NULL,
	"preferred_language" "language" DEFAULT 'en' NOT NULL,
	"whatsapp_opt_in" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"city" text NOT NULL,
	"address_line" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"contact_phone" text,
	"gst_number" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "staff" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"role" "staff_role" NOT NULL,
	"full_name" text NOT NULL,
	"phone_encrypted" text NOT NULL,
	"phone_hash" text NOT NULL,
	"email" text,
	"preferred_language" "language" DEFAULT 'en' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"registration_raw" text NOT NULL,
	"registration_normalised" text NOT NULL,
	"make" text,
	"model" text,
	"variant" text,
	"model_year" integer,
	"fuel_type" text,
	"colour" text,
	"odometer_km" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"estimate_id" uuid,
	"evidence_bundle_id" uuid,
	"objective" text DEFAULT 'APPROVAL' NOT NULL,
	"status" "approval_status" DEFAULT 'PENDING' NOT NULL,
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decision_channel" text,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"work_item_id" uuid,
	"kind" "estimate_line_kind" NOT NULL,
	"description" text NOT NULL,
	"quantity_milli" integer DEFAULT 1000 NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"line_total_paise" bigint NOT NULL,
	"tax_rate_bp" integer DEFAULT 1800 NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "estimate_status" DEFAULT 'DRAFT' NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"subtotal_paise" bigint DEFAULT 0 NOT NULL,
	"tax_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence_bundles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary_text" text NOT NULL,
	"language" "language" DEFAULT 'en' NOT NULL,
	"media_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimate_line_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"work_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"vehicle_id" uuid NOT NULL,
	"code" text NOT NULL,
	"state" "job_card_state" DEFAULT 'DRAFT' NOT NULL,
	"state_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"source" "job_card_source" DEFAULT 'CONSOLE' NOT NULL,
	"complaint_text" text,
	"odometer_km" integer,
	"assigned_advisor_id" uuid,
	"assigned_technician_id" uuid,
	"opened_at" timestamp with time zone,
	"promised_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_card_id" uuid,
	"work_item_id" uuid,
	"kind" "media_kind" NOT NULL,
	"bucket" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"checksum_sha256" text NOT NULL,
	"caption" text,
	"captured_by_id" uuid,
	"captured_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"state" "work_item_state" DEFAULT 'PROPOSED' NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"technician_note" text,
	"estimated_minutes" integer,
	"sequence" integer DEFAULT 0 NOT NULL,
	"approved_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prev_hash" char(64) NOT NULL,
	"hash" char(64) NOT NULL,
	"trace_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "declined_work_ledger" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"work_item_id" uuid NOT NULL,
	"customer_id" uuid,
	"vehicle_id" uuid,
	"kind" "decline_kind" NOT NULL,
	"reason" text NOT NULL,
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"follow_up_after" timestamp with time zone,
	"trigger_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "ledger_status" DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"objective" "objective" NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"ladder_key" text NOT NULL,
	"rung" integer NOT NULL,
	"channel" "escalation_channel" NOT NULL,
	"status" "escalation_status" DEFAULT 'SCHEDULED' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"queue_job_id" text,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"trace_id" text NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"dispatched_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"consumer" text NOT NULL,
	"event_id" uuid NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" jsonb,
	CONSTRAINT "idempotency_keys_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE TABLE "shop_config" (
	"shop_id" uuid PRIMARY KEY NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"config" jsonb NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_staff_id_staff_id_fk" FOREIGN KEY ("assigned_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_approved_by_staff_id_staff_id_fk" FOREIGN KEY ("approved_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff" ADD CONSTRAINT "staff_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_evidence_bundle_id_evidence_bundles_id_fk" FOREIGN KEY ("evidence_bundle_id") REFERENCES "public"."evidence_bundles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_lines" ADD CONSTRAINT "estimate_lines_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_created_by_id_staff_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD CONSTRAINT "evidence_bundles_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_bundles" ADD CONSTRAINT "evidence_bundles_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_assigned_advisor_id_staff_id_fk" FOREIGN KEY ("assigned_advisor_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_cards" ADD CONSTRAINT "job_cards_assigned_technician_id_staff_id_fk" FOREIGN KEY ("assigned_technician_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_captured_by_id_staff_id_fk" FOREIGN KEY ("captured_by_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD CONSTRAINT "declined_work_ledger_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD CONSTRAINT "declined_work_ledger_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD CONSTRAINT "declined_work_ledger_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD CONSTRAINT "declined_work_ledger_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "declined_work_ledger" ADD CONSTRAINT "declined_work_ledger_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events_outbox" ADD CONSTRAINT "events_outbox_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_config" ADD CONSTRAINT "shop_config_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shop_config" ADD CONSTRAINT "shop_config_updated_by_id_staff_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consents_lookup_idx" ON "consents" USING btree ("shop_id","customer_id","purpose","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_shop_customer_channel_key" ON "conversations" USING btree ("shop_id","customer_id","channel");--> statement-breakpoint
CREATE INDEX "conversations_shop_state_idx" ON "conversations" USING btree ("shop_id","state");--> statement-breakpoint
CREATE INDEX "conversations_window_idx" ON "conversations" USING btree ("window_expires_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_shop_status_idx" ON "messages" USING btree ("shop_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_id_key" ON "messages" USING btree ("shop_id","provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_shop_phone_hash_key" ON "customers" USING btree ("shop_id","phone_hash");--> statement-breakpoint
CREATE INDEX "customers_shop_idx" ON "customers" USING btree ("shop_id");--> statement-breakpoint
CREATE INDEX "shops_active_idx" ON "shops" USING btree ("is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_shop_phone_hash_key" ON "staff" USING btree ("shop_id","phone_hash");--> statement-breakpoint
CREATE INDEX "staff_phone_hash_idx" ON "staff" USING btree ("phone_hash");--> statement-breakpoint
CREATE INDEX "staff_shop_role_idx" ON "staff" USING btree ("shop_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicles_shop_registration_key" ON "vehicles" USING btree ("shop_id","registration_normalised");--> statement-breakpoint
CREATE INDEX "vehicles_customer_idx" ON "vehicles" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "approval_requests_job_card_idx" ON "approval_requests" USING btree ("job_card_id");--> statement-breakpoint
CREATE INDEX "approval_requests_shop_status_idx" ON "approval_requests" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "estimate_lines_estimate_idx" ON "estimate_lines" USING btree ("estimate_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "estimates_job_card_version_key" ON "estimates" USING btree ("job_card_id","version");--> statement-breakpoint
CREATE INDEX "estimates_shop_status_idx" ON "estimates" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "evidence_bundles_job_card_idx" ON "evidence_bundles" USING btree ("job_card_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_cards_shop_code_key" ON "job_cards" USING btree ("shop_id","code");--> statement-breakpoint
CREATE INDEX "job_cards_shop_state_idx" ON "job_cards" USING btree ("shop_id","state");--> statement-breakpoint
CREATE INDEX "job_cards_shop_updated_idx" ON "job_cards" USING btree ("shop_id","updated_at");--> statement-breakpoint
CREATE INDEX "job_cards_customer_idx" ON "job_cards" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "job_cards_vehicle_idx" ON "job_cards" USING btree ("vehicle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_bucket_key_key" ON "media_assets" USING btree ("bucket","storage_key");--> statement-breakpoint
CREATE INDEX "media_assets_job_card_idx" ON "media_assets" USING btree ("job_card_id");--> statement-breakpoint
CREATE INDEX "work_items_job_card_idx" ON "work_items" USING btree ("job_card_id","sequence");--> statement-breakpoint
CREATE INDEX "work_items_shop_state_idx" ON "work_items" USING btree ("shop_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_shop_seq_key" ON "audit_events" USING btree ("shop_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_hash_key" ON "audit_events" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("shop_id","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "declined_work_ledger_work_item_key" ON "declined_work_ledger" USING btree ("work_item_id");--> statement-breakpoint
CREATE INDEX "declined_work_ledger_followup_idx" ON "declined_work_ledger" USING btree ("shop_id","status","follow_up_after");--> statement-breakpoint
CREATE UNIQUE INDEX "escalations_subject_rung_key" ON "escalations" USING btree ("subject_type","subject_id","rung");--> statement-breakpoint
CREATE INDEX "escalations_due_idx" ON "escalations" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "events_outbox_pending_idx" ON "events_outbox" USING btree ("status","occurred_at") WHERE status = 'PENDING';--> statement-breakpoint
CREATE INDEX "events_outbox_shop_idx" ON "events_outbox" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "idempotency_keys_seen_idx" ON "idempotency_keys" USING btree ("first_seen_at");