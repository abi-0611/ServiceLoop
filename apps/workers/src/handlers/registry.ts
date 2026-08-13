import type { Database, Tx } from '@serviceloop/db';
import type { EventEnvelope, EventType } from '@serviceloop/shared';
import type { Logger } from 'pino';

/**
 * Event-handler registry.
 *
 * A handler runs inside the consumer's transaction, next to the idempotency
 * claim, so its side effects and the "I have seen this event" record commit or
 * roll back together. Later phases register their handlers here — approval
 * ladders (phase 3), status comms (phase 4), digests (phase 6) — without
 * touching the harness.
 */

export interface HandlerContext {
  readonly tx: Tx;
  readonly db: Database;
  readonly envelope: EventEnvelope;
  readonly logger: Logger;
}

export interface EventHandler {
  readonly name: string;
  readonly handles: readonly EventType[];
  handle(context: HandlerContext): Promise<Record<string, unknown>>;
}

export class HandlerRegistry {
  private readonly handlers: EventHandler[] = [];

  register(handler: EventHandler): this {
    this.handlers.push(handler);
    return this;
  }

  for(type: EventType): EventHandler[] {
    return this.handlers.filter((handler) => handler.handles.includes(type));
  }

  all(): readonly EventHandler[] {
    return this.handlers;
  }
}
