CREATE TYPE "public"."delivery_booking_status" AS ENUM('OFFERED', 'CHOSEN', 'REMINDED', 'COMPLETED', 'MISSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."eta_materiality" AS ENUM('MATERIAL_SLIP', 'MATERIAL_GAIN', 'IMMATERIAL');--> statement-breakpoint
CREATE TYPE "public"."eta_reason" AS ENUM('INTAKE_PROMISE', 'WORK_APPROVED', 'WORK_DECLINED', 'BLOCKED_PARTS', 'PARTS_RECEIVED', 'TECHNICIAN_HINT', 'WORK_DONE', 'QUALITY_PASSED', 'ADVISOR_OVERRIDE');--> statement-breakpoint
CREATE TYPE "public"."gate_pass_status" AS ENUM('ISSUED', 'USED', 'EXPIRED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."gate_pass_verify_result" AS ENUM('VALID', 'EXPIRED', 'ALREADY_USED', 'REVOKED', 'FORGED', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('DRAFT', 'ISSUED', 'PAID', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."payment_event_kind" AS ENUM('LINK_CREATED', 'PAID', 'PARTIALLY_PAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'MANUAL_RECORD');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('UPI', 'CARD', 'NETBANKING', 'WALLET', 'CASH', 'BANK_TRANSFER', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('PENDING', 'PARTIALLY_PAID', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."status_signal_route" AS ENUM('AUTO_APPLIED', 'PENDING_CONFIRMATION', 'AMBIGUOUS', 'ROUTED_TO_EVIDENCE', 'NO_CARD_MATCH', 'CONFIRMED', 'CORRECTED', 'DISCARDED');--> statement-breakpoint
CREATE TYPE "public"."status_signal_source" AS ENUM('VOICE_NOTE', 'PHOTO', 'TEXT', 'CONSOLE');--> statement-breakpoint
CREATE TYPE "public"."status_signal_type" AS ENUM('progress', 'blocked_parts', 'done', 'issue_found');--> statement-breakpoint
-- `agent_objective` gains `answer_status` (phase 4.5) by **recreation**, not by
-- ALTER TYPE ... ADD VALUE.
--
-- Postgres cannot remove a value from an enum, so `ADD VALUE` — which is what
-- drizzle-kit generates — would make this migration one-way and break the
-- "every migration reversible" rule (master §8). Renaming the old type, creating
-- the wider one and re-typing the column costs three statements and leaves a
-- rollback that works. Phase 3 dodged the same problem by adding a column
-- (`escalations.rung_type`, deviation 30); here a fourth objective genuinely is
-- a fourth value of the same thing, so the type is what has to widen.
ALTER TYPE "public"."agent_objective" RENAME TO "agent_objective__v3";--> statement-breakpoint
CREATE TYPE "public"."agent_objective" AS ENUM('request_approval', 'resolve_partial_approval', 'explain_evidence', 'answer_status');--> statement-breakpoint
ALTER TABLE "agent_runs" ALTER COLUMN "objective" SET DATA TYPE "public"."agent_objective" USING "objective"::text::"public"."agent_objective";--> statement-breakpoint
DROP TYPE "public"."agent_objective__v3";--> statement-breakpoint
CREATE TABLE "delivery_bookings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"conversation_id" uuid,
	"status" "delivery_booking_status" DEFAULT 'OFFERED' NOT NULL,
	"offered_slots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"slot_start" timestamp with time zone,
	"slot_end" timestamp with time zone,
	"chosen_via" text,
	"chosen_at" timestamp with time zone,
	"offer_message_id" uuid,
	"reminder_scheduled_for" timestamp with time zone,
	"reminder_sent_at" timestamp with time zone,
	"amount_due_paise" bigint DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eta_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"previous_eta" timestamp with time zone,
	"eta" timestamp with time zone NOT NULL,
	"promised_at" timestamp with time zone,
	"reason" "eta_reason" NOT NULL,
	"materiality" "eta_materiality" NOT NULL,
	"delta_minutes" integer DEFAULT 0 NOT NULL,
	"detail" text NOT NULL,
	"status_signal_id" uuid,
	"notified_at" timestamp with time zone,
	"notified_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gate_passes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"customer_id" uuid,
	"code" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" "gate_pass_status" DEFAULT 'ISSUED' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"verified_by_staff_id" uuid,
	"override_reason" text,
	"override_by_staff_id" uuid,
	"verification_attempts" integer DEFAULT 0 NOT NULL,
	"last_verify_result" "gate_pass_verify_result",
	"message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"estimate_line_id" uuid,
	"work_item_id" uuid,
	"description" text NOT NULL,
	"hsn_sac" text,
	"quantity_milli" integer DEFAULT 1000 NOT NULL,
	"unit_price_paise" bigint NOT NULL,
	"line_total_paise" bigint NOT NULL,
	"tax_rate_bp" integer DEFAULT 1800 NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"is_additional_work" boolean DEFAULT false NOT NULL,
	"approved_at" timestamp with time zone,
	"evidence_media_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"estimate_id" uuid,
	"number" text NOT NULL,
	"status" "invoice_status" DEFAULT 'DRAFT' NOT NULL,
	"issued_at" timestamp with time zone,
	"currency" text DEFAULT 'INR' NOT NULL,
	"subtotal_paise" bigint DEFAULT 0 NOT NULL,
	"cgst_paise" bigint DEFAULT 0 NOT NULL,
	"sgst_paise" bigint DEFAULT 0 NOT NULL,
	"igst_paise" bigint DEFAULT 0 NOT NULL,
	"total_paise" bigint DEFAULT 0 NOT NULL,
	"amount_paid_paise" bigint DEFAULT 0 NOT NULL,
	"seller_name" text NOT NULL,
	"seller_gstin" text,
	"seller_address" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"seller_state_code" text,
	"place_of_supply_state_code" text,
	"intra_state" boolean DEFAULT true NOT NULL,
	"footer_note" text DEFAULT '' NOT NULL,
	"media_id" uuid,
	"evidence_media_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"render_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"kind" "payment_event_kind" NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider_payment_id" text,
	"method" "payment_method",
	"amount_paise" bigint DEFAULT 0 NOT NULL,
	"running_paid_paise" bigint DEFAULT 0 NOT NULL,
	"instrument" text,
	"failure_reason" text,
	"raw_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_by_staff_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"invoice_id" uuid,
	"customer_id" uuid,
	"provider" text NOT NULL,
	"provider_payment_link_id" text,
	"status" "payment_status" DEFAULT 'PENDING' NOT NULL,
	"amount_paise" bigint NOT NULL,
	"amount_paid_paise" bigint DEFAULT 0 NOT NULL,
	"accept_partial" boolean DEFAULT false NOT NULL,
	"short_url" text,
	"reference_id" text,
	"expires_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"last_reminder_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "silent_bay_nudges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_card_id" uuid NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"state" "job_card_state" NOT NULL,
	"quiet_for_minutes" integer NOT NULL,
	"consecutive_windows" integer DEFAULT 1 NOT NULL,
	"message_id" uuid,
	"escalated_to_owner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"shop_id" uuid NOT NULL,
	"job_card_id" uuid,
	"conversation_id" uuid,
	"message_id" uuid,
	"media_id" uuid,
	"sender_staff_id" uuid,
	"signal_type" "status_signal_type" NOT NULL,
	"source" "status_signal_source" NOT NULL,
	"route" "status_signal_route" NOT NULL,
	"confidence_bp" integer NOT NULL,
	"transcript" text NOT NULL,
	"language" "language" DEFAULT 'en' NOT NULL,
	"transcript_confidence_bp" integer,
	"work_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"eta_hint" timestamp with time zone,
	"candidate_job_card_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"match_basis" text,
	"resolved_by_staff_id" uuid,
	"resolved_at" timestamp with time zone,
	"applied_detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_cards" ADD COLUMN "current_eta" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_cards" ADD COLUMN "eta_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "job_cards" ADD COLUMN "eta_reason" "eta_reason";--> statement-breakpoint
ALTER TABLE "delivery_bookings" ADD CONSTRAINT "delivery_bookings_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_bookings" ADD CONSTRAINT "delivery_bookings_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_bookings" ADD CONSTRAINT "delivery_bookings_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_bookings" ADD CONSTRAINT "delivery_bookings_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eta_entries" ADD CONSTRAINT "eta_entries_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eta_entries" ADD CONSTRAINT "eta_entries_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eta_entries" ADD CONSTRAINT "eta_entries_status_signal_id_status_signals_id_fk" FOREIGN KEY ("status_signal_id") REFERENCES "public"."status_signals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_passes" ADD CONSTRAINT "gate_passes_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_passes" ADD CONSTRAINT "gate_passes_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_passes" ADD CONSTRAINT "gate_passes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_passes" ADD CONSTRAINT "gate_passes_verified_by_staff_id_staff_id_fk" FOREIGN KEY ("verified_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_passes" ADD CONSTRAINT "gate_passes_override_by_staff_id_staff_id_fk" FOREIGN KEY ("override_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_estimate_line_id_estimate_lines_id_fk" FOREIGN KEY ("estimate_line_id") REFERENCES "public"."estimate_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_work_item_id_work_items_id_fk" FOREIGN KEY ("work_item_id") REFERENCES "public"."work_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_recorded_by_staff_id_staff_id_fk" FOREIGN KEY ("recorded_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "silent_bay_nudges" ADD CONSTRAINT "silent_bay_nudges_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "silent_bay_nudges" ADD CONSTRAINT "silent_bay_nudges_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "silent_bay_nudges" ADD CONSTRAINT "silent_bay_nudges_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_signals" ADD CONSTRAINT "status_signals_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_signals" ADD CONSTRAINT "status_signals_job_card_id_job_cards_id_fk" FOREIGN KEY ("job_card_id") REFERENCES "public"."job_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_signals" ADD CONSTRAINT "status_signals_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_signals" ADD CONSTRAINT "status_signals_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_signals" ADD CONSTRAINT "status_signals_media_id_media_assets_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_signals" ADD CONSTRAINT "status_signals_sender_staff_id_staff_id_fk" FOREIGN KEY ("sender_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_signals" ADD CONSTRAINT "status_signals_resolved_by_staff_id_staff_id_fk" FOREIGN KEY ("resolved_by_staff_id") REFERENCES "public"."staff"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_bookings_job_card_idx" ON "delivery_bookings" USING btree ("job_card_id");--> statement-breakpoint
CREATE INDEX "delivery_bookings_shop_status_idx" ON "delivery_bookings" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "delivery_bookings_slot_idx" ON "delivery_bookings" USING btree ("shop_id","slot_start");--> statement-breakpoint
CREATE INDEX "delivery_bookings_reminder_idx" ON "delivery_bookings" USING btree ("status","reminder_scheduled_for");--> statement-breakpoint
CREATE UNIQUE INDEX "eta_entries_card_version_key" ON "eta_entries" USING btree ("job_card_id","version");--> statement-breakpoint
CREATE INDEX "eta_entries_shop_created_idx" ON "eta_entries" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "eta_entries_unnotified_idx" ON "eta_entries" USING btree ("shop_id","materiality","notified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gate_passes_shop_code_key" ON "gate_passes" USING btree ("shop_id","code");--> statement-breakpoint
CREATE INDEX "gate_passes_job_card_idx" ON "gate_passes" USING btree ("job_card_id");--> statement-breakpoint
CREATE INDEX "gate_passes_shop_status_idx" ON "gate_passes" USING btree ("shop_id","status");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("invoice_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_shop_number_key" ON "invoices" USING btree ("shop_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_job_card_key" ON "invoices" USING btree ("job_card_id");--> statement-breakpoint
CREATE INDEX "invoices_shop_status_idx" ON "invoices" USING btree ("shop_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_events_provider_key" ON "payment_events" USING btree ("shop_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "payment_events_payment_idx" ON "payment_events" USING btree ("payment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "payments_job_card_idx" ON "payments" USING btree ("job_card_id");--> statement-breakpoint
CREATE INDEX "payments_shop_status_idx" ON "payments" USING btree ("shop_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_link_key" ON "payments" USING btree ("shop_id","provider_payment_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "silent_bay_nudges_card_window_key" ON "silent_bay_nudges" USING btree ("job_card_id","window_start");--> statement-breakpoint
CREATE INDEX "silent_bay_nudges_shop_idx" ON "silent_bay_nudges" USING btree ("shop_id","window_start");--> statement-breakpoint
CREATE INDEX "status_signals_shop_created_idx" ON "status_signals" USING btree ("shop_id","created_at");--> statement-breakpoint
CREATE INDEX "status_signals_job_card_idx" ON "status_signals" USING btree ("job_card_id","created_at");--> statement-breakpoint
CREATE INDEX "status_signals_pending_idx" ON "status_signals" USING btree ("shop_id","route","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "status_signals_message_key" ON "status_signals" USING btree ("shop_id","message_id");--> statement-breakpoint
CREATE INDEX "job_cards_shop_state_changed_idx" ON "job_cards" USING btree ("shop_id","state","state_changed_at");--> statement-breakpoint

-- Invariants that belong in the database rather than only in the service that
-- happens to write the row today. Same reasoning as phase 3's six checks: a
-- money or tax rule enforced in one code path is a rule the second code path
-- will break.

ALTER TABLE "status_signals"
  ADD CONSTRAINT "status_signals_confidence_in_range"
  CHECK ("confidence_bp" BETWEEN 0 AND 10000);--> statement-breakpoint

-- A signal that was applied automatically must say which card it was applied
-- to. Auto-applying to nothing is the failure mode the confidence routing
-- exists to prevent, so it is unrepresentable.
ALTER TABLE "status_signals"
  ADD CONSTRAINT "status_signals_applied_has_card"
  CHECK ("route" <> 'AUTO_APPLIED' OR "job_card_id" IS NOT NULL);--> statement-breakpoint

ALTER TABLE "eta_entries"
  ADD CONSTRAINT "eta_entries_version_positive"
  CHECK ("version" > 0);--> statement-breakpoint

-- CGST/SGST and IGST are mutually exclusive under GST: intra-state supply
-- splits into the two halves, inter-state charges the integrated rate. A row
-- carrying both has double-counted the tax on a document a customer may hand
-- to their accountant.
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_tax_split_exclusive"
  CHECK (
    ("intra_state" AND "igst_paise" = 0)
    OR (NOT "intra_state" AND "cgst_paise" = 0 AND "sgst_paise" = 0)
  );--> statement-breakpoint

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_total_is_sum"
  CHECK ("total_paise" = "subtotal_paise" + "cgst_paise" + "sgst_paise" + "igst_paise");--> statement-breakpoint

ALTER TABLE "invoice_lines"
  ADD CONSTRAINT "invoice_lines_tax_split_exclusive"
  CHECK ("igst_paise" = 0 OR ("cgst_paise" = 0 AND "sgst_paise" = 0));--> statement-breakpoint

-- A payment marked PAID must have covered its amount. Getting here with less
-- means a reconcile wrote a status it had not earned.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_paid_covers_amount"
  CHECK ("status" <> 'PAID' OR "amount_paid_paise" >= "amount_paise");--> statement-breakpoint

-- Two rungs of balance chasing, then a person (phase 4.9). The ladder cap is a
-- guardrail about how a shop treats someone who already owes it money, so it
-- is enforced where a future reminder worker cannot talk its way past it.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_reminders_capped"
  CHECK ("reminders_sent" BETWEEN 0 AND 2);--> statement-breakpoint

ALTER TABLE "delivery_bookings"
  ADD CONSTRAINT "delivery_bookings_chosen_has_slot"
  CHECK (
    "status" NOT IN ('CHOSEN', 'REMINDED', 'COMPLETED')
    OR ("slot_start" IS NOT NULL AND "slot_end" IS NOT NULL)
  );--> statement-breakpoint

ALTER TABLE "gate_passes"
  ADD CONSTRAINT "gate_passes_expires_after_issue"
  CHECK ("expires_at" > "issued_at");--> statement-breakpoint

ALTER TABLE "gate_passes"
  ADD CONSTRAINT "gate_passes_used_has_time"
  CHECK ("status" <> 'USED' OR "used_at" IS NOT NULL);