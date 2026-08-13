-- Guardrails enforced by the database itself.
--
-- Everything here is a rule the application must never be able to talk itself
-- out of: the audit chain is append-only, and an accepted estimate's lines are
-- frozen. Phase 1.3 / 1.7.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- audit_events: append-only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_events_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'audit_events is append-only: % on event % (shop %) is not permitted',
    TG_OP,
    COALESCE(OLD.id::text, 'unknown'),
    COALESCE(OLD.shop_id::text, 'unknown')
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_reject_mutation();
--> statement-breakpoint

-- The per-shop sequence must be contiguous and start at 1; a gap would be
-- indistinguishable from a deletion during chain verification.
ALTER TABLE audit_events ADD CONSTRAINT audit_events_seq_positive CHECK (seq >= 1);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- estimate_lines: immutable once their estimate version is ACCEPTED.
-- An approved amount is a promise to the customer, so the row is frozen the
-- moment the estimate carrying it is accepted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION estimate_lines_reject_frozen_mutation() RETURNS trigger AS $$
DECLARE
  target_estimate uuid;
  estimate_state text;
BEGIN
  target_estimate := COALESCE(NEW.estimate_id, OLD.estimate_id);

  SELECT status::text INTO estimate_state FROM estimates WHERE id = target_estimate;

  IF estimate_state = 'ACCEPTED' THEN
    RAISE EXCEPTION
      'estimate % has been accepted: its lines are immutable (% rejected)',
      target_estimate, TG_OP
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER estimate_lines_immutable_when_accepted
  BEFORE INSERT OR UPDATE OR DELETE ON estimate_lines
  FOR EACH ROW EXECUTE FUNCTION estimate_lines_reject_frozen_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Money is never negative, and quantities are never zero-or-below.
-- ---------------------------------------------------------------------------
ALTER TABLE estimate_lines
  ADD CONSTRAINT estimate_lines_quantity_positive CHECK (quantity_milli > 0);
--> statement-breakpoint
ALTER TABLE estimate_lines
  ADD CONSTRAINT estimate_lines_prices_non_negative
  CHECK (unit_price_paise >= 0 AND line_total_paise >= 0);
--> statement-breakpoint
ALTER TABLE estimates
  ADD CONSTRAINT estimates_totals_non_negative
  CHECK (subtotal_paise >= 0 AND tax_paise >= 0 AND total_paise >= 0);
--> statement-breakpoint
ALTER TABLE estimates ADD CONSTRAINT estimates_version_positive CHECK (version >= 1);
--> statement-breakpoint
ALTER TABLE job_cards ADD CONSTRAINT job_cards_version_positive CHECK (version >= 1);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Outbox draining: partial index on the pending backlog keeps the dispatcher's
-- `FOR UPDATE SKIP LOCKED` scan bounded by the backlog, not by history.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS events_outbox_dispatch_idx
  ON events_outbox (occurred_at, id)
  WHERE status = 'PENDING';
