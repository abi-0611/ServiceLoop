import { migrateShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  applyCorrection,
  type Clock,
  type DraftCorrection,
  type EventEnvelope,
  type IntakeSource,
  type JobCardDraft,
  JobCardDraftSchema,
  lowConfidenceFields,
  normaliseRegistration,
  overallConfidence,
  systemClock,
  uuidv7,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { JobCardTransitionService } from '../job-card/transition-service';
import type { AuditAppender, OutboxWriter, ShopConfigStore, UnitOfWork } from '../ports';
import { type EntityResolutionService, type Resolution } from './entity-resolution';
import type { DraftRecord, DraftStore, JobCardWriter } from './ports';

/**
 * Zero-migration intake (L2), from extraction to a real job card.
 *
 * The invariant that makes this safe: **nothing an extractor produces becomes a
 * record without a human saying so.** A draft is inert. It carries per-field
 * confidence, it can be corrected, and only `confirm()` turns it into a
 * Customer, a Vehicle, a JobCard, WorkItems and an estimate — all through the
 * domain services, so the audit chain and the outbox see every step.
 */

export interface DraftCreatedResult {
  readonly draftId: string;
  readonly overallConfidence: number;
  readonly lowConfidencePaths: readonly string[];
  readonly needsConfirmation: boolean;
}

export interface ConfirmResult {
  readonly draftId: string;
  readonly jobCardId: string;
  readonly code: string;
  readonly customerId: string;
  readonly vehicleId: string;
  readonly workItemIds: readonly string[];
  readonly estimateId: string;
  readonly correctedFields: readonly string[];
  readonly suggestions: Resolution['suggestions'];
  /** Set when the card was created but could not be opened; see `confirm`. */
  readonly openFailure: string | null;
}

export interface IntakeServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly drafts: DraftStore<Tx>;
  readonly writer: JobCardWriter<Tx>;
  readonly entities: EntityResolutionService<Tx>;
  readonly config: ShopConfigStore<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly cards: Pick<JobCardTransitionService<Tx>, 'transition'>;
  readonly clock?: Clock;
}

export interface RecordDraftInput {
  readonly shopId: string;
  readonly source: IntakeSource;
  readonly draft: JobCardDraft;
  readonly conversationId?: string | null;
  readonly messageId?: string | null;
  readonly mediaId?: string | null;
  readonly submittedByStaffId?: string | null;
  readonly rawInput?: string | null;
  readonly extractorModel?: string | null;
  readonly extractorPromptHash?: string | null;
  readonly extractionMs?: number | null;
  readonly actor: Actor;
  readonly traceId: string;
}

export class DraftNotFoundError extends Error {
  constructor(readonly draftId: string) {
    super(`No intake draft ${draftId} in this shop`);
    this.name = 'DraftNotFoundError';
  }
}

export class DraftNotConfirmableError extends Error {
  constructor(
    readonly draftId: string,
    readonly status: string,
  ) {
    super(`Draft ${draftId} is ${status} and can no longer be confirmed`);
    this.name = 'DraftNotConfirmableError';
  }
}

export class IntakeService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: IntakeServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Persists an extracted draft and works out which fields need a human. */
  async recordDraft(input: RecordDraftInput): Promise<DraftCreatedResult> {
    const draft = JobCardDraftSchema.parse(input.draft);

    return this.deps.uow.transaction(async (tx) => {
      const config = await this.loadConfig(tx, input.shopId);
      const threshold = config.intake.confirmationThreshold;

      const confidence = overallConfidence(draft);
      const lowConfidence = lowConfidenceFields(draft, threshold);
      const lowConfidencePaths = lowConfidence.map((entry) => entry.path);

      const draftId = uuidv7();
      const now = this.clock.now();

      await this.deps.drafts.insert(tx, {
        id: draftId,
        shopId: input.shopId,
        source: input.source,
        conversationId: input.conversationId ?? null,
        messageId: input.messageId ?? null,
        mediaId: input.mediaId ?? null,
        submittedByStaffId: input.submittedByStaffId ?? null,
        rawInput: input.rawInput ?? null,
        draft,
        confidenceMilli: Math.round(confidence * 1000),
        lowConfidenceFields: lowConfidencePaths,
        extractorModel: input.extractorModel ?? null,
        extractorPromptHash: input.extractorPromptHash ?? null,
        extractionMs: input.extractionMs ?? null,
        createdAt: now,
      });

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'intake.draft_created',
        entityType: 'JobCardDraft',
        entityId: draftId,
        payload: {
          source: input.source,
          overallConfidence: confidence,
          lowConfidenceFields: lowConfidencePaths,
          extractorModel: input.extractorModel ?? null,
          extractorPromptHash: input.extractorPromptHash ?? null,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'intake.draft_created',
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        payload: {
          draftId,
          source: input.source,
          conversationId: input.conversationId ?? null,
          mediaId: input.mediaId ?? null,
          overallConfidence: confidence,
          lowConfidenceFields: lowConfidencePaths,
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);

      return {
        draftId,
        overallConfidence: confidence,
        lowConfidencePaths,
        // Every draft needs confirmation. The threshold decides how many fields
        // are *flagged*, never whether a human is asked at all.
        needsConfirmation: true,
      };
    });
  }

  async load(shopId: string, draftId: string): Promise<DraftRecord | null> {
    return this.deps.uow.transaction(async (tx) => this.deps.drafts.load(tx, shopId, draftId));
  }

  /** The draft a free-text correction on a thread refers to. */
  async openDraftForConversation(
    shopId: string,
    conversationId: string,
  ): Promise<DraftRecord | null> {
    return this.deps.uow.transaction(async (tx) =>
      this.deps.drafts.findOpenForConversation(tx, shopId, conversationId),
    );
  }

  /**
   * Applies a staff correction. The corrected field jumps to confidence 1 and
   * the change is recorded with its previous value, so the OCR eval can later
   * learn from exactly what the model got wrong.
   */
  async correct(input: {
    readonly shopId: string;
    readonly draftId: string;
    readonly path: string;
    readonly value: string;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<{ draft: JobCardDraft; correction: DraftCorrection }> {
    return this.deps.uow.transaction(async (tx) => {
      const record = await this.deps.drafts.lock(tx, input.shopId, input.draftId);
      if (record === null) throw new DraftNotFoundError(input.draftId);
      if (record.status !== 'AWAITING_CONFIRMATION') {
        throw new DraftNotConfirmableError(input.draftId, record.status);
      }

      const config = await this.loadConfig(tx, input.shopId);
      const { draft, previousValue } = applyCorrection(record.draft, input.path, input.value);

      const correction: DraftCorrection = {
        path: input.path,
        previousValue,
        value: input.value,
        correctedBy: input.actor.id,
        correctedAt: this.clock.now().toISOString(),
      };
      const corrections = [...record.corrections, correction];

      await this.deps.drafts.update(tx, {
        shopId: input.shopId,
        draftId: input.draftId,
        draft,
        corrections,
        confidenceMilli: Math.round(overallConfidence(draft) * 1000),
        lowConfidenceFields: lowConfidenceFields(draft, config.intake.confirmationThreshold).map(
          (entry) => entry.path,
        ),
      });

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'intake.draft_corrected',
        entityType: 'JobCardDraft',
        entityId: input.draftId,
        payload: { path: input.path, previousValue, value: input.value },
        traceId: input.traceId,
      });

      return { draft, correction };
    });
  }

  async discard(input: {
    readonly shopId: string;
    readonly draftId: string;
    readonly actor: Actor;
    readonly traceId: string;
  }): Promise<void> {
    await this.deps.uow.transaction(async (tx) => {
      const record = await this.deps.drafts.lock(tx, input.shopId, input.draftId);
      if (record === null) throw new DraftNotFoundError(input.draftId);

      await this.deps.drafts.settle(tx, {
        shopId: input.shopId,
        draftId: input.draftId,
        status: 'DISCARDED',
        jobCardId: null,
        resolvedCustomerId: null,
        resolvedVehicleId: null,
        failureReason: null,
        at: this.clock.now(),
      });

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'intake.draft_discarded',
        entityType: 'JobCardDraft',
        entityId: input.draftId,
        payload: { source: record.source },
        traceId: input.traceId,
      });
    });
  }

  /**
   * Turns a confirmed draft into a real job card.
   *
   * Everything but the final state transition happens in one transaction:
   * entity resolution, the card, its work items and estimate v1, and settling
   * the draft. The `DRAFT → OPEN` transition then runs through
   * `JobCardTransitionService` in its own transaction, because that service
   * owns transitions and opens its own — nesting it would mean a second
   * database transaction on the same connection rather than a savepoint.
   *
   * If that last step fails, the card exists in `DRAFT` on the board with the
   * failure recorded on the result: visible and recoverable, never lost.
   */
  async confirm(input: {
    readonly shopId: string;
    readonly draftId: string;
    readonly actor: Actor;
    readonly traceId: string;
    readonly assignedAdvisorId?: string | null;
  }): Promise<ConfirmResult> {
    const prepared = await this.deps.uow.transaction(async (tx) => {
      const record = await this.deps.drafts.lock(tx, input.shopId, input.draftId);
      if (record === null) throw new DraftNotFoundError(input.draftId);
      if (record.status !== 'AWAITING_CONFIRMATION') {
        throw new DraftNotConfirmableError(input.draftId, record.status);
      }

      const config = await this.loadConfig(tx, input.shopId);
      const draft = record.draft;

      const resolution = await this.deps.entities.resolveIn(tx, {
        shopId: input.shopId,
        customer: {
          fullName: draft.customer.name.value,
          phone: draft.customer.phone.value,
          preferredLanguage: draft.language,
        },
        vehicle: {
          registration: draft.vehicle.registration.value,
          make: draft.vehicle.make.value,
          model: draft.vehicle.model.value,
          odometerKm: draft.vehicle.odometerKm.value,
        },
        draftId: input.draftId,
        actor: input.actor,
        traceId: input.traceId,
        defaultLanguage: config.languages.default,
      });

      const now = this.clock.now();
      const jobCardId = uuidv7();
      const code = await this.deps.writer.nextJobCardCode(tx, input.shopId, now);

      await this.deps.writer.createJobCard(tx, {
        id: jobCardId,
        shopId: input.shopId,
        customerId: resolution.customerId,
        vehicleId: resolution.vehicleId,
        code,
        source: SOURCE_BY_INTAKE[record.source],
        complaintText:
          draft.complaints.length === 0
            ? null
            : draft.complaints.map((complaint) => complaint.value).join('; '),
        odometerKm: draft.vehicle.odometerKm.value,
        promisedAt: parsePromisedAt(draft.promisedAt.value),
        assignedAdvisorId: input.assignedAdvisorId ?? record.submittedByStaffId ?? null,
        language: draft.language,
      });

      // One work item per complaint keeps the technician's unit of work aligned
      // with what the customer actually reported. An estimate line with no
      // matching complaint becomes its own item.
      const workItems = buildWorkItems(draft, input.shopId, jobCardId);
      await this.deps.writer.createWorkItems(tx, workItems);

      const estimateId = uuidv7();
      await this.deps.writer.createEstimate(tx, {
        id: estimateId,
        shopId: input.shopId,
        jobCardId,
        version: 1,
        createdById: input.actor.type === 'STAFF' ? input.actor.id : null,
        lines: draft.estimateLines.map((line, index) => ({
          workItemId: workItems[index]?.id ?? workItems[0]?.id ?? null,
          kind: 'LABOUR' as const,
          description: line.description.value,
          quantityMilli: line.quantityMilli.value,
          unitPricePaise: line.unitPricePaise.value ?? 0,
        })),
      });

      await this.deps.drafts.settle(tx, {
        shopId: input.shopId,
        draftId: input.draftId,
        status: 'CONFIRMED',
        jobCardId,
        resolvedCustomerId: resolution.customerId,
        resolvedVehicleId: resolution.vehicleId,
        failureReason: null,
        at: now,
      });

      const correctedFields = record.corrections.map((correction) => correction.path);

      await this.deps.audit.append(tx, {
        shopId: input.shopId,
        actorType: input.actor.type,
        actorId: input.actor.id,
        action: 'intake.draft_confirmed',
        entityType: 'JobCardDraft',
        entityId: input.draftId,
        payload: {
          jobCardId,
          code,
          source: record.source,
          // The provenance a phase-2 acceptance check looks for: which model
          // read the card, and which fields a human then fixed.
          extractorModel: record.extractorModel,
          correctedFields,
          customerCreated: resolution.customerCreated,
          vehicleCreated: resolution.vehicleCreated,
        },
        traceId: input.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'intake.draft_confirmed',
        occurredAt: now.toISOString(),
        shopId: input.shopId,
        traceId: input.traceId,
        payload: {
          draftId: input.draftId,
          jobCardId,
          customerId: resolution.customerId,
          vehicleId: resolution.vehicleId,
          source: record.source,
          correctedFields,
          actor: { type: input.actor.type, id: input.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);

      return {
        draftId: input.draftId,
        jobCardId,
        code,
        customerId: resolution.customerId,
        vehicleId: resolution.vehicleId,
        workItemIds: workItems.map((item) => item.id),
        estimateId,
        correctedFields,
        suggestions: resolution.suggestions,
      };
    });

    let openFailure: string | null = null;
    try {
      await this.deps.cards.transition({
        shopId: input.shopId,
        jobCardId: prepared.jobCardId,
        event: 'OPEN_CARD',
        actor: input.actor,
        traceId: input.traceId,
        meta: { source: 'intake', draftId: input.draftId },
      });
    } catch (error) {
      openFailure = error instanceof Error ? error.message : String(error);
    }

    return { ...prepared, openFailure };
  }

  private async loadConfig(tx: Tx, shopId: string): Promise<ShopConfig> {
    const stored = await this.deps.config.load(tx, shopId);
    const timezone = (await this.deps.config.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
    return migrateShopConfig(stored?.raw ?? {}, timezone).config;
  }
}

const SOURCE_BY_INTAKE = {
  PHOTO: 'PAPER_CARD',
  FORWARDED_TEXT: 'WHATSAPP',
  VOICE_NOTE: 'WHATSAPP',
  CONSOLE_FORM: 'CONSOLE',
} as const satisfies Record<IntakeSource, 'PAPER_CARD' | 'WHATSAPP' | 'CONSOLE'>;

function buildWorkItems(
  draft: JobCardDraft,
  shopId: string,
  jobCardId: string,
): Array<{
  id: string;
  shopId: string;
  jobCardId: string;
  title: string;
  description: string | null;
  sequence: number;
}> {
  const titles =
    draft.complaints.length > 0
      ? draft.complaints.map((complaint) => complaint.value)
      : draft.estimateLines.map((line) => line.description.value);

  const effective = titles.length > 0 ? titles : ['Inspection'];

  return effective.map((title, index) => ({
    id: uuidv7(),
    shopId,
    jobCardId,
    title: title.slice(0, 200),
    description: null,
    sequence: index,
  }));
}

/**
 * A paper card says "evening" or "5pm", not an ISO timestamp. The extractor
 * resolves what it can; anything it could not is kept as prose on the card
 * rather than guessed into a date the ETA engine would then treat as a promise.
 */
function parsePromisedAt(value: string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Re-exported so callers do not need a second import for validation. */
export { normaliseRegistration };
