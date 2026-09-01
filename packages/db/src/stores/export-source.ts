import type { ExportBundle, ExportMediaEntry, ExportSource } from '@serviceloop/domain';
import { NotFoundError } from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { decryptPii } from '../crypto/pii';
import type { StoragePort } from '@serviceloop/adapters';

/**
 * Collects a customer's data for a DPDP access request (phase 7.2).
 *
 * The shape is chosen for the person receiving it rather than for the schema
 * producing it: dates are ISO strings, amounts are rupees with two decimals
 * rather than paise, enum codes are spelled out, and internal ids appear only
 * where a customer might reasonably want to quote one back ("job card
 * JC-2026-0007"). A dump of `select *` per table would be a technically
 * complete export that nobody can read, which the Act's word "access" does not
 * mean.
 *
 * What it does *not* do is decide anything about deletion. This class reads.
 */
export class PgExportSource implements ExportSource<Tx> {
  constructor(
    private readonly storage: StoragePort,
    /** Seconds a per-file media link stays valid. Matched to the archive TTL. */
    private readonly mediaLinkTtlSeconds = 72 * 3600,
  ) {}

  async collect(tx: Tx, shopId: string, customerId: string, now: Date): Promise<ExportBundle> {
    const profile = await this.profile(tx, shopId, customerId);

    const [vehicles, jobCards, invoices, messages, calls, consents, mediaIndex] = await Promise.all([
      this.vehicles(tx, shopId, customerId),
      this.jobCards(tx, shopId, customerId),
      this.invoices(tx, shopId, customerId),
      this.messages(tx, shopId, customerId),
      this.calls(tx, shopId, customerId),
      this.consents(tx, shopId, customerId),
      this.mediaIndex(tx, shopId, customerId),
    ]);

    return {
      profile,
      vehicles,
      jobCards,
      invoices,
      messages,
      calls,
      consents,
      mediaIndex,
      generatedAt: now.toISOString(),
    };
  }

  private async profile(tx: Tx, shopId: string, customerId: string) {
    const result = await tx.execute<{
      id: string;
      full_name_encrypted: string;
      phone_encrypted: string;
      preferred_language: string;
      /**
       * A **string**, not a Date.
       *
       * `tx.execute` returns the driver's raw rows, and node-postgres hands
       * back `timestamptz` as whatever its type parser produces — which is not
       * the Date that drizzle's typed query builder would have given us. The
       * type parameter here is a claim about the row, not a coercion, so
       * declaring `Date` did not make it one: it made `.toISOString()` throw at
       * runtime, on the first line of every export, for every customer.
       */
      created_at: string;
      shop_name: string;
    }>(sql`
      select c.id, c.full_name_encrypted, c.phone_encrypted, c.preferred_language,
             c.created_at, s.name as shop_name
      from customers c join shops s on s.id = c.shop_id
      where c.shop_id = ${shopId} and c.id = ${customerId}
    `);

    const row = result.rows[0];
    if (row === undefined) throw new NotFoundError(`No customer ${customerId} in this shop`);

    return {
      customerId: row.id,
      // Decrypted here and nowhere else in this file. The export is the one
      // place the plaintext is legitimately assembled, because the recipient is
      // the person it belongs to.
      fullName: decryptPii(row.full_name_encrypted),
      phone: decryptPii(row.phone_encrypted),
      preferredLanguage: row.preferred_language,
      shopName: row.shop_name,
      customerSince: new Date(row.created_at).toISOString(),
    };
  }

  private async vehicles(tx: Tx, shopId: string, customerId: string) {
    const result = await tx.execute<Record<string, unknown>>(sql`
      select registration_raw as registration, make, model, variant, model_year as "modelYear",
             fuel_type as "fuelType", colour, odometer_km as "odometerKm",
             created_at as "firstSeen"
      from vehicles
      where shop_id = ${shopId} and customer_id = ${customerId}
      order by created_at
    `);
    return result.rows;
  }

  private async jobCards(tx: Tx, shopId: string, customerId: string) {
    const result = await tx.execute<Record<string, unknown>>(sql`
      select jc.code, jc.state, jc.complaint_text as complaint, jc.odometer_km as "odometerKm",
             v.registration_raw as vehicle,
             jc.opened_at as "openedAt", jc.promised_at as "promisedAt",
             jc.delivered_at as "deliveredAt",
             coalesce(
               -- The estimated price of a work item lives on the estimate line
               -- that quoted it, not on the item: an item can be re-quoted, and
               -- a price column on the item would have to be the *latest* quote
               -- with no record of the one the customer actually answered.
               -- The work_items table has no estimate_paise column at all, and
               -- reading one threw on the first real export.
               (select jsonb_agg(jsonb_build_object(
                  'title', wi.title,
                  'state', wi.state,
                  'estimatedRupees', round(
                    coalesce((select sum(el.line_total_paise) from estimate_lines el
                               where el.work_item_id = wi.id), 0) / 100.0, 2)
                ) order by wi.created_at)
                from work_items wi where wi.job_card_id = jc.id),
               '[]'::jsonb) as "work"
      from job_cards jc
      join vehicles v on v.id = jc.vehicle_id
      where jc.shop_id = ${shopId} and jc.customer_id = ${customerId}
      order by jc.created_at
    `);
    return result.rows;
  }

  private async invoices(tx: Tx, shopId: string, customerId: string) {
    const result = await tx.execute<Record<string, unknown>>(sql`
      select i.number, i.status, i.issued_at as "issuedAt",
             round(i.subtotal_paise / 100.0, 2) as "subtotalRupees",
             round((i.cgst_paise + i.sgst_paise + i.igst_paise) / 100.0, 2) as "taxRupees",
             round(i.total_paise / 100.0, 2) as "totalRupees",
             round(i.amount_paid_paise / 100.0, 2) as "paidRupees",
             coalesce(
               (select jsonb_agg(jsonb_build_object(
                  'description', il.description,
                  -- Stored in thousandths so a half-litre of oil is exact
                  -- arithmetic rather than a float. The customer's copy shows
                  -- the quantity they would recognise.
                  'quantity', round(il.quantity_milli / 1000.0, 3),
                  'amountRupees', round(il.line_total_paise / 100.0, 2)
                ) order by il.sequence)
                from invoice_lines il where il.invoice_id = i.id),
               '[]'::jsonb) as "lines"
      from invoices i
      where i.shop_id = ${shopId} and i.customer_id = ${customerId}
      order by i.created_at
    `);
    return result.rows;
  }

  private async messages(tx: Tx, shopId: string, customerId: string) {
    const result = await tx.execute<Record<string, unknown>>(sql`
      select m.created_at as "at", m.direction, m.channel, m.status, m.language,
             m.body, m.kind,
             -- The gate's own refusal code, included deliberately: a customer
             -- asking what we hold about them is owed the messages we chose
             -- *not* to send them and why, not only the ones we did.
             m.blocked_code as "notSentReason"
      from messages m
      join conversations c on c.id = m.conversation_id
      where c.shop_id = ${shopId} and c.customer_id = ${customerId}
      order by m.created_at
    `);
    return result.rows;
  }

  private async calls(tx: Tx, shopId: string, customerId: string) {
    const result = await tx.execute<Record<string, unknown>>(sql`
      select c.created_at as "at", c.direction, c.status, c.outcome, c.language,
             c.duration_seconds as "durationSeconds", c.handed_off as "handedOff",
             coalesce(
               (select jsonb_agg(jsonb_build_object(
                  'role', ct.role,
                  'text', ct.text
                ) order by ct.turn_index)
                from call_turns ct where ct.call_id = c.id),
               '[]'::jsonb) as "transcript"
      from calls c
      where c.shop_id = ${shopId} and c.customer_id = ${customerId}
      order by c.created_at
    `);
    return result.rows;
  }

  private async consents(tx: Tx, shopId: string, customerId: string) {
    const result = await tx.execute<Record<string, unknown>>(sql`
      select purpose, status, source, created_at as "at", evidence
      from consents
      where shop_id = ${shopId} and customer_id = ${customerId}
      order by created_at
    `);
    return result.rows;
  }

  /**
   * An index, not the bytes.
   *
   * A customer's photographs run to tens of megabytes and this archive is
   * delivered to a phone over WhatsApp. Each entry carries a signed link that
   * expires with the archive; the README says so in plain words, and says that
   * the shop will arrange the whole set on request. That is a real trade-off
   * being made explicitly rather than a limitation being hidden.
   */
  private async mediaIndex(
    tx: Tx,
    shopId: string,
    customerId: string,
  ): Promise<readonly ExportMediaEntry[]> {
    const result = await tx.execute<{
      id: string;
      kind: string;
      content_type: string;
      size_bytes: number;
      /** A string, for the reason spelled out on `profile`'s row type above. */
      created_at: string;
      storage_key: string;
      code: string | null;
    }>(sql`
      select ma.id, ma.kind, ma.content_type, ma.size_bytes, ma.created_at,
             ma.storage_key, jc.code
      from media_assets ma
      left join job_cards jc on jc.id = ma.job_card_id
      where ma.shop_id = ${shopId}
        and ma.deleted_at is null
        -- Media hangs off a job card, not off a conversation: the
        -- media_assets table has no conversation_id column, and a photograph a
        -- customer sent on WhatsApp is attached to the card it was sent about.
        -- Reaching for a conversation link here threw on the first real export.
        and ma.job_card_id in (
          select id from job_cards where shop_id = ${shopId} and customer_id = ${customerId}
        )
      order by ma.created_at
    `);

    return Promise.all(
      result.rows.map(async (row) => ({
        mediaId: row.id,
        kind: row.kind,
        contentType: row.content_type,
        sizeBytes: Number(row.size_bytes),
        capturedAt: new Date(row.created_at).toISOString(),
        jobCardCode: row.code,
        // A storage driver that cannot sign a URL reports null rather than
        // throwing: an export missing its media links is a degraded export, and
        // an export that failed entirely is no export.
        downloadUrl: await this.storage
          .presignGet(row.storage_key, this.mediaLinkTtlSeconds)
          .catch(() => null),
      })),
    );
  }
}
