import { migrateShopConfig } from '@serviceloop/config';
import { buildDraftSummary } from '@serviceloop/domain';
import {
  type DraftCorrection,
  type IntakeDraftDetail,
  type IntakeDraftList,
  type IntakeDraftSummary,
  JobCardDraftSchema,
} from '@serviceloop/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database, Executor } from '../client';
import { jobCardDrafts, mergeSuggestions } from '../schema/intake';
import { shopConfig, shops } from '../schema';

/**
 * Read model for the intake review screen (phase 2.6).
 *
 * The draft document is re-validated on the way out. A row that predates a
 * schema change, or one an operator edited by hand, must not reach the console
 * as a half-shaped object that renders blank fields — it fails loudly here
 * instead.
 */
export class IntakeRepository {
  constructor(private readonly db: Database) {}

  async list(
    shopId: string,
    options: {
      readonly status?: 'AWAITING_CONFIRMATION' | 'CONFIRMED' | 'DISCARDED';
      readonly limit?: number;
    } = {},
    executor: Executor = this.db,
  ): Promise<IntakeDraftList> {
    const rows = await executor
      .select()
      .from(jobCardDrafts)
      .where(
        options.status === undefined
          ? eq(jobCardDrafts.shopId, shopId)
          : and(eq(jobCardDrafts.shopId, shopId), eq(jobCardDrafts.status, options.status)),
      )
      .orderBy(desc(jobCardDrafts.createdAt))
      .limit(options.limit ?? 100);

    return { drafts: rows.map(toSummary) };
  }

  async detail(
    shopId: string,
    draftId: string,
    executor: Executor = this.db,
  ): Promise<IntakeDraftDetail | null> {
    const rows = await executor
      .select()
      .from(jobCardDrafts)
      .where(and(eq(jobCardDrafts.shopId, shopId), eq(jobCardDrafts.id, draftId)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;

    const threshold = await this.threshold(shopId, executor);
    const draft = JobCardDraftSchema.parse(row.draft);
    const summary = buildDraftSummary(draft, threshold, draft.language);

    return {
      ...toSummary(row),
      fields: summary.lines.map((line) => ({
        index: line.index,
        path: line.path,
        label: line.label,
        value: line.value,
        confidence: line.confidence,
        uncertain: line.uncertain,
      })),
      corrections: (row.corrections as DraftCorrection[]).map((correction) => ({
        path: correction.path,
        previousValue: correction.previousValue,
        value: correction.value,
        correctedBy: correction.correctedBy,
        correctedAt: correction.correctedAt,
      })),
      rawInput: row.rawInput,
      language: draft.language,
      notes: draft.notes,
      confirmationThreshold: threshold,
      mediaUrl: row.mediaId === null ? null : `/media/${row.mediaId}`,
    };
  }

  /** Open merge suggestions, so the console can show what was *not* merged. */
  async openMergeSuggestions(
    shopId: string,
    draftIds: readonly string[],
    executor: Executor = this.db,
  ): Promise<Map<string, number>> {
    if (draftIds.length === 0) return new Map();

    const rows = await executor
      .select({ draftId: mergeSuggestions.draftId })
      .from(mergeSuggestions)
      .where(
        and(
          eq(mergeSuggestions.shopId, shopId),
          eq(mergeSuggestions.status, 'OPEN'),
          inArray(mergeSuggestions.draftId, [...draftIds]),
        ),
      );

    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.draftId === null) continue;
      counts.set(row.draftId, (counts.get(row.draftId) ?? 0) + 1);
    }
    return counts;
  }

  private async threshold(shopId: string, executor: Executor): Promise<number> {
    const [config] = await executor
      .select({ config: shopConfig.config })
      .from(shopConfig)
      .where(eq(shopConfig.shopId, shopId))
      .limit(1);
    const [shop] = await executor
      .select({ timezone: shops.timezone })
      .from(shops)
      .where(eq(shops.id, shopId))
      .limit(1);

    return migrateShopConfig(config?.config ?? {}, shop?.timezone ?? 'Asia/Kolkata').config.intake
      .confirmationThreshold;
  }
}

type DraftRow = typeof jobCardDrafts.$inferSelect;

function toSummary(row: DraftRow): IntakeDraftSummary {
  const draft = JobCardDraftSchema.parse(row.draft);
  const uncertain = (row.lowConfidenceFields as string[]).length;

  return {
    id: row.id,
    source: row.source,
    status: row.status,
    customerName: draft.customer.name.value,
    registration: draft.vehicle.registration.value,
    overallConfidence: row.confidenceMilli / 1000,
    // The stored list is the authority: it was computed against the threshold
    // in force when the draft was written, and re-deriving it here would make
    // a config change silently rewrite history.
    uncertainCount: uncertain,
    extractorModel: row.extractorModel,
    conversationId: row.conversationId,
    mediaId: row.mediaId,
    jobCardId: row.jobCardId,
    createdAt: row.createdAt.toISOString(),
  };
}
