import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { AuditService, OutboxService } from '@serviceloop/db';
import { type AuditEntryDto, type ChainVerification, ValidationError } from '@serviceloop/shared';
import { z } from 'zod';
import { CurrentStaff, Roles, type AuthenticatedStaff } from '../auth/auth.types';
import { AUDIT_SERVICE, OUTBOX_SERVICE } from '../infra/tokens';

/**
 * Audit trail and the dead-letter admin view (phases 1.5 / 1.7).
 * Both are OWNER-only: they expose the shop's whole activity history.
 */

const EntityQuerySchema = z.object({
  entityType: z.string().min(1).max(64),
  entityId: z.string().uuid(),
});

@Controller('audit')
export class AuditController {
  constructor(
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(OUTBOX_SERVICE) private readonly outbox: OutboxService,
  ) {}

  @Roles('OWNER')
  @Get('verify')
  async verify(@CurrentStaff() staff: AuthenticatedStaff): Promise<ChainVerification> {
    const result = await this.audit.verifyChain(staff.shopId);
    return {
      shopId: staff.shopId,
      entriesChecked: result.entriesChecked,
      valid: result.valid,
      brokenAtIndex: result.brokenAtIndex,
      brokenEventId: result.brokenEventId,
      reason: result.reason,
    };
  }

  @Roles('OWNER')
  @Get('events')
  async events(
    @CurrentStaff() staff: AuthenticatedStaff,
    @Query() query: Record<string, string>,
  ): Promise<AuditEntryDto[]> {
    const parsed = EntityQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new ValidationError('Invalid query string', {
        fieldErrors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const entries = await this.audit.listForEntity(
      staff.shopId,
      parsed.data.entityType,
      parsed.data.entityId,
    );

    return entries.map((entry) => ({
      id: entry.id,
      seq: entry.seq,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      actorType: entry.actorType as AuditEntryDto['actorType'],
      actorId: entry.actorId,
      payload: (entry.payload ?? {}) as Record<string, unknown>,
      hash: entry.hash,
      prevHash: entry.prevHash,
      createdAt: entry.createdAt,
    }));
  }

  /** Phase 1.5: the admin list endpoint for the dead-letter backlog. */
  @Roles('OWNER')
  @Get('dead-letter')
  async deadLetter(@CurrentStaff() staff: AuthenticatedStaff): Promise<{
    counts: Record<string, number>;
    events: Array<{
      id: string;
      type: string;
      attempts: number;
      lastError: string | null;
      occurredAt: string;
    }>;
  }> {
    const [counts, events] = await Promise.all([
      this.outbox.countByStatus(),
      this.outbox.listDeadLettered(staff.shopId, 100),
    ]);

    return {
      counts,
      events: events.map((event) => ({
        id: event.id,
        type: event.type,
        attempts: event.attempts,
        lastError: event.lastError,
        occurredAt: event.occurredAt.toISOString(),
      })),
    };
  }
}
