import { forwardRef, Module } from '@nestjs/common';
import type { AgentRuntime, LoopRuntime } from '@serviceloop/agent-core';
import {
  createChannelPorts,
  createMediaPipeline,
  type ChannelPorts,
  type MediaPipeline,
  type StoragePort,
} from '@serviceloop/adapters';
import { getEnv } from '@serviceloop/config';
import {
  type AuditService,
  ConversationRepository,
  IntakeRepository,
  type OutboxService,
  PgConsentStore,
  PgConversationStore,
  PgCustomerLookup,
  PgDraftStore,
  PgEntityLookup,
  PgJobCardWriter,
  PgMediaStore,
  PgMessageStore,
  PgShopConfigStore,
  PgShopDirectory,
  type PgUnitOfWork,
  type Database,
  type Tx,
} from '@serviceloop/db';
import {
  ConsentCaptureService,
  ConsentService,
  ConversationSessionService,
  EntityResolutionService,
  InboundHandler,
  InboundRouter,
  IntakePipeline,
  IntakeService,
  type JobCardTransitionService,
  MediaService,
  OutboundGate,
} from '@serviceloop/domain';
import { blindIndex } from '@serviceloop/db';
import type { Redis } from 'ioredis';
import {
  AGENT_RUNTIME,
  AUDIT_SERVICE,
  CHANNEL_PORTS,
  CONSENT_CAPTURE,
  CONSENT_SERVICE,
  CONVERSATION_REPOSITORY,
  DATABASE,
  INBOUND_HANDLER,
  INTAKE_PIPELINE,
  LOOP_RUNTIME,
  INTAKE_REPOSITORY,
  INTAKE_SERVICE,
  JOB_CARD_TRANSITION_SERVICE,
  MEDIA_PIPELINE,
  MEDIA_SERVICE,
  OUTBOUND_GATE,
  OUTBOX_SERVICE,
  REDIS,
  SESSION_SERVICE,
  STORAGE,
  UNIT_OF_WORK,
  WHATSAPP_PORT,
} from '../infra/tokens';
import { LoopModule } from '../loop/loop.module';
import { agentProviders } from './agent.providers';
import { ConversationsController } from './conversations.controller';
import { IntakeController } from './intake.controller';
import { MediaController } from './media.controller';
import { ReviewController } from './review.controller';
import { SandboxController } from './sandbox.controller';
import { ShopResolver } from './shop-resolver';
import { WhatsAppWebhookController } from './whatsapp.controller';

/**
 * Composition root for channels and intake (phase 2).
 *
 * Every dependency is constructed here, from the validated environment, so the
 * boot log's claim about which adapter is live is the wiring rather than a
 * description of it. Note the shape of the graph: the Postgres stores implement
 * the domain's ports, the adapters implement the domain's channel and
 * extraction ports, and the domain services are the only things that decide
 * anything.
 *
 * `OutboundGate` is constructed once and shared. That is not an optimisation:
 * it is the choke point every send passes, and two of them would be two
 * opinions about whether a message may leave.
 */
@Module({
  /**
   * Phase 4 made the dependency mutual, and `forwardRef` is the honest way to
   * say so. `LoopModule` needs the one `OutboundGate` that lives here, and
   * `InboundHandler` needs the status sentinel that lives there — because a
   * technician's note *is* an inbound message and a status update *is* an
   * outbound one. The value graph stays acyclic; only the module graph is
   * circular, which is exactly the case this exists for. The alternative was a
   * second `StatusSignalService`, and two of those is two opinions about
   * whether a job card may move.
   */
  imports: [forwardRef(() => LoopModule)],
  controllers: [
    ReviewController,
    WhatsAppWebhookController,
    ConversationsController,
    IntakeController,
    MediaController,
    SandboxController,
  ],
  providers: [
    ...agentProviders,
    ShopResolver,
    {
      provide: CHANNEL_PORTS,
      useFactory: (redis: Redis) => createChannelPorts(getEnv(), { redis }),
      inject: [REDIS],
    },
    {
      provide: WHATSAPP_PORT,
      useFactory: (ports: ChannelPorts) => ports.whatsapp,
      inject: [CHANNEL_PORTS],
    },
    {
      provide: MEDIA_PIPELINE,
      useFactory: (storage: StoragePort) => createMediaPipeline(getEnv(), storage),
      inject: [STORAGE],
    },
    {
      provide: CONSENT_SERVICE,
      useFactory: (uow: PgUnitOfWork, audit: AuditService, outbox: OutboxService) =>
        new ConsentService<Tx>({
          uow,
          consents: new PgConsentStore(),
          audit,
          outbox,
        }),
      inject: [UNIT_OF_WORK, AUDIT_SERVICE, OUTBOX_SERVICE],
    },
    {
      provide: SESSION_SERVICE,
      useFactory: (uow: PgUnitOfWork, audit: AuditService, outbox: OutboxService) =>
        new ConversationSessionService<Tx>({
          uow,
          conversations: new PgConversationStore(),
          customers: new PgCustomerLookup(),
          audit,
          outbox,
          blindIndex,
        }),
      inject: [UNIT_OF_WORK, AUDIT_SERVICE, OUTBOX_SERVICE],
    },
    {
      provide: OUTBOUND_GATE,
      useFactory: (
        uow: PgUnitOfWork,
        audit: AuditService,
        outbox: OutboxService,
        ports: ChannelPorts,
      ) =>
        new OutboundGate<Tx>({
          uow,
          conversations: new PgConversationStore(),
          messages: new PgMessageStore(),
          consents: new PgConsentStore(),
          config: new PgShopConfigStore(),
          audit,
          outbox,
          sender: ports.sender,
        }),
      inject: [UNIT_OF_WORK, AUDIT_SERVICE, OUTBOX_SERVICE, CHANNEL_PORTS],
    },
    {
      provide: MEDIA_SERVICE,
      useFactory: (
        uow: PgUnitOfWork,
        audit: AuditService,
        outbox: OutboxService,
        pipeline: MediaPipeline,
      ) =>
        new MediaService<Tx>({
          uow,
          store: new PgMediaStore(),
          pipeline,
          audit,
          outbox,
        }),
      inject: [UNIT_OF_WORK, AUDIT_SERVICE, OUTBOX_SERVICE, MEDIA_PIPELINE],
    },
    {
      provide: INTAKE_SERVICE,
      useFactory: (
        uow: PgUnitOfWork,
        audit: AuditService,
        outbox: OutboxService,
        cards: JobCardTransitionService<Tx>,
      ) =>
        new IntakeService<Tx>({
          uow,
          drafts: new PgDraftStore(),
          writer: new PgJobCardWriter(),
          entities: new EntityResolutionService<Tx>({
            uow,
            lookup: new PgEntityLookup(),
            audit,
            outbox,
          }),
          config: new PgShopConfigStore(),
          audit,
          outbox,
          cards,
        }),
      inject: [UNIT_OF_WORK, AUDIT_SERVICE, OUTBOX_SERVICE, JOB_CARD_TRANSITION_SERVICE],
    },
    {
      provide: INTAKE_PIPELINE,
      useFactory: (uow: PgUnitOfWork, ports: ChannelPorts, intake: IntakeService<Tx>) =>
        new IntakePipeline<Tx>({
          uow,
          extraction: ports.extraction,
          intake,
          config: new PgShopConfigStore(),
        }),
      inject: [UNIT_OF_WORK, CHANNEL_PORTS, INTAKE_SERVICE],
    },
    {
      provide: INBOUND_HANDLER,
      useFactory: (
        uow: PgUnitOfWork,
        audit: AuditService,
        outbox: OutboxService,
        ports: ChannelPorts,
        gate: OutboundGate<Tx>,
        intake: IntakeService<Tx>,
        pipeline: IntakePipeline<Tx>,
        media: MediaService<Tx>,
        sessions: ConversationSessionService<Tx>,
        consents: ConsentService<Tx>,
        agent: AgentRuntime<Tx>,
        loop: LoopRuntime<Tx>,
      ) => {
        const conversations = new PgConversationStore();
        const messages = new PgMessageStore();
        const customers = new PgCustomerLookup();
        const config = new PgShopConfigStore();

        return new InboundHandler<Tx>({
          uow,
          router: new InboundRouter<Tx>({
            uow,
            conversations,
            messages,
            customers,
            config,
            sessions,
            consents,
            audit,
            outbox,
          }),
          gate,
          intake,
          pipeline,
          media,
          mediaFetch: ports.mediaFetch,
          conversations,
          messages,
          customers,
          consents,
          config,
          directory: new PgShopDirectory(),
          // Phase 3: a tap on Approve / Ask a question / Call me goes here.
          approvals: agent.replies,
          // Phase 4: a staff-group note becomes a status signal, and the ✅/✏️
          // and pickup-slot taps land back here.
          technicianNotes: loop.notes,
          slots: loop.delivery,
          consoleUrl: getEnv().CONSOLE_URL,
        });
      },
      inject: [
        UNIT_OF_WORK,
        AUDIT_SERVICE,
        OUTBOX_SERVICE,
        CHANNEL_PORTS,
        OUTBOUND_GATE,
        INTAKE_SERVICE,
        INTAKE_PIPELINE,
        MEDIA_SERVICE,
        SESSION_SERVICE,
        CONSENT_SERVICE,
        AGENT_RUNTIME,
        LOOP_RUNTIME,
      ],
    },
    {
      provide: CONSENT_CAPTURE,
      useFactory: (uow: PgUnitOfWork, gate: OutboundGate<Tx>, consents: ConsentService<Tx>) =>
        new ConsentCaptureService<Tx>({
          uow,
          gate,
          conversations: new PgConversationStore(),
          messages: new PgMessageStore(),
          customers: new PgCustomerLookup(),
          consents,
          config: new PgShopConfigStore(),
          directory: new PgShopDirectory(),
          channel: 'WHATSAPP',
        }),
      inject: [UNIT_OF_WORK, OUTBOUND_GATE, CONSENT_SERVICE],
    },
    {
      provide: CONVERSATION_REPOSITORY,
      useFactory: (db: Database) => new ConversationRepository(db),
      inject: [DATABASE],
    },
    {
      provide: INTAKE_REPOSITORY,
      useFactory: (db: Database) => new IntakeRepository(db),
      inject: [DATABASE],
    },
  ],
  exports: [
    // The loop module (phase 4) shares the agent runtime rather than building a
    // second one: `agent.tasks` is what the balance ladder hands off to, and
    // two task services would be two advisor queues.
    AGENT_RUNTIME,
    CHANNEL_PORTS,
    WHATSAPP_PORT,
    OUTBOUND_GATE,
    INBOUND_HANDLER,
    INTAKE_SERVICE,
    INTAKE_PIPELINE,
    MEDIA_SERVICE,
    MEDIA_PIPELINE,
    CONSENT_CAPTURE,
    CONSENT_SERVICE,
    CONVERSATION_REPOSITORY,
    INTAKE_REPOSITORY,
    SESSION_SERVICE,
  ],
})
export class MessagingModule {}
