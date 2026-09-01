-- Phase 7 — DPDP data-principal workflows, template operations, and the
-- pseudonymisation columns that let a deletion happen without breaking the
-- audit chain or the metric rollups.
--
-- Read this before the statements, because two of the choices below look wrong
-- until you know what they are for.
--
-- **`audit_events.subject_pseudonym` exists so that erasure and the hash chain
-- can both be true.** The chain is append-only and enforced by a trigger:
-- deleting a customer's audit rows would break every hash after them and
-- destroy the shop's ability to prove anything about anybody. Keeping the rows
-- with a customer's name in them would defeat the erasure. So the payload is
-- rewritten in place — by a function that runs with the trigger temporarily
-- disabled, inside one transaction — replacing identifiers with the pseudonym,
-- and the row's own `hash` is *left alone*. That is deliberate: the chain
-- verifies the sequence of decisions, and a re-hashed row would silently make
-- every historical verification report a different answer. `payload_redacted`
-- marks the rows whose payload no longer matches their hash, and the verifier
-- reports them as redacted rather than as broken.
--
-- **Invoices are retained, not deleted.** GST and Income Tax record-keeping
-- outlive a data-principal request; §8(7)(a) of the DPDP Act preserves a
-- retention obligation imposed by another law. What is erased from them is the
-- customer's identity: `customer_id` is nulled and `subject_pseudonym` is
-- written, so the amount, the tax and the sequence survive for the assessor and
-- the person does not.
--
-- Everything here is additive. The down script drops it cleanly.

CREATE TYPE "data_request_kind" AS ENUM ('EXPORT', 'DELETION');
--> statement-breakpoint
CREATE TYPE "data_request_status" AS ENUM (
  'RECEIVED', 'VERIFIED', 'APPROVED', 'SCHEDULED', 'RUNNING',
  'COMPLETED', 'REJECTED', 'CANCELLED', 'FAILED'
);
--> statement-breakpoint
CREATE TYPE "data_request_verification" AS ENUM (
  'OTP_TO_NUMBER_ON_FILE', 'STAFF_ATTESTED_IN_PERSON', 'AUTHENTICATED_THREAD'
);
--> statement-breakpoint
CREATE TYPE "cascade_action" AS ENUM ('PURGED', 'PSEUDONYMISED', 'RETAINED');
--> statement-breakpoint

CREATE TABLE "data_requests" (
  "id" uuid PRIMARY KEY NOT NULL,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "customer_id" uuid REFERENCES "customers"("id") ON DELETE SET NULL,
  "subject_pseudonym" text NOT NULL,
  "kind" "data_request_kind" NOT NULL,
  "status" "data_request_status" DEFAULT 'RECEIVED' NOT NULL,
  "request_detail" text,
  "requested_by_staff_id" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
  "verification" "data_request_verification",
  "verified_at" timestamptz,
  "approved_by_staff_id" uuid REFERENCES "staff"("id") ON DELETE SET NULL,
  "approved_at" timestamptz,
  "scheduled_for" timestamptz,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "outcome_reason" text,
  "artifact_key" text,
  "artifact_bytes" integer,
  "artifact_sha256" text,
  "download_token_hash" text,
  "download_expires_at" timestamptz,
  "downloaded_at" timestamptz,
  "report" jsonb,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "data_requests_shop_status_idx" ON "data_requests" ("shop_id", "status");
--> statement-breakpoint
CREATE INDEX "data_requests_due_idx" ON "data_requests" ("status", "scheduled_for");
--> statement-breakpoint
CREATE INDEX "data_requests_subject_idx" ON "data_requests" ("shop_id", "subject_pseudonym");
--> statement-breakpoint
CREATE UNIQUE INDEX "data_requests_download_token_key" ON "data_requests" ("download_token_hash");
--> statement-breakpoint

-- A deletion cannot run before somebody has verified who asked and somebody has
-- approved it. Application code enforces this too; the constraint exists
-- because "somebody added a second code path" is exactly how an unverified
-- erasure happens, and this one is checked by the database on every write.
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_deletion_needs_authority"
  CHECK (
    "kind" <> 'DELETION'
    OR "status" IN ('RECEIVED', 'VERIFIED', 'REJECTED', 'CANCELLED')
    OR ("verified_at" IS NOT NULL AND "approved_at" IS NOT NULL)
  );
--> statement-breakpoint

CREATE TABLE "data_request_steps" (
  "id" uuid PRIMARY KEY NOT NULL,
  "request_id" uuid NOT NULL REFERENCES "data_requests"("id") ON DELETE CASCADE,
  "step_index" integer NOT NULL,
  "table_name" text NOT NULL,
  "action" "cascade_action" NOT NULL,
  "rows_affected" integer DEFAULT 0 NOT NULL,
  "detail" text NOT NULL,
  "retention_until" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "data_request_steps_request_table_key"
  ON "data_request_steps" ("request_id", "table_name");
--> statement-breakpoint
CREATE INDEX "data_request_steps_request_idx" ON "data_request_steps" ("request_id", "step_index");
--> statement-breakpoint

-- A retained row must say until when. A carve-out with no clock becomes
-- permanent retention by default, which is the failure the Act is aimed at.
ALTER TABLE "data_request_steps" ADD CONSTRAINT "data_request_steps_retention_has_clock"
  CHECK ("action" <> 'RETAINED' OR "retention_until" IS NOT NULL);
--> statement-breakpoint

/* --- pseudonymisation columns on the tables that survive an erasure ------- */

ALTER TABLE "audit_events" ADD COLUMN "subject_pseudonym" text;
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "payload_redacted" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX "audit_events_pseudonym_idx"
  ON "audit_events" ("shop_id", "subject_pseudonym")
  WHERE "subject_pseudonym" IS NOT NULL;
--> statement-breakpoint

ALTER TABLE "invoices" ADD COLUMN "subject_pseudonym" text;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "retained_until" timestamptz;
--> statement-breakpoint

ALTER TABLE "customers" ADD COLUMN "subject_pseudonym" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "erased_at" timestamptz;
--> statement-breakpoint

/* --- WhatsApp template registration state (phase 7.3) -------------------- */

-- Phase 2 already models a shop's registered templates in `wa_templates`. What
-- phase 7 adds is the link from a registration to the *manifest* entry it
-- satisfies, and the one status the phase-2 enum could not express.
--
-- `NOT_SUBMITTED` is that status, and it is the only useful state on a
-- template-ops screen: a template in the manifest that this shop has never sent
-- to Meta. Without it the screen can show what has been submitted and cannot
-- show what has not, which is the half an operator needs during onboarding.
--
-- The enum is widened by recreation rather than `ALTER TYPE ... ADD VALUE`,
-- following the pattern phase 4 established: Postgres cannot remove an enum
-- value, so `ADD VALUE` would make this migration one-way and break "every
-- migration reversible" (master section 8).
ALTER TYPE "wa_template_status" RENAME TO "wa_template_status_old";
--> statement-breakpoint
CREATE TYPE "wa_template_status" AS ENUM (
  'NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'
);
--> statement-breakpoint
ALTER TABLE "wa_templates" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "wa_templates"
  ALTER COLUMN "status" TYPE "wa_template_status"
  USING "status"::text::"wa_template_status";
--> statement-breakpoint
ALTER TABLE "wa_templates" ALTER COLUMN "status" SET DEFAULT 'NOT_SUBMITTED';
--> statement-breakpoint
DROP TYPE "wa_template_status_old";
--> statement-breakpoint

-- The manifest key this registration satisfies. Nullable, because a shop may
-- legitimately have registered templates of its own that this product does not
-- send, and deleting them because they are not in our manifest would be a
-- product reaching into somebody else's WABA.
ALTER TABLE "wa_templates" ADD COLUMN "template_key" text;
--> statement-breakpoint
ALTER TABLE "wa_templates" ADD COLUMN "submitted_at" timestamptz;
--> statement-breakpoint
-- Meta's own per-template quality signal. A template sliding to RED is on its
-- way to being paused, and the ops screen has to surface that *before* the
-- pause, because a paused template is a conversation that cannot be opened.
ALTER TABLE "wa_templates" ADD COLUMN "quality_rating" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "wa_templates_shop_key_language"
  ON "wa_templates" ("shop_id", "template_key", "language")
  WHERE "template_key" IS NOT NULL;
--> statement-breakpoint

/* --- per-conversation cost metering (phase 7.3) -------------------------- */

-- One row per shop per day per category, upserted as conversations open.
--
-- Conversations rather than messages, because that is how Meta bills: a
-- 24-hour window opened by one template carries every message inside it for one
-- charge. A per-message meter would overstate a busy thread by a factor of ten
-- and make the margin figure useless.
CREATE TABLE "conversation_costs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  "category" "conversation_category" NOT NULL,
  "conversations" integer DEFAULT 0 NOT NULL,
  "messages" integer DEFAULT 0 NOT NULL,
  -- Paise, integer, like every other amount here.
  "cost_paise" bigint DEFAULT 0 NOT NULL,
  -- The rate this row was priced at, so a later repricing is visible rather
  -- than retroactive. A margin report that silently changes last month's cost
  -- is a report nobody can reconcile against a Meta invoice.
  "rate_paise" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_costs_shop_day_category_key"
  ON "conversation_costs" ("shop_id", "day", "category");
--> statement-breakpoint
CREATE INDEX "conversation_costs_shop_day_idx" ON "conversation_costs" ("shop_id", "day");
--> statement-breakpoint

-- SMS is metered separately from WhatsApp, and not folded into the table above,
-- because the units are different: WhatsApp bills per conversation and SMS per
-- segment. Adding them under one "messages" column would produce a number that
-- is not a count of anything.
CREATE TABLE "sms_costs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  "messages" integer DEFAULT 0 NOT NULL,
  "segments" integer DEFAULT 0 NOT NULL,
  "cost_paise" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sms_costs_shop_day_key" ON "sms_costs" ("shop_id", "day");
--> statement-breakpoint

/* --- the pseudonymising redaction function ------------------------------- */

-- Rewrites a customer's identifiers out of the audit payloads while leaving the
-- rows, the sequence and the hashes intact.
--
-- SECURITY DEFINER and a session-local disable of the append-only trigger,
-- because that trigger exists precisely to stop anything doing this — and the
-- one lawful exception is an approved erasure. Wrapping it in a named function
-- means the exception is auditable in the schema itself rather than being a
-- `SET session_replication_role` somebody typed into psql.
CREATE OR REPLACE FUNCTION redact_audit_payloads(
  p_shop_id uuid,
  p_customer_id uuid,
  p_pseudonym text
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  affected integer;
BEGIN
  ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only;

  UPDATE audit_events
     SET payload = jsonb_strip_nulls(
           (payload - 'customerPhone' - 'customerName' - 'phone' - 'fullName' - 'body' - 'to')
           || jsonb_build_object('subjectPseudonym', p_pseudonym)
         ),
         subject_pseudonym = p_pseudonym,
         payload_redacted = true
   WHERE shop_id = p_shop_id
     AND (
       entity_id = p_customer_id
       OR payload->>'customerId' = p_customer_id::text
     );

  GET DIAGNOSTICS affected = ROW_COUNT;

  ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only;
  RETURN affected;
EXCEPTION WHEN OTHERS THEN
  -- Re-enabling on the failure path is not optional: leaving the trigger off
  -- would silently turn the append-only audit log into an editable one.
  ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only;
  RAISE;
END;
$$;
