import {
  type ChannelType,
  type Clock,
  type ConsentPurpose,
  type ConsentSource,
  type ConsentStatus,
  type EventEnvelope,
  systemClock,
  uuidv7,
} from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { AuditAppender, OutboxWriter, UnitOfWork } from '../ports';
import type { ConsentStore } from './ports';
import type { ConsentSnapshotRow } from './types';

/**
 * The consent registry (DPDP Act 2023, master §7).
 *
 * Purpose-limited and append-oriented: a revocation is a new row, never an
 * update, so the question "what had this customer agreed to on the 3rd of
 * March, and how do you know" has an answer. Nothing here decides whether a
 * message may be sent — that is the `OutboundGate`'s job; this class only
 * records what the customer said.
 */

export interface ConsentServiceDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly consents: ConsentStore<Tx>;
  readonly audit: AuditAppender<Tx>;
  readonly outbox: OutboxWriter<Tx>;
  readonly clock?: Clock;
}

export interface RecordConsentInput {
  readonly shopId: string;
  readonly customerId: string;
  readonly purpose: ConsentPurpose;
  readonly status: ConsentStatus;
  readonly channel: ChannelType;
  readonly source: ConsentSource;
  /** The customer's own words or the button they tapped. A regulator asks this. */
  readonly evidence: string | null;
  readonly messageId?: string | null;
  readonly capturedByStaffId?: string | null;
  readonly actor: Actor;
  readonly traceId: string;
}

export interface ConsentState {
  readonly service: ConsentSnapshotRow | null;
  readonly marketing: ConsentSnapshotRow | null;
}

export class ConsentService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: ConsentServiceDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  async current(shopId: string, customerId: string): Promise<ConsentState> {
    return this.deps.uow.transaction(async (tx) => this.currentIn(tx, shopId, customerId));
  }

  async currentIn(tx: Tx, shopId: string, customerId: string): Promise<ConsentState> {
    const rows = await this.deps.consents.current(tx, shopId, customerId);
    return {
      service: rows.find((row) => row.purpose === 'SERVICE') ?? null,
      marketing: rows.find((row) => row.purpose === 'MARKETING') ?? null,
    };
  }

  async record(input: RecordConsentInput): Promise<string> {
    return this.deps.uow.transaction(async (tx) => this.recordIn(tx, input));
  }

  /** Same write, inside a caller's transaction — the router needs this. */
  async recordIn(tx: Tx, input: RecordConsentInput): Promise<string> {
    const now = this.clock.now();
    const previous = await this.deps.consents.current(tx, input.shopId, input.customerId);
    const from = previous.find((row) => row.purpose === input.purpose)?.status ?? null;

    const consentId = uuidv7();
    await this.deps.consents.record(tx, {
      id: consentId,
      shopId: input.shopId,
      customerId: input.customerId,
      purpose: input.purpose,
      status: input.status,
      channel: input.channel,
      source: input.source,
      evidence: input.evidence,
      messageId: input.messageId ?? null,
      capturedByStaffId: input.capturedByStaffId ?? null,
      at: now,
    });

    await this.deps.audit.append(tx, {
      shopId: input.shopId,
      actorType: input.actor.type,
      actorId: input.actor.id,
      action: 'consent.updated',
      entityType: 'Consent',
      entityId: consentId,
      payload: {
        customerId: input.customerId,
        purpose: input.purpose,
        from,
        to: input.status,
        channel: input.channel,
        source: input.source,
        // The evidence string is the customer's own message; it is kept short
        // and is not PII beyond what they chose to type.
        evidence: input.evidence,
      },
      traceId: input.traceId,
    });

    const envelope: EventEnvelope = {
      id: uuidv7(),
      type: 'consent.updated',
      occurredAt: now.toISOString(),
      shopId: input.shopId,
      traceId: input.traceId,
      payload: {
        consentId,
        customerId: input.customerId,
        purpose: input.purpose,
        from,
        to: input.status,
        channel: input.channel,
        actor: { type: input.actor.type, id: input.actor.id },
      },
    };
    await this.deps.outbox.enqueue(tx, envelope);

    return consentId;
  }
}
