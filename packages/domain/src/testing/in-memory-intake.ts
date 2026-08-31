import type {
  DraftCorrection,
  IntakeDraftStatus,
  JobCardDraft,
  Language,
} from '@serviceloop/shared';
import type {
  CustomerMatch,
  EntityLookup,
  VehicleMatch,
} from '../intake/entity-resolution';
import type {
  CreateEstimateLineInput,
  CreateJobCardInput,
  CreateWorkItemInput,
  DraftRecord,
  DraftStore,
  InsertDraftInput,
  JobCardWriter,
} from '../intake/ports';
import type { InMemoryWorld, MemoryTx } from './in-memory';

/**
 * In-memory intake ports.
 *
 * The uniqueness rules the database enforces are enforced here too — one
 * vehicle per normalised registration per shop, one open merge suggestion per
 * entity pair — because those constraints are exactly what the resolution tests
 * are about. A double-booked registration must fail the same way in both.
 */

export interface VehicleRow {
  id: string;
  shopId: string;
  customerId: string;
  registrationRaw: string;
  registrationNormalised: string;
  make: string | null;
  model: string | null;
  odometerKm: number | null;
}

export interface CustomerRow {
  id: string;
  shopId: string;
  fullName: string;
  phoneE164: string;
  preferredLanguage: Language;
}

export interface MergeSuggestionRow {
  id: string;
  shopId: string;
  kind: 'CUSTOMER' | 'VEHICLE';
  primaryEntityId: string;
  candidateEntityId: string;
  reason: string;
  scoreMilli: number;
  status: 'OPEN' | 'MERGED' | 'REJECTED';
}

export interface DraftRow extends DraftRecord {
  resolvedCustomerId: string | null;
  resolvedVehicleId: string | null;
}

export interface IntakeWorld {
  readonly vehicles: Map<string, VehicleRow>;
  readonly customerRows: Map<string, CustomerRow>;
  readonly suggestions: MergeSuggestionRow[];
  readonly drafts: Map<string, DraftRow>;
  readonly workItems: CreateWorkItemInput[];
  readonly estimates: Array<{
    id: string;
    jobCardId: string;
    version: number;
    lines: readonly CreateEstimateLineInput[];
  }>;
  readonly jobCards: Map<string, CreateJobCardInput>;
  codeSequence: number;
}

export function createIntakeWorld(): IntakeWorld {
  return {
    vehicles: new Map(),
    customerRows: new Map(),
    suggestions: [],
    drafts: new Map(),
    workItems: [],
    estimates: [],
    jobCards: new Map(),
    codeSequence: 0,
  };
}

export class InMemoryEntityLookup implements EntityLookup<MemoryTx> {
  constructor(
    private readonly intake: IntakeWorld,
    private readonly world: InMemoryWorld,
  ) {}

  async findVehicleByRegistration(
    _tx: MemoryTx,
    shopId: string,
    registrationNormalised: string,
  ): Promise<VehicleMatch | null> {
    const row = [...this.intake.vehicles.values()].find(
      (candidate) =>
        candidate.shopId === shopId &&
        candidate.registrationNormalised === registrationNormalised,
    );
    return row === undefined ? null : toVehicleMatch(row);
  }

  async findVehiclesByRegistrationPrefix(
    _tx: MemoryTx,
    shopId: string,
    prefix: string,
    limit: number,
  ): Promise<readonly VehicleMatch[]> {
    return [...this.intake.vehicles.values()]
      .filter(
        (row) => row.shopId === shopId && row.registrationNormalised.startsWith(prefix),
      )
      .slice(0, limit)
      .map(toVehicleMatch);
  }

  async findCustomerByPhone(
    _tx: MemoryTx,
    shopId: string,
    phoneE164: string,
  ): Promise<CustomerMatch | null> {
    const row = [...this.intake.customerRows.values()].find(
      (candidate) => candidate.shopId === shopId && candidate.phoneE164 === phoneE164,
    );
    return row === undefined ? null : toCustomerMatch(row);
  }

  async findCustomerById(
    _tx: MemoryTx,
    shopId: string,
    customerId: string,
  ): Promise<CustomerMatch | null> {
    const row = this.intake.customerRows.get(customerId);
    return row === undefined || row.shopId !== shopId ? null : toCustomerMatch(row);
  }

  async createCustomer(
    _tx: MemoryTx,
    input: {
      id: string;
      shopId: string;
      fullName: string;
      phoneE164: string;
      preferredLanguage: Language;
    },
  ): Promise<void> {
    const clash = [...this.intake.customerRows.values()].some(
      (row) => row.shopId === input.shopId && row.phoneE164 === input.phoneE164,
    );
    if (clash) throw new Error(`customers_shop_phone_hash_key: ${input.shopId} already has this number`);

    this.intake.customerRows.set(input.id, { ...input });
    // Keep the messaging lookup in step, so a customer created by intake is
    // immediately recognisable when they message the shop.
    this.world.addCustomer(input.shopId, input.phoneE164, input.id, input.preferredLanguage);
  }

  async createVehicle(
    _tx: MemoryTx,
    input: {
      id: string;
      shopId: string;
      customerId: string;
      registrationRaw: string;
      registrationNormalised: string;
      make: string | null;
      model: string | null;
      odometerKm: number | null;
    },
  ): Promise<void> {
    const clash = [...this.intake.vehicles.values()].some(
      (row) =>
        row.shopId === input.shopId &&
        row.registrationNormalised === input.registrationNormalised,
    );
    if (clash) {
      throw new Error(
        `vehicles_shop_registration_key: ${input.registrationNormalised} already exists in this shop`,
      );
    }
    this.intake.vehicles.set(input.id, { ...input });
  }

  async recordMergeSuggestion(
    _tx: MemoryTx,
    input: {
      id: string;
      shopId: string;
      kind: 'CUSTOMER' | 'VEHICLE';
      primaryEntityId: string;
      candidateEntityId: string;
      reason: string;
      scoreMilli: number;
      context: Readonly<Record<string, unknown>>;
      draftId: string | null;
    },
  ): Promise<boolean> {
    const duplicate = this.intake.suggestions.some(
      (row) =>
        row.shopId === input.shopId &&
        row.kind === input.kind &&
        row.primaryEntityId === input.primaryEntityId &&
        row.candidateEntityId === input.candidateEntityId,
    );
    if (duplicate) return false;

    this.intake.suggestions.push({
      id: input.id,
      shopId: input.shopId,
      kind: input.kind,
      primaryEntityId: input.primaryEntityId,
      candidateEntityId: input.candidateEntityId,
      reason: input.reason,
      scoreMilli: input.scoreMilli,
      status: 'OPEN',
    });
    return true;
  }
}

function toVehicleMatch(row: VehicleRow): VehicleMatch {
  return {
    id: row.id,
    customerId: row.customerId,
    registrationNormalised: row.registrationNormalised,
    make: row.make,
    model: row.model,
  };
}

function toCustomerMatch(row: CustomerRow): CustomerMatch {
  return { id: row.id, fullName: row.fullName, preferredLanguage: row.preferredLanguage };
}

export class InMemoryDraftStore implements DraftStore<MemoryTx> {
  constructor(private readonly intake: IntakeWorld) {}

  async insert(_tx: MemoryTx, input: InsertDraftInput): Promise<void> {
    this.intake.drafts.set(input.id, {
      id: input.id,
      shopId: input.shopId,
      source: input.source,
      status: 'AWAITING_CONFIRMATION',
      conversationId: input.conversationId,
      messageId: input.messageId,
      mediaId: input.mediaId,
      submittedByStaffId: input.submittedByStaffId,
      rawInput: input.rawInput,
      draft: input.draft,
      corrections: [],
      confidenceMilli: input.confidenceMilli,
      lowConfidenceFields: input.lowConfidenceFields,
      extractorModel: input.extractorModel,
      jobCardId: null,
      createdAt: input.createdAt,
      resolvedCustomerId: null,
      resolvedVehicleId: null,
    });
  }

  async load(_tx: MemoryTx, shopId: string, draftId: string): Promise<DraftRecord | null> {
    const row = this.intake.drafts.get(draftId);
    return row === undefined || row.shopId !== shopId ? null : row;
  }

  async lock(tx: MemoryTx, shopId: string, draftId: string): Promise<DraftRecord | null> {
    return this.load(tx, shopId, draftId);
  }

  async findOpenForConversation(
    _tx: MemoryTx,
    shopId: string,
    conversationId: string,
  ): Promise<DraftRecord | null> {
    // Newest first: a second photo supersedes the first as the thing being
    // corrected, which is what a person means by "no, the other one".
    const rows = [...this.intake.drafts.values()]
      .filter(
        (row) =>
          row.shopId === shopId &&
          row.conversationId === conversationId &&
          row.status === 'AWAITING_CONFIRMATION',
      )
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return rows[0] ?? null;
  }

  async update(
    _tx: MemoryTx,
    input: {
      shopId: string;
      draftId: string;
      draft: JobCardDraft;
      corrections: readonly DraftCorrection[];
      confidenceMilli: number;
      lowConfidenceFields: readonly string[];
    },
  ): Promise<void> {
    const row = this.intake.drafts.get(input.draftId);
    if (row === undefined) throw new Error(`No such draft ${input.draftId}`);
    this.intake.drafts.set(input.draftId, {
      ...row,
      draft: input.draft,
      corrections: input.corrections,
      confidenceMilli: input.confidenceMilli,
      lowConfidenceFields: input.lowConfidenceFields,
    });
  }

  async settle(
    _tx: MemoryTx,
    input: {
      shopId: string;
      draftId: string;
      status: IntakeDraftStatus;
      jobCardId: string | null;
      resolvedCustomerId: string | null;
      resolvedVehicleId: string | null;
      failureReason: string | null;
      at: Date;
    },
  ): Promise<void> {
    const row = this.intake.drafts.get(input.draftId);
    if (row === undefined) throw new Error(`No such draft ${input.draftId}`);
    this.intake.drafts.set(input.draftId, {
      ...row,
      status: input.status,
      jobCardId: input.jobCardId,
      resolvedCustomerId: input.resolvedCustomerId,
      resolvedVehicleId: input.resolvedVehicleId,
    });
  }
}

export class InMemoryJobCardWriter implements JobCardWriter<MemoryTx> {
  constructor(
    private readonly intake: IntakeWorld,
    private readonly world: InMemoryWorld,
  ) {}

  async nextJobCardCode(_tx: MemoryTx, _shopId: string, at: Date): Promise<string> {
    this.intake.codeSequence += 1;
    return `JC-${at.getUTCFullYear()}-${String(this.intake.codeSequence).padStart(4, '0')}`;
  }

  async createJobCard(_tx: MemoryTx, input: CreateJobCardInput): Promise<void> {
    this.intake.jobCards.set(input.id, input);
    // Registered on the shared world so `JobCardTransitionService` can drive it
    // to OPEN through the real transition path.
    this.world.addCard({ id: input.id, shopId: input.shopId, state: 'DRAFT' });
  }

  async createWorkItems(_tx: MemoryTx, items: readonly CreateWorkItemInput[]): Promise<void> {
    for (const item of items) {
      this.intake.workItems.push(item);
      this.world.addWorkItem({
        id: item.id,
        shopId: item.shopId,
        jobCardId: item.jobCardId,
        state: 'PROPOSED',
      });
    }
  }

  async createEstimate(
    _tx: MemoryTx,
    input: {
      id: string;
      shopId: string;
      jobCardId: string;
      version: number;
      lines: readonly CreateEstimateLineInput[];
      createdById: string | null;
    },
  ): Promise<void> {
    this.intake.estimates.push({
      id: input.id,
      jobCardId: input.jobCardId,
      version: input.version,
      lines: input.lines,
    });
  }
}
