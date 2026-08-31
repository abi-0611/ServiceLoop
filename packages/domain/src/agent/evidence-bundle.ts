import {
  normaliseRegistration,
  systemClock,
  uuidv7,
  type Clock,
  type EstimateLineKind,
  type EventEnvelope,
  type Language,
  type Paise,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { AuditAppender, OutboxWriter, UnitOfWork } from '../ports';
import type {
  EvidenceBundleStore,
  ExplanationWriter,
  JobCardContext,
  JobCardContextReader,
} from './ports';
import {
  parseSourceId,
  type BundleLine,
  type BundleMedia,
  type Claim,
  type EvidenceBundle,
  type SourceNote,
} from './types';

/**
 * EvidenceBundleBuilder — technician evidence in, bundle out (phase 3.4).
 *
 * A technician photographs a worn pad in the staff group, tags it to a card
 * (reply-to the card's pinned message, or `#TN09BX4432` shorthand) and says
 * what they found. This turns that into the artifact a customer can act on:
 * the media, the affected work items, the estimate-v2 draft lines, and an
 * explanation in the customer's own language.
 *
 * The hard rule (L7) is enforced here rather than requested in a prompt. The
 * explanation writer is handed *only* the technician notes and the estimate
 * lines, and every sentence it produces comes back with the source ids it
 * restates. `verifyClaimSources` then re-checks those ids against the sources
 * that were actually supplied — so a writer that cites `note:fabricated` is
 * caught by the builder, before the post-checker, before HITL, and long before
 * a customer.
 */

/** How a technician's message pointed at a job card. */
export type EvidenceAnchor =
  | { readonly kind: 'reply'; readonly pinnedMessageId: string }
  | { readonly kind: 'registration'; readonly text: string }
  | { readonly kind: 'explicit'; readonly jobCardId: string };

export interface EvidenceSubmission {
  readonly shopId: string;
  readonly anchor: EvidenceAnchor;
  /** The technician's own words — a caption, a text line, or a transcript. */
  readonly note: string;
  readonly noteLanguage: Language;
  readonly authorStaffId: string | null;
  readonly mediaIds: readonly string[];
  /** Work items this evidence concerns. Empty means "every item awaiting a decision". */
  readonly workItemIds?: readonly string[];
  /** New or changed lines the technician is proposing (the estimate v2 draft). */
  readonly proposedLines?: readonly ProposedLine[];
  readonly traceId: string;
  readonly actor: Actor;
  readonly agentRunId?: string | null;
}

export interface ProposedLine {
  readonly workItemId: string | null;
  readonly description: string;
  /** Defaults to LABOUR — work a technician found is work someone has to do. */
  readonly kind?: EstimateLineKind;
  readonly quantityMilli: number;
  readonly unitPricePaise: Paise;
  /** Defaults to the standard 18% GST slab the estimate uses. */
  readonly taxRateBp?: number;
  readonly listPricePaise: Paise | null;
}

/** The GST slab automotive service falls in, and the estimate's own default. */
export const DEFAULT_TAX_RATE_BP = 1800;

export type BundleFailure =
  | { readonly code: 'NO_JOB_CARD'; readonly reason: string }
  | { readonly code: 'NO_NOTE'; readonly reason: string }
  | { readonly code: 'UNSUPPORTED_CLAIM'; readonly reason: string; readonly claims: readonly Claim[] };

export type BundleResult =
  | { readonly ok: true; readonly bundle: EvidenceBundle }
  | { readonly ok: false; readonly failure: BundleFailure };

export interface EvidenceBundleDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly bundles: EvidenceBundleStore<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly explanations: ExplanationWriter;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  /** Resolves a reply-to message id back to the card it was pinned against. */
  readonly resolvePinnedCard: (
    tx: Tx,
    shopId: string,
    messageId: string,
  ) => Promise<string | null>;
  readonly clock?: Clock;
}

export class EvidenceBundleBuilder<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: EvidenceBundleDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  async build(submission: EvidenceSubmission): Promise<BundleResult> {
    const note = submission.note.trim();
    if (note.length === 0) {
      return {
        ok: false,
        failure: {
          code: 'NO_NOTE',
          reason:
            'Evidence with no technician note cannot become a bundle: there would be nothing a customer-facing claim could cite',
        },
      };
    }

    const resolved = await this.deps.uow.transaction(async (tx) => {
      const jobCardId = await this.resolveJobCard(tx, submission);
      if (jobCardId === null) return null;
      const context = await this.deps.cards.load(tx, submission.shopId, jobCardId);
      if (context === null) return null;
      const priorNotes = await this.deps.bundles.loadSourceNotes(tx, submission.shopId, jobCardId);
      return { context, priorNotes };
    });

    if (resolved === null) {
      return {
        ok: false,
        failure: {
          code: 'NO_JOB_CARD',
          reason: describeAnchorFailure(submission.anchor),
        },
      };
    }

    const { context } = resolved;
    const now = this.clock.now();

    const noteId = uuidv7();
    const sourceNote: SourceNote = {
      id: noteId,
      workItemId: submission.workItemIds?.[0] ?? null,
      authorStaffId: submission.authorStaffId,
      text: note,
      language: submission.noteLanguage,
      capturedAt: now,
    };

    const workItemIds = selectWorkItems(context, submission.workItemIds);
    const media = selectMedia(context, submission.mediaIds);
    const lines = composeLines(context, workItemIds, submission.proposedLines ?? []);
    const totalPaise = lines.reduce((sum, line) => sum + line.lineTotalPaise, 0);

    // The writer sees the note, the lines and the media captions — and nothing
    // else. It cannot restate a diagnosis nobody made because it was never
    // shown one.
    const explanation = await this.deps.explanations.write({
      shopId: submission.shopId,
      language: context.customerLanguage,
      customerName: context.customerName,
      vehicleLabel: context.vehicleLabel,
      notes: [sourceNote],
      lines,
      media,
      totalPaise,
      traceId: submission.traceId,
    });

    const available = new Set<string>([
      `note:${noteId}`,
      ...lines.map((line) => `line:${line.id}`),
      ...media.map((asset) => `media:${asset.id}`),
    ]);

    const unsupported = verifyClaimSources(explanation.claims, available);
    if (unsupported.length > 0) {
      return {
        ok: false,
        failure: {
          code: 'UNSUPPORTED_CLAIM',
          reason: `${unsupported.length} sentence(s) cite a source that is not part of this bundle: ${unsupported
            .map((claim) => JSON.stringify(claim.text.slice(0, 60)))
            .join(', ')}`,
          claims: unsupported,
        },
      };
    }

    const bundle: EvidenceBundle = {
      id: uuidv7(),
      shopId: submission.shopId,
      jobCardId: context.jobCardId,
      title: `${context.vehicleLabel} — ${context.code}`,
      summaryText: explanation.summaryText,
      language: context.customerLanguage,
      media,
      lines,
      workItemIds,
      estimateId: context.estimate?.id ?? null,
      claims: explanation.claims,
      sourceNotes: [sourceNote],
      totalPaise,
      createdByRunId: submission.agentRunId ?? null,
      explanationModel: explanation.model,
      explanationPromptHash: explanation.promptHash,
      createdAt: now,
    };

    await this.deps.uow.transaction(async (tx) => {
      await this.deps.bundles.insert(tx, bundle);

      await this.deps.audit.append(tx, {
        shopId: submission.shopId,
        actorType: submission.actor.type,
        actorId: submission.actor.id,
        action: 'evidence_bundle.created',
        entityType: 'EvidenceBundle',
        entityId: bundle.id,
        payload: {
          jobCardId: bundle.jobCardId,
          workItemIds: [...bundle.workItemIds],
          mediaCount: bundle.media.length,
          lineCount: bundle.lines.length,
          claimCount: bundle.claims.length,
          totalPaise: bundle.totalPaise,
          explanationModel: bundle.explanationModel,
          explanationPromptHash: bundle.explanationPromptHash,
        },
        traceId: submission.traceId,
      });

      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'evidence_bundle.created',
        occurredAt: now.toISOString(),
        shopId: submission.shopId,
        traceId: submission.traceId,
        payload: {
          bundleId: bundle.id,
          jobCardId: bundle.jobCardId,
          workItemIds: [...bundle.workItemIds],
          mediaCount: bundle.media.length,
          claimCount: bundle.claims.length,
          language: bundle.language,
          actor: { type: submission.actor.type, id: submission.actor.id },
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
    });

    return { ok: true, bundle };
  }

  private async resolveJobCard(tx: Tx, submission: EvidenceSubmission): Promise<string | null> {
    switch (submission.anchor.kind) {
      case 'explicit':
        return submission.anchor.jobCardId;
      case 'reply':
        return this.deps.resolvePinnedCard(tx, submission.shopId, submission.anchor.pinnedMessageId);
      case 'registration': {
        const normalised = normaliseRegistration(submission.anchor.text);
        // An unrepairable plate resolves to nothing rather than to a guess: a
        // bundle attached to the wrong vehicle is worse than one that failed.
        if (!normalised.ok) return null;
        return this.deps.cards.findByRegistration(
          tx,
          submission.shopId,
          normalised.value.normalised,
        );
      }
    }
  }
}

/**
 * Which sentences cite a source that is not in this bundle.
 *
 * Exported because the post-checker runs the same test over a *composed
 * message* later. Two implementations of "is this claim anchored" would drift,
 * and the drift would be invisible until something unsupported reached a
 * customer.
 */
export function verifyClaimSources(
  claims: readonly Claim[],
  available: ReadonlySet<string>,
): readonly Claim[] {
  return claims.filter((claim) => {
    if (claim.sources.length === 0) return true;
    return !claim.sources.every((source) => {
      if (!available.has(source)) return false;
      return parseSourceId(source) !== null;
    });
  });
}

/** Work items the bundle covers: the named subset, or everything decidable. */
function selectWorkItems(
  context: JobCardContext,
  requested: readonly string[] | undefined,
): readonly string[] {
  if (requested !== undefined && requested.length > 0) {
    const known = new Set(context.workItems.map((item) => item.id));
    return requested.filter((id) => known.has(id));
  }
  return context.workItems
    .filter((item) => item.requiresApproval && DECIDABLE_STATES.has(item.state))
    .map((item) => item.id);
}

const DECIDABLE_STATES: ReadonlySet<string> = new Set(['PROPOSED', 'PENDING_APPROVAL']);

function selectMedia(
  context: JobCardContext,
  mediaIds: readonly string[],
): readonly BundleMedia[] {
  if (mediaIds.length === 0) return [];
  const byId = new Map(context.media.map((asset) => [asset.id, asset]));
  return mediaIds
    .map((id) => byId.get(id))
    .filter((asset): asset is BundleMedia => asset !== undefined);
}

/**
 * The estimate-v2 draft: the existing lines for the affected items, plus
 * whatever the technician proposed.
 *
 * Proposed lines get a synthetic id so a claim can cite them before the
 * estimate has been written. The id is stable within the bundle, which is what
 * the checker needs; it becomes a real `estimate_lines` row when the customer
 * approves.
 */
function composeLines(
  context: JobCardContext,
  workItemIds: readonly string[],
  proposed: readonly ProposedLine[],
): readonly BundleLine[] {
  const covered = new Set(workItemIds);
  const existing = (context.estimate?.lines ?? []).filter(
    (line) => line.workItemId !== null && covered.has(line.workItemId),
  );

  const drafted: BundleLine[] = proposed.map((line, index) => ({
    id: `draft-${index + 1}`,
    workItemId: line.workItemId,
    description: line.description,
    kind: line.kind ?? 'LABOUR',
    quantityMilli: line.quantityMilli,
    unitPricePaise: line.unitPricePaise,
    lineTotalPaise: Math.round((line.unitPricePaise * line.quantityMilli) / 1000),
    taxRateBp: line.taxRateBp ?? DEFAULT_TAX_RATE_BP,
    listPricePaise: line.listPricePaise,
  }));

  return [...existing, ...drafted];
}

function describeAnchorFailure(anchor: EvidenceAnchor): string {
  switch (anchor.kind) {
    case 'reply':
      return 'The message this evidence replied to is not a pinned job-card message, so there is no card to attach it to';
    case 'registration':
      return `No open job card matches ${JSON.stringify(anchor.text)}; check the registration and send it again`;
    case 'explicit':
      return `Job card ${anchor.jobCardId} does not exist in this shop`;
  }
}
