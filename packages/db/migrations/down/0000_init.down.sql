-- Reverses 0000_init.sql. Dropped in FK-dependency order.
DROP TABLE IF EXISTS idempotency_keys CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS events_outbox CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS audit_events CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS shop_config CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS escalations CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS declined_work_ledger CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS consents CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS messages CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS conversations CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS approval_requests CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS evidence_bundles CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS media_assets CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS estimate_lines CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS estimates CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS work_items CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS job_cards CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS vehicles CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS customers CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS staff CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS shops CASCADE;
--> statement-breakpoint
DROP TYPE IF EXISTS outbox_status;
--> statement-breakpoint
DROP TYPE IF EXISTS audit_actor_type;
--> statement-breakpoint
DROP TYPE IF EXISTS escalation_status;
--> statement-breakpoint
DROP TYPE IF EXISTS escalation_channel;
--> statement-breakpoint
DROP TYPE IF EXISTS objective;
--> statement-breakpoint
DROP TYPE IF EXISTS ledger_status;
--> statement-breakpoint
DROP TYPE IF EXISTS decline_kind;
--> statement-breakpoint
DROP TYPE IF EXISTS conversation_state;
--> statement-breakpoint
DROP TYPE IF EXISTS media_kind;
--> statement-breakpoint
DROP TYPE IF EXISTS consent_status;
--> statement-breakpoint
DROP TYPE IF EXISTS consent_purpose;
--> statement-breakpoint
DROP TYPE IF EXISTS message_status;
--> statement-breakpoint
DROP TYPE IF EXISTS message_direction;
--> statement-breakpoint
DROP TYPE IF EXISTS channel_type;
--> statement-breakpoint
DROP TYPE IF EXISTS approval_status;
--> statement-breakpoint
DROP TYPE IF EXISTS estimate_line_kind;
--> statement-breakpoint
DROP TYPE IF EXISTS estimate_status;
--> statement-breakpoint
DROP TYPE IF EXISTS work_item_state;
--> statement-breakpoint
DROP TYPE IF EXISTS job_card_source;
--> statement-breakpoint
DROP TYPE IF EXISTS job_card_state;
--> statement-breakpoint
DROP TYPE IF EXISTS language;
--> statement-breakpoint
DROP TYPE IF EXISTS staff_role;
