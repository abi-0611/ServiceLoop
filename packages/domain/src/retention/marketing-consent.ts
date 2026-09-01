import type { ShopConfig } from '@serviceloop/config';
import { systemClock, t, type Clock, type ConsentSource } from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import { SYSTEM_ACTOR } from '../job-card/context';
import type { ConsentService } from '../messaging/consent';
import type { OutboundGate } from '../messaging/outbound-gate';
import type { ConversationStore } from '../messaging/ports';
import { MARKETING_ACTION_IDS } from '../messaging/retention-actions';
import type { AuditAppender, ShopDirectory, UnitOfWork } from '../ports';
import type { RetentionDirectory } from './ports';

/**
 * The MARKETING consent ask (phase 6.6).
 *
 * A **second, explicit** ask, and every design decision here follows from that
 * one word. DPDP purpose limitation means a SERVICE grant can never imply a
 * MARKETING one — `consent.requireExplicitMarketingConsent` is a
 * `z.literal(true)` precisely so no configuration can make it imply one — so:
 *
 *   - it has its own button ids, not the phase-2 consent ones. A tap that could
 *     be read as either purpose would grant the wider one by accident;
 *   - it is asked **once**, tracked by the registry rather than by a message
 *     count: a `PENDING` MARKETING row is written before the ask goes out, and
 *     an existing row of any status refuses a second one. A customer who has
 *     said no is not asked again in a month;
 *   - it names its scope in plain language — reminders, renewal dates,
 *     occasional offers — because "may we market to you" is not a purpose, it
 *     is a category;
 *   - it is asked at a natural moment, which the caller chooses: after a
 *     positive feedback answer, or at delivery. This service will not ask
 *     out of the blue, because there is no method that lets it.
 *
 * Revocation is instant and total. It is an ordinary `REVOKED` row in the same
 * registry, which means the OutboundGate refuses every MARKETING-purpose send
 * from the next one onwards with no scheduled campaign to unwind — the gate is
 * consulted per message, not per campaign, so there is nothing to halt.
 */

export interface MarketingConsentDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly consents: ConsentService<Tx>;
  readonly conversations: ConversationStore<Tx>;
  readonly directory: RetentionDirectory<Tx>;
  readonly shops: ShopDirectory<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly loadConfig: (tx: Tx, shopId: string) => Promise<ShopConfig>;
  readonly clock?: Clock;
}

export interface MarketingAskResult {
  readonly asked: boolean;
  readonly reason: string;
}

export class MarketingConsentService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: MarketingConsentDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Asks once, at a moment the caller has judged natural.
   *
   * The `PENDING` row goes in **before** the message, in the same transaction
   * that decides to send it. That ordering is what makes "once" true under
   * concurrency: two workers that both decide to ask race on the registry
   * rather than on the channel, and the loser finds a row and stops.
   */
  async ask(input: {
    readonly shopId: string;
    readonly customerId: string;
    readonly conversationId: string;
    readonly vehicleLabel?: string;
    readonly source?: ConsentSource;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<MarketingAskResult> {
    const actor = input.actor ?? SYSTEM_ACTOR;

    const plan = await this.deps.uow.transaction(async (tx) => {
      const state = await this.deps.consents.currentIn(tx, input.shopId, input.customerId);
      if (state.marketing !== null) {
        return {
          kind: 'refuse' as const,
          reason: `MARKETING consent is already ${state.marketing.status}; it is asked once`,
        };
      }
      // SERVICE first, and not as a formality. A customer who has not agreed to
      // hear about their own vehicle's repair is not somebody to ask about
      // offers, and asking would be the shop's second message to a person who
      // has not answered its first.
      if (state.service?.status !== 'GRANTED') {
        return {
          kind: 'refuse' as const,
          reason: 'SERVICE consent has not been granted; MARKETING is never asked first',
        };
      }

      const customer = await this.deps.directory.loadCustomer(
        tx,
        input.shopId,
        input.customerId,
      );
      if (customer === null) return { kind: 'refuse' as const, reason: 'Customer not found' };

      const shopName = (await this.deps.shops.loadShopName(tx, input.shopId)) ?? 'the workshop';

      await this.deps.consents.recordIn(tx, {
        shopId: input.shopId,
        customerId: input.customerId,
        purpose: 'MARKETING',
        status: 'PENDING',
        channel: 'WHATSAPP',
        source: input.source ?? 'INTERACTIVE_REPLY',
        evidence: 'Asked for MARKETING consent with the second, explicit ask',
        actor,
        traceId: input.traceId,
      });

      return { kind: 'ask' as const, language: customer.language, shopName };
    });

    if (plan.kind === 'refuse') return { asked: false, reason: plan.reason };

    const outcome = await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: input.conversationId,
      customerId: input.customerId,
      // The ask itself rides SERVICE. It has to: a message asking for MARKETING
      // consent cannot require MARKETING consent, and the phase-2 gate already
      // makes the same exception for the SERVICE ask via `consentFlow`.
      purpose: 'SERVICE',
      content: {
        kind: 'interactive',
        body: t(plan.language, 'consent.marketing_ask', {
          shopName: plan.shopName,
          vehicle: input.vehicleLabel ?? 'your vehicle',
        }),
        buttons: [
          { id: MARKETING_ACTION_IDS.grant, title: 'Yes, that is fine' },
          { id: MARKETING_ACTION_IDS.decline, title: 'No thanks' },
        ],
      },
      actor,
      traceId: input.traceId,
      flow: 'retention',
      language: plan.language,
      templated: true,
    });

    return {
      asked: outcome.status === 'SENT',
      reason:
        outcome.status === 'SENT'
          ? 'Asked'
          : `${outcome.status}: ${'reason' in outcome ? outcome.reason : ''}`,
    };
  }

  /**
   * The customer's answer, and the acknowledgement it earns.
   *
   * Both answers get one — including the no. A customer who declines and hears
   * nothing has no way to know it registered, and the next marketing-shaped
   * message they see (there will not be one) would be the only confirmation
   * they ever got.
   */
  async decide(input: {
    readonly shopId: string;
    readonly customerId: string;
    readonly conversationId: string;
    readonly decision: 'GRANT' | 'DECLINE';
    readonly evidence: string;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<{ readonly recorded: boolean; readonly status: 'GRANTED' | 'REVOKED' }> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const status = input.decision === 'GRANT' ? 'GRANTED' : 'REVOKED';

    const language = await this.deps.uow.transaction(async (tx) => {
      await this.deps.consents.recordIn(tx, {
        shopId: input.shopId,
        customerId: input.customerId,
        purpose: 'MARKETING',
        status,
        channel: 'WHATSAPP',
        source: 'INTERACTIVE_REPLY',
        evidence: input.evidence,
        actor,
        traceId: input.traceId,
      });

      const customer = await this.deps.directory.loadCustomer(
        tx,
        input.shopId,
        input.customerId,
      );
      return customer?.language ?? 'en';
    });

    await this.deps.gate.send({
      shopId: input.shopId,
      conversationId: input.conversationId,
      customerId: input.customerId,
      purpose: 'SERVICE',
      content: {
        kind: 'text',
        body:
          status === 'GRANTED'
            ? t(language, 'consent.marketing_granted_ack', { vehicle: 'your vehicle' })
            : t(language, 'consent.marketing_revoked_ack'),
      },
      actor,
      traceId: input.traceId,
      flow: 'retention',
      language,
      isAcknowledgement: true,
      templated: true,
    });

    return { recorded: true, status };
  }

  /**
   * Revocation from anywhere — a keyword, the console, an advisor at the
   * counter (phase 6.6).
   *
   * Deliberately separate from `decide`, because this one has no conversation
   * to acknowledge on and must work anyway: a customer who tells an advisor to
   * stop the offers gets the same instant, audited result as one who taps a
   * button.
   */
  async revoke(input: {
    readonly shopId: string;
    readonly customerId: string;
    readonly evidence: string;
    readonly capturedByStaffId?: string | null;
    readonly traceId: string;
    readonly actor?: Actor;
  }): Promise<void> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    await this.deps.uow.transaction(async (tx) => {
      await this.deps.consents.recordIn(tx, {
        shopId: input.shopId,
        customerId: input.customerId,
        purpose: 'MARKETING',
        status: 'REVOKED',
        channel: 'CONSOLE',
        source: 'CONSOLE',
        evidence: input.evidence,
        capturedByStaffId: input.capturedByStaffId ?? null,
        actor,
        traceId: input.traceId,
      });
    });
  }
}
