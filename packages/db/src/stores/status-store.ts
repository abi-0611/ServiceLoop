import type {
  CardCandidate,
  CardResolver,
  EtaEntry,
  EtaHead,
  EtaStore,
  SilentBayStore,
  SilentCard,
  StatusCommsStore,
  StatusSignalRecord,
  StatusSignalStore,
} from '@serviceloop/domain';
import { registrationMatches } from '@serviceloop/domain';
import type {
  EtaMateriality,
  EtaReason,
  JobCardState,
  Language,
  StatusSignalRoute,
  StatusSignalSource,
  StatusSignalType,
} from '@serviceloop/shared';
import { sql } from 'drizzle-orm';
import type { Tx } from '../client';

/**
 * Postgres implementations of the phase-4 status ports.
 *
 * The in-memory versions in `@serviceloop/domain/testing` are the specification
 * these are written against — in particular the idempotency the domain relies
 * on and that these get for free from unique indexes: one status signal per
 * inbound message, one ETA version per card, one silent-bay nudge per window.
 * In every case the store returns **null** rather than throwing, so "already
 * happened" is a value the caller handles instead of an exception it has to
 * classify.
 *
 * Confidence crosses this boundary as basis points. The domain speaks in the
 * 0–1 fraction because that is what a threshold reads like; the column is an
 * integer because a float column for a number that gates a customer-facing
 * transition is a rounding argument waiting to happen.
 */

const BP = 10_000;

function toBp(fraction: number): number {
  return Math.max(0, Math.min(BP, Math.round(fraction * BP)));
}

function fromBp(bp: number | null): number {
  return bp === null ? 0 : bp / BP;
}

/* -------------------------------------------------------------------------- *
 * ETA history
 * -------------------------------------------------------------------------- */

type EtaHeadRow = {
  job_card_id: string;
  eta_version: number;
  current_eta: Date | string | null;
  promised_at: Date | string | null;
  state: JobCardState;
}

type EtaEntryRow = {
  id: string;
  shop_id: string;
  job_card_id: string;
  version: number;
  previous_eta: Date | string | null;
  eta: Date | string;
  promised_at: Date | string | null;
  reason: EtaReason;
  materiality: EtaMateriality;
  delta_minutes: number;
  detail: string;
  status_signal_id: string | null;
  notified_at: Date | string | null;
  created_at: Date | string;
}

/**
 * Driver rows arrive with timestamps as strings on some paths and `Date` on
 * others. Converting at this boundary — rather than trusting whichever the
 * driver felt like — is the lesson from phase 2's deviation 17(b), where a
 * `sent_at` string crashed the frequency cap on the second message to any
 * customer.
 */
function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function maybeDate(value: Date | string | null): Date | null {
  return value === null ? null : date(value);
}

export class PgEtaStore implements EtaStore<Tx> {
  /**
   * Locks the *card* rather than the history.
   *
   * The card row is what carries `eta_version`, so locking it is what makes two
   * simultaneous recalculations — an approval landing as a technician's "done"
   * arrives — produce versions 4 and 5 in some order rather than two rows both
   * claiming to be 4.
   */
  async lockHead(tx: Tx, shopId: string, jobCardId: string): Promise<EtaHead | null> {
    const result = await tx.execute<EtaHeadRow>(sql`
      select id as job_card_id, eta_version, current_eta, promised_at, state::text as state
      from job_cards
      where id = ${jobCardId} and shop_id = ${shopId} and deleted_at is null
      for update
    `);

    const row = result.rows[0];
    if (row === undefined) return null;

    return {
      jobCardId: row.job_card_id,
      version: row.eta_version,
      currentEta: maybeDate(row.current_eta),
      promisedAt: maybeDate(row.promised_at),
      state: row.state,
    };
  }

  /**
   * Appends the history entry and moves the card's denormalised head in one
   * statement pair.
   *
   * Both, or neither. The board reads `job_cards.current_eta` and the drawer
   * reads the history; a shop where those two disagree is a shop where nobody
   * trusts either.
   */
  async append(tx: Tx, entry: EtaEntry): Promise<void> {
    await tx.execute(sql`
      insert into eta_entries (
        id, shop_id, job_card_id, version, previous_eta, eta, promised_at,
        reason, materiality, delta_minutes, detail, status_signal_id, notified_at
      ) values (
        ${entry.id}, ${entry.shopId}, ${entry.jobCardId}, ${entry.version},
        ${entry.previousEta}, ${entry.eta}, ${entry.promisedAt},
        ${entry.reason}::eta_reason, ${entry.materiality}::eta_materiality,
        ${entry.deltaMinutes}, ${entry.detail}, ${entry.statusSignalId}, ${entry.notifiedAt}
      )
    `);

    await tx.execute(sql`
      update job_cards
      set current_eta = ${entry.eta},
          eta_version = ${entry.version},
          eta_reason = ${entry.reason}::eta_reason,
          updated_at = now()
      where id = ${entry.jobCardId} and shop_id = ${entry.shopId}
    `);
  }

  async history(
    tx: Tx,
    shopId: string,
    jobCardId: string,
    limit: number,
  ): Promise<readonly EtaEntry[]> {
    const result = await tx.execute<EtaEntryRow>(sql`
      select
        id, shop_id, job_card_id, version, previous_eta, eta, promised_at,
        reason::text as reason, materiality::text as materiality, delta_minutes,
        detail, status_signal_id, notified_at, created_at
      from eta_entries
      where shop_id = ${shopId} and job_card_id = ${jobCardId}
      order by version desc
      limit ${limit}
    `);

    return result.rows.map(toEtaEntry);
  }

  async latest(tx: Tx, shopId: string, jobCardId: string): Promise<EtaEntry | null> {
    const [newest] = await this.history(tx, shopId, jobCardId, 1);
    return newest ?? null;
  }

  async markNotified(
    tx: Tx,
    input: { readonly entryId: string; readonly messageId: string | null; readonly at: Date },
  ): Promise<void> {
    await tx.execute(sql`
      update eta_entries
      set notified_at = ${input.at}, notified_message_id = ${input.messageId}
      where id = ${input.entryId}
    `);
  }

  /**
   * Material changes nobody has been told about yet.
   *
   * `FOR UPDATE SKIP LOCKED` so two comms workers take disjoint batches rather
   * than both announcing the same delay — which the customer would receive
   * twice, about the same part, in the same minute.
   */
  async claimUnnotified(
    tx: Tx,
    input: { readonly shopId: string | null; readonly limit: number },
  ): Promise<readonly EtaEntry[]> {
    const result = await tx.execute<EtaEntryRow>(sql`
      select
        id, shop_id, job_card_id, version, previous_eta, eta, promised_at,
        reason::text as reason, materiality::text as materiality, delta_minutes,
        detail, status_signal_id, notified_at, created_at
      from eta_entries
      where notified_at is null
        and materiality <> 'IMMATERIAL'
        and (${input.shopId}::uuid is null or shop_id = ${input.shopId}::uuid)
      order by created_at asc
      limit ${input.limit}
      for update skip locked
    `);

    return result.rows.map(toEtaEntry);
  }
}

function toEtaEntry(row: EtaEntryRow): EtaEntry {
  return {
    id: row.id,
    shopId: row.shop_id,
    jobCardId: row.job_card_id,
    version: row.version,
    previousEta: maybeDate(row.previous_eta),
    eta: date(row.eta),
    promisedAt: maybeDate(row.promised_at),
    reason: row.reason,
    materiality: row.materiality,
    deltaMinutes: row.delta_minutes,
    detail: row.detail,
    statusSignalId: row.status_signal_id,
    notifiedAt: maybeDate(row.notified_at),
    createdAt: date(row.created_at),
  };
}

/* -------------------------------------------------------------------------- *
 * Technician status signals
 * -------------------------------------------------------------------------- */

type StatusSignalRow = {
  id: string;
  shop_id: string;
  job_card_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  media_id: string | null;
  sender_staff_id: string | null;
  signal_type: StatusSignalType;
  source: StatusSignalSource;
  route: StatusSignalRoute;
  confidence_bp: number;
  transcript: string;
  language: Language;
  transcript_confidence_bp: number | null;
  work_item_ids: unknown;
  eta_hint: Date | string | null;
  candidate_job_card_ids: unknown;
  match_basis: string | null;
  applied_detail: string | null;
  created_at: Date | string;
}

/** `jsonb` arrives as parsed JSON; anything that is not an array of ids is none. */
function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export class PgStatusSignalStore implements StatusSignalStore<Tx> {
  /**
   * Inserts, or returns null when this inbound message already produced a
   * signal.
   *
   * `status_signals_message_key` is the guard, and `ON CONFLICT DO NOTHING`
   * turns "already captured" into an empty result rather than an exception —
   * a redelivered staff-group webhook must not close the same work item twice.
   *
   * The index covers `(shop_id, message_id)` and Postgres treats nulls as
   * distinct, so a console-originated signal with no message is never blocked
   * by another one.
   *
   * `created_at` is written from the record rather than left to the column's
   * `defaultNow()`. The domain owns the clock — that is what makes the
   * fake-clock silent-bay and ETA tests mean anything — and a store that
   * quietly substituted `now()` would make those suites pass in memory and
   * behave differently against SQL.
   */
  async insert(tx: Tx, record: StatusSignalRecord): Promise<string | null> {
    const result = await tx.execute<{ id: string }>(sql`
      insert into status_signals (
        id, shop_id, job_card_id, conversation_id, message_id, media_id, sender_staff_id,
        signal_type, source, route, confidence_bp, transcript, language,
        transcript_confidence_bp, work_item_ids, eta_hint, candidate_job_card_ids,
        match_basis, applied_detail, created_at
      ) values (
        ${record.id}, ${record.shopId}, ${record.jobCardId}, ${record.conversationId},
        ${record.messageId}, ${record.mediaId}, ${record.senderStaffId},
        ${record.signalType}::status_signal_type, ${record.source}::status_signal_source,
        ${record.route}::status_signal_route, ${toBp(record.confidence)},
        ${record.transcript}, ${record.language}::language,
        ${record.transcriptConfidence === null ? null : toBp(record.transcriptConfidence)},
        ${JSON.stringify(record.workItemIds)}::jsonb, ${record.etaHint},
        ${JSON.stringify(record.candidateJobCardIds)}::jsonb,
        ${record.matchBasis}, ${record.appliedDetail}, ${record.createdAt}
      )
      on conflict (shop_id, message_id) do nothing
      returning id
    `);

    return result.rows[0]?.id ?? null;
  }

  async load(tx: Tx, shopId: string, signalId: string): Promise<StatusSignalRecord | null> {
    const result = await tx.execute<StatusSignalRow>(sql`
      ${selectSignal()}
      where id = ${signalId} and shop_id = ${shopId}
    `);
    const row = result.rows[0];
    return row === undefined ? null : toStatusSignal(row);
  }

  /**
   * Claims a signal awaiting a human.
   *
   * `FOR UPDATE` because the confirmation goes to a *group*: two advisors
   * tapping ✅ on the same card is normal, and it must apply once.
   */
  async lockPending(tx: Tx, shopId: string, signalId: string): Promise<StatusSignalRecord | null> {
    const result = await tx.execute<StatusSignalRow>(sql`
      ${selectSignal()}
      where id = ${signalId} and shop_id = ${shopId}
        and route in ('PENDING_CONFIRMATION', 'AMBIGUOUS')
      for update
    `);
    const row = result.rows[0];
    return row === undefined ? null : toStatusSignal(row);
  }

  async resolve(
    tx: Tx,
    input: {
      readonly signalId: string;
      readonly route: StatusSignalRoute;
      readonly jobCardId: string | null;
      readonly workItemIds: readonly string[];
      readonly staffId: string | null;
      readonly appliedDetail: string;
      readonly at: Date;
    },
  ): Promise<void> {
    await tx.execute(sql`
      update status_signals
      set route = ${input.route}::status_signal_route,
          job_card_id = coalesce(${input.jobCardId}::uuid, job_card_id),
          work_item_ids = ${JSON.stringify(input.workItemIds)}::jsonb,
          resolved_by_staff_id = ${input.staffId},
          resolved_at = ${input.at},
          applied_detail = ${input.appliedDetail},
          updated_at = now()
      where id = ${input.signalId}
    `);
  }

  async pending(tx: Tx, shopId: string, limit: number): Promise<readonly StatusSignalRecord[]> {
    const result = await tx.execute<StatusSignalRow>(sql`
      ${selectSignal()}
      where shop_id = ${shopId} and route in ('PENDING_CONFIRMATION', 'AMBIGUOUS')
      order by created_at desc
      limit ${limit}
    `);
    return result.rows.map(toStatusSignal);
  }

  async lastSignalAt(
    tx: Tx,
    shopId: string,
    jobCardIds: readonly string[],
  ): Promise<ReadonlyMap<string, Date>> {
    if (jobCardIds.length === 0) return new Map();

    const result = await tx.execute<{ job_card_id: string; last_at: Date | string }>(sql`
      select job_card_id, max(created_at) as last_at
      from status_signals
      where shop_id = ${shopId}
        and job_card_id = any(${sql.raw(`ARRAY['${jobCardIds.join("','")}']::uuid[]`)})
      group by job_card_id
    `);

    return new Map(result.rows.map((row) => [row.job_card_id, date(row.last_at)]));
  }
}

function selectSignal() {
  return sql`
    select
      id, shop_id, job_card_id, conversation_id, message_id, media_id, sender_staff_id,
      signal_type::text as signal_type, source::text as source, route::text as route,
      confidence_bp, transcript, language::text as language, transcript_confidence_bp,
      work_item_ids, eta_hint, candidate_job_card_ids, match_basis, applied_detail, created_at
    from status_signals
  `;
}

function toStatusSignal(row: StatusSignalRow): StatusSignalRecord {
  return {
    id: row.id,
    shopId: row.shop_id,
    jobCardId: row.job_card_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    mediaId: row.media_id,
    senderStaffId: row.sender_staff_id,
    signalType: row.signal_type,
    source: row.source,
    route: row.route,
    confidence: fromBp(row.confidence_bp),
    transcript: row.transcript,
    language: row.language,
    transcriptConfidence:
      row.transcript_confidence_bp === null ? null : fromBp(row.transcript_confidence_bp),
    workItemIds: stringArray(row.work_item_ids),
    etaHint: maybeDate(row.eta_hint),
    candidateJobCardIds: stringArray(row.candidate_job_card_ids),
    matchBasis: row.match_basis,
    appliedDetail: row.applied_detail,
    createdAt: date(row.created_at),
  };
}

/* -------------------------------------------------------------------------- *
 * Card resolution
 * -------------------------------------------------------------------------- */

type CandidateRow = {
  job_card_id: string;
  code: string;
  registration: string;
  make: string | null;
  model: string | null;
  state: JobCardState;
  assigned_technician_id: string | null;
  last_touched_at: Date | string;
}

/**
 * States a technician's note may be about.
 *
 * A delivered or cancelled card is not one somebody is working on, and offering
 * it as a match is how a "done" lands on last week's visit.
 */
const RESOLVABLE_STATES = sql`('OPEN', 'IN_DIAGNOSIS', 'AWAITING_APPROVAL', 'IN_PROGRESS', 'AWAITING_PARTS', 'QUALITY_CHECK')`;

export class PgCardResolver implements CardResolver<Tx> {
  /**
   * Cards whose registration ends with the spoken fragment.
   *
   * The suffix match is done in SQL to keep the scan bounded, and then
   * re-checked in the domain by `registrationMatches` — which owns the
   * four-character floor. Two places agreeing is not duplication here: SQL
   * narrows, the domain decides, and only the domain's answer is used.
   */
  async byRegistrationFragment(
    tx: Tx,
    shopId: string,
    fragment: string,
  ): Promise<readonly CardCandidate[]> {
    const needle = fragment.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (needle.length < 4) return [];

    const result = await tx.execute<CandidateRow>(sql`
      ${selectCandidate()}
      where jc.shop_id = ${shopId}
        and jc.deleted_at is null
        and jc.state::text in ${RESOLVABLE_STATES}
        and v.registration_normalised like ${`%${needle}`}
      order by jc.state_changed_at desc
      limit 10
    `);

    return result.rows
      .map((row) => toCandidate(row, 'REGISTRATION'))
      .filter((candidate) => registrationMatches(needle, candidate.registration));
  }

  async byTechnician(tx: Tx, shopId: string, staffId: string): Promise<readonly CardCandidate[]> {
    const result = await tx.execute<CandidateRow>(sql`
      ${selectCandidate()}
      where jc.shop_id = ${shopId}
        and jc.deleted_at is null
        and jc.state::text in ${RESOLVABLE_STATES}
        and jc.assigned_technician_id = ${staffId}
      order by jc.state_changed_at desc
      limit 10
    `);

    return result.rows.map((row) => toCandidate(row, 'ASSIGNMENT'));
  }

  /**
   * The card a staff-group message was about.
   *
   * Read off `messages.job_card_id`, which is set on every card-pinned message
   * the shop sends — so "reply to the message about this car" resolves without
   * the technician typing anything.
   */
  async byReplyContext(tx: Tx, shopId: string, messageId: string): Promise<CardCandidate | null> {
    const result = await tx.execute<CandidateRow>(sql`
      ${selectCandidate()}
      join messages m on m.job_card_id = jc.id
      where jc.shop_id = ${shopId}
        and jc.deleted_at is null
        and m.id = ${messageId}
        and m.shop_id = ${shopId}
      limit 1
    `);

    const row = result.rows[0];
    return row === undefined ? null : toCandidate(row, 'REPLY_CONTEXT');
  }

  /**
   * Labels for cards the resolver already picked out.
   *
   * No state filter, unlike every other read here: a signal can sit in the
   * confirm queue while its card moves on, and a queue that silently dropped
   * the row rather than showing it would look to an advisor like a tap that
   * went nowhere.
   */
  async byIds(
    tx: Tx,
    shopId: string,
    ids: readonly string[],
  ): Promise<readonly CardCandidate[]> {
    if (ids.length === 0) return [];

    const result = await tx.execute<CandidateRow>(sql`
      ${selectCandidate()}
      where jc.shop_id = ${shopId}
        and jc.deleted_at is null
        and jc.id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})
    `);

    return result.rows.map((row) => toCandidate(row, 'CODE'));
  }

  async byCode(tx: Tx, shopId: string, code: string): Promise<CardCandidate | null> {
    const result = await tx.execute<CandidateRow>(sql`
      ${selectCandidate()}
      where jc.shop_id = ${shopId} and jc.deleted_at is null and upper(jc.code) = ${code.toUpperCase()}
      limit 1
    `);

    const row = result.rows[0];
    return row === undefined ? null : toCandidate(row, 'CODE');
  }
}

function selectCandidate() {
  return sql`
    select
      jc.id as job_card_id, jc.code, v.registration_normalised as registration,
      v.make, v.model, jc.state::text as state, jc.assigned_technician_id,
      jc.state_changed_at as last_touched_at
    from job_cards jc
    join vehicles v on v.id = jc.vehicle_id
  `;
}

function toCandidate(row: CandidateRow, basis: CardCandidate['basis']): CardCandidate {
  return {
    jobCardId: row.job_card_id,
    code: row.code,
    registration: row.registration,
    vehicleLabel: [row.make, row.model].filter((part) => part !== null).join(' ') || 'Vehicle',
    state: row.state,
    basis,
    assignedTechnicianId: row.assigned_technician_id,
    lastTouchedAt: date(row.last_touched_at),
  };
}

/* -------------------------------------------------------------------------- *
 * Silent-bay sentinel
 * -------------------------------------------------------------------------- */

type SilentCardRow = {
  job_card_id: string;
  code: string;
  state: JobCardState;
  registration: string;
  make: string | null;
  model: string | null;
  assigned_technician_id: string | null;
  technician_name: string | null;
  last_signal_at: Date | string;
}

export class PgSilentBayStore implements SilentBayStore<Tx> {
  /**
   * Active cards and when each was last heard from.
   *
   * "Heard from" is the newest of three things, and taking the maximum in SQL
   * is what keeps the scan one query: the last state change, the last
   * technician signal, and the last media captured against the card. A bay with
   * a photograph in it from twenty minutes ago is plainly being worked in, and
   * nudging about it would be noise the staff group learns to ignore.
   */
  async activeCards(tx: Tx, shopId: string): Promise<readonly SilentCard[]> {
    const result = await tx.execute<SilentCardRow>(sql`
      select
        jc.id as job_card_id, jc.code, jc.state::text as state,
        v.registration_normalised as registration, v.make, v.model,
        jc.assigned_technician_id, s.full_name as technician_name,
        greatest(
          jc.state_changed_at,
          coalesce((
            select max(ss.created_at) from status_signals ss
            where ss.job_card_id = jc.id
          ), jc.state_changed_at),
          coalesce((
            select max(coalesce(ma.captured_at, ma.created_at)) from media_assets ma
            where ma.job_card_id = jc.id and ma.deleted_at is null
          ), jc.state_changed_at)
        ) as last_signal_at
      from job_cards jc
      join vehicles v on v.id = jc.vehicle_id
      left join staff s on s.id = jc.assigned_technician_id
      where jc.shop_id = ${shopId}
        and jc.deleted_at is null
        and jc.state::text in ('IN_DIAGNOSIS', 'IN_PROGRESS', 'QUALITY_CHECK')
      order by last_signal_at asc
    `);

    return result.rows.map((row) => ({
      jobCardId: row.job_card_id,
      code: row.code,
      state: row.state,
      registration: row.registration,
      vehicleLabel: [row.make, row.model].filter((part) => part !== null).join(' ') || 'Vehicle',
      assignedTechnicianId: row.assigned_technician_id,
      // `staff.full_name` is plain text, unlike `customers.full_name_encrypted`:
      // a technician's name is the shop's own employment record, not a data
      // principal's PII under DPDP, and the nudge names them to their
      // colleagues in a group they are already in.
      assignedTechnicianName: row.technician_name,
      lastSignalAt: date(row.last_signal_at),
    }));
  }

  /**
   * Claims `(job_card_id, window_start)`.
   *
   * The unique index is the entire idempotency story: two workers, a restart,
   * or a scan that runs every five minutes all produce one nudge per window
   * rather than one per scan.
   */
  async claimWindow(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly jobCardId: string;
      readonly windowStart: Date;
      readonly state: JobCardState;
      readonly quietForMinutes: number;
      readonly consecutiveWindows: number;
    },
  ): Promise<string | null> {
    const result = await tx.execute<{ id: string }>(sql`
      insert into silent_bay_nudges (
        id, shop_id, job_card_id, window_start, state, quiet_for_minutes, consecutive_windows
      ) values (
        ${input.id}, ${input.shopId}, ${input.jobCardId}, ${input.windowStart},
        ${input.state}::job_card_state, ${input.quietForMinutes}, ${input.consecutiveWindows}
      )
      on conflict (job_card_id, window_start) do nothing
      returning id
    `);

    return result.rows[0]?.id ?? null;
  }

  async consecutiveWindows(
    tx: Tx,
    shopId: string,
    jobCardId: string,
    since: Date,
  ): Promise<number> {
    const result = await tx.execute<{ count: string | number }>(sql`
      select count(*) as count
      from silent_bay_nudges
      where shop_id = ${shopId} and job_card_id = ${jobCardId} and window_start >= ${since}
    `);

    return Number(result.rows[0]?.count ?? 0);
  }

  async attachMessage(tx: Tx, nudgeId: string, messageId: string | null): Promise<void> {
    await tx.execute(sql`
      update silent_bay_nudges set message_id = ${messageId} where id = ${nudgeId}
    `);
  }

  async markEscalated(tx: Tx, nudgeIds: readonly string[]): Promise<void> {
    if (nudgeIds.length === 0) return;
    await tx.execute(sql`
      update silent_bay_nudges
      set escalated_to_owner = true
      where id = any(${sql.raw(`ARRAY['${nudgeIds.join("','")}']::uuid[]`)})
    `);
  }
}

/* -------------------------------------------------------------------------- *
 * Coalescing window
 * -------------------------------------------------------------------------- */

export class PgStatusCommsStore implements StatusCommsStore<Tx> {
  /**
   * When this customer was last written to about this car.
   *
   * A read over `messages` rather than a counter of its own: the message log
   * already holds this fact, and a second copy is a second thing to keep in
   * step with it. `BLOCKED` rows are excluded — a message the gate refused was
   * never received, so it cannot have been an interruption.
   */
  async lastStatusUpdateAt(tx: Tx, shopId: string, jobCardId: string): Promise<Date | null> {
    const result = await tx.execute<{ last_at: Date | string | null }>(sql`
      select max(coalesce(sent_at, created_at)) as last_at
      from messages
      where shop_id = ${shopId}
        and job_card_id = ${jobCardId}
        and direction = 'OUTBOUND'
        and status <> 'BLOCKED'
    `);

    return maybeDate(result.rows[0]?.last_at ?? null);
  }
}
