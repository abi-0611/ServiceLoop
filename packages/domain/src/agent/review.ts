import { migrateShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  systemClock,
  uuidv7,
  type AgentObjective,
  type AutonomyFlow,
  type AutonomyLevel,
  type Clock,
  type EventEnvelope,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { AuditAppender, OutboxWriter, ShopConfigStore, UnitOfWork } from '../ports';
import { rebuildOutboundContent, type MediaBytesLoader } from '../messaging/deferred';
import type { GateOutcome, OutboundGate, OutboundRequest } from '../messaging/outbound-gate';
import type { MessageStore, ScheduledMessage } from '../messaging/ports';
import type { ReviewStore } from './ports';
import type { GraduationReport, PendingCandidate, ReviewDecisionInput } from './types';

/**
 * HITL review queue and autonomy graduation (phase 3.9).
 *
 * L0 SHADOW is where every shop starts and where every flow stays until an
 * owner decides otherwise. That makes this the surface that carries the whole
 * product in its first weeks: an advisor sees what the agent wanted to say, the
 * checker's reasons for holding it, and three actions.
 *
 * The design decision that matters is that **an edit is data, not a
 * correction**. Approving with an edit is not a failure to be hidden; it is the
 * single most informative signal the system produces, and it is stored — before
 * and after, with a diff — so the graduation report can answer the only
 * question an owner actually has: "how often does it get this right without
 * me?"
 */

export interface ReviewServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly reviews: ReviewStore<Tx>;
  readonly messages: MessageStore<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly config: ShopConfigStore<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  /** Reloads the held row so the *stored* words are what goes out. */
  readonly loadHeld: (tx: Tx, shopId: string, messageId: string) => Promise<ScheduledMessage | null>;
  readonly media?: MediaBytesLoader;
  readonly clock?: Clock;
}

export type ReviewOutcome =
  | { readonly ok: true; readonly action: 'SENT'; readonly gate: GateOutcome; readonly edited: boolean }
  | { readonly ok: true; readonly action: 'REJECTED' }
  | { readonly ok: false; readonly code: string; readonly reason: string };

export class ReviewService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: ReviewServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  async pending(shopId: string, limit = 50): Promise<readonly PendingCandidate[]> {
    return this.deps.uow.transaction(async (tx) => this.deps.reviews.pending(tx, shopId, limit));
  }

  /**
   * Applies an advisor's decision.
   *
   * A send goes back through `OutboundGate.release`, which re-runs every
   * *customer* protection — consent may have been revoked while the candidate
   * sat in the queue — and skips only the autonomy check, because a person has
   * now taken responsibility for these specific words.
   */
  async decide(input: ReviewDecisionInput): Promise<ReviewOutcome> {
    const now = this.clock.now();

    const loaded = await this.deps.uow.transaction(async (tx) => {
      const candidate = await this.deps.reviews.loadCandidate(tx, input.shopId, input.messageId);
      if (candidate === null) return null;
      const held = await this.deps.loadHeld(tx, input.shopId, input.messageId);
      return held === null ? null : { candidate, held };
    });

    if (loaded === null) {
      return {
        ok: false,
        code: 'NOT_PENDING',
        reason: `Message ${input.messageId} is not waiting for review in this shop`,
      };
    }

    const { candidate, held } = loaded;
    const waitedMs = Math.max(0, now.getTime() - candidate.createdAt.getTime());

    if (input.action === 'REJECT') {
      const reason = input.rejectionReason?.trim() ?? '';
      if (reason.length === 0) {
        // Without a reason the graduation report cannot tell "the agent was
        // wrong" from "the advisor was busy", and that distinction is the whole
        // value of the queue.
        return {
          ok: false,
          code: 'REASON_REQUIRED',
          reason: 'Rejecting a candidate requires a reason so the graduation report stays honest',
        };
      }

      await this.deps.uow.transaction(async (tx) => {
        await this.deps.reviews.markRejected(tx, {
          shopId: input.shopId,
          messageId: input.messageId,
          reason,
          at: now,
        });
        await this.recordReview(tx, {
          candidate,
          input,
          bodyAfter: null,
          diff: [],
          rejectionReason: reason,
          waitedMs,
          at: now,
        });
      });

      return { ok: true, action: 'REJECTED' };
    }

    const edited = input.action === 'EDIT_AND_SEND';
    const bodyAfter = edited ? (input.editedBody?.trim() ?? '') : candidate.body;

    if (edited && bodyAfter.length === 0) {
      return {
        ok: false,
        code: 'EMPTY_EDIT',
        reason: 'Edit-then-send needs the edited copy; an empty body is a rejection, not an edit',
      };
    }

    const diff = edited ? diffLines(candidate.body, bodyAfter) : [];

    await this.deps.uow.transaction(async (tx) => {
      if (edited) {
        // The stored row is updated before the send, so the audited words and
        // the sent words are the same words.
        await this.deps.reviews.updateBody(tx, input.shopId, input.messageId, bodyAfter);
      }
      await this.recordReview(tx, {
        candidate,
        input,
        bodyAfter: edited ? bodyAfter : null,
        diff,
        rejectionReason: null,
        waitedMs,
        at: now,
      });
    });

    const content = await rebuildOutboundContent(
      edited ? { ...held, body: bodyAfter } : held,
      this.deps.media,
    );
    if (content === null) {
      return {
        ok: false,
        code: 'MEDIA_UNAVAILABLE',
        reason: 'The media this candidate referred to is no longer in storage',
      };
    }

    const request: OutboundRequest = {
      shopId: held.shopId,
      conversationId: held.conversationId,
      customerId: held.customerId,
      purpose: held.purpose,
      content,
      actor: { type: 'STAFF', id: input.reviewerStaffId },
      traceId: input.traceId,
      flow: 'approval',
      language: held.language,
      jobCardId: held.jobCardId,
      createdByAgent: held.createdByAgent,
      agentRunId: held.agentRunId,
      approvedByStaffId: input.reviewerStaffId,
      mediaId: held.mediaId,
    };

    const gate = await this.deps.gate.release(request, held.id, input.reviewerStaffId);
    return { ok: true, action: 'SENT', gate, edited };
  }

  /**
   * The graduation report: what the last N runs of a flow actually did.
   *
   * The system recommends and the owner decides (master §6). The recommendation
   * is therefore deliberately conservative — it never suggests skipping a level,
   * and it refuses to suggest anything at all below the configured sample size,
   * because a 100% rate over four messages is not evidence.
   */
  async graduationReport(input: {
    readonly shopId: string;
    readonly objective: AgentObjective;
    readonly flow: AutonomyFlow;
  }): Promise<GraduationReport> {
    return this.deps.uow.transaction(async (tx) => {
      const stored = await this.deps.config.load(tx, input.shopId);
      const timezone = (await this.deps.config.loadShopTimezone(tx, input.shopId)) ?? 'Asia/Kolkata';
      const config = migrateShopConfig(stored?.raw ?? {}, timezone).config;

      const counts = await this.deps.reviews.graduationCounts(tx, {
        shopId: input.shopId,
        objective: input.objective,
        limit: config.agent.graduation.minRuns,
      });

      return buildGraduationReport(config, input.shopId, input.flow, counts);
    });
  }

  private async recordReview(
    tx: Tx,
    args: {
      readonly candidate: PendingCandidate;
      readonly input: ReviewDecisionInput;
      readonly bodyAfter: string | null;
      readonly diff: readonly DiffHunk[];
      readonly rejectionReason: string | null;
      readonly waitedMs: number;
      readonly at: Date;
    },
  ): Promise<void> {
    const { candidate, input } = args;

    await this.deps.reviews.recordReview(tx, {
      id: uuidv7(),
      shopId: input.shopId,
      messageId: input.messageId,
      conversationId: candidate.conversationId,
      agentRunId: candidate.agentRunId,
      action: input.action,
      reviewerStaffId: input.reviewerStaffId,
      bodyBefore: candidate.body,
      bodyAfter: args.bodyAfter,
      diff: args.diff,
      rejectionReason: args.rejectionReason,
      checkerReasons: candidate.checkerReasons,
      waitedMs: args.waitedMs,
      at: args.at,
    });

    const actor: Actor = { type: 'STAFF', id: input.reviewerStaffId };

    await this.deps.audit.append(tx, {
      shopId: input.shopId,
      actorType: actor.type,
      actorId: actor.id,
      action: 'message.review_decided',
      entityType: 'Message',
      entityId: input.messageId,
      payload: {
        action: input.action,
        edited: args.bodyAfter !== null,
        agentRunId: candidate.agentRunId,
        checkerReasons: [...candidate.checkerReasons],
        rejectionReason: args.rejectionReason,
        waitedMs: args.waitedMs,
        diff: args.diff,
      },
      traceId: input.traceId,
    });

    const envelope: EventEnvelope = {
      id: uuidv7(),
      type: 'message.review_decided',
      occurredAt: args.at.toISOString(),
      shopId: input.shopId,
      traceId: input.traceId,
      payload: {
        messageId: input.messageId,
        conversationId: candidate.conversationId,
        action: input.action,
        edited: args.bodyAfter !== null,
        agentRunId: candidate.agentRunId,
        reviewerStaffId: input.reviewerStaffId,
        actor: { type: actor.type, id: actor.id },
      },
    };
    await this.deps.outbox.enqueue(tx, envelope);
  }
}

/* ------------------------------------------------------------ graduation -- */

export interface GraduationCounts {
  readonly approvedWithoutEdit: number;
  readonly approvedWithEdit: number;
  readonly rejected: number;
  readonly checkerBlocks: number;
  readonly runs: number;
  readonly waitTimesMs: readonly number[];
}

const NEXT_LEVEL: Readonly<Record<AutonomyLevel, AutonomyLevel | null>> = {
  L0_SHADOW: 'L1_TEMPLATED',
  L1_TEMPLATED: 'L2_CONVERSATIONAL',
  // Voice autonomy is phase 5's to recommend; a chat record says nothing about
  // how the agent behaves on a phone call.
  L2_CONVERSATIONAL: null,
  L3_VOICE: null,
};

/**
 * Pure, so the thresholds can be exercised exhaustively without a database.
 *
 * Every gate must pass: enough runs, a high enough approve-without-edit rate,
 * and a low enough checker-block rate. A flow that is blocked often is a flow
 * whose drafts are unsafe, and a high approval rate on the few that got through
 * does not redeem it.
 */
export function buildGraduationReport(
  config: ShopConfig,
  shopId: string,
  flow: AutonomyFlow,
  counts: GraduationCounts,
): GraduationReport {
  const reviewed = counts.approvedWithoutEdit + counts.approvedWithEdit + counts.rejected;
  const approvedWithoutEditRate = reviewed === 0 ? 0 : counts.approvedWithoutEdit / reviewed;
  const checkerBlockRate = counts.runs === 0 ? 0 : counts.checkerBlocks / counts.runs;

  const currentLevel = config.autonomy[flow];
  const thresholds = config.agent.graduation;
  const next = NEXT_LEVEL[currentLevel];

  const reasons: string[] = [];
  if (reviewed < thresholds.minRuns) {
    reasons.push(
      `only ${reviewed} reviewed message(s) so far; ${thresholds.minRuns} are needed before a recommendation means anything`,
    );
  }
  if (approvedWithoutEditRate < thresholds.minApprovedWithoutEditRate) {
    reasons.push(
      `approved-without-edit is ${percent(approvedWithoutEditRate)}, below the ${percent(thresholds.minApprovedWithoutEditRate)} bar`,
    );
  }
  if (checkerBlockRate > thresholds.maxCheckerBlockRate) {
    reasons.push(
      `the post-checker blocked ${percent(checkerBlockRate)} of runs, above the ${percent(thresholds.maxCheckerBlockRate)} ceiling`,
    );
  }
  if (next === null) {
    reasons.push(`${currentLevel} is as far as the ${flow} flow graduates on chat evidence alone`);
  }

  const recommended = reasons.length === 0 ? next : null;

  return {
    shopId,
    flow,
    runs: counts.runs,
    approvedWithoutEdit: counts.approvedWithoutEdit,
    approvedWithEdit: counts.approvedWithEdit,
    rejected: counts.rejected,
    checkerBlocks: counts.checkerBlocks,
    approvedWithoutEditRate,
    checkerBlockRate,
    medianReviewWaitMs: median(counts.waitTimesMs),
    currentLevel,
    recommendedLevel: recommended,
    rationale:
      recommended === null
        ? `Staying at ${currentLevel}: ${reasons.join('; ')}.`
        : `The ${flow} flow has ${percent(approvedWithoutEditRate)} approved-without-edit over ${reviewed} reviewed messages and a ${percent(checkerBlockRate)} checker-block rate. ${recommended} looks warranted — you decide.`,
  };
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/* ------------------------------------------------------------------ diff -- */

export interface DiffHunk {
  readonly op: 'keep' | 'remove' | 'add';
  readonly text: string;
}

/**
 * A line-level diff, computed here rather than in the browser.
 *
 * It is stored on the review row, so what an owner sees six weeks later is the
 * diff that was recorded, not one a client-side library recomputed from two
 * strings that may since have been normalised differently.
 */
export function diffLines(before: string, after: string): readonly DiffHunk[] {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // Longest common subsequence — the texts are a few lines of a WhatsApp
  // message, so the quadratic table is free and the output is minimal.
  const table: number[][] = Array.from({ length: beforeLines.length + 1 }, () =>
    new Array<number>(afterLines.length + 1).fill(0),
  );

  for (let i = beforeLines.length - 1; i >= 0; i -= 1) {
    for (let j = afterLines.length - 1; j >= 0; j -= 1) {
      const row = table[i] as number[];
      const nextRow = table[i + 1] as number[];
      row[j] =
        beforeLines[i] === afterLines[j]
          ? (nextRow[j + 1] ?? 0) + 1
          : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      hunks.push({ op: 'keep', text: beforeLines[i] ?? '' });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      hunks.push({ op: 'remove', text: beforeLines[i] ?? '' });
      i += 1;
    } else {
      hunks.push({ op: 'add', text: afterLines[j] ?? '' });
      j += 1;
    }
  }
  for (; i < beforeLines.length; i += 1) {
    hunks.push({ op: 'remove', text: beforeLines[i] ?? '' });
  }
  for (; j < afterLines.length; j += 1) {
    hunks.push({ op: 'add', text: afterLines[j] ?? '' });
  }

  return hunks;
}
