import { Controller, Get, Inject, Post } from '@nestjs/common';
import type { RetentionRuntime } from '@serviceloop/agent-core';
import { decryptPii, type Database, type Tx } from '@serviceloop/db';
import {
  NotFoundError,
  type AlertList,
  type DeclineReason,
  type FeedbackDto,
  type FeedbackList,
  type FeedbackSentiment,
  type FeedbackStatus,
  type LedgerItemDto,
  type LedgerList,
  type LedgerStatus,
  type NextVisitPromptList,
  type RepitchResponse,
  type RetentionTouchDto,
  type RetentionTouchList,
  type RetentionTouchStatus,
  type RetentionTrigger,
  type ConsentPurpose,
  type AlertKind,
} from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { CurrentStaff, type AuthenticatedStaff } from '../auth/auth.types';
import { currentTraceId } from '../common/request-context';
import { ZodBody, ZodParam, ZodQuery } from '../common/zod';
import { DATABASE, RETENTION_RUNTIME } from '../infra/tokens';

/**
 * The retention surface the console reads and writes (phase 6.1–6.8).
 *
 * Everything an advisor or an owner can *see* about the loop after the vehicle
 * has left: the declined-work ledger, the touches that went out (and the ones
 * the gate withheld, which is the more interesting list), the feedback, and the
 * live exception alerts.
 *
 * There is deliberately no endpoint here that sends a message. A re-pitch is
 * sent by the trigger engine on the worker, after the OutboundGate has checked
 * consent, purpose, quiet hours and the twenty-one-day floor. A "send now"
 * button would be a way around all four, and the phase's own acceptance gate
 * says every retention touch passes them.
 *
 * The two writes that do exist are both facts a person collected at the
 * counter — a renewal date the customer read off their papers, and an odometer
 * reading they volunteered — and neither causes a message on its own.
 */

const LedgerQuery = z.object({
  status: z
    .enum(['OPEN', 'RE_PITCHED', 'CONVERTED', 'EXPIRED', 'OPTED_OUT', 'all'])
    .default('all'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const AlertQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** How far back to look. An alert stream older than a day is a report. */
  hours: z.coerce.number().int().min(1).max(720).default(48),
});

const DocumentBody = z.object({
  vehicleId: z.string().uuid(),
  kind: z.enum(['INSURANCE', 'PUC']),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const OdometerBody = z.object({
  vehicleId: z.string().uuid(),
  odometerKm: z.number().int().min(0).max(2_000_000),
});

@Controller('retention')
export class RetentionController {
  constructor(
    @Inject(RETENTION_RUNTIME) private readonly retention: RetentionRuntime<Tx>,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  /**
   * The declined-work ledger (6.1).
   *
   * Two totals travel with it because they are the two numbers a shop owner
   * actually asks about — what is still on the table, and what has come back —
   * and computing them in the browser from a paged list would give a different
   * answer on page two.
   */
  @Get('ledger')
  async ledger(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(LedgerQuery) query: z.infer<typeof LedgerQuery>,
  ): Promise<LedgerList> {
    const filter =
      query.status === 'all' ? sql`` : sql` and l.status = ${query.status}`;

    const rows = await this.db.execute<LedgerRow>(sql`
      select
        l.id, l.job_card_id, l.work_item_id, l.customer_id, l.vehicle_id,
        l.title, l.technician_note, l.decline_reason, l.reason, l.amount_paise,
        l.category, l.follow_up_after, l.trigger_tags, l.status, l.repitch_count,
        l.last_repitched_at, l.last_response, l.recovered_amount_paise, l.created_at,
        c.full_name_encrypted as customer_name_encrypted,
        nullif(trim(concat_ws(' ', v.make, v.model)), '') as vehicle_label,
        v.registration_normalised as registration
      from declined_work_ledger l
      left join customers c on c.id = l.customer_id
      left join vehicles v on v.id = l.vehicle_id
      where l.shop_id = ${staff.shopId}${filter}
      order by l.created_at desc
      limit ${query.limit}
    `);

    const totals = await this.db.execute<{ open_paise: string; recovered_paise: string }>(sql`
      select
        coalesce(sum(amount_paise) filter (where status in ('OPEN', 'RE_PITCHED')), 0) as open_paise,
        coalesce(sum(recovered_amount_paise), 0) as recovered_paise
      from declined_work_ledger
      where shop_id = ${staff.shopId}
    `);

    return {
      items: rows.rows.map(toLedgerDto),
      openValuePaise: Number(totals.rows[0]?.open_paise ?? 0),
      recoveredValuePaise: Number(totals.rows[0]?.recovered_paise ?? 0),
    };
  }

  /**
   * The "while it's here" prompts for a card that is open right now (6.2).
   *
   * Keyed by job card rather than by customer because that is what the drawer
   * has, and the card it was declined on is excluded — an advisor being told
   * about work the customer refused ten minutes ago, on this visit, would read
   * as the system not listening.
   */
  @Get('next-visit/:jobCardId')
  async nextVisit(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodParam('jobCardId', z.string().uuid()) jobCardId: string,
  ): Promise<NextVisitPromptList> {
    const card = await this.db.execute<{ customer_id: string }>(sql`
      select customer_id from job_cards where id = ${jobCardId} and shop_id = ${staff.shopId}
    `);
    const customerId = card.rows[0]?.customer_id;
    // 404 rather than an empty list for a card in another shop: the same
    // cross-tenant rule phase 1 set, for the same reason.
    if (customerId === undefined) throw new NotFoundError('Job card not found');

    const prompts = await this.retention.ledger.nextVisitPrompts({
      shopId: staff.shopId,
      customerId,
      excludeJobCardId: jobCardId,
    });

    return {
      prompts: prompts.map((prompt) => ({
        ledgerItemId: prompt.ledgerItemId,
        title: prompt.title,
        technicianNote: prompt.technicianNote,
        amountPaise: prompt.amountPaise,
        declinedAt: prompt.declinedAt.toISOString(),
        declineReason: prompt.declineReason,
        repitchCount: prompt.repitchCount,
      })),
    };
  }

  /**
   * Retention touches, sent and withheld (6.1–6.3, 6.5, 6.10).
   *
   * The withheld ones carry their skip code, and that is the point of the page:
   * "we did not write to this customer because they are inside the twenty-one
   * day floor" is the answer to the only question anybody asks about a
   * retention engine, and it should not require a log search.
   */
  @Get('touches')
  async touches(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(ListQuery) query: z.infer<typeof ListQuery>,
  ): Promise<RetentionTouchList> {
    const rows = await this.db.execute<TouchRow>(sql`
      select
        t.id, t.customer_id, t.trigger, t.purpose, t.status, t.amount_paise,
        t.scheduled_for, t.sent_at, t.skip_code, t.skip_reason,
        c.full_name_encrypted as customer_name_encrypted,
        nullif(trim(concat_ws(' ', v.make, v.model)), '') as vehicle_label,
        v.registration_normalised as registration
      from retention_touches t
      left join customers c on c.id = t.customer_id
      left join vehicles v on v.id = t.vehicle_id
      where t.shop_id = ${staff.shopId}
      order by coalesce(t.sent_at, t.scheduled_for) desc
      limit ${query.limit}
    `);

    return { touches: rows.rows.map(toTouchDto) };
  }

  /** Post-service feedback, newest first, with the day's tally (6.4). */
  @Get('feedback')
  async feedback(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(ListQuery) query: z.infer<typeof ListQuery>,
  ): Promise<FeedbackList> {
    const rows = await this.db.execute<FeedbackRow>(sql`
      select
        f.id, f.job_card_id, f.customer_id, f.status, f.sentiment,
        f.comment_encrypted, f.via_voice_note, f.delivered_at, f.asked_at, f.answered_at,
        f.review_asked_at, f.recovery_task_id,
        c.full_name_encrypted as customer_name_encrypted,
        nullif(trim(concat_ws(' ', v.make, v.model)), '') as vehicle_label,
        v.registration_normalised as registration
      from feedback_requests f
      left join customers c on c.id = f.customer_id
      left join job_cards j on j.id = f.job_card_id
      left join vehicles v on v.id = j.vehicle_id
      where f.shop_id = ${staff.shopId}
      order by f.delivered_at desc
      limit ${query.limit}
    `);

    const tally = await this.db.execute<{
      positive: number;
      neutral: number;
      negative: number;
    }>(sql`
      select
        count(*) filter (where sentiment = 'POSITIVE')::int as positive,
        count(*) filter (where sentiment = 'NEUTRAL')::int as neutral,
        count(*) filter (where sentiment = 'NEGATIVE')::int as negative
      from feedback_requests
      where shop_id = ${staff.shopId}
    `);

    return {
      feedback: rows.rows.map(toFeedbackDto),
      positive: Number(tally.rows[0]?.positive ?? 0),
      neutral: Number(tally.rows[0]?.neutral ?? 0),
      negative: Number(tally.rows[0]?.negative ?? 0),
    };
  }

  /** The realtime exception stream, as a list (6.8). */
  @Get('alerts')
  async alerts(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(AlertQuery) query: z.infer<typeof AlertQuery>,
  ): Promise<AlertList> {
    const since = new Date(Date.now() - query.hours * 3_600_000);
    const rows = await this.db.execute<{
      id: string;
      kind: string;
      detail: string;
      raised_at: Date | string;
    }>(sql`
      select id, kind, detail, raised_at
      from exception_alerts
      where shop_id = ${staff.shopId} and raised_at >= ${since}
      order by raised_at desc
      limit ${query.limit}
    `);

    return {
      alerts: rows.rows.map((row) => ({
        id: row.id,
        kind: row.kind as AlertKind,
        detail: row.detail,
        raisedAt: iso(row.raised_at) ?? '',
      })),
    };
  }

  /**
   * A renewal date the customer read off their papers at delivery (6.5).
   *
   * Recording a date is not enrolment. The customer still has to say yes to
   * being reminded, and until they do this row sits there and nothing is sent —
   * which is exactly the distinction DPDP purpose limitation is about, and the
   * reason `recordDocument` and `enrol` are two calls rather than one.
   */
  @Post('documents')
  async recordDocument(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(DocumentBody) body: z.infer<typeof DocumentBody>,
  ): Promise<{ recorded: boolean; enrolled: boolean }> {
    const owner = await this.db.execute<{ customer_id: string; enrolled_at: Date | null }>(sql`
      select v.customer_id,
             (select max(enrolled_at) from vehicle_documents d
               where d.shop_id = v.shop_id and d.vehicle_id = v.id and d.revoked_at is null)
               as enrolled_at
      from vehicles v where v.id = ${body.vehicleId} and v.shop_id = ${staff.shopId}
    `);
    const row = owner.rows[0];
    if (row === undefined) throw new NotFoundError('Vehicle not found');

    await this.retention.reminders.recordDocument({
      shopId: staff.shopId,
      vehicleId: body.vehicleId,
      customerId: row.customer_id,
      kind: body.kind,
      expiresOn: body.expiresOn,
      traceId: currentTraceId(),
    });

    return { recorded: true, enrolled: row.enrolled_at !== null };
  }

  /**
   * An odometer reading the customer volunteered (6.2).
   *
   * `CONSOLE` rather than `CUSTOMER_VOLUNTEERED`, and the difference decides
   * whether the odometer trigger may ever fire on it: the trigger reads only
   * readings the customer gave *in their own words*, because a number an
   * advisor typed from memory is not a fact about a vehicle. This endpoint
   * records history and improves the service-due forecast; it cannot cause a
   * re-pitch on its own.
   */
  @Post('odometer')
  async recordOdometer(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(OdometerBody) body: z.infer<typeof OdometerBody>,
  ): Promise<{ recorded: boolean }> {
    const vehicle = await this.db.execute<{ id: string }>(sql`
      select id from vehicles where id = ${body.vehicleId} and shop_id = ${staff.shopId}
    `);
    if (vehicle.rows[0] === undefined) throw new NotFoundError('Vehicle not found');

    await this.retention.retention.recordOdometer({
      shopId: staff.shopId,
      vehicleId: body.vehicleId,
      odometerKm: body.odometerKm,
      source: 'CONSOLE',
      traceId: currentTraceId(),
      actor: { type: 'STAFF', id: staff.staffId },
    });

    return { recorded: true };
  }
}

/* -------------------------------------------------------------------------- *
 * Row shapes and projection
 * -------------------------------------------------------------------------- */

/**
 * A timestamp column as an ISO string.
 *
 * `db.execute` with raw SQL returns whatever the driver's type parser produced,
 * which for `timestamptz` is a `Date` on some paths and a string on others
 * depending on how the column was projected. Handling both here is the
 * difference between a list endpoint and a 500 that only appears once there is
 * a row with a nullable date on it.
 */
function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Ciphertext from an `encrypted_text` column, as plain text.
 *
 * The key never goes near the database, so no query can join on one of these
 * columns or return it in the clear — decryption is always an app-layer step.
 * A row whose ciphertext predates a key rotation resolves to null rather than
 * failing the whole list: an advisor should still see the queue.
 */
function decrypted(encrypted: string | null): string | null {
  if (encrypted === null) return null;
  try {
    return decryptPii(encrypted);
  } catch {
    return null;
  }
}

/**
 * A customer's name, decrypted here rather than in SQL.
 *
 * `customers.full_name_encrypted` is an app-layer AES column: the key never
 * goes near the database, so no query can join on it or return it in the clear.
 * A row whose ciphertext predates a key rotation resolves to null rather than
 * failing the whole list — an advisor should still see the ledger.
 */
function customerName(encrypted: string | null): string | null {
  return decrypted(encrypted);
}

interface LedgerRow extends Record<string, unknown> {
  readonly id: string;
  readonly job_card_id: string;
  readonly work_item_id: string;
  readonly customer_id: string | null;
  readonly vehicle_id: string | null;
  readonly title: string | null;
  readonly technician_note: string | null;
  readonly decline_reason: string;
  readonly reason: string;
  readonly amount_paise: string | number;
  readonly category: string | null;
  readonly follow_up_after: Date | string | null;
  readonly trigger_tags: readonly string[] | null;
  readonly status: string;
  readonly repitch_count: number;
  readonly last_repitched_at: Date | string | null;
  readonly last_response: string | null;
  readonly recovered_amount_paise: string | number;
  readonly created_at: Date | string;
  readonly customer_name_encrypted: string | null;
  readonly vehicle_label: string | null;
  readonly registration: string | null;
}

function toLedgerDto(row: LedgerRow): LedgerItemDto {
  return {
    id: row.id,
    jobCardId: row.job_card_id,
    workItemId: row.work_item_id,
    customerId: row.customer_id,
    vehicleId: row.vehicle_id,
    vehicleLabel: row.vehicle_label ?? row.registration,
    customerName: customerName(row.customer_name_encrypted),
    title: row.title,
    technicianNote: row.technician_note,
    declineReason: row.decline_reason as DeclineReason,
    reason: row.reason,
    amountPaise: Number(row.amount_paise),
    category: row.category,
    followUpAfter: iso(row.follow_up_after),
    triggerTags: [...(row.trigger_tags ?? [])],
    status: row.status as LedgerStatus,
    repitchCount: Number(row.repitch_count),
    lastRepitchedAt: iso(row.last_repitched_at),
    lastResponse: (row.last_response as RepitchResponse | null) ?? null,
    recoveredAmountPaise: Number(row.recovered_amount_paise),
    createdAt: iso(row.created_at) ?? '',
  };
}

interface TouchRow extends Record<string, unknown> {
  readonly id: string;
  readonly customer_id: string;
  readonly trigger: string;
  readonly purpose: string;
  readonly status: string;
  readonly amount_paise: string | number;
  readonly scheduled_for: Date | string;
  readonly sent_at: Date | string | null;
  readonly skip_code: string | null;
  readonly skip_reason: string | null;
  readonly customer_name_encrypted: string | null;
  readonly vehicle_label: string | null;
  readonly registration: string | null;
}

function toTouchDto(row: TouchRow): RetentionTouchDto {
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: customerName(row.customer_name_encrypted),
    vehicleLabel: row.vehicle_label ?? row.registration,
    trigger: row.trigger as RetentionTrigger,
    purpose: row.purpose as ConsentPurpose,
    status: row.status as RetentionTouchStatus,
    amountPaise: Number(row.amount_paise),
    scheduledFor: iso(row.scheduled_for) ?? '',
    sentAt: iso(row.sent_at),
    skipCode: row.skip_code,
    skipReason: row.skip_reason,
  };
}

interface FeedbackRow extends Record<string, unknown> {
  readonly id: string;
  readonly job_card_id: string;
  readonly customer_id: string;
  readonly status: string;
  readonly sentiment: string | null;
  readonly comment_encrypted: string | null;
  readonly via_voice_note: boolean;
  readonly delivered_at: Date | string;
  readonly asked_at: Date | string | null;
  readonly answered_at: Date | string | null;
  readonly review_asked_at: Date | string | null;
  readonly recovery_task_id: string | null;
  readonly customer_name_encrypted: string | null;
  readonly vehicle_label: string | null;
  readonly registration: string | null;
}

function toFeedbackDto(row: FeedbackRow): FeedbackDto {
  return {
    id: row.id,
    jobCardId: row.job_card_id,
    customerId: row.customer_id,
    customerName: customerName(row.customer_name_encrypted),
    vehicleLabel: row.vehicle_label ?? row.registration,
    status: row.status as FeedbackStatus,
    sentiment: (row.sentiment as FeedbackSentiment | null) ?? null,
    comment: decrypted(row.comment_encrypted),
    viaVoiceNote: row.via_voice_note,
    deliveredAt: iso(row.delivered_at) ?? '',
    askedAt: iso(row.asked_at),
    answeredAt: iso(row.answered_at),
    reviewAskedAt: iso(row.review_asked_at),
    recoveryTaskId: row.recovery_task_id,
  };
}
