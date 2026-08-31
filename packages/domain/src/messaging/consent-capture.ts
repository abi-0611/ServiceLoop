import { migrateShopConfig } from '@serviceloop/config';
import { type ChannelType, type Clock, type Language, systemClock, t } from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { ShopConfigStore, ShopDirectory, UnitOfWork } from '../ports';
import type { ConsentService, ConsentState } from './consent';
import type { OutboundGate, GateOutcome } from './outbound-gate';
import type { ConversationStore, CustomerLookup, MessageStore } from './ports';
import type { OutboundContent } from './types';

/**
 * First contact and consent capture (phase 2.9).
 *
 * The first thing a shop ever says to a customer through ServiceLoop has three
 * jobs, and it does all three in one message because a second message would be
 * a second thing to consent to: it says who is writing, it discloses that the
 * writer is an AI (master §6, non-removable), and it asks for SERVICE-purpose
 * consent with a Yes/No the customer can tap.
 *
 * MARKETING is deliberately absent. It is a separate ask, in phase 6, because
 * DPDP purpose limitation means a SERVICE grant can never imply one — the
 * config field that would allow otherwise is a `z.literal(true)`.
 */

export const CONSENT_ACTION_IDS = {
  grantService: 'consent:service:yes',
  revokeService: 'consent:service:no',
} as const;

export interface ParsedConsentAction {
  readonly purpose: 'SERVICE';
  readonly decision: 'GRANTED' | 'REVOKED';
}

export function parseConsentAction(replyId: string): ParsedConsentAction | null {
  if (replyId === CONSENT_ACTION_IDS.grantService) {
    return { purpose: 'SERVICE', decision: 'GRANTED' };
  }
  if (replyId === CONSENT_ACTION_IDS.revokeService) {
    return { purpose: 'SERVICE', decision: 'REVOKED' };
  }
  return null;
}

/** Yes/No, in the thread's language, with the ids the handler parses back. */
export function buildConsentRequest(input: {
  readonly language: Language;
  readonly shopName: string;
  readonly customerName: string;
  readonly vehicleLabel: string;
  /** True when a counter handover already established implied service consent. */
  readonly implied: boolean;
}): OutboundContent {
  const disclosure = t(input.language, 'disclosure.first_contact', {
    customerName: input.customerName,
    shopName: input.shopName,
  });

  // Implied consent still carries the opt-out line, so the customer is never
  // worse off than an explicit opt-in would have left them.
  const ask = input.implied
    ? t(input.language, 'consent.implied_notice', {
        vehicle: input.vehicleLabel,
        shopName: input.shopName,
      })
    : t(input.language, 'consent.request', { vehicle: input.vehicleLabel });

  return {
    kind: 'interactive',
    body: `${disclosure}\n\n${ask}`,
    buttons: [
      { id: CONSENT_ACTION_IDS.grantService, title: 'Yes, send updates' },
      { id: CONSENT_ACTION_IDS.revokeService, title: 'No, stop' },
    ],
  };
}

/* -------------------------------------------------------------------------- *
 * Service
 * -------------------------------------------------------------------------- */

export interface ConsentCaptureDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly messages: MessageStore<Tx>;
  readonly customers: CustomerLookup<Tx>;
  readonly consents: ConsentService<Tx>;
  readonly config: ShopConfigStore<Tx>;
  readonly directory: ShopDirectory<Tx>;
  readonly channel: ChannelType;
  readonly clock?: Clock;
}

export interface OpenFirstContactInput {
  readonly shopId: string;
  readonly customerId: string;
  readonly conversationId: string;
  readonly customerName?: string;
  readonly vehicleLabel?: string;
  readonly actor: Actor;
  readonly traceId: string;
}

export interface FirstContactResult {
  readonly outcome: GateOutcome;
  /** False when the shop had already opened this thread; nothing was re-sent. */
  readonly sent: boolean;
}

export class ConsentCaptureService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: ConsentCaptureDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Opens a thread with the identification + disclosure + consent message.
   *
   * Idempotent on the *consent registry*, not on the message log. The question
   * this has to answer is "has this customer been asked yet", and the registry
   * is where that lives: an outstanding ask is a `PENDING` SERVICE row, an
   * answered one is `GRANTED` or `REVOKED`. Keying on "has anything been sent
   * on this thread" would get it wrong in the ordinary case — an unrecognised
   * number gets an identification prompt first, and that must not consume the
   * shop's one chance to ask for consent.
   */
  async openFirstContact(input: OpenFirstContactInput): Promise<FirstContactResult> {
    const prepared = await this.deps.uow.transaction(async (tx) => {
      const consentState = await this.deps.consents.currentIn(
        tx,
        input.shopId,
        input.customerId,
      );
      const conversation = await this.deps.conversations.findById(
        tx,
        input.shopId,
        input.conversationId,
      );
      const stored = await this.deps.config.load(tx, input.shopId);
      const timezone =
        (await this.deps.config.loadShopTimezone(tx, input.shopId)) ?? 'Asia/Kolkata';
      const shopName = (await this.deps.directory.loadShopName(tx, input.shopId)) ?? 'the workshop';
      const vehicleLabel =
        input.vehicleLabel ??
        (await this.deps.customers.loadCustomerVehicleLabel(tx, input.shopId, input.customerId)) ??
        'vehicle';

      return {
        consentState,
        conversation,
        config: migrateShopConfig(stored?.raw ?? {}, timezone).config,
        shopName,
        vehicleLabel,
      };
    });

    if (prepared.conversation === null) {
      throw new Error(`Conversation ${input.conversationId} does not exist in this shop`);
    }

    const language = prepared.conversation.language;

    if (prepared.consentState.service !== null) {
      return {
        sent: false,
        outcome: {
          status: 'BLOCKED',
          messageId: '',
          code: 'CONSENT_ALREADY_REQUESTED',
          reason: `SERVICE consent for this customer is already ${prepared.consentState.service.status}; asking again would be a second record of one decision`,
        },
      };
    }

    const implied = prepared.config.consent.impliedServiceConsentFromCounter;

    // A counter handover is a lawful basis in its own right, and it is recorded
    // as one — with its source — before a word is sent, so the registry says
    // *why* the shop was allowed to write rather than inferring it later.
    if (implied) {
      await this.deps.consents.record({
        shopId: input.shopId,
        customerId: input.customerId,
        purpose: 'SERVICE',
        status: 'GRANTED',
        channel: this.deps.channel,
        source: 'COUNTER_HANDOVER',
        evidence: 'Job card handed over at the counter (shop config: implied service consent)',
        actor: input.actor,
        traceId: input.traceId,
      });
    }

    const content = buildConsentRequest({
      language,
      shopName: prepared.shopName,
      customerName: input.customerName ?? '',
      vehicleLabel: prepared.vehicleLabel,
      implied,
    });

    // An outstanding ask is a fact worth recording before it is sent: it is
    // what stops a second ask, and it is what the console's consent badge
    // means by "awaiting reply". `implied` has already written a GRANTED row,
    // so this only runs when the customer genuinely has to answer.
    if (!implied) {
      await this.deps.consents.record({
        shopId: input.shopId,
        customerId: input.customerId,
        purpose: 'SERVICE',
        status: 'PENDING',
        channel: this.deps.channel,
        source: 'INTERACTIVE_REPLY',
        evidence: 'Consent requested; awaiting the customer’s Yes/No',
        actor: input.actor,
        traceId: input.traceId,
      });
    }

    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: input.conversationId,
      customerId: input.customerId,
      purpose: 'SERVICE',
      content,
      actor: input.actor,
      traceId: input.traceId,
      flow: 'status',
      language,
      // The consent ask is the one message that may open a thread with someone
      // who has not yet said yes — and the only reason it may is that saying
      // yes is what it asks for.
      consentFlow: 'CAPTURE',
      systemReply: true,
    });

    return { sent: outcome.status === 'SENT', outcome };
  }

  /** The current SERVICE/MARKETING state, for the console's consent panel. */
  async state(shopId: string, customerId: string): Promise<ConsentState> {
    return this.deps.consents.current(shopId, customerId);
  }

  now(): Date {
    return this.clock.now();
  }
}
