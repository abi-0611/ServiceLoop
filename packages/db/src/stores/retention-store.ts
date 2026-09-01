import type {
  AlertStore,
  EventLogReader,
  FeedbackRecord,
  FeedbackStore,
  LedgerItem,
  LedgerStore,
  OdometerReading,
  OdometerStore,
  OwnerDigestStore,
  RetentionDirectory,
  RetentionFrequencyReader,
  RetentionGateFacts,
  RetentionHoldStore,
  RetentionTouchStore,
  RollupStore,
  ServiceDueForecast,
  ServiceDueStore,
  TouchSnapshot,
  VehicleDocument,
  VehicleDocumentStore,
} from '@serviceloop/domain';
import {
  parseEventEnvelope,
  type AlertKind,
  type ConsentPurpose,
  type DeclineKind,
  type DeclineReason,
  type DigestKind,
  type DocumentKind,
  type EventEnvelope,
  type FeedbackSentiment,
  type FeedbackStatus,
  type IsoDay,
  type Language,
  type LedgerStatus,
  type Paise,
  type RepitchResponse,
  type RetentionTouchStatus,
  type RetentionTrigger,
} from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import type { Tx } from '../client';
import { decryptPii, encryptPii } from '../crypto/pii';

/**
 * Postgres implementations of the phase-6 retention ports.
 *
 * Written against the in-memory doubles in `@serviceloop/domain/testing`, which
 * are the specification. Five guarantees here come from unique indexes rather
 * than from careful callers, and every one of them is a promise to a person:
 *
 *   - `declined_work_ledger_work_item_key` — a redelivered decline does not
 *     double the denominator of the recovery rate.
 *   - `retention_touches_dedupe_key` — a scan that runs every ten minutes sends
 *     one re-pitch, not ten.
 *   - `feedback_requests_job_card_key` — a customer is asked about a visit once.
 *   - `exception_alerts_incident_key` — an owner hears about a stuck approval
 *     once, however often a scan re-observes it.
 *   - `owner_digests_day_key` — a restarted scheduler does not brief twice.
 *
 * Money is `bigint` and arrives from the driver as a string; every read goes
 * through `Number(...)` at this boundary rather than leaving a string to be
 * added to an integer downstream.
 */

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function maybeDate(value: Date | string | null): Date | null {
  return value === null ? null : date(value);
}

function paise(value: string | number | null): Paise {
  return value === null ? 0 : Number(value);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function numberArray(value: unknown): readonly number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === 'number')
    : [];
}

/** A `date` column comes back as `YYYY-MM-DD` or a Date, depending on driver. */
function isoDay(value: Date | string): IsoDay {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

/* -------------------------------------------------------------------------- *
 * 6.1 — the declined-work ledger
 * -------------------------------------------------------------------------- */

type LedgerRow = {
  id: string;
  shop_id: string;
  job_card_id: string;
  work_item_id: string;
  customer_id: string | null;
  vehicle_id: string | null;
  kind: DeclineKind;
  decline_reason: DeclineReason;
  reason: string;
  amount_paise: string | number;
  category: string | null;
  title: string | null;
  technician_note: string | null;
  evidence_bundle_id: string | null;
  estimate_line_ids: unknown;
  follow_up_after: Date | string | null;
  trigger_tags: unknown;
  status: LedgerStatus;
  repitch_count: number;
  last_repitched_at: Date | string | null;
  last_response: RepitchResponse | null;
  closed_at: Date | string | null;
  closed_reason: string | null;
  converted_job_card_id: string | null;
  recovered_amount_paise: string | number;
  created_at: Date | string;
};

function toLedgerItem(row: LedgerRow): LedgerItem {
  return {
    id: row.id,
    shopId: row.shop_id,
    jobCardId: row.job_card_id,
    workItemId: row.work_item_id,
    customerId: row.customer_id,
    vehicleId: row.vehicle_id,
    kind: row.kind,
    declineReason: row.decline_reason,
    reason: row.reason,
    amountPaise: paise(row.amount_paise),
    category: row.category,
    title: row.title,
    technicianNote: row.technician_note,
    evidenceBundleId: row.evidence_bundle_id,
    estimateLineIds: stringArray(row.estimate_line_ids),
    followUpAfter: maybeDate(row.follow_up_after),
    triggerTags: stringArray(row.trigger_tags),
    status: row.status,
    repitchCount: row.repitch_count,
    lastRepitchedAt: maybeDate(row.last_repitched_at),
    lastResponse: row.last_response,
    closedAt: maybeDate(row.closed_at),
    closedReason: row.closed_reason,
    convertedJobCardId: row.converted_job_card_id,
    recoveredAmountPaise: paise(row.recovered_amount_paise),
    createdAt: date(row.created_at),
  };
}

const SELECT_LEDGER = sql`
  select
    id, shop_id, job_card_id, work_item_id, customer_id, vehicle_id,
    kind::text as kind, decline_reason::text as decline_reason, reason, amount_paise,
    category, title, technician_note, evidence_bundle_id, estimate_line_ids,
    follow_up_after, trigger_tags, status::text as status, repitch_count,
    last_repitched_at, last_response::text as last_response, closed_at, closed_reason,
    converted_job_card_id, recovered_amount_paise, created_at
  from declined_work_ledger
`;

export class PgLedgerStore implements LedgerStore<Tx> {
  /**
   * Creates the row, or completes the bare one phase 3 left behind.
   *
   * `for update` first, then one of two writes. A read-then-write rather than a
   * single upsert because `created` has to distinguish "this call brought the
   * item into existence" from "this event has been seen before", and an
   * `on conflict do update` cannot tell the caller which of those happened.
   * The lock is what makes the read safe: two consumers handed the same
   * redelivered event serialise here, and exactly one of them reports `created`.
   */
  async open(
    tx: Tx,
    id: string,
    input: Parameters<LedgerStore<Tx>['open']>[2],
    at: Date,
  ): Promise<{ id: string; created: boolean }> {
    const existing = await tx.execute<{ id: string; title: string | null; category: string | null }>(sql`
      select id, title, category from declined_work_ledger
      where work_item_id = ${input.workItemId} and shop_id = ${input.shopId}
      for update
    `);

    const row = existing.rows[0];
    if (row === undefined) {
      await tx.execute(sql`
        insert into declined_work_ledger (
          id, shop_id, job_card_id, work_item_id, customer_id, vehicle_id, kind,
          decline_reason, reason, amount_paise, category, title, technician_note,
          evidence_bundle_id, estimate_line_ids, follow_up_after, trigger_tags,
          status, created_at, updated_at
        ) values (
          ${id}, ${input.shopId}, ${input.jobCardId}, ${input.workItemId},
          ${input.customerId}, ${input.vehicleId}, ${input.kind}::decline_kind,
          ${input.declineReason}::decline_reason, ${input.reason}, ${input.amountPaise},
          ${input.category}, ${input.title}, ${input.technicianNote},
          ${input.evidenceBundleId},
          ${JSON.stringify([...input.estimateLineIds])}::jsonb,
          ${input.followUpAfter}, ${JSON.stringify([...input.triggerTags])}::jsonb,
          'OPEN', ${at}, ${at}
        )
      `);
      return { id, created: true };
    }

    // Already complete: a redelivered event, and nothing to do. Reporting
    // `created: false` is what stops a second `ledger.item_opened`.
    if (row.title !== null || row.category !== null) {
      return { id: row.id, created: false };
    }

    await tx.execute(sql`
      update declined_work_ledger
      set decline_reason = ${input.declineReason}::decline_reason,
          customer_id = coalesce(customer_id, ${input.customerId}),
          vehicle_id = coalesce(vehicle_id, ${input.vehicleId}),
          amount_paise = case when amount_paise = 0 then ${input.amountPaise} else amount_paise end,
          category = ${input.category},
          title = ${input.title},
          technician_note = ${input.technicianNote},
          evidence_bundle_id = ${input.evidenceBundleId},
          estimate_line_ids = ${JSON.stringify([...input.estimateLineIds])}::jsonb,
          -- The transition may have set a horizon of its own from an explicit
          -- customer promise; phase 6's category default must not overwrite it.
          follow_up_after = coalesce(follow_up_after, ${input.followUpAfter}),
          trigger_tags = ${JSON.stringify([...input.triggerTags])}::jsonb,
          updated_at = ${at}
      where id = ${row.id} and shop_id = ${input.shopId}
    `);
    return { id: row.id, created: true };
  }

  async lockById(tx: Tx, shopId: string, ledgerItemId: string): Promise<LedgerItem | null> {
    const result = await tx.execute<LedgerRow>(sql`
      ${SELECT_LEDGER} where id = ${ledgerItemId} and shop_id = ${shopId} for update
    `);
    const row = result.rows[0];
    return row === undefined ? null : toLedgerItem(row);
  }

  async load(tx: Tx, shopId: string, ledgerItemId: string): Promise<LedgerItem | null> {
    const result = await tx.execute<LedgerRow>(sql`
      ${SELECT_LEDGER} where id = ${ledgerItemId} and shop_id = ${shopId}
    `);
    const row = result.rows[0];
    return row === undefined ? null : toLedgerItem(row);
  }

  async loadMany(
    tx: Tx,
    shopId: string,
    ledgerItemIds: readonly string[],
  ): Promise<readonly LedgerItem[]> {
    if (ledgerItemIds.length === 0) return [];
    const result = await tx.execute<LedgerRow>(sql`
      ${SELECT_LEDGER}
      where shop_id = ${shopId} and id = any(${sql.raw(`ARRAY[${ledgerItemIds.map((id) => `'${id}'`).join(',')}]::uuid[]`)})
    `);
    return result.rows.map(toLedgerItem);
  }

  async openForCustomer(
    tx: Tx,
    shopId: string,
    customerId: string,
  ): Promise<readonly LedgerItem[]> {
    const result = await tx.execute<LedgerRow>(sql`
      ${SELECT_LEDGER}
      where shop_id = ${shopId} and customer_id = ${customerId}
        and status in ('OPEN', 'RE_PITCHED')
      order by created_at asc
    `);
    return result.rows.map(toLedgerItem);
  }

  async openForVehicle(tx: Tx, shopId: string, vehicleId: string): Promise<readonly LedgerItem[]> {
    const result = await tx.execute<LedgerRow>(sql`
      ${SELECT_LEDGER}
      where shop_id = ${shopId} and vehicle_id = ${vehicleId}
        and status in ('OPEN', 'RE_PITCHED')
      order by created_at asc
    `);
    return result.rows.map(toLedgerItem);
  }

  async openForShop(tx: Tx, shopId: string, limit: number): Promise<readonly LedgerItem[]> {
    const result = await tx.execute<LedgerRow>(sql`
      ${SELECT_LEDGER}
      where shop_id = ${shopId} and status in ('OPEN', 'RE_PITCHED')
      order by created_at asc
      limit ${limit}
    `);
    return result.rows.map(toLedgerItem);
  }

  async linkedLedgerItems(
    tx: Tx,
    shopId: string,
    workItemIds: readonly string[],
  ): Promise<readonly { ledgerItemId: string; workItemId: string; amountPaise: Paise }[]> {
    if (workItemIds.length === 0) return [];
    const list = sql.raw(`ARRAY[${workItemIds.map((id) => `'${id}'`).join(',')}]::uuid[]`);
    const result = await tx.execute<{
      ledger_item_id: string;
      work_item_id: string;
      amount_paise: string | number | null;
    }>(sql`
      select
        wi.ledger_item_id,
        wi.id as work_item_id,
        coalesce(sum(el.line_total_paise), 0) as amount_paise
      from work_items wi
      left join estimate_lines el on el.work_item_id = wi.id
      where wi.shop_id = ${shopId}
        and wi.ledger_item_id is not null
        and wi.id = any(${list})
      group by wi.ledger_item_id, wi.id
    `);
    return result.rows.map((row) => ({
      ledgerItemId: row.ledger_item_id,
      workItemId: row.work_item_id,
      amountPaise: paise(row.amount_paise),
    }));
  }

  async recordRepitch(
    tx: Tx,
    input: Parameters<LedgerStore<Tx>['recordRepitch']>[1],
  ): Promise<void> {
    await tx.execute(sql`
      update declined_work_ledger
      set status = 'RE_PITCHED',
          repitch_count = ${input.repitchCount},
          last_repitched_at = ${input.at},
          follow_up_after = ${input.followUpAfter},
          updated_at = ${input.at}
      where id = ${input.ledgerItemId} and shop_id = ${input.shopId}
    `);
  }

  async recordResponse(
    tx: Tx,
    input: Parameters<LedgerStore<Tx>['recordResponse']>[1],
  ): Promise<void> {
    await tx.execute(sql`
      update declined_work_ledger
      set last_response = ${input.response}::repitch_response,
          follow_up_after = ${input.followUpAfter},
          updated_at = ${input.at}
      where id = ${input.ledgerItemId} and shop_id = ${input.shopId}
    `);
  }

  async close(tx: Tx, input: Parameters<LedgerStore<Tx>['close']>[1]): Promise<void> {
    await tx.execute(sql`
      update declined_work_ledger
      set status = ${input.status}::ledger_status,
          closed_at = ${input.at},
          closed_reason = ${input.reason},
          converted_job_card_id = ${input.convertedJobCardId},
          recovered_amount_paise = ${input.recoveredAmountPaise},
          updated_at = ${input.at}
      where id = ${input.ledgerItemId} and shop_id = ${input.shopId}
    `);
  }
}

/* -------------------------------------------------------------------------- *
 * 6.2 / 6.3 — touches, holds, odometer
 * -------------------------------------------------------------------------- */

type TouchRow = {
  id: string;
  shop_id: string;
  customer_id: string;
  vehicle_id: string | null;
  job_card_id: string | null;
  conversation_id: string | null;
  trigger: RetentionTrigger;
  purpose: ConsentPurpose;
  status: RetentionTouchStatus;
  ledger_item_ids: unknown;
  amount_paise: string | number;
  language: Language;
  dedupe_key: string;
  scheduled_for: Date | string;
  sent_at: Date | string | null;
  message_id: string | null;
  skip_code: string | null;
  skip_reason: string | null;
};

function toTouch(row: TouchRow): TouchSnapshot {
  return {
    id: row.id,
    shopId: row.shop_id,
    customerId: row.customer_id,
    vehicleId: row.vehicle_id,
    jobCardId: row.job_card_id,
    conversationId: row.conversation_id,
    trigger: row.trigger,
    purpose: row.purpose,
    status: row.status,
    ledgerItemIds: stringArray(row.ledger_item_ids),
    amountPaise: paise(row.amount_paise),
    language: row.language,
    dedupeKey: row.dedupe_key,
    scheduledFor: date(row.scheduled_for),
    sentAt: maybeDate(row.sent_at),
    messageId: row.message_id,
    skipCode: row.skip_code,
    skipReason: row.skip_reason,
  };
}

const SELECT_TOUCH = sql`
  select
    id, shop_id, customer_id, vehicle_id, job_card_id, conversation_id,
    trigger::text as trigger, purpose::text as purpose, status::text as status,
    ledger_item_ids, amount_paise, language::text as language, dedupe_key,
    scheduled_for, sent_at, message_id, skip_code, skip_reason
  from retention_touches
`;

export class PgRetentionTouchStore implements RetentionTouchStore<Tx> {
  async claim(tx: Tx, input: Parameters<RetentionTouchStore<Tx>['claim']>[1]): Promise<string | null> {
    const result = await tx.execute<{ id: string }>(sql`
      insert into retention_touches (
        id, shop_id, customer_id, vehicle_id, job_card_id, conversation_id,
        trigger, purpose, status, ledger_item_ids, amount_paise, language,
        dedupe_key, scheduled_for, trace_id
      ) values (
        ${input.id}, ${input.shopId}, ${input.customerId}, ${input.vehicleId},
        ${input.jobCardId}, ${input.conversationId}, ${input.trigger}::retention_trigger,
        ${input.purpose}::consent_purpose, 'SCHEDULED',
        ${JSON.stringify([...input.ledgerItemIds])}::jsonb, ${input.amountPaise},
        ${input.language}::language, ${input.dedupeKey}, ${input.scheduledFor}, ${input.traceId}
      )
      on conflict (shop_id, dedupe_key) do nothing
      returning id
    `);
    return result.rows[0]?.id ?? null;
  }

  async settle(tx: Tx, input: Parameters<RetentionTouchStore<Tx>['settle']>[1]): Promise<void> {
    await tx.execute(sql`
      update retention_touches
      set status = ${input.status}::retention_touch_status,
          message_id = ${input.messageId},
          sent_at = ${input.status === 'SENT' ? input.at : null},
          skip_code = ${input.skipCode},
          skip_reason = ${input.skipReason},
          -- The refusal keeps its row and gives up its slot. The spent form
          -- (hash + row id) cannot collide with any key the composer generates,
          -- so a re-pitch blocked on the twenty-one-day floor goes out three
          -- weeks later instead of being silenced for ever by its own refusal.
          dedupe_key = case when ${input.releaseDedupeKey === true}
            then dedupe_key || '#' || id::text
            else dedupe_key
          end,
          updated_at = ${input.at}
      where id = ${input.touchId} and shop_id = ${input.shopId}
    `);
  }

  async load(tx: Tx, shopId: string, touchId: string): Promise<TouchSnapshot | null> {
    const result = await tx.execute<TouchRow>(sql`
      ${SELECT_TOUCH} where id = ${touchId} and shop_id = ${shopId}
    `);
    const row = result.rows[0];
    return row === undefined ? null : toTouch(row);
  }

  async lastSentAt(tx: Tx, shopId: string, customerId: string): Promise<Date | null> {
    const result = await tx.execute<{ sent_at: Date | string | null }>(sql`
      select max(sent_at) as sent_at from retention_touches
      where shop_id = ${shopId} and customer_id = ${customerId} and sent_at is not null
    `);
    return maybeDate(result.rows[0]?.sent_at ?? null);
  }

  async lastSentAtForTrigger(
    tx: Tx,
    shopId: string,
    customerId: string,
    trigger: RetentionTrigger,
  ): Promise<Date | null> {
    const result = await tx.execute<{ sent_at: Date | string | null }>(sql`
      select max(sent_at) as sent_at from retention_touches
      where shop_id = ${shopId} and customer_id = ${customerId}
        and trigger = ${trigger}::retention_trigger and sent_at is not null
    `);
    return maybeDate(result.rows[0]?.sent_at ?? null);
  }

  async listForCustomer(
    tx: Tx,
    shopId: string,
    customerId: string,
    limit: number,
  ): Promise<readonly TouchSnapshot[]> {
    const result = await tx.execute<TouchRow>(sql`
      ${SELECT_TOUCH}
      where shop_id = ${shopId} and customer_id = ${customerId}
      order by scheduled_for desc
      limit ${limit}
    `);
    return result.rows.map(toTouch);
  }
}

export class PgRetentionHoldStore implements RetentionHoldStore<Tx> {
  async open(tx: Tx, input: Parameters<RetentionHoldStore<Tx>['open']>[1]): Promise<string> {
    await tx.execute(sql`
      insert into retention_holds (
        id, shop_id, customer_id, reason, source_type, source_id, task_id,
        created_at, updated_at
      ) values (
        ${input.id}, ${input.shopId}, ${input.customerId}, ${input.reason},
        ${input.sourceType}, ${input.sourceId}, ${input.taskId}, ${input.at}, ${input.at}
      )
    `);
    return input.id;
  }

  async active(
    tx: Tx,
    shopId: string,
    customerId: string,
  ): Promise<{ id: string; reason: string } | null> {
    const result = await tx.execute<{ id: string; reason: string }>(sql`
      select id, reason from retention_holds
      where shop_id = ${shopId} and customer_id = ${customerId} and released_at is null
      order by created_at desc
      limit 1
    `);
    return result.rows[0] ?? null;
  }

  async release(tx: Tx, input: Parameters<RetentionHoldStore<Tx>['release']>[1]): Promise<void> {
    await tx.execute(sql`
      update retention_holds
      set released_at = ${input.at}, released_by_staff_id = ${input.staffId}, updated_at = ${input.at}
      where id = ${input.holdId} and shop_id = ${input.shopId} and released_at is null
    `);
  }

  async releaseForTask(tx: Tx, shopId: string, taskId: string, at: Date): Promise<number> {
    const result = await tx.execute<{ id: string }>(sql`
      update retention_holds
      set released_at = ${at}, updated_at = ${at}
      where shop_id = ${shopId} and task_id = ${taskId} and released_at is null
      returning id
    `);
    return result.rows.length;
  }
}

/**
 * The gate's retention reader — two questions in one round trip.
 *
 * A single query rather than two, because the gate runs this inside the
 * transaction that is about to write a message row, and the retention floor is
 * on the hot path of every retention send.
 */
export class PgRetentionFrequencyReader implements RetentionFrequencyReader<Tx> {
  async facts(tx: Tx, shopId: string, customerId: string): Promise<RetentionGateFacts> {
    const result = await tx.execute<{ last_touch_at: Date | string | null; reason: string | null }>(sql`
      select
        (select max(sent_at) from retention_touches
          where shop_id = ${shopId} and customer_id = ${customerId} and sent_at is not null
        ) as last_touch_at,
        (select reason from retention_holds
          where shop_id = ${shopId} and customer_id = ${customerId} and released_at is null
          order by created_at desc limit 1
        ) as reason
    `);
    const row = result.rows[0];
    return {
      lastTouchAt: maybeDate(row?.last_touch_at ?? null),
      frozenReason: row?.reason ?? null,
    };
  }
}

type OdometerRow = {
  vehicle_id: string;
  odometer_km: number;
  source: string;
  read_at: Date | string;
};

function toReading(row: OdometerRow): OdometerReading {
  return {
    vehicleId: row.vehicle_id,
    odometerKm: row.odometer_km,
    source: row.source as OdometerReading['source'],
    readAt: date(row.read_at),
  };
}

export class PgOdometerStore implements OdometerStore<Tx> {
  async record(tx: Tx, input: Parameters<OdometerStore<Tx>['record']>[1]): Promise<void> {
    await tx.execute(sql`
      insert into odometer_readings (
        id, shop_id, vehicle_id, odometer_km, source, message_id, job_card_id, read_at
      ) values (
        ${input.id}, ${input.shopId}, ${input.vehicleId}, ${input.odometerKm},
        ${input.source}, ${input.messageId}, ${input.jobCardId}, ${input.readAt}
      )
    `);
  }

  async latest(tx: Tx, shopId: string, vehicleId: string): Promise<OdometerReading | null> {
    const result = await tx.execute<OdometerRow>(sql`
      select vehicle_id, odometer_km, source, read_at from odometer_readings
      where shop_id = ${shopId} and vehicle_id = ${vehicleId}
      order by read_at desc, created_at desc
      limit 1
    `);
    const row = result.rows[0];
    return row === undefined ? null : toReading(row);
  }

  async asOf(
    tx: Tx,
    shopId: string,
    vehicleId: string,
    at: Date,
  ): Promise<OdometerReading | null> {
    const result = await tx.execute<OdometerRow>(sql`
      select vehicle_id, odometer_km, source, read_at from odometer_readings
      where shop_id = ${shopId} and vehicle_id = ${vehicleId} and read_at <= ${at}
      order by read_at desc, created_at desc
      limit 1
    `);
    const row = result.rows[0];
    return row === undefined ? null : toReading(row);
  }
}

/* -------------------------------------------------------------------------- *
 * 6.4 — feedback
 * -------------------------------------------------------------------------- */

type FeedbackRow = {
  id: string;
  shop_id: string;
  job_card_id: string;
  customer_id: string;
  conversation_id: string | null;
  status: FeedbackStatus;
  delivered_at: Date | string;
  due_at: Date | string;
  asked_at: Date | string | null;
  reminded_at: Date | string | null;
  expires_at: Date | string;
  answered_at: Date | string | null;
  sentiment: FeedbackSentiment | null;
  comment_encrypted: string | null;
  via_voice_note: boolean;
  review_asked_at: Date | string | null;
  recovery_task_id: string | null;
  hold_id: string | null;
};

function toFeedback(row: FeedbackRow): FeedbackRecord {
  return {
    id: row.id,
    shopId: row.shop_id,
    jobCardId: row.job_card_id,
    customerId: row.customer_id,
    conversationId: row.conversation_id,
    status: row.status,
    deliveredAt: date(row.delivered_at),
    dueAt: date(row.due_at),
    askedAt: maybeDate(row.asked_at),
    remindedAt: maybeDate(row.reminded_at),
    expiresAt: date(row.expires_at),
    answeredAt: maybeDate(row.answered_at),
    sentiment: row.sentiment,
    // Raw SQL bypasses the `encryptedText` column helper, so the decryption
    // that Drizzle would have done is done here instead.
    comment: row.comment_encrypted === null ? null : decryptPii(row.comment_encrypted),
    viaVoiceNote: row.via_voice_note,
    reviewAskedAt: maybeDate(row.review_asked_at),
    recoveryTaskId: row.recovery_task_id,
    holdId: row.hold_id,
  };
}

const SELECT_FEEDBACK = sql`
  select
    id, shop_id, job_card_id, customer_id, conversation_id, status::text as status,
    delivered_at, due_at, asked_at, reminded_at, expires_at, answered_at,
    sentiment::text as sentiment, comment_encrypted, via_voice_note,
    review_asked_at, recovery_task_id, hold_id
  from feedback_requests
`;

export class PgFeedbackStore implements FeedbackStore<Tx> {
  async schedule(
    tx: Tx,
    input: Parameters<FeedbackStore<Tx>['schedule']>[1],
  ): Promise<string | null> {
    const result = await tx.execute<{ id: string }>(sql`
      insert into feedback_requests (
        id, shop_id, job_card_id, customer_id, conversation_id, status,
        delivered_at, due_at, expires_at, trace_id
      ) values (
        ${input.id}, ${input.shopId}, ${input.jobCardId}, ${input.customerId},
        ${input.conversationId}, 'SCHEDULED', ${input.deliveredAt}, ${input.dueAt},
        ${input.expiresAt}, ${input.traceId}
      )
      on conflict (shop_id, job_card_id) do nothing
      returning id
    `);
    return result.rows[0]?.id ?? null;
  }

  async lockById(tx: Tx, shopId: string, feedbackId: string): Promise<FeedbackRecord | null> {
    const result = await tx.execute<FeedbackRow>(sql`
      ${SELECT_FEEDBACK} where id = ${feedbackId} and shop_id = ${shopId} for update
    `);
    const row = result.rows[0];
    return row === undefined ? null : toFeedback(row);
  }

  async load(tx: Tx, shopId: string, feedbackId: string): Promise<FeedbackRecord | null> {
    const result = await tx.execute<FeedbackRow>(sql`
      ${SELECT_FEEDBACK} where id = ${feedbackId} and shop_id = ${shopId}
    `);
    const row = result.rows[0];
    return row === undefined ? null : toFeedback(row);
  }

  /** `for update skip locked`: two workers draining take disjoint batches. */
  async claimDue(
    tx: Tx,
    input: { shopId: string; dueBefore: Date; limit: number },
  ): Promise<readonly FeedbackRecord[]> {
    const result = await tx.execute<FeedbackRow>(sql`
      ${SELECT_FEEDBACK}
      where shop_id = ${input.shopId}
        and status in ('SCHEDULED', 'ASKED')
        and answered_at is null
        and due_at <= ${input.dueBefore}
        and expires_at > ${input.dueBefore}
        and (asked_at is null or reminded_at is null)
      order by due_at asc
      limit ${input.limit}
      for update skip locked
    `);
    return result.rows.map(toFeedback);
  }

  async markAsked(tx: Tx, input: Parameters<FeedbackStore<Tx>['markAsked']>[1]): Promise<void> {
    await tx.execute(sql`
      update feedback_requests
      set status = 'ASKED',
          asked_at = ${input.reminder ? sql`asked_at` : sql`${input.at}`},
          reminded_at = ${input.reminder ? sql`${input.at}` : sql`reminded_at`},
          ask_message_id = coalesce(ask_message_id, ${input.messageId}),
          updated_at = ${input.at}
      where id = ${input.feedbackId} and shop_id = ${input.shopId}
    `);
  }

  async recordAnswer(
    tx: Tx,
    input: Parameters<FeedbackStore<Tx>['recordAnswer']>[1],
  ): Promise<void> {
    await tx.execute(sql`
      update feedback_requests
      set status = 'ANSWERED',
          sentiment = ${input.sentiment}::feedback_sentiment,
          comment_encrypted = coalesce(
            ${input.comment === null ? null : encryptPii(input.comment)},
            comment_encrypted
          ),
          via_voice_note = via_voice_note or ${input.viaVoiceNote},
          media_id = coalesce(${input.mediaId}, media_id),
          answered_at = coalesce(answered_at, ${input.at}),
          updated_at = ${input.at}
      where id = ${input.feedbackId} and shop_id = ${input.shopId}
    `);
  }

  async recordReviewAsk(
    tx: Tx,
    input: Parameters<FeedbackStore<Tx>['recordReviewAsk']>[1],
  ): Promise<void> {
    await tx.execute(sql`
      update feedback_requests
      set review_asked_at = ${input.at}, review_message_id = ${input.messageId}, updated_at = ${input.at}
      where id = ${input.feedbackId} and shop_id = ${input.shopId}
    `);
  }

  async attachRecovery(
    tx: Tx,
    input: Parameters<FeedbackStore<Tx>['attachRecovery']>[1],
  ): Promise<void> {
    await tx.execute(sql`
      update feedback_requests
      set recovery_task_id = ${input.taskId}, hold_id = ${input.holdId}
      where id = ${input.feedbackId} and shop_id = ${input.shopId}
    `);
    // The hold was opened before the task existed. Giving it the task id here
    // is what lets `releaseForTask` find it when an advisor closes the task.
    if (input.holdId !== null && input.taskId !== null) {
      await tx.execute(sql`
        update retention_holds set task_id = ${input.taskId}
        where id = ${input.holdId} and shop_id = ${input.shopId} and task_id is null
      `);
    }
  }

  async expire(
    tx: Tx,
    input: { shopId: string; before: Date; limit: number },
  ): Promise<number> {
    const result = await tx.execute<{ id: string }>(sql`
      update feedback_requests
      set status = 'EXPIRED', updated_at = ${input.before}
      where id in (
        select id from feedback_requests
        where shop_id = ${input.shopId} and answered_at is null and status <> 'EXPIRED'
          and expires_at <= ${input.before}
        limit ${input.limit}
      )
      returning id
    `);
    return result.rows.length;
  }

  async findOpenForCustomer(
    tx: Tx,
    shopId: string,
    customerId: string,
  ): Promise<FeedbackRecord | null> {
    const result = await tx.execute<FeedbackRow>(sql`
      ${SELECT_FEEDBACK}
      where shop_id = ${shopId} and customer_id = ${customerId} and status <> 'EXPIRED'
      order by delivered_at desc
      limit 1
    `);
    const row = result.rows[0];
    return row === undefined ? null : toFeedback(row);
  }
}

/* -------------------------------------------------------------------------- *
 * 6.5 — reminders
 * -------------------------------------------------------------------------- */

type ForecastRow = {
  id: string;
  shop_id: string;
  vehicle_id: string;
  customer_id: string;
  job_card_id: string | null;
  due_at: Date | string;
  basis: string;
  reminded_leads: unknown;
};

function toForecast(row: ForecastRow): ServiceDueForecast {
  return {
    id: row.id,
    shopId: row.shop_id,
    vehicleId: row.vehicle_id,
    customerId: row.customer_id,
    jobCardId: row.job_card_id,
    dueAt: date(row.due_at),
    basis: row.basis,
    remindedLeads: numberArray(row.reminded_leads),
  };
}

export class PgServiceDueStore implements ServiceDueStore<Tx> {
  async upsert(tx: Tx, input: Parameters<ServiceDueStore<Tx>['upsert']>[1]): Promise<string> {
    // Supersede first, then insert. The partial unique index only covers live
    // rows, so the two statements have to happen in this order or the insert
    // collides with the row it is replacing.
    await tx.execute(sql`
      update service_due_forecasts set superseded_at = ${input.at}, updated_at = ${input.at}
      where shop_id = ${input.shopId} and vehicle_id = ${input.vehicleId} and superseded_at is null
    `);
    await tx.execute(sql`
      insert into service_due_forecasts (
        id, shop_id, vehicle_id, customer_id, job_card_id, due_at, basis, created_at, updated_at
      ) values (
        ${input.id}, ${input.shopId}, ${input.vehicleId}, ${input.customerId},
        ${input.jobCardId}, ${input.dueAt}, ${input.basis}, ${input.at}, ${input.at}
      )
    `);
    return input.id;
  }

  async live(tx: Tx, shopId: string, vehicleId: string): Promise<ServiceDueForecast | null> {
    const result = await tx.execute<ForecastRow>(sql`
      select id, shop_id, vehicle_id, customer_id, job_card_id, due_at, basis, reminded_leads
      from service_due_forecasts
      where shop_id = ${shopId} and vehicle_id = ${vehicleId} and superseded_at is null
    `);
    const row = result.rows[0];
    return row === undefined ? null : toForecast(row);
  }

  async dueWithin(
    tx: Tx,
    input: { shopId: string; before: Date; limit: number },
  ): Promise<readonly ServiceDueForecast[]> {
    const result = await tx.execute<ForecastRow>(sql`
      select id, shop_id, vehicle_id, customer_id, job_card_id, due_at, basis, reminded_leads
      from service_due_forecasts
      where shop_id = ${input.shopId} and superseded_at is null and due_at <= ${input.before}
      order by due_at asc
      limit ${input.limit}
    `);
    return result.rows.map(toForecast);
  }

  async markLeadSent(
    tx: Tx,
    input: Parameters<ServiceDueStore<Tx>['markLeadSent']>[1],
  ): Promise<void> {
    await tx.execute(sql`
      update service_due_forecasts
      set reminded_leads = reminded_leads || ${JSON.stringify([input.leadDays])}::jsonb,
          updated_at = ${input.at}
      where id = ${input.forecastId} and shop_id = ${input.shopId}
    `);
  }
}

type DocumentRow = {
  id: string;
  shop_id: string;
  vehicle_id: string;
  customer_id: string;
  kind: DocumentKind;
  expires_on: Date | string;
  enrolled_at: Date | string | null;
  revoked_at: Date | string | null;
  last_reminded_at: Date | string | null;
  last_reminded_cycle: Date | string | null;
};

function toDocument(row: DocumentRow): VehicleDocument {
  return {
    id: row.id,
    shopId: row.shop_id,
    vehicleId: row.vehicle_id,
    customerId: row.customer_id,
    kind: row.kind,
    expiresOn: isoDay(row.expires_on),
    enrolledAt: maybeDate(row.enrolled_at),
    revokedAt: maybeDate(row.revoked_at),
    lastRemindedAt: maybeDate(row.last_reminded_at),
    lastRemindedCycle: row.last_reminded_cycle === null ? null : isoDay(row.last_reminded_cycle),
  };
}

const SELECT_DOCUMENT = sql`
  select
    id, shop_id, vehicle_id, customer_id, kind::text as kind, expires_on,
    enrolled_at, revoked_at, last_reminded_at, last_reminded_cycle
  from vehicle_documents
`;

export class PgVehicleDocumentStore implements VehicleDocumentStore<Tx> {
  async upsert(tx: Tx, input: Parameters<VehicleDocumentStore<Tx>['upsert']>[1]): Promise<string> {
    const result = await tx.execute<{ id: string }>(sql`
      insert into vehicle_documents (
        id, shop_id, vehicle_id, customer_id, kind, expires_on, created_at, updated_at
      ) values (
        ${input.id}, ${input.shopId}, ${input.vehicleId}, ${input.customerId},
        ${input.kind}::document_kind, ${input.expiresOn}::date, ${input.at}, ${input.at}
      )
      on conflict (shop_id, vehicle_id, kind) do update
        set expires_on = excluded.expires_on, updated_at = ${input.at}
      returning id
    `);
    return result.rows[0]?.id ?? input.id;
  }

  async enrol(
    tx: Tx,
    input: { shopId: string; vehicleId: string; via: string; at: Date },
  ): Promise<number> {
    const result = await tx.execute<{ id: string }>(sql`
      update vehicle_documents
      set enrolled_at = ${input.at}, enrolled_via = ${input.via}, revoked_at = null,
          updated_at = ${input.at}
      where shop_id = ${input.shopId} and vehicle_id = ${input.vehicleId}
      returning id
    `);
    return result.rows.length;
  }

  async revoke(
    tx: Tx,
    input: { shopId: string; vehicleId: string; at: Date },
  ): Promise<number> {
    const result = await tx.execute<{ id: string }>(sql`
      update vehicle_documents
      set revoked_at = ${input.at}, updated_at = ${input.at}
      where shop_id = ${input.shopId} and vehicle_id = ${input.vehicleId} and revoked_at is null
      returning id
    `);
    return result.rows.length;
  }

  /**
   * Enrolled, unrevoked, expiring soon, not yet reminded *this cycle*.
   *
   * The `enrolled_at is not null` clause is the one that matters: a shop very
   * often knows an expiry because it saw the papers, and knowing a date is not
   * being asked to write about it.
   */
  async dueWithin(
    tx: Tx,
    input: { shopId: string; before: string; limit: number },
  ): Promise<readonly VehicleDocument[]> {
    const result = await tx.execute<DocumentRow>(sql`
      ${SELECT_DOCUMENT}
      where shop_id = ${input.shopId}
        and enrolled_at is not null
        and revoked_at is null
        and expires_on <= ${input.before}::date
        and (last_reminded_cycle is null or last_reminded_cycle <> expires_on)
      order by expires_on asc
      limit ${input.limit}
    `);
    return result.rows.map(toDocument);
  }

  async markReminded(
    tx: Tx,
    input: Parameters<VehicleDocumentStore<Tx>['markReminded']>[1],
  ): Promise<void> {
    await tx.execute(sql`
      update vehicle_documents
      set last_reminded_at = ${input.at}, last_reminded_cycle = ${input.cycle}::date,
          updated_at = ${input.at}
      where id = ${input.documentId} and shop_id = ${input.shopId}
    `);
  }

  async listForVehicle(
    tx: Tx,
    shopId: string,
    vehicleId: string,
  ): Promise<readonly VehicleDocument[]> {
    const result = await tx.execute<DocumentRow>(sql`
      ${SELECT_DOCUMENT} where shop_id = ${shopId} and vehicle_id = ${vehicleId}
    `);
    return result.rows.map(toDocument);
  }
}

/* -------------------------------------------------------------------------- *
 * 6.7 / 6.8 — digests and alerts
 * -------------------------------------------------------------------------- */

export class PgOwnerDigestStore implements OwnerDigestStore<Tx> {
  async claim(tx: Tx, input: Parameters<OwnerDigestStore<Tx>['claim']>[1]): Promise<string | null> {
    const result = await tx.execute<{ id: string }>(sql`
      insert into owner_digests (
        id, shop_id, kind, day, recipient_staff_id, conversation_id, language,
        payload, trace_id
      ) values (
        ${input.id}, ${input.shopId}, ${input.kind}::digest_kind, ${input.day}::date,
        ${input.recipientStaffId}, ${input.conversationId}, ${input.language}::language,
        ${JSON.stringify(input.payload)}::jsonb, ${input.traceId}
      )
      on conflict (shop_id, kind, day, recipient_staff_id) do nothing
      returning id
    `);
    return result.rows[0]?.id ?? null;
  }

  async settle(tx: Tx, input: Parameters<OwnerDigestStore<Tx>['settle']>[1]): Promise<void> {
    await tx.execute(sql`
      update owner_digests
      set message_id = ${input.messageId},
          sent_at = ${input.messageId === null ? null : input.at},
          blocked_reason = ${input.blockedReason},
          updated_at = ${input.at}
      where id = ${input.digestId} and shop_id = ${input.shopId}
    `);
  }

  async load(
    tx: Tx,
    shopId: string,
    digestId: string,
  ): Promise<{ id: string; payload: unknown; sentAt: Date | null } | null> {
    const result = await tx.execute<{ id: string; payload: unknown; sent_at: Date | string | null }>(sql`
      select id, payload, sent_at from owner_digests
      where id = ${digestId} and shop_id = ${shopId}
    `);
    const row = result.rows[0];
    return row === undefined
      ? null
      : { id: row.id, payload: row.payload, sentAt: maybeDate(row.sent_at) };
  }

  async latest(
    tx: Tx,
    shopId: string,
    kind: DigestKind,
    limit: number,
  ): Promise<readonly { id: string; day: IsoDay; payload: unknown }[]> {
    const result = await tx.execute<{ id: string; day: Date | string; payload: unknown }>(sql`
      select id, day, payload from owner_digests
      where shop_id = ${shopId} and kind = ${kind}::digest_kind
      order by day desc
      limit ${limit}
    `);
    return result.rows.map((row) => ({ id: row.id, day: isoDay(row.day), payload: row.payload }));
  }
}

export class PgAlertStore implements AlertStore<Tx> {
  async claim(tx: Tx, input: Parameters<AlertStore<Tx>['claim']>[1]): Promise<string | null> {
    const result = await tx.execute<{ id: string }>(sql`
      insert into exception_alerts (
        id, shop_id, kind, incident_key, subject_type, subject_id, urgency,
        detail, recipient_staff_id, raised_at, trace_id
      ) values (
        ${input.id}, ${input.shopId}, ${input.kind}::alert_kind, ${input.incidentKey},
        ${input.subjectType}, ${input.subjectId}, ${input.urgency}::task_urgency,
        ${input.detail}, ${input.recipientStaffId}, ${input.raisedAt}, ${input.traceId}
      )
      on conflict (shop_id, incident_key) do nothing
      returning id
    `);
    return result.rows[0]?.id ?? null;
  }

  async settle(tx: Tx, input: Parameters<AlertStore<Tx>['settle']>[1]): Promise<void> {
    await tx.execute(sql`
      update exception_alerts
      set message_id = ${input.messageId}, task_id = ${input.taskId},
          held_reason = ${input.heldReason}, updated_at = now()
      where id = ${input.alertId} and shop_id = ${input.shopId}
    `);
  }

  async resolve(tx: Tx, shopId: string, incidentKey: string, at: Date): Promise<boolean> {
    const result = await tx.execute<{ id: string }>(sql`
      update exception_alerts
      set resolved_at = ${at}, updated_at = ${at}
      where shop_id = ${shopId} and incident_key = ${incidentKey} and resolved_at is null
      returning id
    `);
    return result.rows.length > 0;
  }

  async since(
    tx: Tx,
    shopId: string,
    from: Date,
    limit: number,
  ): Promise<readonly { id: string; kind: AlertKind; detail: string; raisedAt: Date }[]> {
    const result = await tx.execute<{
      id: string;
      kind: AlertKind;
      detail: string;
      raised_at: Date | string;
    }>(sql`
      select id, kind::text as kind, detail, raised_at from exception_alerts
      where shop_id = ${shopId} and raised_at >= ${from}
      order by raised_at desc
      limit ${limit}
    `);
    return result.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      detail: row.detail,
      raisedAt: date(row.raised_at),
    }));
  }
}

/* -------------------------------------------------------------------------- *
 * 6.9 — the event log and the rollups
 * -------------------------------------------------------------------------- */

/**
 * The metrics fold's source: `events_outbox`.
 *
 * Not a copy, and not a live table join. Every phase writes its facts here in
 * the same transaction as the state change they describe, rows are marked
 * `DISPATCHED` rather than deleted, and the envelope is zod-validated on the
 * way out — so the stream a backfill replays in December is the stream the
 * nightly fold saw in September. That is the whole reason `recompute --from`
 * can promise identical numbers.
 *
 * A malformed row is skipped rather than allowed to abort the fold. An outbox
 * that has one unparseable event from a build that has since been rolled back
 * must not make a shop's entire history uncomputable.
 */
export class PgEventLogReader implements EventLogReader<Tx> {
  async read(
    tx: Tx,
    input: { shopId: string; from: Date; to: Date; types?: readonly string[] },
  ): Promise<readonly EventEnvelope[]> {
    const typeFilter =
      input.types === undefined || input.types.length === 0
        ? sql``
        : sql` and type = any(${sql.raw(`ARRAY[${input.types.map((type) => `'${type}'`).join(',')}]::text[]`)})`;

    const result = await tx.execute<{
      id: string;
      type: string;
      payload: unknown;
      occurred_at: Date | string;
      trace_id: string;
    }>(sql`
      select id, type, payload, occurred_at, trace_id
      from events_outbox
      where shop_id = ${input.shopId}
        and occurred_at >= ${input.from}
        and occurred_at < ${input.to}
        ${typeFilter}
      order by occurred_at asc, id asc
    `);

    const events: EventEnvelope[] = [];
    for (const row of result.rows) {
      try {
        events.push(
          parseEventEnvelope({
            id: row.id,
            type: row.type,
            occurredAt: date(row.occurred_at).toISOString(),
            shopId: input.shopId,
            traceId: row.trace_id,
            payload: row.payload,
          }),
        );
      } catch {
        // Skipped, deliberately. See the class comment.
      }
    }
    return events;
  }
}

export class PgRollupStore implements RollupStore<Tx> {
  /**
   * Upserts in place and says whether the numbers moved.
   *
   * A rollup is a derived value with exactly one correct answer, not a record
   * of an opinion held on a Tuesday — so a recompute overwrites rather than
   * appending. `changed` is the alarm: a backfill that alters a day already
   * folded is a regression somebody has to look at.
   */
  async upsert(
    tx: Tx,
    input: Parameters<RollupStore<Tx>['upsert']>[1],
  ): Promise<{ changed: boolean; previousHash: string | null }> {
    const before = await tx.execute<{ payload_hash: string }>(sql`
      select payload_hash from metric_rollups
      where shop_id = ${input.shopId} and day = ${input.day}::date
    `);
    const previousHash = before.rows[0]?.payload_hash ?? null;

    await tx.execute(sql`
      insert into metric_rollups (
        id, shop_id, day, timezone, payload, payload_hash, source, events_read,
        computed_at, created_at, updated_at
      ) values (
        ${input.id}, ${input.shopId}, ${input.day}::date, ${input.timezone},
        ${JSON.stringify(input.payload)}::jsonb, ${input.payloadHash},
        ${input.source}::rollup_source, ${input.eventsRead}, ${input.computedAt},
        ${input.computedAt}, ${input.computedAt}
      )
      on conflict (shop_id, day) do update set
        payload = excluded.payload,
        payload_hash = excluded.payload_hash,
        source = excluded.source,
        events_read = excluded.events_read,
        computed_at = excluded.computed_at,
        updated_at = excluded.computed_at
    `);

    return { changed: previousHash !== input.payloadHash, previousHash };
  }

  async load(
    tx: Tx,
    shopId: string,
    day: IsoDay,
  ): Promise<{ payload: unknown; payloadHash: string } | null> {
    const result = await tx.execute<{ payload: unknown; payload_hash: string }>(sql`
      select payload, payload_hash from metric_rollups
      where shop_id = ${shopId} and day = ${day}::date
    `);
    const row = result.rows[0];
    return row === undefined ? null : { payload: row.payload, payloadHash: row.payload_hash };
  }

  async range(
    tx: Tx,
    shopId: string,
    from: IsoDay,
    to: IsoDay,
  ): Promise<readonly { day: IsoDay; payload: unknown }[]> {
    const result = await tx.execute<{ day: Date | string; payload: unknown }>(sql`
      select day, payload from metric_rollups
      where shop_id = ${shopId} and day between ${from}::date and ${to}::date
      order by day asc
    `);
    return result.rows.map((row) => ({ day: isoDay(row.day), payload: row.payload }));
  }
}

/* -------------------------------------------------------------------------- *
 * The facts a retention message interpolates
 * -------------------------------------------------------------------------- */

/**
 * Customers, vehicles and owners, decrypted at this boundary.
 *
 * The retention module has no business knowing that a customer's name lives in
 * an AES-GCM column; it needs a name, a language and a vehicle label. This is
 * the only place that knows both.
 */
export class PgRetentionDirectory implements RetentionDirectory<Tx> {
  async loadCustomer(
    tx: Tx,
    shopId: string,
    customerId: string,
  ): Promise<{ id: string; name: string; language: Language; lastVisitAt: Date | null } | null> {
    const result = await tx.execute<{
      id: string;
      full_name_encrypted: string;
      preferred_language: Language;
      last_visit_at: Date | string | null;
    }>(sql`
      select
        c.id,
        c.full_name_encrypted,
        c.preferred_language::text as preferred_language,
        (select max(j.created_at) from job_cards j where j.customer_id = c.id) as last_visit_at
      from customers c
      where c.id = ${customerId} and c.shop_id = ${shopId} and c.deleted_at is null
    `);
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      name: decryptPii(row.full_name_encrypted),
      language: row.preferred_language,
      lastVisitAt: maybeDate(row.last_visit_at),
    };
  }

  async loadVehicle(
    tx: Tx,
    shopId: string,
    vehicleId: string,
  ): Promise<{
    id: string;
    label: string;
    registration: string;
    customerId: string;
    modelYear: number | null;
  } | null> {
    const result = await tx.execute<{
      id: string;
      make: string | null;
      model: string | null;
      registration_normalised: string;
      customer_id: string;
      model_year: number | null;
    }>(sql`
      select id, make, model, registration_normalised, customer_id, model_year
      from vehicles
      where id = ${vehicleId} and shop_id = ${shopId} and deleted_at is null
    `);
    const row = result.rows[0];
    if (row === undefined) return null;
    const label = [row.make, row.model].filter((part) => part !== null).join(' ').trim();
    return {
      id: row.id,
      // A registration is a poor thing to call somebody's car in a message, but
      // it beats "your vehicle" when the shop has never recorded a make.
      label: label.length > 0 ? label : row.registration_normalised,
      registration: row.registration_normalised,
      customerId: row.customer_id,
      modelYear: row.model_year,
    };
  }

  async vehicleForJobCard(tx: Tx, shopId: string, jobCardId: string): Promise<string | null> {
    const result = await tx.execute<{ vehicle_id: string | null }>(sql`
      select vehicle_id from job_cards where id = ${jobCardId} and shop_id = ${shopId}
    `);
    return result.rows[0]?.vehicle_id ?? null;
  }

  /**
   * Customers whose most recent visit is older than `before`.
   *
   * The `having` is what makes this "lapsed" rather than "has an old visit": a
   * customer who came in last week and also came in two years ago is not
   * lapsed, and a query without it would win-back half the shop's book.
   */
  async lapsedCustomers(
    tx: Tx,
    input: { shopId: string; before: Date; limit: number },
  ): Promise<readonly { customerId: string; vehicleId: string | null; lastVisitAt: Date }[]> {
    const result = await tx.execute<{
      customer_id: string;
      vehicle_id: string | null;
      last_visit_at: Date | string;
    }>(sql`
      select
        j.customer_id,
        (array_agg(j.vehicle_id order by j.created_at desc))[1] as vehicle_id,
        max(j.created_at) as last_visit_at
      from job_cards j
      join customers c on c.id = j.customer_id and c.deleted_at is null
      where j.shop_id = ${input.shopId}
      group by j.customer_id
      having max(j.created_at) <= ${input.before}
      order by max(j.created_at) asc
      limit ${input.limit}
    `);
    return result.rows.map((row) => ({
      customerId: row.customer_id,
      vehicleId: row.vehicle_id,
      lastVisitAt: date(row.last_visit_at),
    }));
  }

  async owners(
    tx: Tx,
    shopId: string,
  ): Promise<readonly { staffId: string; name: string; language: Language }[]> {
    const result = await tx.execute<{
      id: string;
      full_name: string;
      preferred_language: Language;
    }>(sql`
      select id, full_name, preferred_language::text as preferred_language
      from staff
      where shop_id = ${shopId} and role = 'OWNER' and deleted_at is null
      order by created_at asc
    `);
    return result.rows.map((row) => ({
      staffId: row.id,
      name: row.full_name,
      language: row.preferred_language,
    }));
  }

  /**
   * The shops one owner can see (phase 6.7's consolidated digest).
   *
   * Matched on the **decrypted phone number**, in the application, and that is
   * not laziness — it is the only correct answer this schema permits.
   * `staff.phone_hash` is an HMAC salted with the shop id (see `blindIndex`),
   * so the same person has a different hash in every shop and a SQL join on it
   * finds nothing. The encrypted column is AES-GCM with a random IV, so it
   * cannot be compared either.
   *
   * The cost is one decrypt per owner row in the deployment, which for a
   * product whose unit is an independent workshop is tens of rows read once an
   * evening. A cross-shop person identity would be the right fix and is a
   * schema change phase 7 should weigh against the DPDP surface it adds; until
   * then this is correct and slow rather than fast and wrong.
   */
  async shopsForOwner(
    tx: Tx,
    staffId: string,
  ): Promise<readonly { shopId: string; name: string }[]> {
    const me = await tx.execute<{ phone_encrypted: string }>(sql`
      select phone_encrypted from staff where id = ${staffId} and deleted_at is null
    `);
    const mine = me.rows[0];
    if (mine === undefined) return [];
    const phone = decryptPii(mine.phone_encrypted);

    const owners = await tx.execute<{
      shop_id: string;
      name: string;
      phone_encrypted: string;
    }>(sql`
      select s.id as shop_id, s.name, st.phone_encrypted
      from staff st
      join shops s on s.id = st.shop_id and s.deleted_at is null
      where st.role = 'OWNER' and st.deleted_at is null
      order by s.name asc
    `);

    return owners.rows
      .filter((row) => decryptPii(row.phone_encrypted) === phone)
      .map((row) => ({ shopId: row.shop_id, name: row.name }));
  }
}

/* -------------------------------------------------------------------------- *
 * Factory
 * -------------------------------------------------------------------------- */

/**
 * Vehicles with a card open right now, by vehicle id — the next-visit trigger's
 * only input (phase 6.2).
 *
 * "Open" is every state a vehicle can be in while it is still in the shop;
 * `DELIVERED`, `CLOSED` and `CANCELLED` are the three that mean it is not. A
 * `DRAFT` counts, because the advisor is looking at the drawer, which is
 * precisely the moment the "while it's here" prompt is worth anything.
 *
 * A vehicle with two open cards resolves to the newest, which is the one on the
 * advisor's screen.
 */
export async function openVisitsByVehicle(
  tx: Tx,
  shopId: string,
): Promise<ReadonlyMap<string, string>> {
  const result = await tx.execute<{ vehicle_id: string; job_card_id: string }>(sql`
    select distinct on (vehicle_id) vehicle_id, id as job_card_id
    from job_cards
    where shop_id = ${shopId}
      and vehicle_id is not null
      and state not in ('DELIVERED', 'CLOSED', 'CANCELLED')
    order by vehicle_id, created_at desc
  `);
  return new Map(result.rows.map((row) => [row.vehicle_id, row.job_card_id]));
}

/**
 * Vehicle labels for the digest's stuck-approval lines (phase 6.7).
 *
 * Falls back to the registration and then to a generic phrase: a line reading
 * "— is waiting" is worse than one reading "a vehicle is waiting", because the
 * owner is being asked to make a telephone call about it.
 */
export async function jobCardLabels(
  tx: Tx,
  shopId: string,
  jobCardIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const labels = new Map<string, string>();
  if (jobCardIds.length === 0) return labels;

  const list = sql.raw(`ARRAY[${jobCardIds.map((id) => `'${id}'`).join(',')}]::uuid[]`);
  const result = await tx.execute<{
    job_card_id: string;
    label: string | null;
    registration: string | null;
  }>(sql`
    select j.id as job_card_id,
           trim(concat_ws(' ', v.make, v.model)) as label,
           v.registration_normalised as registration
    from job_cards j
    left join vehicles v on v.id = j.vehicle_id
    where j.shop_id = ${shopId}
      and j.id = any(${list})
  `);

  for (const row of result.rows) {
    const label = row.label ?? '';
    labels.set(row.job_card_id, label.length > 0 ? label : (row.registration ?? 'a vehicle'));
  }
  return labels;
}

export interface RetentionStores {
  readonly ledger: PgLedgerStore;
  readonly touches: PgRetentionTouchStore;
  readonly holds: PgRetentionHoldStore;
  readonly frequency: PgRetentionFrequencyReader;
  readonly odometer: PgOdometerStore;
  readonly feedback: PgFeedbackStore;
  readonly forecasts: PgServiceDueStore;
  readonly documents: PgVehicleDocumentStore;
  readonly digests: PgOwnerDigestStore;
  readonly alerts: PgAlertStore;
  readonly events: PgEventLogReader;
  readonly rollups: PgRollupStore;
  readonly directory: PgRetentionDirectory;
}

/**
 * Every phase-6 store, in one call.
 *
 * The same shape as `createAgentStores` and `createVoiceStores`, for the same
 * reason: three processes want the identical set — the API, the workers and the
 * demo runner — and each assembling it by hand is how one of them ends up a
 * store short.
 */
export function createRetentionStores(): RetentionStores {
  return {
    ledger: new PgLedgerStore(),
    touches: new PgRetentionTouchStore(),
    holds: new PgRetentionHoldStore(),
    frequency: new PgRetentionFrequencyReader(),
    odometer: new PgOdometerStore(),
    feedback: new PgFeedbackStore(),
    forecasts: new PgServiceDueStore(),
    documents: new PgVehicleDocumentStore(),
    digests: new PgOwnerDigestStore(),
    alerts: new PgAlertStore(),
    events: new PgEventLogReader(),
    rollups: new PgRollupStore(),
    directory: new PgRetentionDirectory(),
  };
}
