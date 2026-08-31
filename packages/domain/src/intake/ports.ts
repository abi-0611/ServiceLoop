import type {
  IntakeDraftStatus,
  IntakeSource,
  JobCardDraft,
  DraftCorrection,
  Language,
} from '@serviceloop/shared';

/** Persistence ports for zero-migration intake. */

export interface DraftRecord {
  readonly id: string;
  readonly shopId: string;
  readonly source: IntakeSource;
  readonly status: IntakeDraftStatus;
  readonly conversationId: string | null;
  readonly messageId: string | null;
  readonly mediaId: string | null;
  readonly submittedByStaffId: string | null;
  readonly rawInput: string | null;
  readonly draft: JobCardDraft;
  readonly corrections: readonly DraftCorrection[];
  readonly confidenceMilli: number;
  readonly lowConfidenceFields: readonly string[];
  readonly extractorModel: string | null;
  readonly jobCardId: string | null;
  readonly createdAt: Date;
}

export interface InsertDraftInput {
  readonly id: string;
  readonly shopId: string;
  readonly source: IntakeSource;
  readonly conversationId: string | null;
  readonly messageId: string | null;
  readonly mediaId: string | null;
  readonly submittedByStaffId: string | null;
  readonly rawInput: string | null;
  readonly draft: JobCardDraft;
  readonly confidenceMilli: number;
  readonly lowConfidenceFields: readonly string[];
  readonly extractorModel: string | null;
  readonly extractorPromptHash: string | null;
  readonly extractionMs: number | null;
  readonly createdAt: Date;
}

export interface DraftStore<Tx> {
  insert(tx: Tx, input: InsertDraftInput): Promise<void>;
  load(tx: Tx, shopId: string, draftId: string): Promise<DraftRecord | null>;
  /** Locks the draft so two Confirm taps cannot both create a job card. */
  lock(tx: Tx, shopId: string, draftId: string): Promise<DraftRecord | null>;

  /** The draft awaiting confirmation on a thread, for a free-text correction. */
  findOpenForConversation(tx: Tx, shopId: string, conversationId: string): Promise<DraftRecord | null>;

  update(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly draftId: string;
      readonly draft: JobCardDraft;
      readonly corrections: readonly DraftCorrection[];
      readonly confidenceMilli: number;
      readonly lowConfidenceFields: readonly string[];
    },
  ): Promise<void>;

  settle(
    tx: Tx,
    input: {
      readonly shopId: string;
      readonly draftId: string;
      readonly status: IntakeDraftStatus;
      readonly jobCardId: string | null;
      readonly resolvedCustomerId: string | null;
      readonly resolvedVehicleId: string | null;
      readonly failureReason: string | null;
      readonly at: Date;
    },
  ): Promise<void>;
}

export interface CreateJobCardInput {
  readonly id: string;
  readonly shopId: string;
  readonly customerId: string;
  readonly vehicleId: string;
  readonly code: string;
  readonly source: 'PAPER_CARD' | 'WHATSAPP' | 'WALK_IN' | 'PHONE' | 'CONSOLE';
  readonly complaintText: string | null;
  readonly odometerKm: number | null;
  readonly promisedAt: Date | null;
  readonly assignedAdvisorId: string | null;
  readonly language: Language;
}

export interface CreateWorkItemInput {
  readonly id: string;
  readonly shopId: string;
  readonly jobCardId: string;
  readonly title: string;
  readonly description: string | null;
  readonly sequence: number;
}

export interface CreateEstimateLineInput {
  readonly workItemId: string | null;
  readonly kind: 'LABOUR' | 'PART' | 'CONSUMABLE' | 'FEE';
  readonly description: string;
  readonly quantityMilli: number;
  readonly unitPricePaise: number;
}

/**
 * Row creation for a confirmed draft. State *changes* still go through
 * `JobCardTransitionService`; this only writes the initial rows.
 */
export interface JobCardWriter<Tx> {
  /** Next `JC-YYYY-NNNN` for the shop, allocated inside the transaction. */
  nextJobCardCode(tx: Tx, shopId: string, at: Date): Promise<string>;
  createJobCard(tx: Tx, input: CreateJobCardInput): Promise<void>;
  createWorkItems(tx: Tx, items: readonly CreateWorkItemInput[]): Promise<void>;
  createEstimate(
    tx: Tx,
    input: {
      readonly id: string;
      readonly shopId: string;
      readonly jobCardId: string;
      readonly version: number;
      readonly lines: readonly CreateEstimateLineInput[];
      readonly createdById: string | null;
    },
  ): Promise<void>;
}
