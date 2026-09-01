import type { ErasureExecutor } from '@serviceloop/domain';
import type { CascadeAction } from '@serviceloop/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../client';
import { blindIndex, encryptPii } from '../crypto/pii';

/**
 * The SQL half of the deletion cascade (phase 7.2).
 *
 * The *plan* — which tables, what happens to each and why — is
 * `CASCADE_PLAN` in the domain, and is where a reviewer or a regulator should
 * look. This file is how each planned step is carried out, and nothing here
 * decides anything: an unrecognised table throws rather than silently doing
 * nothing, so a table added to the plan without a statement here fails loudly
 * on the first deletion rather than being quietly skipped in a report that
 * claims success.
 *
 * Raw SQL rather than the query builder, deliberately. Three reasons, in order
 * of how much they matter:
 *
 *  1. The statements are the auditable artefact. A regulator, or the shop's own
 *    accountant, can read `delete from messages where conversation_id in (...)`
 *    and see what happened. `tx.delete(messages).where(inArray(...))` requires
 *    them to trust a query builder they cannot see the output of.
 *  2. Several steps reach a table through two or three joins, and the builder
 *    expression for those is markedly less legible than the SQL.
 *  3. Every statement returns its row count, which is what the completion
 *    report is made of.
 *
 * Every parameter is bound. There is no string interpolation of a value
 * anywhere in this file, and the table names are not parameters at all — they
 * are literals inside a `switch`, reached only by a key from the declared plan.
 */
export class PgErasureExecutor implements ErasureExecutor<Tx> {
  async execute(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly customerId: string;
      readonly subjectPseudonym: string;
      readonly table: string;
      readonly action: CascadeAction;
      readonly retentionUntil: Date | null;
      readonly now: Date;
    },
  ): Promise<{ readonly rowsAffected: number; readonly detail: string }> {
    const { shopId: shop, customerId: customer, subjectPseudonym: pseudonym } = input;

    switch (input.table) {
      /* --- conversations and messages ------------------------------------ */

      case 'message_reviews':
        return this.run(
          tx,
          sql`delete from message_reviews where message_id in (
                select m.id from messages m
                join conversations c on c.id = m.conversation_id
                where c.shop_id = ${shop} and c.customer_id = ${customer})`,
          'review decisions on this customer’s messages',
        );

      case 'messages':
        return this.run(
          tx,
          sql`delete from messages where conversation_id in (
                select id from conversations
                where shop_id = ${shop} and customer_id = ${customer})`,
          'every message on this customer’s threads, in both directions',
        );

      case 'conversations':
        return this.run(
          tx,
          sql`delete from conversations where shop_id = ${shop} and customer_id = ${customer}`,
          'the threads themselves, including the WhatsApp address they were keyed on',
        );

      case 'consents':
        return this.run(
          tx,
          sql`delete from consents where shop_id = ${shop} and customer_id = ${customer}`,
          'every consent decision this customer made',
        );

      /* --- media --------------------------------------------------------- */

      case 'media_assets':
        // Rows only. The objects behind them are removed after the transaction
        // commits, by `MediaPurger` — a rollback cannot un-delete a GCS object,
        // so deleting bytes inside a transaction that might roll back would
        // leave rows pointing at nothing.
        return this.run(
          tx,
          // Media hangs off a job card. The media_assets table has no
          // conversation_id column — a photograph a customer sends on WhatsApp
          // is attached to the card it is about — and reaching for one threw
          // on the first real cascade.
          sql`delete from media_assets where shop_id = ${shop}
                and job_card_id in (
                  select id from job_cards where shop_id = ${shop} and customer_id = ${customer}
                )`,
          'photographs, voice notes and documents; the stored objects are removed immediately after this transaction commits',
        );

      /* --- voice ---------------------------------------------------------- */

      case 'call_turns':
        return this.run(
          tx,
          sql`delete from call_turns where call_id in (
                select id from calls where shop_id = ${shop} and customer_id = ${customer})`,
          'verbatim transcripts of what was said on the telephone',
        );

      case 'call_consent_events':
        return this.run(
          tx,
          sql`delete from call_consent_events where call_id in (
                select id from calls where shop_id = ${shop} and customer_id = ${customer})`,
          'recording-consent facts for those calls',
        );

      case 'call_usage':
        // Nothing to write. `call_usage` has no identifier of its own and its
        // call survives (see below), so the shop's telephony spend stays
        // reconcilable without any change here. Counted so the report can say
        // how many cost rows were kept.
        return this.count(
          tx,
          sql`select count(*)::int as count from call_usage cu
              join calls c on c.id = cu.call_id
              where c.shop_id = ${shop} and c.customer_id = ${customer}`,
          'per-call cost rows kept intact; they carry no identifier and are what the shop’s telephone spend is reconciled from',
        );

      case 'calls':
        /**
         * Pseudonymised rather than deleted, because `call_usage.call_id` is
         * NOT NULL and cascades: a DELETE here would silently take the shop's
         * telephone bill with it.
         *
         * Everything that identifies anybody is cleared in one statement — the
         * masked number, the whisper line an advisor was read, the recording
         * reference, the intent, and both links to the customer and their card.
         */
        return this.run(
          tx,
          sql`update calls set
                customer_id = null,
                job_card_id = null,
                conversation_id = null,
                to_masked = '[erased]',
                whisper_text = null,
                recording_media_id = null,
                intent = null
              where shop_id = ${shop} and customer_id = ${customer}`,
          'call records kept with the number, the whisper, the recording reference and every link erased; only the duration and the cost survive',
        );

      /* --- retention and feedback ---------------------------------------- */

      case 'retention_touches':
        return this.run(
          tx,
          sql`delete from retention_touches where shop_id = ${shop} and customer_id = ${customer}`,
          'the history of when the shop last wrote to this customer',
        );

      case 'retention_holds':
        return this.run(
          tx,
          sql`delete from retention_holds where shop_id = ${shop} and customer_id = ${customer}`,
          'marketing freezes held against this customer',
        );

      case 'feedback_requests':
        return this.run(
          tx,
          sql`delete from feedback_requests where shop_id = ${shop} and customer_id = ${customer}`,
          'ratings and the free-text comments the customer wrote',
        );

      case 'exception_alerts':
        // Polymorphic subject, not a customer column. Both shapes the alert
        // service writes are covered: a card-scoped alert and a feedback one.
        return this.run(
          tx,
          sql`delete from exception_alerts where shop_id = ${shop} and subject_id in (
                select id from job_cards where shop_id = ${shop} and customer_id = ${customer}
                union all
                select id from feedback_requests where shop_id = ${shop} and customer_id = ${customer}
                union all
                select ${customer}::uuid)`,
          'owner alerts, which quote the customer’s complaint verbatim',
        );

      case 'service_due_forecasts':
        return this.run(
          tx,
          sql`delete from service_due_forecasts where shop_id = ${shop} and vehicle_id in (
                select id from vehicles where shop_id = ${shop} and customer_id = ${customer})`,
          'predictions about when to contact this customer next',
        );

      case 'vehicle_documents':
        return this.run(
          tx,
          sql`delete from vehicle_documents where shop_id = ${shop} and vehicle_id in (
                select id from vehicles where shop_id = ${shop} and customer_id = ${customer})`,
          'insurance and PUC expiry dates the customer supplied',
        );

      case 'odometer_readings':
        return this.run(
          tx,
          sql`delete from odometer_readings where shop_id = ${shop} and vehicle_id in (
                select id from vehicles where shop_id = ${shop} and customer_id = ${customer})`,
          'mileage history',
        );

      case 'declined_work_ledger':
        return this.run(
          tx,
          sql`delete from declined_work_ledger where shop_id = ${shop} and customer_id = ${customer}`,
          'work this customer declined, with the technician’s note',
        );

      /* --- the job -------------------------------------------------------- */

      case 'delivery_bookings':
        return this.run(tx, this.byJobCard('delivery_bookings', shop, customer), 'pickup slots');

      case 'gate_passes':
        return this.run(tx, this.byJobCard('gate_passes', shop, customer), 'vehicle-release tokens');

      case 'status_signals':
        return this.run(
          tx,
          this.byJobCard('status_signals', shop, customer),
          'technician status utterances about this vehicle',
        );

      case 'eta_entries':
        return this.run(tx, this.byJobCard('eta_entries', shop, customer), 'the ETA history');

      case 'silent_bay_nudges':
        return this.run(
          tx,
          this.byJobCard('silent_bay_nudges', shop, customer),
          'internal nudges about a stalled bay',
        );

      case 'evidence_bundles':
        return this.run(
          tx,
          this.byJobCard('evidence_bundles', shop, customer),
          'the evidence put in front of this customer to justify a quote',
        );

      case 'approval_requests':
        return this.run(
          tx,
          this.byJobCard('approval_requests', shop, customer),
          'what the customer approved and what they refused',
        );

      case 'estimate_lines':
        return this.run(
          tx,
          sql`delete from estimate_lines where estimate_id in (
                select e.id from estimates e
                join job_cards jc on jc.id = e.job_card_id
                where jc.shop_id = ${shop} and jc.customer_id = ${customer})`,
          'quoted line items',
        );

      case 'estimates':
        return this.run(tx, this.byJobCard('estimates', shop, customer), 'quotes');

      case 'work_items':
        return this.run(
          tx,
          this.byJobCard('work_items', shop, customer),
          'the working record of what was done to the vehicle',
        );

      case 'agent_steps':
        return this.run(
          tx,
          sql`delete from agent_steps where run_id in (
                select id from agent_runs where shop_id = ${shop} and customer_id = ${customer})`,
          'model prompts and completions, which quote the customer’s messages verbatim',
        );

      case 'llm_usage':
        return this.run(
          tx,
          sql`update llm_usage set agent_run_id = null
              where agent_run_id in (
                select ar.id from agent_runs ar
                where ar.shop_id = ${shop} and ar.customer_id = ${customer})`,
          'model cost rows kept with the run link severed',
        );

      case 'agent_runs':
        return this.run(
          tx,
          sql`delete from agent_runs where shop_id = ${shop} and customer_id = ${customer}`,
          'agent runs taken on this customer’s behalf',
        );

      case 'advisor_tasks':
        return this.run(
          tx,
          sql`delete from advisor_tasks where shop_id = ${shop} and customer_id = ${customer}`,
          'queued tasks telling an advisor to contact this customer',
        );

      case 'escalations':
        return this.run(
          tx,
          sql`delete from escalations where shop_id = ${shop} and subject_id in (
                select id from job_cards where shop_id = ${shop} and customer_id = ${customer})`,
          'scheduled attempts to reach this customer',
        );

      case 'job_card_drafts':
        return this.run(
          tx,
          sql`delete from job_card_drafts where shop_id = ${shop} and (
                job_card_id in (select id from job_cards where shop_id = ${shop} and customer_id = ${customer})
                or conversation_id in (select id from conversations where shop_id = ${shop} and customer_id = ${customer}))`,
          'photographed paper cards and everything read off them',
        );

      case 'merge_suggestions':
        return this.run(
          tx,
          sql`delete from merge_suggestions where shop_id = ${shop}
              and (primary_entity_id = ${customer} or candidate_entity_id = ${customer})`,
          'suggested duplicates of this customer record',
        );

      /* --- money ---------------------------------------------------------- */

      case 'payment_events':
        return this.run(
          tx,
          // `raw_payload`, not `payload`: the column holds the gateway's body
          // verbatim, and the name says so. Stripping a column that does not
          // exist threw on the first real cascade — which would have left the
          // payer's name and contact in the gateway payload for ever.
          sql`update payment_events set raw_payload = raw_payload - 'payerName' - 'email' - 'contact' - 'vpa' - 'name'
              where payment_id in (
                select id from payments where shop_id = ${shop} and customer_id = ${customer})`,
          'provider callbacks kept with the payer name and contact stripped',
        );

      case 'payments':
        // RETAINED. Nothing is written: a payment row holds no identifier of its
        // own, and the invoice it hangs from carries the pseudonym. The step is
        // recorded so the completion report can say how many records were kept
        // and until when — which is the whole reason the carve-out is legible.
        return this.count(
          tx,
          sql`select count(*)::int as count from payments
              where shop_id = ${shop} and customer_id = ${customer}`,
          `receipts retained with their invoices until ${isoDay(input.retentionUntil)} under the GST record-keeping obligation`,
        );

      case 'invoice_lines':
        return this.count(
          tx,
          sql`select count(*)::int as count from invoice_lines il
              join invoices i on i.id = il.invoice_id
              where i.shop_id = ${shop} and i.customer_id = ${customer}`,
          `invoice lines retained until ${isoDay(input.retentionUntil)}; a tax invoice without its lines is not a tax invoice`,
        );

      case 'invoices':
        /**
         * The carve-out, executed.
         *
         * The invoice survives; the person does not. `customer_id` stays,
         * because it is NOT NULL and RESTRICT and because the row it points at
         * is itself reduced to a tombstone in the final step — following the
         * link finds `[erased]`.
         *
         * The two things that *are* cleared here are the ones easily missed:
         * `media_id` is the rendered PDF, which has the customer's name printed
         * on it, and `evidence_media_ids` are the photographs reproduced in its
         * appendix. Both are purged with the rest of the media; nulling the
         * references here stops the invoice pointing at objects that no longer
         * exist. A tax record is the ledger row, not a picture of it.
         */
        return this.run(
          tx,
          sql`update invoices set
                subject_pseudonym = ${pseudonym},
                retained_until = ${input.retentionUntil},
                media_id = null,
                evidence_media_ids = '[]'::jsonb
              where shop_id = ${shop} and customer_id = ${customer}`,
          `invoices retained until ${isoDay(input.retentionUntil)} under the GST record-keeping obligation, with the buyer identity erased`,
        );

      case 'job_cards':
        // `customer_id` and `vehicle_id` are NOT NULL and RESTRICT, so they
        // stay — pointing at rows that the last two steps reduce to tombstones.
        // What is cleared is the card's own copy of the customer's words.
        return this.run(
          tx,
          sql`update job_cards set
                complaint_text = null,
                odometer_km = null
              where shop_id = ${shop} and customer_id = ${customer}`,
          'job cards kept so the shop’s totals stay countable, with the complaint text and the odometer reading cleared; their customer and vehicle links now resolve to erased records',
        );

      /* --- the chain and the person --------------------------------------- */

      case 'audit_events':
        // Through the function defined in migration 0007, which is the only
        // sanctioned way past the append-only trigger. See the migration's
        // header for why the hashes are left alone.
        return this.count(
          tx,
          sql`select redact_audit_payloads(${shop}::uuid, ${customer}::uuid, ${pseudonym}) as count`,
          'audit rows kept in place with their payloads rewritten to the pseudonym; the hash chain is unbroken and the rewritten rows are flagged as redacted rather than tampered',
        );

      case 'events_outbox':
        return this.run(
          tx,
          sql`delete from events_outbox
              where shop_id = ${shop}
                and status <> 'PENDING'
                and payload->>'customerId' = ${customer}`,
          'dispatched event envelopes naming this customer; anything still pending is work in flight and is left alone',
        );

      case 'vehicles':
        /**
         * The registration is destroyed; the row is not, because
         * `job_cards.vehicle_id` is NOT NULL and RESTRICT.
         *
         * The replacement registration is derived per row from the vehicle's own
         * id, not from the pseudonym: a customer with two vehicles would
         * otherwise write the same value twice and collide on
         * `vehicles_shop_registration_key`. Getting that wrong fails the whole
         * transaction — which is at least loud — but only for customers with
         * more than one vehicle, which is exactly the case a hand-tested
         * deletion misses.
         */
        return this.run(
          tx,
          sql`update vehicles set
                registration_raw = 'ERASED',
                registration_normalised = 'ERASED-' || replace(id::text, '-', ''),
                make = null, model = null, variant = null, model_year = null,
                fuel_type = null, colour = null, odometer_km = null,
                deleted_at = ${input.now}
              where shop_id = ${shop} and customer_id = ${customer}`,
          'registration numbers destroyed and every descriptive field cleared; the rows survive only because a job card cannot exist without a vehicle',
        );

      case 'customers':
        /**
         * Last, and the only step that cannot be re-run to any effect.
         *
         * The encrypted columns are overwritten with a constant rather than
         * nulled, because they are `NOT NULL` and because a null would be
         * indistinguishable from a record that was never populated. The blind
         * index is replaced by the pseudonym: it must not stay, or the customer
         * remains findable by phone number for ever, and it must not be null,
         * because the unique index on (shop, phone_hash) would then collide on
         * the second erasure in a shop.
         */
        return this.run(
          tx,
          sql`update customers set
                full_name_encrypted = ${encryptPii('[erased]')},
                phone_encrypted = ${encryptPii('[erased]')},
                phone_hash = ${blindIndex(shop, `erased:${pseudonym}`)},
                notes = null,
                whatsapp_opt_in = false,
                subject_pseudonym = ${pseudonym},
                erased_at = ${input.now},
                deleted_at = ${input.now}
              where shop_id = ${shop} and id = ${customer}`,
          'the customer record itself: name and phone overwritten, the phone index destroyed so they can never be found by number again',
        );

      default:
        // Loud, never silent. A table in the plan with no statement here would
        // otherwise be reported as "0 rows affected" — a completion report
        // asserting that a table was handled when nothing touched it.
        throw new Error(
          `No erasure statement for table "${input.table}". Add one, or remove it from CASCADE_PLAN.`,
        );
    }
  }

  private byJobCard(table: string, shop: string, customer: string): SQL {
    // `sql.raw` on the table name only, and the name is a literal from the
    // switch above — never a value from a request.
    return sql`delete from ${sql.raw(table)} where job_card_id in (
                 select id from job_cards where shop_id = ${shop} and customer_id = ${customer})`;
  }

  private async run(
    tx: Tx,
    statement: SQL,
    detail: string,
  ): Promise<{ rowsAffected: number; detail: string }> {
    const result = await tx.execute(statement);
    return { rowsAffected: result.rowCount ?? 0, detail };
  }

  private async count(
    tx: Tx,
    statement: SQL,
    detail: string,
  ): Promise<{ rowsAffected: number; detail: string }> {
    const result = await tx.execute<{ count: number }>(statement);
    return { rowsAffected: Number(result.rows[0]?.count ?? 0), detail };
  }
}

function isoDay(date: Date | null): string {
  return date === null ? 'the end of the statutory period' : date.toISOString().slice(0, 10);
}
