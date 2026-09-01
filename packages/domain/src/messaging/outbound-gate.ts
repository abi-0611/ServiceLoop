import { migrateShopConfig, type ShopConfig } from '@serviceloop/config';
import {
  type AutonomyFlow,
  type ChannelType,
  type Clock,
  type ConsentPurpose,
  type EventEnvelope,
  type Language,
  type MessageKind,
  systemClock,
  uuidv7,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import {
  autonomyFor,
  checkClaimAnchoring,
  checkConsent,
  checkDisclosure,
  checkFrequencyCaps,
  evaluateQuietHours,
  resolveSendMode,
  type EvidenceRef,
  type PolicyVerdict,
} from '../guardrails/policies';
import type { AuditAppender, OutboxWriter, ShopConfigStore, UnitOfWork } from '../ports';
import type {
  ChannelSender,
  ConsentStore,
  ConversationStore,
  MessageStore,
  RetentionFrequencyReader,
  SmsFallbackContent,
} from './ports';
import { isWindowOpen } from './session';
import type { ConversationSnapshot, OutboundContent } from './types';

/**
 * OutboundGate — the single choke point every customer-facing message passes.
 *
 * Master §10: "Don't let any code path send a customer message without passing
 * the consent gate, autonomy check, and post-checker." This class is how that
 * is *enforced* rather than merely intended: `packages/domain/messaging` exports
 * the gate and no other sender, the `ChannelSender` transport is a private
 * constructor dependency, and `no-bypass.test.ts` walks the repository to prove
 * nothing else calls a channel directly.
 *
 * Every decision writes a `messages` row. A refusal is a `BLOCKED` row with a
 * code and reason, a quiet-hours hold is a `QUEUED` row with `scheduledFor`,
 * and an autonomy hold is `PENDING_APPROVAL`. There is no outcome in which a
 * message simply disappears.
 */

export interface OutboundRequest {
  readonly shopId: string;
  readonly conversationId: string;
  /** Null only for the staff group, which is internal and has no consent. */
  readonly customerId: string | null;
  readonly purpose: ConsentPurpose;
  readonly content: OutboundContent;
  readonly actor: Actor;
  readonly traceId: string;
  /** Which autonomy flow governs this send (master §6). */
  readonly flow: AutonomyFlow;
  readonly language?: Language;
  readonly jobCardId?: string | null;
  /** L7 — claims the copy makes, each with the evidence it cites. */
  readonly claims?: readonly { readonly text: string; readonly evidence: readonly EvidenceRef[] }[];
  readonly evidenceRefs?: readonly unknown[];
  readonly createdByAgent?: boolean;
  readonly agentRunId?: string | null;
  /** A human advisor typed this. Bypasses autonomy, never consent. */
  readonly isHumanReply?: boolean;
  /**
   * Mandatory acknowledgement copy the shop has no discretion over: the
   * identification prompt for an unknown number, the opt-out confirmation, the
   * consent ask itself, a "that file was too large" notice, and the numbered
   * draft summary a technician confirms.
   *
   * Autonomy governs what the *agent* chooses to say (master §6: "agent drafts;
   * every send requires HITL approval"). It is not a licence to hold back the
   * confirmation a customer is owed the instant they type STOP, or to leave an
   * unrecognised number in silence while an advisor is at lunch. Every
   * customer protection — consent, window, quiet hours, caps, disclosure —
   * still applies, and each of these messages is audited like any other.
   */
  readonly systemReply?: boolean;
  /**
   * This message confirms something the customer just did — tapped Approve,
   * asked to be called, made a decision.
   *
   * Exempt from **frequency caps only**, for the same reason the opt-out
   * acknowledgement is (deviation 18): the caps exist to stop a shop pestering
   * someone, and a reply to their own action is the opposite of pestering. A
   * customer who taps a button and hears nothing assumes it did not work and
   * taps again — the silence causes the very repetition the cap is meant to
   * prevent.
   *
   * Consent, window, quiet hours, disclosure and claim anchoring all still
   * apply, and it grants nothing to a *business-initiated* message: only a
   * caller answering an inbound action may set it.
   */
  readonly isAcknowledgement?: boolean;
  /**
   * This message answers something the customer just said.
   *
   * Exempt from the **minimum interval between messages** only — see
   * `checkFrequencyCaps`. Set by `send_customer_message`, which is the one tool
   * that puts free-form copy on a channel and which only ever runs in response
   * to an inbound message. The daily and weekly caps still apply.
   */
  readonly isReply?: boolean;
  readonly approvedByStaffId?: string | null;
  readonly replyToMessageId?: string | null;
  readonly mediaId?: string | null;
  /**
   * Marks the two messages that exist to *establish* consent: the first-contact
   * identification/consent ask, and the acknowledgement of an opt-out. Both are
   * still gated on window, quiet hours (except the opt-out ack) and caps.
   */
  readonly consentFlow?: 'CAPTURE' | 'OPT_OUT_ACK' | null;
  /**
   * The copy came from the i18n catalogue, not from a model (phase 4.4).
   *
   * Master §6 defines L1 as auto-send for "low-risk templated messages (status
   * updates, ready alerts)" — and until phase 4 the gate read "templated" as
   * "a Meta-approved template", which is a narrower thing. A proactive status
   * update sent inside the 24-hour window is free-form as far as WhatsApp is
   * concerned and fully templated as far as *risk* is concerned: fixed
   * sentences from a reviewed catalogue with a time and a vehicle substituted
   * in. Without this distinction the phase's own requirement is unsatisfiable,
   * because a message cannot be both templated (so it may auto-send at L1) and
   * composed by a model (which makes it free-form, hence L2).
   *
   * It is ignored when `createdByAgent` is set, which is the case that matters:
   * the agent's `send_customer_message` cannot assert its own output is
   * templated and talk its way from L1 into auto-sending free prose.
   */
  readonly templated?: boolean;
  /**
   * What this message would say over SMS if WhatsApp were unreachable
   * (phase 7.3).
   *
   * Supplied by the composer, never derived here, and the reason is legal
   * rather than architectural: an Indian SMS may only carry DLT-registered
   * content, so the fallback text has to be one a human submitted to the
   * registry and an operator approved. A gate that rendered its own plain-text
   * version of an interactive message would produce something the operator
   * accepts and then silently discards, which looks exactly like a delivered
   * message from in here.
   *
   * Omitting it is a legitimate choice and the common one. A message with no
   * fallback simply does not fall back: the send fails, and the ladder raises
   * the advisor task it raises for any other unsendable rung.
   */
  readonly smsFallback?: SmsFallbackContent;
}

export type GateOutcome =
  | {
      readonly status: 'SENT';
      readonly messageId: string;
      readonly providerMessageId: string;
    }
  | {
      readonly status: 'BLOCKED';
      readonly messageId: string;
      readonly code: string;
      readonly reason: string;
    }
  | {
      readonly status: 'DEFERRED';
      readonly messageId: string;
      readonly deferUntil: Date;
      readonly reason: string;
    }
  | {
      readonly status: 'PENDING_APPROVAL';
      readonly messageId: string;
      readonly reason: string;
    }
  | {
      readonly status: 'FAILED';
      readonly messageId: string;
      readonly code: string;
      readonly reason: string;
    };

export interface OutboundGateDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly messages: MessageStore<Tx>;
  readonly consents: ConsentStore<Tx>;
  readonly config: ShopConfigStore<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly sender: ChannelSender;
  /**
   * The retention floor and the service-recovery freeze (phase 6.1 / 6.4).
   *
   * Optional, and its absence is not a degraded mode: a deployment without the
   * retention module has no retention traffic, so there is nothing for a
   * retention floor to apply to. What it is *not* is a knob — a build that has
   * retention wired passes this, and every retention touch is then measured
   * against the shop's twenty-one-day minimum here, in the frequency layer,
   * rather than in whichever composer happened to produce the message.
   *
   * That placement is the phase's own requirement and it earns its keep: a
   * fifth retention flow written next year inherits the floor without its
   * author knowing the floor exists.
   */
  readonly retention?: RetentionFrequencyReader<Tx>;
  readonly clock?: Clock;
}

interface Preflight {
  readonly conversation: ConversationSnapshot;
  readonly config: ShopConfig;
  readonly now: Date;
}

type Decision =
  | { readonly kind: 'send' }
  | { readonly kind: 'block'; readonly code: string; readonly reason: string }
  | { readonly kind: 'defer'; readonly until: Date; readonly reason: string }
  | { readonly kind: 'hitl'; readonly reason: string };

export class OutboundGate<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: OutboundGateDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  get channel(): ChannelType {
    return this.deps.sender.channel;
  }

  /**
   * The only way to send. Persists the message row and the decision in one
   * transaction, then — and only when the decision is `send` — hands the bytes
   * to the channel and records the provider id in a second transaction.
   *
   * The split is deliberate: holding a database transaction open across an HTTP
   * call to Meta would pin a connection for the length of a network round trip,
   * and a rollback after a successful send would lose the record of a message
   * the customer has already received.
   */
  async send(request: OutboundRequest): Promise<GateOutcome> {
    const messageId = uuidv7();

    const prepared = await this.deps.uow.transaction(
      async (tx): Promise<{ decision: Decision; preflight: Preflight }> => {
        const preflight = await this.preflight(tx, request);
        const decision = await this.decide(tx, request, preflight);
        await this.persist(tx, request, messageId, decision, preflight);
        return { decision, preflight };
      },
    );

    switch (prepared.decision.kind) {
      case 'block':
        return {
          status: 'BLOCKED',
          messageId,
          code: prepared.decision.code,
          reason: prepared.decision.reason,
        };
      case 'defer':
        return {
          status: 'DEFERRED',
          messageId,
          deferUntil: prepared.decision.until,
          reason: prepared.decision.reason,
        };
      case 'hitl':
        return { status: 'PENDING_APPROVAL', messageId, reason: prepared.decision.reason };
      case 'send':
        return this.dispatch(request, messageId, prepared.preflight);
    }
  }

  /**
   * Re-runs the gate for a message a human approved in the HITL queue, or one
   * whose quiet-hours hold has elapsed. Approval does not grant a free pass:
   * consent may have been revoked while the message sat in the queue.
   */
  async release(
    request: OutboundRequest,
    messageId: string,
    approvedByStaffId: string | null,
  ): Promise<GateOutcome> {
    const prepared = await this.deps.uow.transaction(async (tx) => {
      const preflight = await this.preflight(tx, request);
      // Autonomy is not re-checked: a human has already taken responsibility
      // for this specific message. Everything protecting the *customer* is.
      const decision = await this.decideCustomerProtections(tx, request, preflight);
      if (decision.kind !== 'send') {
        await this.persistDecisionUpdate(tx, request, messageId, decision, preflight);
      }
      return { decision, preflight };
    });

    switch (prepared.decision.kind) {
      case 'block':
        return {
          status: 'BLOCKED',
          messageId,
          code: prepared.decision.code,
          reason: prepared.decision.reason,
        };
      case 'defer':
        return {
          status: 'DEFERRED',
          messageId,
          deferUntil: prepared.decision.until,
          reason: prepared.decision.reason,
        };
      case 'hitl':
        return { status: 'PENDING_APPROVAL', messageId, reason: prepared.decision.reason };
      case 'send':
        return this.dispatch(
          { ...request, approvedByStaffId },
          messageId,
          prepared.preflight,
          true,
        );
    }
  }

  /* ------------------------------------------------------------- decisions */

  private async preflight(tx: Tx, request: OutboundRequest): Promise<Preflight> {
    const conversation = await this.deps.conversations.lockById(
      tx,
      request.shopId,
      request.conversationId,
    );
    if (conversation === null) {
      throw new Error(`Conversation ${request.conversationId} does not exist in this shop`);
    }

    const stored = await this.deps.config.load(tx, request.shopId);
    const timezone = (await this.deps.config.loadShopTimezone(tx, request.shopId)) ?? 'Asia/Kolkata';
    const config = migrateShopConfig(stored?.raw ?? {}, timezone).config;

    return { conversation, config, now: this.clock.now() };
  }

  private async decide(
    tx: Tx,
    request: OutboundRequest,
    preflight: Preflight,
  ): Promise<Decision> {
    // Everything that *blocks* comes first: a message that would be refused for
    // the customer's sake must not sit in a human's approval queue pretending
    // to be sendable.
    const blocking = await this.decideCustomerProtections(tx, request, preflight, false);
    if (blocking.kind !== 'send') return blocking;

    // Autonomy before quiet hours, deliberately.
    //
    // A quiet-hours *defer* is about when a customer may be disturbed, not
    // about when an advisor may read something. Deferring first would hide the
    // draft from the review queue until morning and only then start the clock
    // on a human looking at it — so a 21:30 estimate would reach the customer a
    // working day late. Holding for review first lets the advisor clear it at
    // 21:30; `release()` re-runs quiet hours, so the customer still hears
    // nothing until 08:00.
    if (request.isHumanReply !== true && request.systemReply !== true) {
      const level = autonomyFor(preflight.config, request.flow);
      const mode = resolveSendMode(level, {
        templated:
          request.content.kind === 'template' ||
          (request.templated === true && request.createdByAgent !== true),
        channel: this.deps.sender.channel === 'VOICE' ? 'VOICE' : 'WHATSAPP',
      });

      if (mode === 'HITL_REQUIRED') {
        return {
          kind: 'hitl',
          reason: `Autonomy for the ${request.flow} flow is ${level}; this message needs advisor approval before it can be sent`,
        };
      }
    }

    return this.quietHoursDecision(request, preflight.config, preflight.now);
  }

  /**
   * Everything that exists to protect the customer rather than to manage the
   * shop's risk appetite. `release()` re-runs exactly this set, so an approved
   * message still cannot go out to someone who has since opted out.
   */
  private async decideCustomerProtections(
    tx: Tx,
    request: OutboundRequest,
    preflight: Preflight,
    withQuietHours = true,
  ): Promise<Decision> {
    const { conversation, config, now } = preflight;
    const quietHours = (): Decision =>
      withQuietHours ? this.quietHoursDecision(request, config, now) : { kind: 'send' };

    // The staff evidence group is internal: no consent, no window, no caps.
    // Quiet hours still apply — technicians sleep too.
    if (conversation.kind === 'STAFF_GROUP') {
      return quietHours();
    }

    if (request.customerId === null) {
      // An unidentified thread may only be answered inside its own window, and
      // only to ask who is calling.
      if (!isWindowOpen(conversation.windowExpiresAt, now)) {
        return {
          kind: 'block',
          code: 'UNIDENTIFIED_RECIPIENT',
          reason:
            'This thread has no customer on record and its 24-hour window has closed; there is no lawful basis to message it',
        };
      }
      // Quiet hours still apply. Not knowing who someone is does not make it
      // acceptable to write to them at 2am — if anything it is worse, since
      // there is no relationship to justify the intrusion. Consent and caps
      // genuinely cannot be evaluated without a customer record; this can.
      return quietHours();
    }

    const consentDecision = await this.consentDecision(tx, request, preflight);
    if (consentDecision.kind !== 'send') return consentDecision;

    const windowDecision = this.windowDecision(request, conversation, now);
    if (windowDecision.kind !== 'send') return windowDecision;

    const claims = request.claims ?? [];
    if (claims.length > 0) {
      const anchoring = checkClaimAnchoring(claims);
      if (!anchoring.allowed) return toBlock(anchoring);
    }

    const disclosure = await this.disclosureDecision(tx, request, preflight);
    if (disclosure.kind !== 'send') return disclosure;

    const capsDecision = await this.frequencyDecision(tx, request, preflight);
    if (capsDecision.kind !== 'send') return capsDecision;

    return quietHours();
  }

  private async consentDecision(
    tx: Tx,
    request: OutboundRequest,
    preflight: Preflight,
  ): Promise<Decision> {
    const customerId = request.customerId;
    if (customerId === null) return { kind: 'send' };

    const rows = await this.deps.consents.current(tx, request.shopId, customerId);
    const snapshots = rows.map((row) => ({ purpose: row.purpose, status: row.status }));
    const relevant = snapshots.find((row) => row.purpose === request.purpose);

    // A revocation silences everything except the single acknowledgement that
    // confirms it. That message is the customer's own request being honoured.
    if (relevant?.status === 'REVOKED') {
      return request.consentFlow === 'OPT_OUT_ACK'
        ? { kind: 'send' }
        : {
            kind: 'block',
            code: 'CONSENT_REVOKED',
            reason: `${request.purpose} consent has been revoked by this customer`,
          };
    }

    if (request.purpose === 'MARKETING') {
      // Never implied by a SERVICE grant, in any configuration (DPDP purpose
      // limitation, and `requireExplicitMarketingConsent` is a z.literal(true)).
      const verdict = checkConsent('MARKETING', snapshots);
      return verdict.allowed ? { kind: 'send' } : toBlock(verdict);
    }

    // SERVICE. A customer who messaged us first has, by messaging us, given a
    // lawful basis to reply — that reply is how consent gets asked for at all.
    // Outside the window the contact is business-initiated and needs a grant.
    const windowOpen = isWindowOpen(preflight.conversation.windowExpiresAt, preflight.now);
    if (windowOpen) return { kind: 'send' };

    if (preflight.config.consent.impliedServiceConsentFromCounter) {
      // Implied consent from a counter handover. The copy still carries the
      // opt-out line, which `consent.implied_notice` guarantees.
      return { kind: 'send' };
    }

    const verdict = checkConsent('SERVICE', snapshots);
    if (verdict.allowed) return { kind: 'send' };
    return request.consentFlow === 'CAPTURE' && request.content.kind === 'template'
      ? // The consent ask itself, sent as an approved template — the only way
        // to open a conversation with someone who has not yet said yes.
        { kind: 'send' }
      : toBlock(verdict);
  }

  private windowDecision(
    request: OutboundRequest,
    conversation: ConversationSnapshot,
    now: Date,
  ): Decision {
    if (isWindowOpen(conversation.windowExpiresAt, now)) return { kind: 'send' };
    if (request.content.kind === 'template') return { kind: 'send' };

    return {
      kind: 'block',
      code: 'WINDOW_CLOSED_NEEDS_TEMPLATE',
      reason:
        conversation.windowExpiresAt === null
          ? 'This customer has never messaged this thread, so only an approved template may open it'
          : `The 24-hour customer-service window closed at ${conversation.windowExpiresAt.toISOString()}; only an approved template may be sent`,
    };
  }

  private async disclosureDecision(
    tx: Tx,
    request: OutboundRequest,
    preflight: Preflight,
  ): Promise<Decision> {
    // A human advisor typing in the inbox is not an AI and does not disclose.
    if (request.isHumanReply === true) return { kind: 'send' };

    // Honouring an opt-out is not an AI-initiated contact — it is the customer's
    // own instruction being confirmed. Requiring a disclosure preamble here
    // would mean a customer whose first ever message is "STOP" never gets the
    // confirmation that it worked, which is the one message they are owed.
    if (request.consentFlow === 'OPT_OUT_ACK') return { kind: 'send' };

    const priorOutbound = await this.deps.messages.countOutbound(tx, request.conversationId);
    const verdict = checkDisclosure(preflight.config, {
      isFirstContactInSession: priorOutbound === 0,
      isVoiceCall: false,
      bodyIncludesDisclosure: bodyDisclosesAi(request.content),
    });
    return verdict.allowed ? { kind: 'send' } : toBlock(verdict);
  }

  private async frequencyDecision(
    tx: Tx,
    request: OutboundRequest,
    preflight: Preflight,
  ): Promise<Decision> {
    const customerId = request.customerId;
    if (customerId === null) return { kind: 'send' };
    // Honouring an opt-out is not "another message" for cap purposes; refusing
    // to confirm it because of a cap would leave the customer unsure it worked.
    if (request.consentFlow === 'OPT_OUT_ACK') return { kind: 'send' };
    // Nor is the consent ask itself. Frequency caps exist to stop a shop
    // pestering someone; the message that asks whether the shop may write at
    // all is the opposite of that, and it is sent at most once per customer —
    // `ConsentCaptureService` records a PENDING row before sending and refuses
    // a second ask — so it cannot be turned into a way around the cap. Blocking
    // it would strand the customer with no consent record and the shop with no
    // lawful way to obtain one.
    if (request.consentFlow === 'CAPTURE') return { kind: 'send' };
    // And nor is confirming what the customer has just done — see the note on
    // `isAcknowledgement`.
    if (request.isAcknowledgement === true) return { kind: 'send' };

    const weekAgo = new Date(preflight.now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const sentAt = await this.deps.messages.recentOutboundAt(
      tx,
      request.shopId,
      customerId,
      weekAgo,
    );

    const verdict = checkFrequencyCaps(
      preflight.config,
      { sentAt, isReply: request.isReply === true },
      preflight.now,
    );
    if (!verdict.allowed) return toBlock(verdict);

    return this.retentionDecision(tx, request, preflight, customerId);
  }

  /**
   * The two rules that apply to retention traffic and to nothing else
   * (phases 6.1 and 6.4).
   *
   * **The freeze comes first.** A customer who has just told the shop their
   * visit went badly is not somebody to sell to, and the hold stands until an
   * advisor has closed the recovery task. It refuses every purpose and every
   * trigger, because "we froze retention but the win-back still went out" is
   * the failure this exists to make impossible.
   *
   * **Then the floor.** At least `minDaysBetweenTouches` between *any* two
   * retention touches to one person — re-pitches, service reminders, document
   * reminders and win-backs together, which is why it is measured from the
   * retention store rather than from `messages`. Four flows each respecting
   * their own cadence and jointly writing weekly is precisely the outcome a
   * per-flow limit produces and this one does not.
   *
   * Acknowledgements are exempt, for the reason every other acknowledgement is:
   * a customer who taps "Not interested" and hears nothing assumes it did not
   * work and taps again.
   */
  private async retentionDecision(
    tx: Tx,
    request: OutboundRequest,
    preflight: Preflight,
    customerId: string,
  ): Promise<Decision> {
    if (request.flow !== 'retention') return { kind: 'send' };
    if (request.isAcknowledgement === true) return { kind: 'send' };

    const reader = this.deps.retention;
    if (reader === undefined) return { kind: 'send' };

    const facts = await reader.facts(tx, request.shopId, customerId);

    if (facts.frozenReason !== null) {
      return {
        kind: 'block',
        code: 'RETENTION_FROZEN',
        reason: `Retention is on hold for this customer: ${facts.frozenReason}`,
      };
    }

    const minDays = preflight.config.retention.minDaysBetweenTouches;
    if (facts.lastTouchAt === null) return { kind: 'send' };

    const daysSince = (preflight.now.getTime() - facts.lastTouchAt.getTime()) / 86_400_000;
    if (daysSince >= minDays) return { kind: 'send' };

    return {
      kind: 'block',
      code: 'RETENTION_FLOOR_NOT_ELAPSED',
      reason: `Only ${Math.floor(daysSince)} day(s) since the last retention touch; this shop requires ${minDays}`,
    };
  }

  private quietHoursDecision(
    request: OutboundRequest,
    config: ShopConfig,
    now: Date,
  ): Decision {
    // An opt-out acknowledgement is a compliance obligation and goes out at
    // once: "confirm once, immediately" beats "confirm at 8am".
    if (request.consentFlow === 'OPT_OUT_ACK') return { kind: 'send' };

    const verdict = evaluateQuietHours(config, now);
    if (!verdict.withinQuietHours || verdict.deferUntil === null) return { kind: 'send' };

    return {
      kind: 'defer',
      until: verdict.deferUntil,
      reason: `Quiet hours (${config.quietHours.start}–${config.quietHours.end} ${config.quietHours.timezone}); held until ${verdict.deferUntil.toISOString()}`,
    };
  }

  /* ------------------------------------------------------------ persistence */

  private async persist(
    tx: Tx,
    request: OutboundRequest,
    messageId: string,
    decision: Decision,
    preflight: Preflight,
  ): Promise<void> {
    const status =
      decision.kind === 'send'
        ? 'QUEUED'
        : decision.kind === 'block'
          ? 'BLOCKED'
          : decision.kind === 'defer'
            ? 'QUEUED'
            : 'PENDING_APPROVAL';

    const content = request.content;
    const language =
      request.language ?? preflight.conversation.language ?? preflight.config.languages.default;

    await this.deps.messages.insert(tx, {
      id: messageId,
      shopId: request.shopId,
      conversationId: request.conversationId,
      direction: 'OUTBOUND',
      status,
      channel: this.deps.sender.channel,
      kind: messageKindFor(content),
      language,
      body: bodyOf(content),
      purpose: request.purpose,
      templateName: content.kind === 'template' ? content.templateName : null,
      templateLanguage: content.kind === 'template' ? content.templateLanguage : null,
      templateVariables: content.kind === 'template' ? content.variables : null,
      interactive: content.kind === 'interactive' ? interactiveOf(content) : null,
      conversationCategory: content.kind === 'template' ? content.category : null,
      mediaId: request.mediaId ?? (content.kind === 'media' ? content.mediaId : null),
      jobCardId: request.jobCardId ?? null,
      replyToMessageId: request.replyToMessageId ?? null,
      evidenceRefs: request.evidenceRefs ?? [],
      createdByAgent: request.createdByAgent ?? false,
      isHumanReply: request.isHumanReply ?? false,
      agentRunId: request.agentRunId ?? null,
      approvedByStaffId: request.approvedByStaffId ?? null,
      scheduledFor: decision.kind === 'defer' ? decision.until : null,
      blockedCode: decision.kind === 'block' ? decision.code : null,
      blockedReason: decision.kind === 'block' ? decision.reason : null,
      createdAt: preflight.now,
    });

    await this.recordDecision(tx, request, messageId, decision, preflight);
  }

  private async persistDecisionUpdate(
    tx: Tx,
    request: OutboundRequest,
    messageId: string,
    decision: Decision,
    preflight: Preflight,
  ): Promise<void> {
    if (decision.kind === 'block') {
      await this.deps.messages.markFailed(tx, {
        messageId,
        errorCode: decision.code,
        failureReason: decision.reason,
      });
    }

    // A release that lands in quiet hours must go back on the queue with its
    // due time. Recording the decision without rescheduling would leave an
    // approved message stuck in `PENDING_APPROVAL` and never sent.
    if (decision.kind === 'defer') {
      await this.deps.messages.reschedule(tx, {
        messageId,
        scheduledFor: decision.until,
      });
    }

    await this.recordDecision(tx, request, messageId, decision, preflight);
  }

  private async recordDecision(
    tx: Tx,
    request: OutboundRequest,
    messageId: string,
    decision: Decision,
    preflight: Preflight,
  ): Promise<void> {
    if (decision.kind === 'send') return;

    const action =
      decision.kind === 'block'
        ? 'message.blocked'
        : decision.kind === 'defer'
          ? 'message.deferred'
          : 'message.held_for_approval';

    await this.deps.audit.append(tx, {
      shopId: request.shopId,
      actorType: request.actor.type,
      actorId: request.actor.id,
      action,
      entityType: 'Message',
      entityId: messageId,
      payload: {
        conversationId: request.conversationId,
        purpose: request.purpose,
        flow: request.flow,
        ...(decision.kind === 'block' ? { code: decision.code, reason: decision.reason } : {}),
        ...(decision.kind === 'defer'
          ? { deferUntil: decision.until.toISOString(), reason: decision.reason }
          : {}),
        ...(decision.kind === 'hitl' ? { reason: decision.reason } : {}),
      },
      traceId: request.traceId,
    });

    const occurredAt = preflight.now.toISOString();
    const actor = { type: request.actor.type, id: request.actor.id };

    if (decision.kind === 'block') {
      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'message.blocked',
        occurredAt,
        shopId: request.shopId,
        traceId: request.traceId,
        payload: {
          messageId,
          conversationId: request.conversationId,
          customerId: request.customerId,
          purpose: request.purpose,
          code: decision.code,
          reason: decision.reason,
          actor,
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
      return;
    }

    if (decision.kind === 'defer') {
      const envelope: EventEnvelope = {
        id: uuidv7(),
        type: 'message.deferred',
        occurredAt,
        shopId: request.shopId,
        traceId: request.traceId,
        payload: {
          messageId,
          conversationId: request.conversationId,
          deferUntil: decision.until.toISOString(),
          reason: decision.reason,
          actor,
        },
      };
      await this.deps.outbox.enqueue(tx, envelope);
    }
  }

  /* --------------------------------------------------------------- dispatch */

  private async dispatch(
    request: OutboundRequest,
    messageId: string,
    preflight: Preflight,
    alreadyPersisted = false,
  ): Promise<GateOutcome> {
    const address = preflight.conversation.externalAddress;
    if (address === null) {
      const reason = 'The conversation has no provider address to send to';
      await this.deps.uow.transaction(async (tx) => {
        await this.deps.messages.markFailed(tx, {
          messageId,
          errorCode: 'NO_ADDRESS',
          failureReason: reason,
        });
      });
      return { status: 'FAILED', messageId, code: 'NO_ADDRESS', reason };
    }

    try {
      const result = await this.deps.sender.send({
        shopId: request.shopId,
        to: address,
        content: request.content,
        ...(request.smsFallback === undefined ? {} : { fallback: request.smsFallback }),
      });

      // What the row was written with, versus what actually carried it. They
      // differ exactly when a failover sender dropped to SMS.
      const declared = this.deps.sender.channel;
      const carriedBy = result.channel ?? declared;

      await this.deps.uow.transaction(async (tx) => {
        const sentAt = this.clock.now();
        await this.deps.messages.markSent(tx, {
          messageId,
          providerMessageId: result.providerMessageId,
          providerConversationId: result.providerConversationId,
          conversationCategory: result.category,
          sentAt,
          ...(carriedBy === declared ? {} : { channel: carriedBy }),
        });
        await this.deps.conversations.recordOutbound(tx, {
          conversationId: request.conversationId,
          at: sentAt,
        });

        await this.deps.audit.append(tx, {
          shopId: request.shopId,
          actorType: request.actor.type,
          actorId: request.actor.id,
          action: 'message.sent',
          entityType: 'Message',
          entityId: messageId,
          payload: {
            conversationId: request.conversationId,
            purpose: request.purpose,
            flow: request.flow,
            kind: request.content.kind,
            providerMessageId: result.providerMessageId,
            category: result.category,
            approved: alreadyPersisted,
            channel: carriedBy,
            ...(carriedBy === declared ? {} : { fellBackFrom: declared }),
          },
          traceId: request.traceId,
        });

        const envelope: EventEnvelope = {
          id: uuidv7(),
          type: 'message.sent',
          occurredAt: sentAt.toISOString(),
          shopId: request.shopId,
          traceId: request.traceId,
          payload: {
            messageId,
            conversationId: request.conversationId,
            channel: carriedBy,
            purpose: request.purpose,
            templateName:
              request.content.kind === 'template' ? request.content.templateName : null,
            providerMessageId: result.providerMessageId,
            actor: { type: request.actor.type, id: request.actor.id },
          },
        };
        await this.deps.outbox.enqueue(tx, envelope);
      });

      return { status: 'SENT', messageId, providerMessageId: result.providerMessageId };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const code = extractErrorKind(error) ?? 'SEND_FAILED';

      await this.deps.uow.transaction(async (tx) => {
        await this.deps.messages.markFailed(tx, {
          messageId,
          errorCode: code,
          failureReason: reason,
        });
        await this.deps.audit.append(tx, {
          shopId: request.shopId,
          actorType: 'SYSTEM',
          actorId: null,
          action: 'message.send_failed',
          entityType: 'Message',
          entityId: messageId,
          payload: { conversationId: request.conversationId, code, reason },
          traceId: request.traceId,
        });
      });

      return { status: 'FAILED', messageId, code, reason };
    }
  }
}

/* ---------------------------------------------------------------- helpers -- */

function toBlock(verdict: PolicyVerdict): Decision {
  if (verdict.allowed) return { kind: 'send' };
  return { kind: 'block', code: verdict.code, reason: verdict.reason };
}

function bodyOf(content: OutboundContent): string {
  switch (content.kind) {
    case 'text':
      return content.body;
    case 'template':
      return content.preview;
    case 'interactive':
      return content.body;
    case 'media':
      return content.caption ?? '';
  }
}

function messageKindFor(content: OutboundContent): MessageKind {
  switch (content.kind) {
    case 'text':
      return 'TEXT';
    case 'template':
      return 'TEMPLATE';
    case 'interactive':
      return 'INTERACTIVE';
    case 'media':
      return content.mediaKind === 'PHOTO'
        ? 'IMAGE'
        : content.mediaKind === 'AUDIO'
          ? 'AUDIO'
          : content.mediaKind === 'VIDEO'
            ? 'VIDEO'
            : 'DOCUMENT';
  }
}

function interactiveOf(content: Extract<OutboundContent, { kind: 'interactive' }>): unknown {
  return {
    buttons: content.buttons ?? [],
    listButtonLabel: content.listButtonLabel ?? null,
    sections: content.sections ?? [],
    header: content.header ?? null,
    footer: content.footer ?? null,
  };
}

/**
 * The disclosure check is a substring test on the rendered copy, so it works
 * for templates and free-form alike. Matching on the distinctive phrase rather
 * than the whole sentence keeps it robust across the three catalogues.
 */
const DISCLOSURE_MARKERS = [
  'ai assistant',
  'serviceloop assistant',
  'ai உதவியாளர்',
  'serviceloop உதவியாளர்',
  'ai सहायक',
  'serviceloop सहायक',
];

function bodyDisclosesAi(content: OutboundContent): boolean {
  return disclosesAi(bodyOf(content));
}

/**
 * Exported so a composer can ask "does this copy already disclose?" using the
 * *same* test the gate will apply. Two implementations of this check would
 * drift, and the failure mode is a message blocked at the last moment for
 * missing a disclosure its author believed it had.
 */
export function disclosesAi(text: string): boolean {
  const haystack = text.toLowerCase();
  return DISCLOSURE_MARKERS.some((marker) => haystack.includes(marker));
}

/** Reads `kind` off a typed adapter error without importing the adapter package. */
function extractErrorKind(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const kind = (error as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : null;
}
