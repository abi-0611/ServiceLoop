-- Reverse of 0007.
--
-- Clean, because 0007 is additive: four new tables, six new columns, one enum
-- widened, one function. Nothing it added carries data that a phase-1..6 row
-- depends on.
--
-- What this script deliberately does *not* do is undo an erasure. Rolling the
-- migration back drops the record that a deletion happened; it does not — and
-- cannot — bring back the personal data that deletion destroyed. That is the
-- correct behaviour and it is worth stating plainly here, because the shape of
-- a down script invites the assumption that it is a general undo. If a release
-- containing 0007 is rolled back after a deletion has run, the shop has still
-- honoured that deletion and must say so in its own records: see
-- `docs/runbooks/rollback.md`.

DROP FUNCTION IF EXISTS redact_audit_payloads(uuid, uuid, text);
--> statement-breakpoint

DROP TABLE IF EXISTS "sms_costs";
--> statement-breakpoint
DROP TABLE IF EXISTS "conversation_costs";
--> statement-breakpoint
DROP TABLE IF EXISTS "data_request_steps";
--> statement-breakpoint
DROP TABLE IF EXISTS "data_requests";
--> statement-breakpoint

DROP INDEX IF EXISTS "wa_templates_shop_key_language";
--> statement-breakpoint
ALTER TABLE "wa_templates" DROP COLUMN IF EXISTS "quality_rating";
--> statement-breakpoint
ALTER TABLE "wa_templates" DROP COLUMN IF EXISTS "submitted_at";
--> statement-breakpoint
ALTER TABLE "wa_templates" DROP COLUMN IF EXISTS "template_key";
--> statement-breakpoint

-- Narrowing the enum back. Any row still sitting on the value that is going
-- away has to move first, and PENDING is the honest destination: a template
-- this build never submitted is, to a build that cannot express
-- NOT_SUBMITTED, indistinguishable from one awaiting review.
UPDATE "wa_templates" SET "status" = 'PENDING' WHERE "status" = 'NOT_SUBMITTED';
--> statement-breakpoint
ALTER TYPE "wa_template_status" RENAME TO "wa_template_status_new";
--> statement-breakpoint
CREATE TYPE "wa_template_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED');
--> statement-breakpoint
ALTER TABLE "wa_templates" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "wa_templates"
  ALTER COLUMN "status" TYPE "wa_template_status"
  USING "status"::text::"wa_template_status";
--> statement-breakpoint
ALTER TABLE "wa_templates" ALTER COLUMN "status" SET DEFAULT 'PENDING';
--> statement-breakpoint
DROP TYPE "wa_template_status_new";
--> statement-breakpoint

ALTER TABLE "customers" DROP COLUMN IF EXISTS "erased_at";
--> statement-breakpoint
ALTER TABLE "customers" DROP COLUMN IF EXISTS "subject_pseudonym";
--> statement-breakpoint
ALTER TABLE "invoices" DROP COLUMN IF EXISTS "retained_until";
--> statement-breakpoint
ALTER TABLE "invoices" DROP COLUMN IF EXISTS "subject_pseudonym";
--> statement-breakpoint
DROP INDEX IF EXISTS "audit_events_pseudonym_idx";
--> statement-breakpoint
ALTER TABLE "audit_events" DROP COLUMN IF EXISTS "payload_redacted";
--> statement-breakpoint
ALTER TABLE "audit_events" DROP COLUMN IF EXISTS "subject_pseudonym";
--> statement-breakpoint

DROP TYPE IF EXISTS "cascade_action";
--> statement-breakpoint
DROP TYPE IF EXISTS "data_request_verification";
--> statement-breakpoint
DROP TYPE IF EXISTS "data_request_status";
--> statement-breakpoint
DROP TYPE IF EXISTS "data_request_kind";
