import { migrateShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  type ChannelType,
  type Clock,
  formatBytes,
  type IntakeSource,
  type Language,
  systemClock,
  t,
} from '@serviceloop/shared';
import { parseDraftAction, parseQuickCorrection, pathForLine } from '../intake/confirmation';
import { IntakeExtractionFailedError, type IntakePipeline } from '../intake/intake-pipeline';
import type { IntakeService } from '../intake/intake-service';
import type { Actor } from '../job-card/context';
import type { ShopConfigStore, ShopDirectory, UnitOfWork } from '../ports';
import { parseApprovalAction, type ApprovalAction } from './approval-actions';
import type { ConsentService } from './consent';
import { parseConsentAction } from './consent-capture';
import type { MediaRejection, MediaService } from './media';
import { disclosesAi, type GateOutcome, type OutboundGate } from './outbound-gate';
import {
  noteIdentifiesAVehicle,
  type ApprovalReplyPort,
  type ConversationStore,
  type CustomerLookup,
  type MessageStore,
  type RetentionReplyPort,
  type SlotReplyPort,
  type TechnicianNotePort,
} from './ports';
import {
  parseDigestClaim,
  parseDocumentEnrolment,
  parseFeedbackAction,
  parseMarketingAction,
  parseRepitchAction,
} from './retention-actions';
import {
  parseSlotAction,
  parseStatusAction,
  type ParsedStatusAction,
} from './status-actions';
import type { FollowUp, InboundRouter, RoutedMessage } from './router';
import type { InboundMessage, OutboundContent } from './types';

/**
 * What happens after the router has classified a message (phase 2.3–2.9).
 *
 * The router answers "what is this?"; this class answers "so what do we do?".
 * Keeping them apart matters: the router is a pure classification with no
 * outbound consequences, which is why it can be reasoned about and tested
 * without a channel, and why phase 3's agent can consume its output without
 * inheriting any of the reply logic below.
 *
 * Every reply here goes through `OutboundGate.send`. There is no other call.
 */

/* -------------------------------------------------------------------------- *
 * Media fetching
 * -------------------------------------------------------------------------- */

export interface FetchedMedia {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly filename: string | null;
}

/**
 * Pulls the bytes behind an inbound media reference. Implemented in
 * `packages/adapters` over `WhatsAppPort.downloadMedia`; a channel that
 * delivers bytes inline can return them directly.
 */
export interface MediaFetchPort {
  download(
    shopId: string,
    ref: { readonly providerMediaId: string; readonly mimeType: string },
  ): Promise<FetchedMedia>;
}

/* -------------------------------------------------------------------------- *
 * Trace
 * -------------------------------------------------------------------------- */

/**
 * A step-by-step record of what this message caused.
 *
 * The console simulator renders it as the pipeline trace beside the thread
 * (phase 2.2), which is the difference between "the reply didn't arrive" and
 * "the reply was blocked at the consent gate because SERVICE is REVOKED".
 */
export interface TraceStep {
  readonly stage:
    | 'webhook'
    | 'media'
    | 'router'
    | 'session'
    | 'intake'
    | 'consent'
    | 'gate'
    | 'handoff'
    /** Phase 4: a technician note that became (or did not become) a signal. */
    | 'status';
  readonly detail: string;
  readonly at: string;
  readonly ok: boolean;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface InboundOutcome {
  readonly routed: RoutedMessage | null;
  readonly duplicate: boolean;
  readonly mediaId: string | null;
  readonly draftId: string | null;
  readonly jobCardId: string | null;
  readonly replies: readonly GateOutcome[];
  readonly trace: readonly TraceStep[];
}

/* -------------------------------------------------------------------------- *
 * Handler
 * -------------------------------------------------------------------------- */

export interface InboundHandlerDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly router: InboundRouter<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly intake: IntakeService<Tx>;
  readonly pipeline: IntakePipeline<Tx>;
  readonly media: MediaService<Tx>;
  readonly mediaFetch: MediaFetchPort;
  readonly conversations: ConversationStore<Tx>;
  readonly messages: MessageStore<Tx>;
  readonly customers: CustomerLookup<Tx>;
  readonly consents: ConsentService<Tx>;
  readonly config: ShopConfigStore<Tx>;
  readonly directory: ShopDirectory<Tx>;
  /**
   * What the approval buttons do (phase 3.6). Absent in a deployment with no
   * agent, in which case a tap is logged and nothing else happens.
   */
  readonly approvals?: ApprovalReplyPort;
  /**
   * What a staff-group note becomes (phase 4.2), and what the ✅/✏️ taps on a
   * confirmation card do. Absent in a deployment with no status sentinel, in
   * which case every staff note is an intake, exactly as it was in phase 2.
   */
  readonly technicianNotes?: TechnicianNotePort;
  /** The customer's pickup-slot tap (phase 4.7). */
  readonly slots?: SlotReplyPort;
  /**
   * The five phase-6 taps. Absent in a deployment with no retention module, in
   * which case a tap is recognised and logged and nothing happens — which is
   * the important half: without the parse it would reach the intake pipeline,
   * and "Not interested" would become a draft job card.
   */
  readonly retention?: RetentionReplyPort;
  /**
   * Turns a *customer's* voice note into words (phase 6.4).
   *
   * Narrower than `TechnicianNotePort`, which is staff-only by design and must
   * stay that way: a customer's voice note must never be read as an instruction
   * to move a job card. All this one does is give a spoken feedback comment a
   * transcript, so "the AC still isn't cold" reaches the advisor's recovery task
   * as text rather than as an audio file nobody plays.
   */
  readonly transcribeVoiceNote?: (input: {
    readonly shopId: string;
    readonly bytes: Buffer;
    readonly contentType: string;
    readonly languageHint: Language;
  }) => Promise<string | null>;
  /** Deep-link base for "Edit in console" replies. */
  readonly consoleUrl: string;
  readonly clock?: Clock;
}

export interface HandleInboundInput {
  readonly shopId: string;
  readonly channel: ChannelType;
  readonly message: InboundMessage;
  readonly traceId: string;
}

const SYSTEM_ACTOR: Actor = { type: 'SYSTEM', id: null };

export class InboundHandler<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: InboundHandlerDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  async handle(input: HandleInboundInput): Promise<InboundOutcome> {
    const trace: TraceStep[] = [];
    const replies: GateOutcome[] = [];
    const push = (step: Omit<TraceStep, 'at'>): void => {
      trace.push({ ...step, at: this.clock.now().toISOString() });
    };

    push({
      stage: 'webhook',
      ok: true,
      detail: `${input.message.kind} from ${maskAddress(input.message.from)}`,
      data: { providerMessageId: input.message.providerMessageId },
    });

    const config = await this.loadConfig(input.shopId);

    /* ---------------------------------------------------------- media --- */

    let mediaId: string | null = null;
    let fetched: FetchedMedia | null = null;
    let rejection: MediaRejection | null = null;

    if (input.message.media !== null) {
      const handle = input.message.media;
      try {
        fetched = await this.deps.mediaFetch.download(input.shopId, {
          providerMediaId: handle.providerMediaId,
          mimeType: handle.mimeType,
        });
      } catch (error) {
        push({
          stage: 'media',
          ok: false,
          detail: `Could not download ${handle.providerMediaId}: ${messageOf(error)}`,
        });
      }

      if (fetched !== null) {
        const ingested = await this.deps.media.ingestInbound({
          shopId: input.shopId,
          bytes: fetched.bytes,
          declaredContentType: fetched.contentType,
          filename: fetched.filename,
          caption: input.message.caption,
          origin: 'INBOUND_WHATSAPP',
          providerMediaId: handle.providerMediaId,
          // Audio waits for the worker: ffmpeg does not belong on a webhook.
          deferAudio: handle.kind === 'AUDIO',
          actor: SYSTEM_ACTOR,
          traceId: input.traceId,
        });

        if (ingested.ok) {
          mediaId = ingested.asset.id;
          push({
            stage: 'media',
            ok: true,
            detail: `${ingested.asset.kind} stored (${formatBytes(ingested.asset.sizeBytes)})`,
            data: { mediaId, warnings: ingested.warnings },
          });
        } else {
          rejection = ingested.rejection;
          push({ stage: 'media', ok: false, detail: ingested.rejection.reason });
        }
      }
    }

    /* --------------------------------------------------------- router --- */

    const routed = await this.deps.router.route({
      shopId: input.shopId,
      channel: input.channel,
      message: input.message,
      traceId: input.traceId,
      mediaId,
    });

    push({
      stage: 'router',
      ok: true,
      detail: routed.duplicate
        ? 'Already processed — redelivered webhook ignored'
        : `${routed.conversationKind} thread · ${routed.followUps.map((f) => f.kind).join(', ')}`,
      data: {
        conversationId: routed.conversationId,
        messageId: routed.messageId,
        duplicate: routed.duplicate,
      },
    });

    if (routed.duplicate) {
      return { routed, duplicate: true, mediaId, draftId: null, jobCardId: null, replies, trace };
    }

    push({
      stage: 'session',
      ok: true,
      detail:
        routed.windowExpiresAt === null
          ? 'No customer-service window on this thread'
          : `24h window open until ${routed.windowExpiresAt.toISOString()}`,
    });

    // A file we refused is the only thing worth saying about this message.
    if (rejection !== null) {
      const outcome = await this.send({
        shopId: input.shopId,
        routed,
        content: { kind: 'text', body: rejectionCopy(rejection, routed.language) },
        config,
        traceId: input.traceId,
      });
      replies.push(outcome);
      push({ stage: 'gate', ok: outcome.status === 'SENT', detail: describeOutcome(outcome) });
      return { routed, duplicate: false, mediaId, draftId: null, jobCardId: null, replies, trace };
    }

    /* ------------------------------------------------------ follow-ups --- */

    let draftId: string | null = null;
    let jobCardId: string | null = null;

    for (const followUp of routed.followUps) {
      const result = await this.runFollowUp({
        followUp,
        input,
        routed,
        config,
        media: fetched,
        mediaId,
        push,
      });
      if (result.draftId !== null) draftId = result.draftId;
      if (result.jobCardId !== null) jobCardId = result.jobCardId;
      replies.push(...result.replies);
    }

    return { routed, duplicate: false, mediaId, draftId, jobCardId, replies, trace };
  }

  /* ------------------------------------------------------------ follow-ups */

  private async runFollowUp(args: {
    readonly followUp: FollowUp;
    readonly input: HandleInboundInput;
    readonly routed: RoutedMessage;
    readonly config: ShopConfig;
    readonly media: FetchedMedia | null;
    /** The stored asset for this message, when the pipeline kept one. */
    readonly mediaId: string | null;
    readonly push: (step: Omit<TraceStep, 'at'>) => void;
  }): Promise<{
    readonly replies: readonly GateOutcome[];
    readonly draftId: string | null;
    readonly jobCardId: string | null;
  }> {
    const { followUp, input, routed, config, push } = args;
    const none = { replies: [] as GateOutcome[], draftId: null, jobCardId: null };

    switch (followUp.kind) {
      case 'IDENTIFY_UNKNOWN_NUMBER': {
        const shopName = await this.shopName(input.shopId);
        const outcome = await this.send({
          shopId: input.shopId,
          routed,
          content: {
            kind: 'text',
            body: t(routed.language, 'identify.unknown_number', { shopName }),
          },
          config,
          traceId: input.traceId,
        });
        push({ stage: 'gate', ok: outcome.status === 'SENT', detail: describeOutcome(outcome) });
        return { ...none, replies: [outcome] };
      }

      case 'ACKNOWLEDGE_OPT_OUT': {
        const shopName = await this.shopName(input.shopId);
        const outcome = await this.send({
          shopId: input.shopId,
          routed,
          content: { kind: 'text', body: t(routed.language, 'consent.opt_out_ack', { shopName }) },
          config,
          traceId: input.traceId,
          consentFlow: 'OPT_OUT_ACK',
        });
        push({ stage: 'consent', ok: true, detail: 'SERVICE and MARKETING consent revoked' });
        push({ stage: 'gate', ok: outcome.status === 'SENT', detail: describeOutcome(outcome) });
        return { ...none, replies: [outcome] };
      }

      case 'ACKNOWLEDGE_OPT_IN': {
        const shopName = await this.shopName(input.shopId);
        const outcome = await this.send({
          shopId: input.shopId,
          routed,
          content: { kind: 'text', body: t(routed.language, 'consent.opt_in_ack', { shopName }) },
          config,
          traceId: input.traceId,
        });
        push({ stage: 'consent', ok: true, detail: 'SERVICE consent granted by keyword' });
        push({ stage: 'gate', ok: outcome.status === 'SENT', detail: describeOutcome(outcome) });
        return { ...none, replies: [outcome] };
      }

      case 'HUMAN_HANDOFF_REQUESTED': {
        const [shopName, advisor] = await Promise.all([
          this.shopName(input.shopId),
          this.deps.uow.transaction(async (tx) =>
            this.deps.directory.loadHandoffAdvisor(tx, input.shopId),
          ),
        ]);

        // L6: the thread is marked so the inbox surfaces it and phase 3 pauses
        // any running objective on it. The promise is only made once there is
        // a named person to make it about.
        await this.deps.uow.transaction(async (tx) => {
          await this.deps.conversations.markHumanOverride(tx, {
            conversationId: routed.conversationId,
            at: this.clock.now(),
          });
        });
        push({
          stage: 'handoff',
          ok: true,
          detail:
            advisor === null
              ? 'Thread flagged for a human; no advisor on record to name'
              : `Thread flagged for ${advisor.fullName}`,
        });

        if (advisor === null) return none;

        const outcome = await this.send({
          shopId: input.shopId,
          routed,
          content: {
            kind: 'text',
            body: t(routed.language, 'handoff.confirmed', {
              advisorName: advisor.fullName,
              shopName,
            }),
          },
          config,
          traceId: input.traceId,
        });
        push({ stage: 'gate', ok: outcome.status === 'SENT', detail: describeOutcome(outcome) });
        return { ...none, replies: [outcome] };
      }

      case 'RUN_INTAKE':
        return this.runIntake({ ...args, source: followUp.source });

      case 'INTERACTIVE_REPLY':
        return this.handleInteractiveReply({ ...args, replyId: followUp.replyId });

      case 'CONVERSATION':
        return this.handleConversation(args);
    }
  }

  /* ---------------------------------------------------------------- intake */

  private async runIntake(args: {
    readonly source: IntakeSource;
    readonly input: HandleInboundInput;
    readonly routed: RoutedMessage;
    readonly config: ShopConfig;
    readonly media: FetchedMedia | null;
    readonly mediaId: string | null;
    readonly push: (step: Omit<TraceStep, 'at'>) => void;
  }): Promise<{
    readonly replies: readonly GateOutcome[];
    readonly draftId: string | null;
    readonly jobCardId: string | null;
  }> {
    const { source, input, routed, config, media, push } = args;

    // Phase 4: the same lane carries "new Swift just came in" and "4432 brake
    // pads done". Only the second may move an existing job card, so the note is
    // read first and becomes a status signal when it names a vehicle the shop
    // already has open. Everything else falls through to intake below — and
    // the transcript travels with it, so a voice note is never heard twice.
    const signal = await this.tryTechnicianNote({
      input,
      routed,
      source: source === 'PHOTO' ? 'PHOTO' : source === 'VOICE_NOTE' ? 'VOICE_NOTE' : 'TEXT',
      media,
      mediaId: args.mediaId,
      push,
    });
    if (signal.handled) {
      return { replies: [], draftId: null, jobCardId: signal.jobCardId };
    }

    try {
      const run = await this.deps.pipeline.run({
        shopId: input.shopId,
        source,
        ...(media === null ? {} : { bytes: media.bytes, contentType: media.contentType }),
        ...(signal.transcript === null ? {} : { transcript: signal.transcript }),
        text: input.message.text.length > 0 ? input.message.text : input.message.caption,
        language: routed.language,
        conversationId: routed.conversationId,
        messageId: routed.messageId,
        mediaId: null,
        submittedByStaffId: routed.senderStaffId,
        actor:
          routed.senderStaffId === null
            ? SYSTEM_ACTOR
            : { type: 'STAFF', id: routed.senderStaffId },
        traceId: input.traceId,
      });

      push({
        stage: 'intake',
        ok: true,
        detail: `${source} draft ${run.draftId.slice(0, 8)}… · confidence ${(run.overallConfidence * 100).toFixed(0)}% · ${run.summary.uncertainCount} field(s) to check`,
        data: { draftId: run.draftId, model: run.model, lowConfidence: run.lowConfidencePaths },
      });

      // The numbered summary is a *staff* surface. A customer who happened to
      // type the trigger word gets their card queued for an advisor rather
      // than a list of fields to proofread.
      if (!this.isStaffOriginated(routed)) {
        return { replies: [], draftId: run.draftId, jobCardId: null };
      }

      const outcome = await this.send({
        shopId: input.shopId,
        routed,
        content: run.content,
        config,
        traceId: input.traceId,
      });
      push({ stage: 'gate', ok: outcome.status === 'SENT', detail: describeOutcome(outcome) });
      return { replies: [outcome], draftId: run.draftId, jobCardId: null };
    } catch (error) {
      const reason =
        error instanceof IntakeExtractionFailedError ? error.message : messageOf(error);
      push({ stage: 'intake', ok: false, detail: reason });

      const outcome = await this.send({
        shopId: input.shopId,
        routed,
        content: { kind: 'text', body: t(routed.language, 'intake.extraction_failed') },
        config,
        traceId: input.traceId,
      });
      push({ stage: 'gate', ok: outcome.status === 'SENT', detail: describeOutcome(outcome) });
      return { replies: [outcome], draftId: null, jobCardId: null };
    }
  }

  /* ------------------------------------------------------ interactive taps */

  private async handleInteractiveReply(args: {
    readonly replyId: string;
    readonly input: HandleInboundInput;
    readonly routed: RoutedMessage;
    readonly config: ShopConfig;
    readonly push: (step: Omit<TraceStep, 'at'>) => void;
  }): Promise<{
    readonly replies: readonly GateOutcome[];
    readonly draftId: string | null;
    readonly jobCardId: string | null;
  }> {
    const { replyId, input, routed, config, push } = args;

    const consent = parseConsentAction(replyId);
    if (consent !== null) return this.applyConsentDecision({ ...args, decision: consent.decision });

    const approval = parseApprovalAction(replyId);
    if (approval !== null) {
      return this.applyApprovalAction({ ...args, action: approval });
    }

    // Phase 4. Checked before the draft actions because a status confirmation
    // and a draft confirmation are both "✅" to the person tapping, and only
    // the id says which card they were looking at.
    const status = parseStatusAction(replyId);
    if (status !== null) return this.applyStatusTap({ ...args, action: status });

    const slot = parseSlotAction(replyId);
    if (slot !== null) {
      return this.applySlotChoice({
        ...args,
        bookingId: slot.bookingId,
        slotIndex: slot.slotIndex,
      });
    }

    // Phase 6. All five checked before the draft actions, and all five before
    // the fall-through: an unrecognised id is logged, but a *recognised*
    // retention id that reached `parseDraftAction` would be a "Not interested"
    // that opened a job card.
    const repitch = parseRepitchAction(replyId);
    if (repitch !== null) {
      return this.applyRetentionTap({
        ...args,
        label: `Re-pitch answered: ${repitch.response}`,
        run: (port, actor) =>
          port.answerRepitch({
            shopId: input.shopId,
            ledgerItemId: repitch.ledgerItemId,
            response: repitch.response,
            conversationId: routed.conversationId,
            customerId: routed.customerId,
            actor,
            traceId: input.traceId,
          }),
      });
    }

    const feedback = parseFeedbackAction(replyId);
    if (feedback !== null) {
      return this.applyRetentionTap({
        ...args,
        label: `Feedback: ${feedback.sentiment}`,
        run: (port, actor) =>
          port.answerFeedback({
            shopId: input.shopId,
            feedbackId: feedback.feedbackId,
            sentiment: feedback.sentiment,
            conversationId: routed.conversationId,
            actor,
            traceId: input.traceId,
          }),
      });
    }

    const enrolment = parseDocumentEnrolment(replyId);
    if (enrolment !== null) {
      const customerId = routed.customerId;
      if (customerId === null) {
        push({ stage: 'router', ok: false, detail: 'Document enrolment tapped by no customer' });
        return { replies: [], draftId: null, jobCardId: null };
      }
      return this.applyRetentionTap({
        ...args,
        label: enrolment.enrol ? 'Document tracking enrolled' : 'Document tracking declined',
        run: (port, actor) =>
          port.answerDocumentEnrolment({
            shopId: input.shopId,
            vehicleId: enrolment.vehicleId,
            customerId,
            enrol: enrolment.enrol,
            conversationId: routed.conversationId,
            actor,
            traceId: input.traceId,
          }),
      });
    }

    const marketing = parseMarketingAction(replyId);
    if (marketing !== null) {
      const customerId = routed.customerId;
      if (customerId === null) {
        push({ stage: 'consent', ok: false, detail: 'MARKETING tapped by no customer' });
        return { replies: [], draftId: null, jobCardId: null };
      }
      return this.applyRetentionTap({
        ...args,
        stage: 'consent',
        label: `MARKETING ${marketing === 'GRANT' ? 'granted' : 'declined'}`,
        run: (port, actor) =>
          port.answerMarketingConsent({
            shopId: input.shopId,
            customerId,
            conversationId: routed.conversationId,
            decision: marketing,
            evidence: replyId,
            actor,
            traceId: input.traceId,
          }),
      });
    }

    const claimed = parseDigestClaim(replyId);
    if (claimed !== null) {
      return this.applyRetentionTap({
        ...args,
        stage: 'status',
        label: 'Digest line claimed',
        run: (port, actor) =>
          port.claimDigestLine({
            shopId: input.shopId,
            approvalId: claimed,
            claimedByStaffId: routed.senderStaffId,
            conversationId: routed.conversationId,
            actor,
            traceId: input.traceId,
          }),
      });
    }

    const action = parseDraftAction(replyId);
    if (action === null) {
      push({ stage: 'router', ok: true, detail: `Unrecognised reply id "${replyId}"` });
      return { replies: [], draftId: null, jobCardId: null };
    }

    const actor: Actor =
      routed.senderStaffId === null ? SYSTEM_ACTOR : { type: 'STAFF', id: routed.senderStaffId };

    if (action.action === 'discard') {
      await this.deps.intake.discard({
        shopId: input.shopId,
        draftId: action.draftId,
        actor,
        traceId: input.traceId,
      });
      push({ stage: 'intake', ok: true, detail: `Draft ${action.draftId.slice(0, 8)}… discarded` });

      const outcome = await this.send({
        shopId: input.shopId,
        routed,
        content: { kind: 'text', body: t(routed.language, 'intake.discarded') },
        config,
        traceId: input.traceId,
      });
      return { replies: [outcome], draftId: action.draftId, jobCardId: null };
    }

    if (action.action === 'edit') {
      const url = `${this.deps.consoleUrl.replace(/\/$/, '')}/intake/${action.draftId}`;
      const outcome = await this.send({
        shopId: input.shopId,
        routed,
        content: { kind: 'text', body: t(routed.language, 'intake.edit_in_console', { url }) },
        config,
        traceId: input.traceId,
      });
      push({ stage: 'intake', ok: true, detail: 'Handed the draft to the console' });
      return { replies: [outcome], draftId: action.draftId, jobCardId: null };
    }

    try {
      const confirmed = await this.deps.intake.confirm({
        shopId: input.shopId,
        draftId: action.draftId,
        actor,
        traceId: input.traceId,
        assignedAdvisorId: routed.senderStaffId,
      });

      push({
        stage: 'intake',
        ok: confirmed.openFailure === null,
        detail:
          confirmed.openFailure === null
            ? `Job card ${confirmed.code} opened · ${confirmed.workItemIds.length} work item(s)${
                confirmed.correctedFields.length === 0
                  ? ''
                  : ` · corrected [${confirmed.correctedFields.join(', ')}]`
              }`
            : `Job card ${confirmed.code} created but could not be opened: ${confirmed.openFailure}`,
        data: { jobCardId: confirmed.jobCardId, suggestions: confirmed.suggestions.length },
      });

      const record = await this.deps.intake.load(input.shopId, action.draftId);
      const outcome = await this.send({
        shopId: input.shopId,
        routed,
        content: {
          kind: 'text',
          body: t(routed.language, 'intake.confirmed', {
            code: confirmed.code,
            vehicle: record?.draft.vehicle.registration.value ?? '',
          }),
        },
        config,
        traceId: input.traceId,
      });

      return {
        replies: [outcome],
        draftId: action.draftId,
        jobCardId: confirmed.jobCardId,
      };
    } catch (error) {
      push({ stage: 'intake', ok: false, detail: messageOf(error) });
      const outcome = await this.send({
        shopId: input.shopId,
        routed,
        content: {
          kind: 'text',
          body: t(routed.language, 'intake.confirm_failed', { reason: messageOf(error) }),
        },
        config,
        traceId: input.traceId,
      });
      return { replies: [outcome], draftId: action.draftId, jobCardId: null };
    }
  }

  /**
   * ✅ or ✏️ on a status confirmation card (phase 4.2).
   *
   * The tap arrives in the **staff** group, which is why nothing is sent back
   * from here: the service itself decides what the customer hears, and a second
   * acknowledgement from the handler would be the shop talking to itself.
   *
   * `CONFIRM` carries the chosen card when the ask was "which of these two?",
   * and that is exactly why the id carries it: re-running a match that already
   * failed once is how a tap ends up applied to the wrong vehicle.
   */
  private async applyStatusTap(args: {
    readonly action: ParsedStatusAction;
    readonly input: HandleInboundInput;
    readonly routed: RoutedMessage;
    readonly push: (step: Omit<TraceStep, 'at'>) => void;
  }): Promise<{
    readonly replies: readonly GateOutcome[];
    readonly draftId: string | null;
    readonly jobCardId: string | null;
  }> {
    const { action, input, routed, push } = args;
    const none = { replies: [] as GateOutcome[], draftId: null, jobCardId: null };
    const port = this.deps.technicianNotes;

    if (port === undefined) {
      push({
        stage: 'status',
        ok: false,
        detail: `status:${action.kind.toLowerCase()} tapped but no status sentinel is wired`,
      });
      return none;
    }

    const tap = {
      shopId: input.shopId,
      signalId: action.signalId,
      staffId: routed.senderStaffId,
      ...(action.jobCardId === null ? {} : { jobCardId: action.jobCardId }),
      actor:
        routed.senderStaffId === null
          ? SYSTEM_ACTOR
          : ({ type: 'STAFF', id: routed.senderStaffId } as Actor),
      traceId: input.traceId,
    };

    // ✏️ means "not that" — recorded as a discard, because a queue that only
    // ever records agreement cannot answer "how often was the parser right?".
    const outcome =
      action.kind === 'CONFIRM' ? await port.confirm(tap) : await port.discard(tap);

    push({
      stage: 'status',
      ok: true,
      detail: `${outcome.route} — ${outcome.detail}`,
      data: { signalId: outcome.signalId, workItemIds: outcome.workItemIds },
    });

    return { ...none, jobCardId: outcome.jobCardId };
  }

  /**
   * The customer tapped one of the three pickup times (phase 4.7).
   *
   * The *index* travelled in the button id rather than the instant, so a stale
   * button cannot book a time the shop stopped offering. Everything else —
   * confirming the slot, scheduling the day-of reminder, refusing a second tap
   * — belongs to the delivery service, and this method's whole job is to name
   * which button was pressed.
   */
  /**
   * The one shape every phase-6 tap has (6.3–6.7).
   *
   * Each of the five parses to a different call on a different service, and all
   * five then do exactly the same three things: refuse politely when the module
   * is not wired, run the call, and put the outcome on the trace the console
   * renders. Writing that out five times is how four of them end up with a
   * slightly different failure message and the fifth with none.
   *
   * No reply is composed here. Every one of these services acknowledges through
   * the gate itself, because the acknowledgement depends on what the service
   * decided — "we will raise it again in about a month" is only true if the
   * ledger item actually took the deferral.
   */
  private async applyRetentionTap(args: {
    readonly input: HandleInboundInput;
    readonly routed: RoutedMessage;
    readonly push: (step: Omit<TraceStep, 'at'>) => void;
    readonly label: string;
    readonly stage?: TraceStep['stage'];
    readonly run: (
      port: RetentionReplyPort,
      actor: Actor,
    ) => Promise<{ readonly handled: boolean; readonly detail: string }>;
  }): Promise<{
    readonly replies: readonly GateOutcome[];
    readonly draftId: string | null;
    readonly jobCardId: string | null;
  }> {
    const { routed, push, label } = args;
    const none = { replies: [] as GateOutcome[], draftId: null, jobCardId: null };
    const stage = args.stage ?? 'router';
    const port = this.deps.retention;

    if (port === undefined) {
      push({ stage, ok: false, detail: `${label}, but no retention module is wired` });
      return none;
    }

    const actor: Actor =
      routed.senderStaffId !== null
        ? { type: 'STAFF', id: routed.senderStaffId }
        : routed.customerId === null
          ? SYSTEM_ACTOR
          : { type: 'CUSTOMER', id: routed.customerId };

    const result = await args.run(port, actor);
    push({
      stage,
      ok: result.handled,
      detail: result.handled ? label : `${label} — not applied: ${result.detail}`,
    });
    return none;
  }

  private async applySlotChoice(args: {
    readonly bookingId: string;
    readonly slotIndex: number;
    readonly input: HandleInboundInput;
    readonly routed: RoutedMessage;
    readonly push: (step: Omit<TraceStep, 'at'>) => void;
  }): Promise<{
    readonly replies: readonly GateOutcome[];
    readonly draftId: string | null;
    readonly jobCardId: string | null;
  }> {
    const { bookingId, slotIndex, input, routed, push } = args;
    const none = { replies: [] as GateOutcome[], draftId: null, jobCardId: null };
    const port = this.deps.slots;

    if (port === undefined) {
      push({ stage: 'status', ok: false, detail: 'Slot tapped but no delivery module is wired' });
      return none;
    }

    const result = await port.chooseSlot({
      shopId: input.shopId,
      bookingId,
      slotIndex,
      chosenVia: 'WHATSAPP',
      actor: routed.customerId === null ? SYSTEM_ACTOR : { type: 'CUSTOMER', id: routed.customerId },
      traceId: input.traceId,
    });

    push({
      stage: 'status',
      ok: result.ok,
      detail: result.ok
        ? `Pickup slot ${slotIndex + 1} booked`
        : `Slot not booked (${result.code ?? 'UNKNOWN'}): ${result.reason ?? ''}`,
    });

    return none;
  }

  /**
   * A tap on Approve / Ask a question / Call me.
   *
   * The handler does not decide anything itself: it names the button and hands
   * off to the port, so the transitions, the ledger and the ladder cancellation
   * all happen in the one service that owns them. An unwired agent logs the tap
   * and stays silent, which is better than acknowledging a decision nothing
   * recorded.
   */
  private async applyApprovalAction(args: {
    readonly action: ApprovalAction;
    readonly input: HandleInboundInput;
    readonly routed: RoutedMessage;
    readonly push: (step: Omit<TraceStep, 'at'>) => void;
  }): Promise<{
    readonly replies: readonly GateOutcome[];
    readonly draftId: string | null;
    readonly jobCardId: string | null;
  }> {
    const { action, input, routed, push } = args;
    const port = this.deps.approvals;

    if (port === undefined) {
      push({
        stage: 'router',
        ok: false,
        detail: `Approval button "${action}" tapped but no approval handler is wired`,
      });
      return { replies: [], draftId: null, jobCardId: null };
    }

    const request = {
      shopId: input.shopId,
      conversationId: routed.conversationId,
      customerId: routed.customerId,
      triggerMessageId: routed.messageId,
      replyTitle: input.message.replyTitle,
      traceId: input.traceId,
    };

    const result =
      action === 'APPROVE'
        ? await port.approve(request)
        : action === 'PARTIAL'
          ? await port.openObjection(request)
          : await port.requestCall(request);

    push({
      stage: 'router',
      ok: result.handled,
      detail: `approval:${action.toLowerCase()} — ${result.detail}`,
    });

    return { replies: [], draftId: null, jobCardId: null };
  }

  private async applyConsentDecision(args: {
    readonly decision: 'GRANTED' | 'REVOKED';
    readonly input: HandleInboundInput;
    readonly routed: RoutedMessage;
    readonly config: ShopConfig;
    readonly push: (step: Omit<TraceStep, 'at'>) => void;
  }): Promise<{
    readonly replies: readonly GateOutcome[];
    readonly draftId: string | null;
    readonly jobCardId: string | null;
  }> {
    const { decision, input, routed, config, push } = args;
    const customerId = routed.customerId;

    if (customerId === null) {
      push({ stage: 'consent', ok: false, detail: 'No customer on this thread to record against' });
      return { replies: [], draftId: null, jobCardId: null };
    }

    await this.deps.consents.record({
      shopId: input.shopId,
      customerId,
      purpose: 'SERVICE',
      status: decision,
      channel: input.channel,
      source: 'INTERACTIVE_REPLY',
      evidence: input.message.replyTitle ?? input.message.replyId,
      messageId: routed.messageId,
      actor: { type: 'CUSTOMER', id: null },
      traceId: input.traceId,
    });
    push({ stage: 'consent', ok: true, detail: `SERVICE consent ${decision} by button` });

    const shopName = await this.shopName(input.shopId);
    const body =
      decision === 'GRANTED'
        ? t(routed.language, 'consent.granted_ack', { vehicle: '' }).replace(/\s{2,}/g, ' ')
        : t(routed.language, 'consent.opt_out_ack', { shopName });

    const outcome = await this.send({
      shopId: input.shopId,
      routed,
      content: { kind: 'text', body },
      config,
      traceId: input.traceId,
      ...(decision === 'REVOKED' ? { consentFlow: 'OPT_OUT_ACK' as const } : {}),
    });
    return { replies: [outcome], draftId: null, jobCardId: null };
  }

  /* --------------------------------------------------- ordinary messages */

  /**
   * Free text on a thread that has a draft awaiting confirmation is almost
   * always a correction — `2 = TN 09 BX 4432`. Anything else is conversation
   * for an advisor (and, from phase 3, for the agent) to answer.
   */
  private async handleConversation(args: {
    readonly input: HandleInboundInput;
    readonly routed: RoutedMessage;
    readonly config: ShopConfig;
    readonly media: FetchedMedia | null;
    readonly mediaId: string | null;
    readonly push: (step: Omit<TraceStep, 'at'>) => void;
  }): Promise<{
    readonly replies: readonly GateOutcome[];
    readonly draftId: string | null;
    readonly jobCardId: string | null;
  }> {
    const { input, routed, config, push } = args;
    const none = { replies: [] as GateOutcome[], draftId: null, jobCardId: null };

    // Phase 6.4: the sentence after the face. A customer who tapped 😞 and then
    // typed (or spoke) why is answering the same question, and the recovery
    // task an advisor picks up should carry their words rather than a shrug.
    // Checked before everything else in this lane because it is the *narrowest*
    // claim on the message: it applies only while that customer has an answered
    // feedback record still open, and returns false otherwise.
    if (routed.conversationKind !== 'STAFF_GROUP' && routed.customerId !== null) {
      const attached = await this.tryFeedbackComment({ ...args, customerId: routed.customerId });
      if (attached) return none;

      // Phase 6.2: the answer to the odometer ask that rode along on the last
      // re-pitch. Only a *bare* number is read this way, and only inside a
      // fortnight of a touch actually reaching them — both guards live in the
      // service, and both are why "4432" typed in a customer thread does not
      // become a vehicle with 4,432 km on it.
      const reading = await this.deps.retention?.recordVolunteeredOdometer({
        shopId: input.shopId,
        customerId: routed.customerId,
        text: input.message.text,
        messageId: routed.messageId,
        actor: { type: 'CUSTOMER', id: routed.customerId },
        traceId: input.traceId,
      });
      if (reading !== null && reading !== undefined) {
        push({
          stage: 'status',
          ok: true,
          detail: `Odometer noted: ${reading.odometerKm} km`,
        });
        const outcome = await this.send({
          shopId: input.shopId,
          routed,
          content: { kind: 'text', body: t(routed.language, 'retention.odometer_ack') },
          config,
          traceId: input.traceId,
        });
        return { ...none, replies: [outcome] };
      }
    }

    // A typed line in the staff group — "4432 pads done" — is a status note as
    // much as a voice one is. This lane is otherwise dead: phase 2 routed staff
    // text with no trigger word to a correction check and then to nothing.
    if (routed.conversationKind === 'STAFF_GROUP') {
      const signal = await this.tryTechnicianNote({
        input,
        routed,
        source: 'TEXT',
        media: null,
        mediaId: null,
        push,
      });
      if (signal.handled) return { ...none, jobCardId: signal.jobCardId };
    }

    const corrections = parseQuickCorrection(input.message.text);
    if (corrections.length === 0) return none;

    const open = await this.deps.intake.openDraftForConversation(
      input.shopId,
      routed.conversationId,
    );
    if (open === null) return none;

    const summary = await this.deps.pipeline.summarise(input.shopId, open.id, routed.language);
    if (summary === null) return none;

    const actor: Actor =
      routed.senderStaffId === null ? SYSTEM_ACTOR : { type: 'STAFF', id: routed.senderStaffId };

    const applied: string[] = [];
    for (const correction of corrections) {
      const path = pathForLine(summary.summary, correction.lineIndex);
      if (path === null) {
        push({
          stage: 'intake',
          ok: false,
          detail: `Line ${correction.lineIndex} is not on this draft`,
        });
        continue;
      }
      try {
        await this.deps.intake.correct({
          shopId: input.shopId,
          draftId: open.id,
          path,
          value: correction.value,
          actor,
          traceId: input.traceId,
        });
        applied.push(`${path} = ${correction.value}`);
      } catch (error) {
        push({ stage: 'intake', ok: false, detail: `${path}: ${messageOf(error)}` });
      }
    }

    if (applied.length === 0) return { ...none, draftId: open.id };

    push({ stage: 'intake', ok: true, detail: `Corrected ${applied.join('; ')}` });

    // Re-send the summary rather than a bare acknowledgement: the person is
    // proofreading, and what they need next is the corrected list in front of
    // them with the buttons still attached.
    const refreshed = await this.deps.pipeline.summarise(input.shopId, open.id, routed.language);
    const outcome = await this.send({
      shopId: input.shopId,
      routed,
      content: refreshed?.content ?? summary.content,
      config,
      traceId: input.traceId,
    });
    push({ stage: 'gate', ok: outcome.status === 'SENT', detail: describeOutcome(outcome) });

    return { replies: [outcome], draftId: open.id, jobCardId: null };
  }

  /* ------------------------------------------------- technician status notes */

  /**
   * A staff-group note, read and — when it is about a car already in the
   * workshop — captured as a status signal (phase 4.2).
   *
   * `handled: false` means *"not a status note"*, which is the caller's cue to
   * carry on down the intake path. Two things produce it:
   *
   *   - **The note named no vehicle.** Nothing is written at all: a confirm
   *     queue that filled up with new arrivals could not answer "how often was
   *     the parser right?", which is the only question that queue exists for.
   *   - **It named one the shop does not have open.** A signal row *is* written
   *     — the parse was a genuine attempt and belongs in the denominator — and
   *     then intake runs, because a plate nobody is working on is exactly what
   *     a car arriving for the first time looks like.
   *
   * Either way the transcript comes back with the answer, so the voice note is
   * transcribed once however the fork goes.
   */
  /**
   * A comment following a feedback face (phase 6.4).
   *
   * Returns true when it took the message, and true is the end of the line for
   * it: a customer explaining why the service went badly is not also opening a
   * job card. That is the whole reason this sits above the intake fall-through
   * rather than beside it.
   *
   * A voice note is transcribed when there is something to transcribe with, and
   * kept as an audio reference either way — the words are for the advisor, the
   * recording is what the customer actually sent.
   */
  private async tryFeedbackComment(args: {
    readonly input: HandleInboundInput;
    readonly routed: RoutedMessage;
    readonly customerId: string;
    readonly media: FetchedMedia | null;
    readonly mediaId: string | null;
    readonly push: (step: Omit<TraceStep, 'at'>) => void;
  }): Promise<boolean> {
    const { input, routed, customerId, media, push } = args;
    const port = this.deps.retention;
    if (port === undefined) return false;

    const isVoiceNote = input.message.media !== null && input.message.media.kind === 'AUDIO';
    const typed = input.message.text.length > 0 ? input.message.text : (input.message.caption ?? '');

    let comment = typed.trim();
    if (comment.length === 0 && isVoiceNote && media !== null) {
      const transcribe = this.deps.transcribeVoiceNote;
      if (transcribe !== undefined) {
        try {
          comment = (
            await transcribe({
              shopId: input.shopId,
              bytes: media.bytes,
              contentType: media.contentType,
              languageHint: routed.language,
            })
          )?.trim() ?? '';
        } catch (error) {
          // A recogniser outage must not swallow the customer's complaint. The
          // audio reference still reaches the record below.
          push({ stage: 'status', ok: false, detail: `Could not transcribe: ${messageOf(error)}` });
        }
      }
    }

    if (comment.length === 0 && !isVoiceNote) return false;

    const attached = await port.attachFeedbackComment({
      shopId: input.shopId,
      customerId,
      comment,
      viaVoiceNote: isVoiceNote,
      mediaId: args.mediaId,
      traceId: input.traceId,
    });

    if (attached) {
      push({
        stage: 'status',
        ok: true,
        detail: isVoiceNote
          ? `Voice comment attached to this visit's feedback${comment.length === 0 ? ' (not transcribed)' : ''}`
          : "Comment attached to this visit's feedback",
      });
    }
    return attached;
  }

  private async tryTechnicianNote(args: {
    readonly input: HandleInboundInput;
    readonly routed: RoutedMessage;
    readonly source: 'VOICE_NOTE' | 'PHOTO' | 'TEXT';
    readonly media: FetchedMedia | null;
    readonly mediaId: string | null;
    readonly push: (step: Omit<TraceStep, 'at'>) => void;
  }): Promise<
    | { readonly handled: true; readonly jobCardId: string | null }
    | { readonly handled: false; readonly transcript: string | null }
  > {
    const { input, routed, source, media, push } = args;
    const port = this.deps.technicianNotes;
    const unhandled = { handled: false as const, transcript: null };

    if (port === undefined) return unhandled;
    if (!this.isStaffOriginated(routed)) return unhandled;

    const text = input.message.text.length > 0 ? input.message.text : (input.message.caption ?? '');
    const audio =
      source === 'VOICE_NOTE' && media !== null
        ? { bytes: media.bytes, contentType: media.contentType }
        : null;
    if (audio === null && text.trim().length === 0) return unhandled;

    let reading;
    try {
      reading = await port.read({
        shopId: input.shopId,
        text,
        audio,
        languageHint: routed.language,
        traceId: input.traceId,
      });
    } catch (error) {
      // A recogniser outage. Say so and let intake try — it has its own voice
      // path and its own apology, and one apology to the group is enough.
      push({ stage: 'status', ok: false, detail: `Could not read the note: ${messageOf(error)}` });
      return unhandled;
    }
    if (reading === null) return unhandled;

    const replyToMessageId = await this.resolveReplyContext(input);

    if (
      !noteIdentifiesAVehicle({
        parsed: reading.parsed,
        hasReplyContext: replyToMessageId !== null,
      })
    ) {
      push({
        stage: 'status',
        ok: true,
        detail: 'No vehicle named — treated as intake rather than a status update',
      });
      return { handled: false, transcript: reading.transcript };
    }

    const outcome = await port.capture({
      shopId: input.shopId,
      parsed: reading.parsed,
      source,
      transcript: reading.transcript,
      transcriptConfidence: reading.transcriptConfidence,
      conversationId: routed.conversationId,
      messageId: routed.messageId,
      // The photo behind an `issue_found` note is the evidence the phase-3
      // bundle is built from; dropping it here would send an advisor to look
      // for a picture the system had and forgot.
      mediaId: args.mediaId,
      senderStaffId: routed.senderStaffId,
      replyToMessageId,
      actor:
        routed.senderStaffId === null
          ? SYSTEM_ACTOR
          : { type: 'STAFF', id: routed.senderStaffId },
      traceId: input.traceId,
    });

    push({
      stage: 'status',
      ok: true,
      detail: `${outcome.route} · ${(reading.parsed.confidence * 100).toFixed(0)}% — ${outcome.detail}`,
      data: {
        signalId: outcome.signalId,
        signalType: reading.parsed.signalType,
        transcript: reading.transcript,
        workItemIds: outcome.workItemIds,
      },
    });

    if (outcome.route === 'NO_CARD_MATCH') {
      return { handled: false, transcript: reading.transcript };
    }

    return { handled: true, jobCardId: outcome.jobCardId };
  }

  /** The internal id of the message a staff note replied to, when it was one. */
  private async resolveReplyContext(input: HandleInboundInput): Promise<string | null> {
    const providerId = input.message.contextProviderMessageId;
    if (providerId === null) return null;

    const found = await this.deps.uow.transaction((tx) =>
      this.deps.messages.findByProviderMessageId(tx, input.shopId, providerId),
    );
    return found?.id ?? null;
  }

  /* ---------------------------------------------------------------- helpers */

  private isStaffOriginated(routed: RoutedMessage): boolean {
    return routed.conversationKind === 'STAFF_GROUP' || routed.senderStaffId !== null;
  }

  private async send(args: {
    readonly shopId: string;
    readonly routed: RoutedMessage;
    readonly content: OutboundContent;
    readonly config: ShopConfig;
    readonly traceId: string;
    readonly consentFlow?: 'CAPTURE' | 'OPT_OUT_ACK';
  }): Promise<GateOutcome> {
    return this.deps.gate.send({
      shopId: args.shopId,
      conversationId: args.routed.conversationId,
      customerId: args.routed.customerId,
      purpose: 'SERVICE',
      content: await this.withDisclosure(
        args.shopId,
        args.routed,
        args.content,
        args.consentFlow,
      ),
      actor: SYSTEM_ACTOR,
      traceId: args.traceId,
      // Nothing here is an agent decision: these are acknowledgements the shop
      // owes the sender. See `OutboundRequest.systemReply`.
      flow: 'status',
      systemReply: true,
      language: args.routed.language,
      ...(args.consentFlow === undefined ? {} : { consentFlow: args.consentFlow }),
    });
  }

  /**
   * Prefixes the mandatory AI disclosure when this is the first thing the shop
   * has ever said on a customer thread (master §6).
   *
   * The gate applies exactly this test and would refuse the message otherwise,
   * so composing without it would turn a compliance rule into an intermittent
   * "the reply never arrived". Two exemptions, both the gate's own: an opt-out
   * acknowledgement is the customer's instruction being honoured rather than an
   * AI-initiated contact, and the staff group is not a customer.
   */
  private async withDisclosure(
    shopId: string,
    routed: RoutedMessage,
    content: OutboundContent,
    consentFlow: 'CAPTURE' | 'OPT_OUT_ACK' | undefined,
  ): Promise<OutboundContent> {
    if (consentFlow === 'OPT_OUT_ACK') return content;
    if (routed.conversationKind === 'STAFF_GROUP') return content;
    if (content.kind !== 'text' && content.kind !== 'interactive') return content;
    if (disclosesAi(content.body)) return content;

    const priorOutbound = await this.deps.uow.transaction(async (tx) =>
      this.deps.messages.countOutbound(tx, routed.conversationId),
    );
    if (priorOutbound > 0) return content;

    const shopName = await this.shopName(shopId);
    const disclosure = t(routed.language, 'disclosure.first_contact', {
      customerName: '',
      shopName,
    }).replace(/\s{2,}/g, ' ');

    return { ...content, body: `${disclosure}\n\n${content.body}` };
  }

  private async shopName(shopId: string): Promise<string> {
    const name = await this.deps.uow.transaction(async (tx) =>
      this.deps.directory.loadShopName(tx, shopId),
    );
    return name ?? 'the workshop';
  }

  private async loadConfig(shopId: string): Promise<ShopConfig> {
    return this.deps.uow.transaction(async (tx) => {
      const stored = await this.deps.config.load(tx, shopId);
      const timezone = (await this.deps.config.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
      return migrateShopConfig(stored?.raw ?? {}, timezone).config;
    });
  }
}

/* -------------------------------------------------------------------------- *
 * Copy
 * -------------------------------------------------------------------------- */

function rejectionCopy(rejection: MediaRejection, language: Language): string {
  switch (rejection.code) {
    case 'TOO_LARGE':
      return t(language, 'media.too_large', {
        size: formatBytes(rejection.sizeBytes ?? 0),
        limit: formatBytes(rejection.limitBytes ?? 0),
      });
    case 'UNSUPPORTED_TYPE':
      return t(language, 'media.unsupported_type', { type: rejection.contentType ?? 'those' });
    case 'INFECTED':
      // Deliberately vague about *what* was found. Naming the signature to a
      // customer tells whoever sent it which detection they tripped, and the
      // overwhelmingly likely sender is a person whose own phone is infected
      // and who needs to be told plainly, not diagnosed at.
      return t(language, 'media.infected');
    case 'SCAN_UNAVAILABLE':
      return t(language, 'media.scan_unavailable');
    case 'EMPTY':
    case 'UNREADABLE':
      return t(language, 'intake.extraction_failed');
  }
}

function describeOutcome(outcome: GateOutcome): string {
  switch (outcome.status) {
    case 'SENT':
      return `Sent as ${outcome.providerMessageId}`;
    case 'BLOCKED':
      return `Blocked (${outcome.code}): ${outcome.reason}`;
    case 'DEFERRED':
      return `Held until ${outcome.deferUntil.toISOString()}: ${outcome.reason}`;
    case 'PENDING_APPROVAL':
      return `Waiting for advisor approval: ${outcome.reason}`;
    case 'FAILED':
      return `Send failed (${outcome.code}): ${outcome.reason}`;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Never put a full number in a trace a browser will render. */
function maskAddress(address: string): string {
  if (address.startsWith('group:')) return address;
  return address.length <= 4 ? '••••' : `••••${address.slice(-4)}`;
}
