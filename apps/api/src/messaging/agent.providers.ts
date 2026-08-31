import { createAgentRuntime, type AgentRuntime } from '@serviceloop/agent-core';
import { defaultShopConfig } from '@serviceloop/config';
import type { ChannelPorts } from '@serviceloop/adapters';
import {
  type AuditService,
  createAgentStores,
  type OutboxService,
  PgConversationStore,
  PgJobCardStore,
  PgMessageStore,
  PgShopConfigStore,
  PgShopDirectory,
  type PgUnitOfWork,
  PgWorkItemStore,
  type Tx,
} from '@serviceloop/db';
import {
  JobCardTransitionService,
  type OutboundGate,
  WorkItemTransitionService,
  type RungScheduler,
} from '@serviceloop/domain';
import { getEnv } from '@serviceloop/config';
import { ESCALATION_QUEUE } from '@serviceloop/shared';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Provider } from '@nestjs/common';
import {
  AGENT_RUNTIME,
  AUDIT_SERVICE,
  CHANNEL_PORTS,
  OUTBOUND_GATE,
  OUTBOX_SERVICE,
  REDIS,
  UNIT_OF_WORK,
} from '../infra/tokens';

/**
 * The phase-3 agent runtime, as the API sees it.
 *
 * The API does not *run* ladders — the worker owns those timers — but it does
 * schedule them, cancel them and answer buttons, so it needs the same
 * `RungScheduler` contract pointed at the same queue. Sharing the queue name
 * rather than the worker's code is what keeps the two processes independent.
 */

/**
 * Enqueue-only scheduler.
 *
 * The API never consumes the escalation queue, so this deliberately implements
 * enqueue and cancel and nothing else. Cancellation stays best effort for the
 * same reason it is in the worker: the database row is the authority, and a job
 * that survives finds its rung already `CANCELLED`.
 */
class ApiRungScheduler implements RungScheduler {
  constructor(private readonly queue: Queue) {}

  async enqueue(input: {
    readonly escalationId: string;
    readonly shopId: string;
    readonly subjectId: string;
    readonly runAt: Date;
  }): Promise<string | null> {
    const job = await this.queue.add(
      'rung',
      { escalationId: input.escalationId, shopId: input.shopId, subjectId: input.subjectId },
      {
        jobId: input.escalationId,
        delay: Math.max(0, input.runAt.getTime() - Date.now()),
        attempts: 1,
        removeOnComplete: { age: 86_400, count: 10_000 },
        removeOnFail: false,
      },
    );
    return job.id ?? null;
  }

  async cancel(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    await job?.remove().catch(() => undefined);
  }
}

export const agentProviders: Provider[] = [
  {
    provide: AGENT_RUNTIME,
    useFactory: (
      uow: PgUnitOfWork,
      audit: AuditService,
      outbox: OutboxService,
      gate: OutboundGate<Tx>,
      ports: ChannelPorts,
      redis: Redis,
    ): AgentRuntime<Tx> => {
      const env = getEnv();
      const messages = new PgMessageStore();
      const conversations = new PgConversationStore();
      const config = new PgShopConfigStore();

      const queue = new Queue(ESCALATION_QUEUE, {
        connection: redis as unknown as { host?: string },
      });

      return createAgentRuntime<Tx>({
        stores: {
          uow,
          ...createAgentStores(),
          conversations,
          messages,
          config,
          directory: new PgShopDirectory(),
          audit,
          outbox,
        },
        gate,
        jobCards: new JobCardTransitionService<Tx>({
          uow,
          cards: new PgJobCardStore(),
          config,
          audit,
          outbox,
        }),
        workItems: new WorkItemTransitionService<Tx>({
          uow,
          items: new PgWorkItemStore(),
          audit,
          outbox,
        }),
        scheduler: new ApiRungScheduler(queue),
        llm: ports.llm,
        config: defaultShopConfig(env.DEFAULT_TIMEZONE),
        conversationTail: (tx, shopId, conversationId, limit) =>
          messages.recentForConversation(tx, shopId, conversationId, limit),
        loadHeld: (tx, shopId, messageId) => messages.loadHeld(tx, shopId, messageId),
        resolvePinnedCard: (tx, shopId, messageId) =>
          messages.jobCardForMessage(tx, shopId, messageId),
        // Scheduled follow-ups arrive with phase 4's reminder engine; until then
        // the tool reports honestly rather than pretending to have booked one.
        scheduleFollowup: async () => 'not-scheduled',
        // An objection opens a run on the thread. Phase 3's API answers the
        // button synchronously and leaves the run to the next inbound message,
        // which is when the customer actually says what they meant.
        openObjectionObjective: async () => undefined,
      });
    },
    inject: [UNIT_OF_WORK, AUDIT_SERVICE, OUTBOX_SERVICE, OUTBOUND_GATE, CHANNEL_PORTS, REDIS],
  },
];
