import { z } from 'zod';
import {
  JobCardEventSchema,
  JobCardStateSchema,
  WorkItemEventSchema,
  WorkItemStateSchema,
} from './enums';

/**
 * The event envelope crossing the transactional outbox → BullMQ boundary.
 *
 * It is zod-validated on both ends (phase 1.5): the writer cannot enqueue a
 * malformed event, and a consumer cannot silently mis-read one. Phase 2+ adds
 * new members to the union; the envelope shape itself is frozen.
 */

export const EVENT_TYPES = [
  'job_card.created',
  'job_card.state_changed',
  'job_card.transition_rejected',
  'work_item.created',
  'work_item.state_changed',
  'shop_config.updated',
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

const ActorSchema = z.object({
  type: z.enum(['STAFF', 'CUSTOMER', 'AGENT', 'SYSTEM']),
  id: z.string().nullable(),
});
export type EventActor = z.infer<typeof ActorSchema>;

const envelopeBase = {
  id: z.string().uuid(),
  occurredAt: z.string().datetime({ offset: true }),
  shopId: z.string().uuid(),
  traceId: z.string().min(1).max(128),
};

export const JobCardCreatedPayloadSchema = z.object({
  jobCardId: z.string().uuid(),
  code: z.string(),
  state: JobCardStateSchema,
  actor: ActorSchema,
});

export const JobCardStateChangedPayloadSchema = z.object({
  jobCardId: z.string().uuid(),
  from: JobCardStateSchema,
  to: JobCardStateSchema,
  event: JobCardEventSchema,
  actor: ActorSchema,
  meta: z.record(z.unknown()).default({}),
});

export const JobCardTransitionRejectedPayloadSchema = z.object({
  jobCardId: z.string().uuid(),
  from: JobCardStateSchema,
  event: JobCardEventSchema,
  reason: z.string(),
  actor: ActorSchema,
});

export const WorkItemCreatedPayloadSchema = z.object({
  workItemId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  state: WorkItemStateSchema,
  actor: ActorSchema,
});

export const WorkItemStateChangedPayloadSchema = z.object({
  workItemId: z.string().uuid(),
  jobCardId: z.string().uuid(),
  from: WorkItemStateSchema,
  to: WorkItemStateSchema,
  event: WorkItemEventSchema,
  actor: ActorSchema,
  meta: z.record(z.unknown()).default({}),
});

export const ShopConfigUpdatedPayloadSchema = z.object({
  configVersion: z.number().int(),
  changedPaths: z.array(z.string()),
  actor: ActorSchema,
});

export const EventEnvelopeSchema = z.discriminatedUnion('type', [
  z.object({
    ...envelopeBase,
    type: z.literal('job_card.created'),
    payload: JobCardCreatedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('job_card.state_changed'),
    payload: JobCardStateChangedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('job_card.transition_rejected'),
    payload: JobCardTransitionRejectedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('work_item.created'),
    payload: WorkItemCreatedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('work_item.state_changed'),
    payload: WorkItemStateChangedPayloadSchema,
  }),
  z.object({
    ...envelopeBase,
    type: z.literal('shop_config.updated'),
    payload: ShopConfigUpdatedPayloadSchema,
  }),
]);

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** Payload for a given event type, resolved from the union. */
export type PayloadOf<T extends EventType> = Extract<EventEnvelope, { type: T }>['payload'];

export function parseEventEnvelope(raw: unknown): EventEnvelope {
  return EventEnvelopeSchema.parse(raw);
}

export const QUEUE_NAMES = ['jobcard-events', 'workitem-events', 'config-events'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const DEAD_LETTER_QUEUE = 'dead-letter' as const;

/** Static routing table: every event type has exactly one home queue. */
export const QUEUE_BY_EVENT_TYPE: Readonly<Record<EventType, QueueName>> = {
  'job_card.created': 'jobcard-events',
  'job_card.state_changed': 'jobcard-events',
  'job_card.transition_rejected': 'jobcard-events',
  'work_item.created': 'workitem-events',
  'work_item.state_changed': 'workitem-events',
  'shop_config.updated': 'config-events',
};

export function queueForEventType(type: EventType): QueueName {
  return QUEUE_BY_EVENT_TYPE[type];
}
