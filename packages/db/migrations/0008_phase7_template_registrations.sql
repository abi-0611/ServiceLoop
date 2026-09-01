-- Phase 7.3 — per-shop WhatsApp template registration state.
--
-- A separate migration from 0007 rather than an addition to it, because 0007
-- has already been applied wherever this branch has been run: drizzle records a
-- hash per migration, and editing an applied file makes the migrator try to run
-- it again. "The phase is not released yet" is not a reason to edit an applied
-- migration; only "nobody has run it" would be, and that is not knowable.
--
-- **Why this is a table and the manifest is code.** `TEMPLATE_MANIFEST` says a
-- template exists, what it renders from, and which variables it takes — the
-- same for every shop, linted in CI, changed only by a deploy. This table says
-- what Meta decided about that template for one shop's WABA: the id they
-- assigned, whether they approved it, and if not, why. None of that is knowable
-- at build time, none of it is the same across two shops, and all of it changes
-- without a deploy — an approved template can be paused on a quality signal
-- nobody controls.
--
-- **One row per (shop, template, language).** Meta approves per language
-- variant. A shop live in English and still waiting on Tamil is the single most
-- common state during onboarding, and a table keyed only by template would have
-- to report one of those as the truth.
--
-- **`template_key` has no foreign key**, deliberately. What it references is
-- code. A template retired from the manifest leaves its rows behind and the ops
-- screen reports them as orphaned — which is the warning that matters, because
-- Meta is still holding an approval for something this build will never send. A
-- cascade would destroy exactly that evidence.
--
-- Entirely additive. The down script drops it cleanly.

CREATE TYPE "template_approval_status" AS ENUM (
  'NOT_SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED'
);
--> statement-breakpoint

CREATE TABLE "template_registrations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "shop_id" uuid NOT NULL REFERENCES "shops"("id") ON DELETE CASCADE,
  "template_key" text NOT NULL,
  "language" "language" NOT NULL,
  "provider_template_id" text,
  "status" "template_approval_status" NOT NULL DEFAULT 'NOT_SUBMITTED',
  "rejection_reason" text,
  "submitted_at" timestamptz,
  "reviewed_at" timestamptz,
  -- The body as submitted. A template's content cannot be edited after
  -- approval, so once the catalogue moves on this is the only record of what a
  -- shop's approved template actually says.
  "submitted_body" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX "template_registrations_shop_key_language_key"
  ON "template_registrations" ("shop_id", "template_key", "language");
--> statement-breakpoint

-- The ops screen's own query: "what is outstanding for this shop".
CREATE INDEX "template_registrations_shop_status_idx"
  ON "template_registrations" ("shop_id", "status");
