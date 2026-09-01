-- Reverse of 0008. Additive forward, so the reverse is a clean drop.
--
-- CONTRACT: this is a down script — dropping what 0008 created is its entire
-- purpose, and the objects named here exist nowhere else.

DROP INDEX IF EXISTS "template_registrations_shop_status_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "template_registrations_shop_key_language_key";
--> statement-breakpoint
DROP TABLE IF EXISTS "template_registrations";
--> statement-breakpoint
DROP TYPE IF EXISTS "template_approval_status";
