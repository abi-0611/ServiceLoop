import { Controller, ForbiddenException, Get, Inject, Post } from '@nestjs/common';
import {
  SandboxWhatsAppAdapter,
  toInboundMessage,
  type WebhookDelivery,
  type WhatsAppPort,
} from '@serviceloop/adapters';
import { getEnv, migrateShopConfig } from '@serviceloop/config';
import {
  customers,
  type Database,
  PgMessageStore,
  PgShopConfigStore,
  type PgUnitOfWork,
  staff,
  type Tx,
  vehicles,
} from '@serviceloop/db';
import type { AgentRuntime } from '@serviceloop/agent-core';
import type { InboundHandler, TraceStep } from '@serviceloop/domain';
import {
  NotFoundError,
  type SandboxInjectRequest,
  SandboxInjectRequestSchema,
  type SandboxInjectResponse,
  type SandboxPersona,
  type SandboxPersonaList,
  ValidationError,
} from '@serviceloop/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { CurrentStaff, Roles, type AuthenticatedStaff } from '../auth/auth.types';
import { currentTraceId } from '../common/request-context';
import { ZodBody } from '../common/zod';
import {
  AGENT_RUNTIME,
  DATABASE,
  INBOUND_HANDLER,
  UNIT_OF_WORK,
  WHATSAPP_PORT,
} from '../infra/tokens';
import { toSendOutcome } from './conversations.controller';

/**
 * The Sandbox Simulator's back end (phase 2.2).
 *
 * The design decision that makes this worth trusting: an injected message is
 * rendered as a *real Cloud API webhook envelope*, signed with the sandbox app
 * secret, and pushed through the same `receive` → `toInboundMessage` →
 * `InboundHandler` path a Meta delivery takes. There is no private back door
 * into the router, so a flow that works here works in production.
 *
 * DEMO_MODE only, and refused twice over: the route 403s when the flag is off,
 * and the adapter it needs is not the sandbox one in any other configuration.
 */
@Controller('sandbox')
export class SandboxController {
  private readonly configStore = new PgShopConfigStore();
  private readonly messageStore = new PgMessageStore();

  constructor(
    @Inject(WHATSAPP_PORT) private readonly whatsapp: WhatsAppPort,
    @Inject(INBOUND_HANDLER) private readonly handler: InboundHandler<Tx>,
    @Inject(UNIT_OF_WORK) private readonly uow: PgUnitOfWork,
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AGENT_RUNTIME) private readonly agent: AgentRuntime<Tx>,
  ) {}

  private sandbox(): SandboxWhatsAppAdapter {
    if (!getEnv().DEMO_MODE) {
      throw new ForbiddenException('The sandbox simulator is only available in DEMO_MODE');
    }
    if (!(this.whatsapp instanceof SandboxWhatsAppAdapter)) {
      throw new ForbiddenException(
        'The live WhatsApp adapter is wired; the simulator would send real messages',
      );
    }
    return this.whatsapp;
  }

  /**
   * Who you can pretend to be: every seeded customer, plus the staff in the
   * evidence group. Personas come from the database rather than a fixture list
   * so the simulator always reflects the shop as it actually is.
   */
  /**
   * Phase 7.1 - RBAC tightening.
   *
   * These routes carried no `@Roles()` and were therefore open to every
   * authenticated role, technicians included. That was never intended: a
   * technician's job is the vehicle, and this controller reads a simulator that injects messages into live conversation state.
   * `rbac-matrix.test.ts` now asserts the whole surface, so the omission
   * cannot come back silently.
   */
  @Get('personas')
  @Roles('OWNER', 'ADVISOR')
  async personas(@CurrentStaff() authed: AuthenticatedStaff): Promise<SandboxPersonaList> {
    this.sandbox();

    const config = await this.uow.transaction(async (tx: Tx) => {
      const stored = await this.configStore.load(tx, authed.shopId);
      const timezone = (await this.configStore.loadShopTimezone(tx, authed.shopId)) ?? 'Asia/Kolkata';
      return migrateShopConfig(stored?.raw ?? {}, timezone).config;
    });

    const customerRows = await this.db
      .select({
        id: customers.id,
        name: customers.fullNameEncrypted,
        phone: customers.phoneEncrypted,
        language: customers.preferredLanguage,
        registration: vehicles.registrationRaw,
      })
      .from(customers)
      .leftJoin(vehicles, eq(vehicles.customerId, customers.id))
      .where(and(eq(customers.shopId, authed.shopId), isNull(customers.deletedAt)))
      .orderBy(desc(customers.createdAt))
      .limit(40);

    const staffRows = await this.db
      .select({
        id: staff.id,
        name: staff.fullName,
        phone: staff.phoneEncrypted,
        role: staff.role,
      })
      .from(staff)
      .where(and(eq(staff.shopId, authed.shopId), eq(staff.isActive, true), isNull(staff.deletedAt)))
      .limit(20);

    const seen = new Set<string>();
    const personas: SandboxPersona[] = [];

    for (const row of customerRows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      personas.push({
        id: `customer:${row.id}`,
        kind: 'CUSTOMER',
        label: row.name,
        phone: row.phone,
        language: row.language,
        groupId: null,
        vehicle: row.registration,
      });
    }

    for (const row of staffRows) {
      personas.push({
        id: `staff:${row.id}`,
        kind: 'STAFF',
        label: `${row.name} (${row.role})`,
        phone: row.phone,
        language: config.languages.default,
        // Staff speak in the evidence group; that is what makes their photos
        // intake triggers without a caption.
        groupId: config.messaging.staffGroupId,
        vehicle: null,
      });
    }

    return { personas, staffGroupId: config.messaging.staffGroupId };
  }

  /**
   * Injects a message as if Meta had delivered it, and returns the full
   * pipeline trace — which is the simulator's actual value. "The reply didn't
   * arrive" and "the reply was blocked at the consent gate" look identical in a
   * chat window and could not be more different to debug.
   */
  @Post('inject')
  @Roles('OWNER', 'ADVISOR')
  async inject(
    @CurrentStaff() authed: AuthenticatedStaff,
    @ZodBody(SandboxInjectRequestSchema) body: SandboxInjectRequest,
  ): Promise<SandboxInjectResponse> {
    const adapter = this.sandbox();
    const personas = await this.personas(authed);
    const persona = personas.personas.find((candidate) => candidate.id === body.personaId);
    if (persona === undefined) throw new NotFoundError('SandboxPersona', body.personaId);

    const delivery = adapter.injectInbound(this.toInjection(persona, body));
    const batch = await adapter.receive(delivery);
    const event = batch.events[0];
    if (event === undefined) {
      throw new ValidationError('That injection produced no inbound event', {});
    }

    const outcome = await this.handler.handle({
      shopId: authed.shopId,
      channel: 'WHATSAPP',
      message: toInboundMessage(event),
      traceId: currentTraceId(),
    });

    // Delivery receipts travel the production path too, so the inbox's ticks
    // are exercised in dev rather than only in production.
    const statusDelivery = adapter.drainStatusDelivery();
    if (statusDelivery !== null) {
      await this.applyStatuses(authed.shopId, statusDelivery);
    }

    return {
      conversationId: outcome.routed?.conversationId ?? null,
      messageId: outcome.routed?.messageId ?? null,
      duplicate: outcome.duplicate,
      mediaId: outcome.mediaId,
      draftId: outcome.draftId,
      jobCardId: outcome.jobCardId,
      replies: outcome.replies.map(toSendOutcome),
      trace: outcome.trace.map(toTraceDto),
    };
  }

  /** Everything the sandbox has been asked to send, for the simulator's thread. */
  @Get('transcript')
  @Roles('OWNER', 'ADVISOR')
  transcript(@CurrentStaff() _authed: AuthenticatedStaff): {
    outbound: ReadonlyArray<Record<string, unknown>>;
  } {
    const adapter = this.sandbox();
    return {
      outbound: adapter.transcript().map((entry) => ({
        providerMessageId: entry.providerMessageId,
        to: entry.to,
        sentAt: entry.sentAt.toISOString(),
        kind: entry.kind,
        body: entry.body,
        interactive: entry.interactive,
        template: entry.template,
        caption: entry.caption,
      })),
    };
  }

  private async applyStatuses(shopId: string, delivery: WebhookDelivery): Promise<void> {
    const batch = await this.sandbox().receive(delivery);

    await this.uow.transaction(async (tx: Tx) => {
      for (const status of batch.statuses) {
        const mapped =
          status.state === 'read'
            ? 'READ'
            : status.state === 'delivered'
              ? 'DELIVERED'
              : status.state === 'sent'
                ? 'SENT'
                : 'FAILED';
        await this.messageStore.updateDeliveryState(tx, {
          shopId,
          providerMessageId: status.waMessageId,
          status: mapped,
          at: status.timestamp,
        });
      }
    });
  }

  private toInjection(
    persona: SandboxPersona,
    body: SandboxInjectRequest,
  ): Parameters<SandboxWhatsAppAdapter['injectInbound']>[0] {
    const base = {
      from: persona.phone,
      displayName: persona.label,
      ...(persona.groupId === null ? {} : { groupId: persona.groupId }),
    };

    switch (body.kind) {
      case 'text':
        return { ...base, kind: 'text', text: body.text ?? '' };

      case 'button_reply':
        return {
          ...base,
          kind: 'button_reply',
          replyId: body.replyId ?? '',
          title: body.replyTitle ?? '',
        };

      case 'image':
      case 'audio': {
        if (body.mediaBase64 === undefined) {
          throw new ValidationError('An image or audio injection needs `mediaBase64`', {});
        }
        return {
          ...base,
          kind: 'media',
          mediaKind: body.kind === 'image' ? 'PHOTO' : 'AUDIO',
          bytes: Buffer.from(body.mediaBase64, 'base64'),
          contentType:
            body.contentType ?? (body.kind === 'image' ? 'image/jpeg' : 'audio/ogg'),
          ...(body.caption === undefined ? {} : { caption: body.caption }),
          ...(body.filename === undefined ? {} : { filename: body.filename }),
          ...(body.kind === 'audio' ? { isVoiceNote: true } : {}),
        };
      }
    }
  }

  /**
   * Puts a real approval request to a customer, so the review queue has
   * something in it (phase 3.9).
   *
   * Not a fixture: it builds a genuine evidence bundle from the card's own
   * technician notes and sends it through `ApprovalService` → `OutboundGate`.
   * At the default L0 autonomy the gate holds it, which is exactly how a
   * candidate reaches the queue in production. The only thing the sandbox
   * supplies is the trigger a technician would otherwise pull.
   *
   * DEMO_MODE only, through the same double guard as every other route here.
   */
  @Post('approval-draft')
  @Roles('OWNER', 'ADVISOR')
  async approvalDraft(
    @CurrentStaff() staff: AuthenticatedStaff,
  ): Promise<{
    approvalId: string;
    messageId: string;
    status: string;
    jobCardId: string;
    conversationId: string;
  }> {
    this.sandbox();
    const traceId = currentTraceId();

    const target = await this.findApprovableCard(staff.shopId);
    if (target.kind === 'none') {
      throw new NotFoundError('JobCard', 'no card is awaiting approval with work to decide');
    }
    if (target.kind === 'all_recently_messaged') {
      throw new NotFoundError(
        'JobCard',
        `${target.candidates} card(s) await approval, but every one belongs to a customer this ` +
          `shop wrote to inside its ${target.minMinutesBetweenMessages}-minute minimum interval; ` +
          'the frequency cap would refuse the request this button exists to create',
      );
    }

    // The customer messages first, through the real webhook path.
    //
    // Not a convenience: an approval request is free-form interactive content,
    // and outside the 24-hour customer-service window the gate will only pass a
    // template. In production that window is open because the customer has been
    // in touch — they dropped the car off and asked how it was going. The
    // sandbox stands in for exactly that, and it does it by injecting a real
    // signed delivery rather than by writing a conversation row.
    const injected = await this.inject(staff, {
      kind: 'text',
      personaId: `customer:${target.customerId}`,
      text: 'Any update on my car?',
    });

    const conversationId = injected.conversationId;
    if (conversationId === null) {
      throw new ValidationError('The injected message opened no conversation', {});
    }

    const built = await this.agent.bundles.build({
      shopId: staff.shopId,
      anchor: { kind: 'explicit', jobCardId: target.jobCardId },
      note: target.technicianNote,
      noteLanguage: 'en',
      authorStaffId: staff.staffId,
      mediaIds: [],
      workItemIds: target.workItemIds,
      traceId,
      actor: { type: 'STAFF', id: staff.staffId },
    });

    if (!built.ok) throw new ValidationError(built.failure.reason);

    const created = await this.agent.approvals.createApprovalRequest({
      shopId: staff.shopId,
      jobCardId: target.jobCardId,
      customerId: target.customerId,
      conversationId,
      bundle: built.bundle,
      ladderRef: 'APPROVAL',
      actor: { type: 'STAFF', id: staff.staffId },
      traceId,
    });

    if (!created.ok) throw new ValidationError(created.reason);

    // The thread comes back with it, because the caller cannot look it up: it
    // asked for "a card", and which customer that turned out to be is this
    // route's answer rather than its input.
    return {
      approvalId: created.approvalId,
      messageId: created.messageId,
      status: created.gateStatus,
      jobCardId: target.jobCardId,
      conversationId,
    };
  }

  /**
   * A card with decidable work, a technician note to cite, and a customer this
   * shop may actually write to.
   *
   * The last clause is the one that earns its keep. Creating an approval
   * request runs the outbound gate, so a picker that kept returning the same
   * card produced one draft and then a wall of `MIN_INTERVAL_NOT_ELAPSED` —
   * the frequency cap working exactly as designed against a caller asking it
   * the wrong question. So this rotates: the customer left alone longest comes
   * first, and one inside the shop's own minimum interval is not offered at
   * all. That is also what an advisor does with this queue — you chase the
   * person you have not chased yet.
   *
   * The interval is read from shop config rather than assumed, because it is
   * the shop's number and a shop that widens it should see this widen with it.
   */
  private async findApprovableCard(shopId: string): Promise<ApprovableCard> {
    const config = await this.uow.transaction(async (tx: Tx) => {
      const stored = await this.configStore.load(tx, shopId);
      const timezone = (await this.configStore.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
      return migrateShopConfig(stored?.raw ?? {}, timezone).config;
    });
    const minMinutesBetweenMessages = config.frequencyCaps.minMinutesBetweenMessages;
    const cutoff = new Date(Date.now() - minMinutesBetweenMessages * 60_000);

    // SQL narrows to the cards that could be asked about, and reports when each
    // one's customer was last written to; which of them to take is decided
    // below, where the reason for the choice can be read alongside it.
    const rows = await this.db.execute<{
      job_card_id: string;
      customer_id: string;
      work_item_ids: string[];
      technician_note: string | null;
      last_outbound_at: Date | string | null;
    }>(sql`
      select
        jc.id as job_card_id,
        jc.customer_id as customer_id,
        array_agg(distinct wi.id) as work_item_ids,
        max(wi.technician_note) as technician_note,
        (
          select max(m.sent_at)
          from messages m
          join conversations c on c.id = m.conversation_id
          where m.shop_id = jc.shop_id
            and c.customer_id = jc.customer_id
            and m.direction = 'OUTBOUND'
            and m.sent_at is not null
        ) as last_outbound_at
      from job_cards jc
      join work_items wi on wi.job_card_id = jc.id
      left join approval_requests ar
        on ar.job_card_id = jc.id and ar.decided_at is null
      where jc.shop_id = ${shopId}
        and jc.state = 'AWAITING_APPROVAL'
        and wi.requires_approval
        and wi.state in ('PROPOSED', 'PENDING_APPROVAL')
      group by jc.id, jc.customer_id, jc.updated_at
      -- Least recently messaged first, so repeated pulls spread across the
      -- column instead of landing on one customer. A card with no open request
      -- breaks the tie, because that is the realistic case, and updated_at
      -- settles the rest so the order is total and the route deterministic.
      order by last_outbound_at asc nulls first, count(ar.id) asc, jc.updated_at desc
      limit 50
    `);

    if (rows.rows.length === 0) return { kind: 'none' };

    const free = rows.rows.find(
      (row) => row.last_outbound_at === null || new Date(row.last_outbound_at) < cutoff,
    );
    if (free === undefined) {
      return {
        kind: 'all_recently_messaged',
        candidates: rows.rows.length,
        minMinutesBetweenMessages,
      };
    }

    return {
      kind: 'card',
      jobCardId: free.job_card_id,
      customerId: free.customer_id,
      workItemIds: free.work_item_ids,
      technicianNote:
        free.technician_note ??
        'Inspected on the lift; the work listed on the estimate is what was found.',
    };
  }
}

/**
 * What the approval-draft picker found.
 *
 * "Nothing to ask about" and "plenty to ask about, but not right now" are
 * different answers to the operator holding the button, and collapsing them
 * into one null sent whoever hit it looking for a job card that was there all
 * along.
 */
type ApprovableCard =
  | {
      readonly kind: 'card';
      readonly jobCardId: string;
      readonly customerId: string;
      readonly workItemIds: string[];
      readonly technicianNote: string;
    }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'all_recently_messaged';
      readonly candidates: number;
      readonly minMinutesBetweenMessages: number;
    };

function toTraceDto(step: TraceStep): {
  stage: string;
  detail: string;
  at: string;
  ok: boolean;
  data: Record<string, unknown> | null;
} {
  return {
    stage: step.stage,
    detail: step.detail,
    at: step.at,
    ok: step.ok,
    data: step.data === undefined ? null : { ...step.data },
  };
}
