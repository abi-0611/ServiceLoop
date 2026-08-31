import type { ShopConfig } from '@serviceloop/config';
import {
  APPROVAL_SUBJECT_TYPE,
  checkOfferedPrice,
  parseSourceId,
  sourceId,
  type EvidenceRef,
  type AdvisorTaskService,
  type ApprovalService,
  type Claim,
  type EtaEntry,
  type EvidenceBundle,
  type EvidenceBundleBuilder,
  type EvidenceBundleStore,
  type JobCardContext,
  type JobCardContextReader,
  type MessageSnapshot,
  type OutboundGate,
  type PriceListReader,
  type UnitOfWork,
} from '@serviceloop/domain';
import {
  formatPaise,
  uuidv7,
  type CustomerDecision,
  type Language,
  type Paise,
} from '@serviceloop/shared';
import { z } from 'zod';
import type { PostChecker, CandidateSource, CheckReason } from './post-checker';
import { ToolRegistry, type ToolContext } from './tool-registry';

/**
 * Tool set v1 (phase 3.3).
 *
 * Master L5: the tools *are* the guardrails. Each one validates its arguments,
 * checks the shop's invariants, audits what it did, and returns a typed result
 * — refusals included. The agent therefore experiences a price floor as a tool
 * saying no, not as a sentence in a prompt it might be talked out of.
 *
 * Two of them carry the weight:
 *
 *   - `compose_customer_message` produces a candidate and **never sends**. It
 *     exists so drafting and sending are separate acts with separate audit
 *     rows, and so a draft can be shown to a human without a race.
 *   - `send_customer_message` is the **only** tool that reaches a customer. It
 *     runs the post-checker, then `OutboundGate`, which runs consent, window,
 *     caps, quiet hours, disclosure and the autonomy check. At L0 the draft
 *     lands in the HITL queue and the wire stays silent.
 */

export interface ToolDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly cards: JobCardContextReader<Tx>;
  readonly bundles: EvidenceBundleStore<Tx>;
  readonly bundleBuilder: EvidenceBundleBuilder<Tx>;
  readonly approvals: ApprovalService<Tx>;
  readonly tasks: AdvisorTaskService<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly prices: PriceListReader<Tx>;
  readonly checker: PostChecker;
  /**
   * The *shop's* guardrail document, loaded per call.
   *
   * Not a value: a static config would mean `adjust_offer` judging every shop
   * against the defaults, so a workshop that had deliberately allowed a 10%
   * concession would still have every concession refused — and the refusal
   * would cite a floor the owner never set.
   */
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  /** The bundle backing this run, when the objective has one. */
  readonly activeBundle: (
    tx: Tx,
    shopId: string,
    jobCardId: string,
  ) => Promise<EvidenceBundle | null>;
  readonly conversationTail: (
    tx: Tx,
    shopId: string,
    conversationId: string,
    limit: number,
  ) => Promise<readonly MessageSnapshot[]>;
  /**
   * The card's ETA history (phase 4.5).
   *
   * Optional because a deployment can run the phase-3 objectives without the
   * ETA engine wired; `get_eta` refuses honestly when it is absent rather than
   * returning an empty history that reads as "no delays".
   */
  readonly etaHistory?: (
    tx: Tx,
    shopId: string,
    jobCardId: string,
    limit: number,
  ) => Promise<readonly EtaEntry[]>;
  readonly scheduleFollowup: (input: {
    readonly shopId: string;
    readonly conversationId: string;
    readonly at: Date;
    readonly objective: string;
    readonly traceId: string;
  }) => Promise<string>;
}

/* -------------------------------------------------------------------------- *
 * Argument schemas
 *
 * These are the contract the model is shown, so their `.describe()` text is
 * customer-facing documentation in the only sense that matters: it is what the
 * agent reads before deciding what to do.
 * -------------------------------------------------------------------------- */

const ClaimSchema = z.object({
  text: z.string().min(1).max(600).describe('One sentence of the message, exactly as written'),
  sources: z
    .array(z.string().min(3).max(80))
    .describe('Source ids this sentence restates: note:…, line:… or media:…'),
});

export const GetJobCardArgs = z.object({
  jobCardId: z
    .string()
    .uuid()
    .optional()
    .describe('Defaults to the card this conversation is about'),
});

export const GetCustomerContextArgs = z.object({
  recentMessages: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(10)
    .describe('How many recent turns to read back'),
});

export const ComposeMessageArgs = z.object({
  draft: z.string().min(1).max(3000).describe('The message exactly as the customer will read it'),
  claims: z
    .array(ClaimSchema)
    .describe(
      'Every factual sentence in the draft, each with the source ids it restates. A sentence that states a fact and is missing here will block the send.',
    ),
  language: z.enum(['en', 'ta', 'hi']).describe("The customer's language, mirrored from theirs"),
});

export const SendMessageArgs = z.object({
  candidateId: z
    .string()
    .min(1)
    .describe('The id compose_customer_message returned. Nothing else may be sent.'),
});

export const CreateApprovalArgs = z.object({
  workItemIds: z
    .array(z.string().uuid())
    .min(1)
    .describe('The work items to put to the customer, in the order they should be shown'),
  ladderRef: z
    .enum(['APPROVAL', 'STATUS', 'DELIVERY', 'PAYMENT', 'RETENTION', 'FEEDBACK'])
    .default('APPROVAL')
    .describe('Which escalation ladder chases this'),
});

export const RecordDecisionArgs = z.object({
  approvalId: z.string().uuid(),
  decision: z
    .enum(['FULL', 'PARTIAL', 'DEFERRED', 'DECLINED'])
    .describe('What the customer actually decided'),
  approvedWorkItemIds: z
    .array(z.string().uuid())
    .default([])
    .describe('For PARTIAL: exactly the items they said yes to. Ignored for FULL.'),
  note: z.string().max(500).default('').describe("The customer's own words, where you have them"),
  followUpAfterDays: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe('For DEFERRED: when the shop may raise it again'),
});

export const AdjustOfferArgs = z.object({
  lineId: z.string().min(1).describe('The estimate line to reprice'),
  newPricePaise: z
    .number()
    .int()
    .min(0)
    .describe('The new line total in paise (rupees × 100). Never below the shop floor.'),
});

export const ScheduleFollowupArgs = z.object({
  afterMinutes: z.number().int().min(5).max(60 * 24 * 30),
  objective: z
    .enum(['request_approval', 'resolve_partial_approval', 'explain_evidence'])
    .describe('What the follow-up run should try to achieve'),
});

export const HandoffArgs = z.object({
  summary: z
    .string()
    .min(10)
    .max(400)
    .describe('One line an advisor can act on from a phone screen, without reading the thread'),
  urgency: z.enum(['LOW', 'NORMAL', 'HIGH']).default('NORMAL'),
});

export const LogNoteArgs = z.object({
  note: z.string().min(1).max(1000).describe('For the audit trail. Never reaches the customer.'),
});

export const GetEtaArgs = z.object({
  history: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(5)
    .describe('How many past ETA changes to read back, newest first'),
});

/* -------------------------------------------------------------------------- *
 * Typed results
 * -------------------------------------------------------------------------- */

export interface ToolRefusal {
  readonly refused: true;
  readonly code: string;
  /** Written to be relayed to a customer honestly, not to be hidden. */
  readonly reason: string;
}

export type ComposeResult =
  | { readonly candidateId: string; readonly length: number; readonly claims: number }
  | ToolRefusal;

export type SendResult =
  | {
      readonly sent: boolean;
      readonly status: string;
      readonly messageId: string;
      readonly detail: string;
    }
  | (ToolRefusal & { readonly checkerReasons: readonly CheckReason[] });

export type AdjustOfferResult =
  | {
      readonly lineId: string;
      readonly previousPaise: Paise;
      readonly newPaise: Paise;
      readonly accepted: true;
    }
  | ToolRefusal;

function refuse(code: string, reason: string): ToolRefusal {
  return { refused: true, code, reason };
}

/* -------------------------------------------------------------------------- *
 * Registry
 * -------------------------------------------------------------------------- */

export function buildToolRegistry<Tx>(deps: ToolDeps<Tx>): ToolRegistry {
  const registry = new ToolRegistry();
  // Registered one at a time rather than from an array, so each tool's `args`
  // schema flows into its handler's parameter type. An array of heterogeneous
  // definitions erases exactly the typing this layer exists to provide.
  registry
    .register({
      name: 'get_job_card',
      description:
        'Read the job card: its state, work items, technician notes, estimate lines and media.',
      args: GetJobCardArgs,
      customerFacing: false,
      handler: async (args, context) => {
        const jobCardId = args.jobCardId ?? context.jobCardId;
        if (jobCardId === null || jobCardId === undefined) {
          return refuse(
            'NO_JOB_CARD',
            'This conversation has no open job card, so there is nothing to read',
          );
        }
        const card = await deps.uow.transaction(async (tx) =>
          deps.cards.load(tx, context.shopId, jobCardId),
        );
        return card === null
          ? refuse('NO_JOB_CARD', `Job card ${jobCardId} is not in this shop`)
          : summariseCard(card);
      },
    })
    .register({
      name: 'get_customer_context',
      description:
        'Read the customer, their vehicle, their language preference and the recent conversation.',
      args: GetCustomerContextArgs,
      customerFacing: false,
      handler: async (args, context) => {
        const tail = await deps.uow.transaction(async (tx) =>
          deps.conversationTail(tx, context.shopId, context.conversationId, args.recentMessages),
        );
        return {
          conversationId: context.conversationId,
          customerId: context.customerId,
          language: context.language,
          recentMessages: tail.map((message) => ({
            from: message.direction === 'INBOUND' ? 'customer' : 'shop',
            at: message.createdAt.toISOString(),
            body: message.body,
          })),
        };
      },
    })
    .register({
      name: 'compose_customer_message',
      description:
        'Draft a message and declare its claims. Returns a candidate and sends nothing. Every factual sentence must appear in `claims` with the source ids it restates.',
      args: ComposeMessageArgs,
      customerFacing: false,
      handler: async (args, context): Promise<ComposeResult> => {
        const claims: readonly Claim[] = args.claims.map((claim: { text: string; sources: string[] }) => ({
          text: claim.text,
          sources: claim.sources,
        }));

        const candidateId = `cand_${uuidv7()}`;
        context.state.putCandidate(candidateId, {
          body: args.draft,
          claims,
          language: args.language as Language,
        });

        return { candidateId, length: args.draft.length, claims: claims.length };
      },
    })
    .register({
      name: 'send_customer_message',
      description:
        'Send a composed candidate to the customer. This is the only tool that reaches them. It runs the claim checker, the consent gate and the autonomy check; at shadow autonomy it routes the draft to an advisor instead, which is a success.',
      args: SendMessageArgs,
      customerFacing: true,
      handler: async (args, context): Promise<SendResult> => {
        const candidate = context.state.candidate(args.candidateId) as
          | { body: string; claims: readonly Claim[]; language: Language }
          | undefined;

        if (candidate === undefined) {
          return {
            ...refuse(
              'UNKNOWN_CANDIDATE',
              'That candidate id was never composed. Call compose_customer_message first.',
            ),
            checkerReasons: [],
          };
        }

        const context_ = await deps.uow.transaction(async (tx) => {
          const bundle =
            context.jobCardId === null
              ? null
              : await deps.activeBundle(tx, context.shopId, context.jobCardId);
          const priorOutbound = await deps.conversationTail(
            tx,
            context.shopId,
            context.conversationId,
            50,
          );
          // Phase 4.5: a status answer cites the card's live state and its ETA
          // history, neither of which is in an evidence bundle. Without these
          // as declared sources, "your car is in quality check, ready by four"
          // has nothing to anchor to and every status reply is blocked (L7).
          const card =
            context.jobCardId === null
              ? null
              : await deps.cards.load(tx, context.shopId, context.jobCardId);
          const etaEntries =
            context.jobCardId === null || deps.etaHistory === undefined
              ? []
              : await deps.etaHistory(tx, context.shopId, context.jobCardId, 5);
          return { bundle, priorOutbound, card, etaEntries };
        });

        const agreed = [...context.state.agreedPrices().entries()].map(([id, concession]) => ({
          id,
          text: `Agreed price for ${concession.description} — ${formatPaise(concession.newPaise)}`,
        }));
        const sources = [
          ...sourcesFor(context_.bundle),
          ...statusSourcesFor(context_.card, context_.etaEntries),
          ...agreed,
        ];
        const isFirstContact = !context_.priorOutbound.some(
          (message) => message.direction === 'OUTBOUND',
        );

        const verdict = await deps.checker.review({
          shopId: context.shopId,
          language: candidate.language,
          body: candidate.body,
          claims: candidate.claims,
          sources,
          allowedAmountsPaise: [
            ...allowedAmounts(context_.bundle),
            ...[...context.state.agreedPrices().values()].map(
              (concession) => concession.newPaise,
            ),
            ...revisedTotals(context_.bundle, context.state.agreedPrices()),
          ],
          isFirstContactInSession: isFirstContact,
          traceId: context.traceId,
        });

        if (verdict.kind === 'block_to_hitl') {
          // Not discarded: the gate still writes the row, so an advisor sees the
          // draft *and* the reasons it was held. Silently dropping it would
          // leave a customer waiting for a reply that was never coming.
          await deps.gate.send({
            shopId: context.shopId,
            conversationId: context.conversationId,
            customerId: context.customerId,
            purpose: 'SERVICE',
            content: { kind: 'text', body: candidate.body },
            actor: { type: 'AGENT', id: context.actorId },
            traceId: context.traceId,
            flow: 'approval',
            language: candidate.language,
            jobCardId: context.jobCardId,
            // Anchoring is deliberately not re-run by the gate here: this
            // checker has already produced richer reasons, and the gate's own
            // claim check would collapse them to one line.
            evidenceRefs: candidate.claims.flatMap((claim) => [...claim.sources]),
            createdByAgent: true,
            agentRunId: context.runId,
          });

          context.state.heldForReview = true;
          return {
            ...refuse(
              'BLOCKED_TO_HITL',
              `The claim checker held this message for an advisor: ${verdict.reasons
                .map((reason) => reason.detail)
                .join('; ')}`,
            ),
            checkerReasons: verdict.reasons,
          };
        }

        const outcome = await deps.gate.send({
          shopId: context.shopId,
          conversationId: context.conversationId,
          customerId: context.customerId,
          purpose: 'SERVICE',
          content: { kind: 'text', body: candidate.body },
          actor: { type: 'AGENT', id: context.actorId },
          traceId: context.traceId,
          flow: 'approval',
          language: candidate.language,
          jobCardId: context.jobCardId,
          claims: candidate.claims.map((claim) => ({
            text: claim.text,
            evidence: claim.sources.flatMap((source) => {
              const parsed = parseRef(source);
              return parsed === null ? [] : [parsed];
            }),
          })),
          evidenceRefs: candidate.claims.flatMap((claim) => [...claim.sources]),
          createdByAgent: true,
          agentRunId: context.runId,
          // This tool only ever runs inside a conversational objective, which
          // only ever runs because the customer said something. Answering them
          // is not the business-initiated contact the minimum interval limits.
          isReply: true,
        });

        if (outcome.status === 'PENDING_APPROVAL') context.state.heldForReview = true;

        return {
          sent: outcome.status === 'SENT',
          status: outcome.status,
          messageId: outcome.messageId,
          detail: describeOutcome(outcome),
        };
      },
    })
    .register({
      name: 'create_approval_request',
      description:
        'Put the evidence bundle to the customer as an interactive request with Approve / Ask a question / Call me. Composes and sends the message itself.',
      args: CreateApprovalArgs,
      customerFacing: true,
      handler: async (args, context) => {
        if (context.jobCardId === null || context.customerId === null) {
          return refuse(
            'NO_JOB_CARD',
            'An approval request needs an open job card and an identified customer',
          );
        }

        const bundle = await deps.uow.transaction(async (tx) =>
          deps.activeBundle(tx, context.shopId, context.jobCardId as string),
        );
        if (bundle === null) {
          return refuse(
            'NO_EVIDENCE_BUNDLE',
            'There is no evidence bundle for this card yet, and an approval request without evidence cannot be sent (L7)',
          );
        }

        const requested = new Set(args.workItemIds);
        const known = new Set(bundle.workItemIds);
        const unknown = [...requested].filter((id) => !known.has(id));
        if (unknown.length > 0) {
          return refuse(
            'WORK_ITEM_NOT_IN_BUNDLE',
            `These work items are not part of the evidence bundle, so no claim about them could be anchored: ${unknown.join(', ')}`,
          );
        }

        const result = await deps.approvals.createApprovalRequest({
          shopId: context.shopId,
          jobCardId: context.jobCardId,
          customerId: context.customerId,
          conversationId: context.conversationId,
          bundle: { ...bundle, workItemIds: args.workItemIds },
          ladderRef: args.ladderRef,
          actor: { type: 'AGENT', id: context.actorId },
          traceId: context.traceId,
          agentRunId: context.runId,
        });

        if (!result.ok) return refuse(result.code, result.reason);
        if (result.gateStatus === 'PENDING_APPROVAL') context.state.heldForReview = true;

        return {
          approvalId: result.approvalId,
          messageId: result.messageId,
          status: result.gateStatus,
          workItemCount: args.workItemIds.length,
        };
      },
    })
    .register({
      name: 'record_customer_decision',
      description:
        'Record what the customer decided. FULL, PARTIAL (with the exact items they approved), DEFERRED or DECLINED. Moves the work items and writes the ledger.',
      args: RecordDecisionArgs,
      customerFacing: false,
      handler: async (args, context) => {
        const followUpAfter =
          args.followUpAfterDays === undefined
            ? undefined
            : new Date(Date.now() + args.followUpAfterDays * 24 * 60 * 60 * 1000);

        const result = await deps.approvals.recordCustomerDecision({
          shopId: context.shopId,
          approvalId: args.approvalId,
          decision: args.decision as CustomerDecision,
          approvedWorkItemIds: args.approvedWorkItemIds,
          note: args.note,
          decidedVia: 'agent',
          ...(followUpAfter === undefined ? {} : { followUpAfter }),
          actor: { type: 'AGENT', id: context.actorId },
          traceId: context.traceId,
        });

        return {
          approvalId: result.approvalId,
          decision: result.decision,
          approvedWorkItemIds: [...result.approvedWorkItemIds],
          deferredWorkItemIds: [...result.deferredWorkItemIds],
          approvedAmount: formatPaise(result.approvedAmountPaise),
          alreadyRecorded: !result.applied,
        };
      },
    })
    .register({
      name: 'adjust_offer',
      description:
        "Offer a lower price on one estimate line. Refuses anything below the shop's floor or above its discount ceiling — relay a refusal honestly rather than implying the discount was given.",
      args: AdjustOfferArgs,
      customerFacing: false,
      handler: async (args, context): Promise<AdjustOfferResult> => {
        const resolved = await deps.uow.transaction(async (tx) => {
          const bundle =
            context.jobCardId === null
              ? null
              : await deps.activeBundle(tx, context.shopId, context.jobCardId);
          const line = bundle?.lines.find((candidate) => candidate.id === args.lineId) ?? null;
          const listPrice =
            line === null
              ? null
              : (line.listPricePaise ??
                (await deps.prices.listPriceFor(tx, context.shopId, args.lineId)));
          const config = await deps.loadConfig(tx, context.shopId);
          return { line, listPrice, config };
        });

        if (resolved.line === null) {
          return refuse(
            'LINE_NOT_FOUND',
            `Estimate line ${args.lineId} is not part of this job card's evidence bundle`,
          );
        }

        if (resolved.listPrice === null) {
          // Without a list price there is no floor to check against, and a
          // discount off an unknown number is not a discount — it is a
          // negotiation the shop never agreed to.
          return refuse(
            'NO_LIST_PRICE',
            'That item has no list price on file, so I cannot change its price. I can check with the owner.',
          );
        }

        const verdict = checkOfferedPrice(
          resolved.config,
          resolved.listPrice,
          args.newPricePaise,
        );
        if (!verdict.allowed) {
          return refuse(verdict.code, verdict.reason);
        }

        // The approved price becomes citable evidence: the guardrail that let
        // it through is the source for it.
        context.state.recordConcession({
          lineId: args.lineId,
          description: resolved.line.description,
          newPaise: args.newPricePaise,
        });

        return {
          lineId: args.lineId,
          previousPaise: resolved.line.lineTotalPaise,
          newPaise: args.newPricePaise,
          accepted: true,
        };
      },
    })
    .register({
      name: 'schedule_followup',
      description:
        'Schedule another agent run on this thread later — for example when a customer asks to be reminded next week.',
      args: ScheduleFollowupArgs,
      customerFacing: false,
      handler: async (args, context) => {
        const at = new Date(Date.now() + args.afterMinutes * 60_000);
        const id = await deps.scheduleFollowup({
          shopId: context.shopId,
          conversationId: context.conversationId,
          at,
          objective: args.objective,
          traceId: context.traceId,
        });
        return { followupId: id, at: at.toISOString(), objective: args.objective };
      },
    })
    .register({
      name: 'handoff_to_human',
      description:
        'Hand this conversation to an advisor with a one-line brief. Always available, and the right answer more often than you expect.',
      args: HandoffArgs,
      customerFacing: false,
      handler: async (args, context) => {
        const taskId = await deps.tasks.create({
          shopId: context.shopId,
          kind: 'HANDOFF',
          urgency: args.urgency,
          brief: args.summary,
          context: {
            conversationId: context.conversationId,
            jobCardId: context.jobCardId,
            agentRunId: context.runId,
          },
          jobCardId: context.jobCardId,
          conversationId: context.conversationId,
          customerId: context.customerId,
          agentRunId: context.runId,
          actor: { type: 'AGENT', id: context.actorId },
          traceId: context.traceId,
        });

        context.state.handedOff = true;
        return { taskId, urgency: args.urgency };
      },
    })
    .register({
      name: 'log_note',
      description: 'Record a note on this run for the audit trail. Never reaches the customer.',
      args: LogNoteArgs,
      customerFacing: false,
      handler: async (args, context) => {
        context.state.addNote(args.note);
        return { logged: true };
      },
    })
    .register({
      name: 'get_eta',
      description:
        'Read when this vehicle is expected to be ready, and every time that answer changed with the reason it changed. This is the only source for a completion time; never state one that is not here.',
      args: GetEtaArgs,
      customerFacing: false,
      handler: async (args, context) => {
        if (context.jobCardId === null) {
          return refuse('NO_JOB_CARD', 'This conversation has no open job card, so there is no ETA');
        }
        if (deps.etaHistory === undefined) {
          // Honest refusal rather than an empty list. An empty history reads as
          // "nothing has gone wrong", and a model told that will happily
          // reassure a customer whose part has not arrived.
          return refuse(
            'ETA_UNAVAILABLE',
            'The ETA engine is not available in this deployment, so no completion time can be quoted',
          );
        }

        const history = await deps.uow.transaction(async (tx) =>
          deps.etaHistory?.(tx, context.shopId, context.jobCardId as string, args.history),
        );

        const entries = history ?? [];
        const current = entries[0];

        return {
          currentEta: current?.eta.toISOString() ?? null,
          currentEtaSourceId: current === undefined ? null : etaSource(current),
          promisedAt: current?.promisedAt?.toISOString() ?? null,
          scheduled: current !== undefined,
          history: entries.map((entry) => ({
            sourceId: etaSource(entry),
            version: entry.version,
            eta: entry.eta.toISOString(),
            previousEta: entry.previousEta?.toISOString() ?? null,
            reason: entry.reason,
            materiality: entry.materiality,
            changedAt: entry.createdAt.toISOString(),
            customerWasTold: entry.notifiedAt !== null,
          })),
        };
      },
    });

  return registry;
}

/* ---------------------------------------------------------------- helpers -- */

/**
 * Everything the agent may cite about this card.
 *
 * Built from the bundle, not from the card, and that is the point: a technician
 * note that has not been turned into a bundle is not yet evidence anyone
 * reviewed, and citing it would let the agent restate an unfinished thought.
 */
export function sourcesFor(bundle: EvidenceBundle | null): readonly CandidateSource[] {
  if (bundle === null) return [];

  return [
    // The grand total is its own citable source. Without it, a sentence stating
    // the total cites individual lines and a judge is asked to do arithmetic to
    // clear it — which is both unreliable and the wrong question. The total is
    // a figure the estimate carries, so it gets an id like any other.
    {
      id: TOTAL_SOURCE_ID,
      text: `Total for this work — ${formatPaise(bundle.totalPaise)}`,
    },
    ...bundle.sourceNotes.map((note) => ({
      id: sourceId({ kind: 'TECHNICIAN_NOTE', id: note.id }),
      text: note.text,
    })),
    ...bundle.lines.map((line) => ({
      id: sourceId({ kind: 'ESTIMATE_LINE', id: line.id }),
      text: `${line.description} — ${formatPaise(line.lineTotalPaise)}`,
    })),
    ...bundle.media.map((asset) => ({
      id: sourceId({ kind: 'MEDIA', id: asset.id }),
      text: asset.caption ?? `${asset.kind.toLowerCase()} of the work in question`,
    })),
  ];
}

/**
 * The id an ETA entry is cited by: `eta:<jobCardId>#<version>`.
 *
 * Card plus version rather than the row's uuid, so an advisor reading an audit
 * row or the card drawer can find the exact entry a message quoted. The domain
 * builds the same key in `etaSourceKey`; both go through `sourceId`, so a
 * prompt example and a checker lookup cannot disagree about the shape.
 */
export function etaSource(entry: EtaEntry): string {
  return sourceId({ kind: 'ETA', id: `${entry.jobCardId}#${entry.version}` });
}

/**
 * What a status answer may cite (phase 4.5).
 *
 * The card's live state and each ETA entry, rendered as the sentence a person
 * would write from them — because the judge reads the source *text* and asks
 * whether it supports the claim, so a source that reads `QUALITY_CHECK` would
 * fail to support "we are checking it over now" even though it is exactly what
 * that means.
 */
export function statusSourcesFor(
  card: JobCardContext | null,
  etaEntries: readonly EtaEntry[],
): readonly CandidateSource[] {
  if (card === null) return [];

  const sources: CandidateSource[] = [
    {
      id: sourceId({ kind: 'JOB_CARD_STATE', id: `${card.jobCardId}#${card.state}` }),
      text: `${card.vehicleLabel} (${card.registration}) is currently ${describeState(card.state)}.`,
    },
  ];

  for (const entry of etaEntries) {
    sources.push({
      id: etaSource(entry),
      text: `Expected ready ${entry.eta.toISOString()}${
        entry.previousEta === null ? '' : `, moved from ${entry.previousEta.toISOString()}`
      }. Reason: ${entry.detail}`,
    });
  }

  return sources;
}

/** Job-card states in the words a customer would recognise. */
function describeState(state: string): string {
  switch (state) {
    case 'OPEN':
      return 'booked in and waiting to be looked at';
    case 'IN_DIAGNOSIS':
      return 'being inspected';
    case 'AWAITING_APPROVAL':
      return 'waiting for your approval before work continues';
    case 'IN_PROGRESS':
      return 'being worked on';
    case 'AWAITING_PARTS':
      return 'waiting for a part to arrive';
    case 'QUALITY_CHECK':
      return 'finished and going through its final check';
    case 'READY_FOR_DELIVERY':
      return 'ready to collect';
    case 'AWAITING_PAYMENT':
      return 'ready to collect, with payment outstanding';
    case 'DELIVERED':
      return 'already collected';
    default:
      return state.toLowerCase().replace(/_/g, ' ');
  }
}

/**
 * The id under which an evidence bundle's grand total is citable.
 *
 * `total` rather than a uuid, because it is the estimate's own summary figure
 * and not a row: an agent citing it is saying "the number at the bottom", which
 * is exactly what a customer reads.
 */
export const TOTAL_SOURCE_ID = 'line:total';

/**
 * Totals that hold once a concession has been agreed.
 *
 * A message that restates the total after a discount is quoting arithmetic the
 * shop has just agreed to, not inventing a number — so the revised total is
 * allowed exactly when a concession exists.
 */
function revisedTotals(
  bundle: EvidenceBundle | null,
  agreed: ReadonlyMap<string, { readonly lineId: string; readonly newPaise: number }>,
): readonly Paise[] {
  if (bundle === null || agreed.size === 0) return [];

  const byLine = new Map([...agreed.values()].map((entry) => [entry.lineId, entry.newPaise]));
  return [
    bundle.lines.reduce(
      (sum, line) => sum + (byLine.get(line.id) ?? line.lineTotalPaise),
      0,
    ),
  ];
}

/** Line totals plus the grand total — the only figures the copy may state. */
export function allowedAmounts(bundle: EvidenceBundle | null): readonly Paise[] {
  if (bundle === null) return [];
  return [...bundle.lines.map((line) => line.lineTotalPaise), bundle.totalPaise];
}

function summariseCard(card: JobCardContext): Record<string, unknown> {
  return {
    jobCardId: card.jobCardId,
    code: card.code,
    state: card.state,
    customerName: card.customerName,
    customerLanguage: card.customerLanguage,
    vehicle: card.vehicleLabel,
    registration: card.registration,
    odometerKm: card.odometerKm,
    promisedAt: card.promisedAt?.toISOString() ?? null,
    complaint: card.complaint,
    workItems: card.workItems.map((item) => ({
      id: item.id,
      title: item.title,
      state: item.state,
      requiresApproval: item.requiresApproval,
      technicianNote: item.technicianNote,
    })),
    estimate:
      card.estimate === null
        ? null
        : {
            id: card.estimate.id,
            version: card.estimate.version,
            status: card.estimate.status,
            total: formatPaise(card.estimate.totalPaise),
            lines: card.estimate.lines.map((line) => ({
              id: sourceId({ kind: 'ESTIMATE_LINE', id: line.id }),
              description: line.description,
              total: formatPaise(line.lineTotalPaise),
            })),
          },
    media: card.media.map((asset) => ({
      id: sourceId({ kind: 'MEDIA', id: asset.id }),
      kind: asset.kind,
      caption: asset.caption,
    })),
  };
}

function describeOutcome(outcome: {
  readonly status: string;
  readonly reason?: string;
  readonly code?: string;
}): string {
  switch (outcome.status) {
    case 'SENT':
      return 'Delivered to the customer.';
    case 'PENDING_APPROVAL':
      return `Held for an advisor to approve: ${outcome.reason ?? 'autonomy is at shadow level'}. This is the expected outcome at L0 and the objective counts as met.`;
    case 'DEFERRED':
      return `Held for quiet hours: ${outcome.reason ?? 'outside sending hours'}. It will go out automatically.`;
    case 'BLOCKED':
      return `Blocked by the outbound gate (${outcome.code ?? 'unknown'}): ${outcome.reason ?? ''}`;
    default:
      return `Send failed (${outcome.code ?? 'unknown'}): ${outcome.reason ?? ''}`;
  }
}

/**
 * String source id → typed ref, for the gate's own anchoring check.
 *
 * `parseSourceId` in the domain owns the mapping; this is the same call, kept as
 * a named helper because the gate wants the refs and the checker wants the
 * strings, and one function producing both is what stops the two disagreeing.
 */
function parseRef(source: string): EvidenceRef | null {
  return parseSourceId(source);
}

/** The subject type approval ladders are keyed on, re-exported for callers. */
export { APPROVAL_SUBJECT_TYPE };

/** Every tool name in v1, so an objective spec cannot name one that does not exist. */
export const TOOL_NAMES = [
  'get_job_card',
  'get_customer_context',
  'compose_customer_message',
  'send_customer_message',
  'create_approval_request',
  'record_customer_decision',
  'adjust_offer',
  'schedule_followup',
  'handoff_to_human',
  'log_note',
  'get_eta',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export type { ToolContext };
