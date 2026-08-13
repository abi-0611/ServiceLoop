import { type AuditService } from '@serviceloop/db';
import { EVENT_TYPES, type EventType } from '@serviceloop/shared';
import { chainIntegrityFailures } from '../metrics';
import type { EventHandler, HandlerContext } from './registry';

/**
 * Audit-chain integrity monitor.
 *
 * Every domain event implies a fresh audit entry, so each event is a natural
 * moment to re-check that the chain still links. This verifies a bounded tail
 * rather than the whole chain, which keeps the check cheap while making
 * tampering visible within minutes instead of at the next full audit.
 *
 * A break is a hard failure: the job is retried and ultimately dead-lettered,
 * and the counter drives the alert.
 */
export class ChainIntegrityHandler implements EventHandler {
  readonly name = 'chain-integrity';
  readonly handles: readonly EventType[] = EVENT_TYPES;

  constructor(
    private readonly audit: AuditService,
    private readonly tailSize = 25,
  ) {}

  async handle(context: HandlerContext): Promise<Record<string, unknown>> {
    const { envelope, tx, logger } = context;
    const verification = await this.audit.verifyTail(envelope.shopId, this.tailSize, tx);

    if (!verification.valid) {
      chainIntegrityFailures.inc({ shop: envelope.shopId });
      logger.error(
        {
          shopId: envelope.shopId,
          brokenAtIndex: verification.brokenAtIndex,
          brokenEventId: verification.brokenEventId,
          reason: verification.reason,
        },
        'audit chain integrity check failed',
      );
      throw new Error(
        `Audit chain broken for shop ${envelope.shopId} at tail index ${String(verification.brokenAtIndex)}: ${verification.reason ?? 'unknown'}`,
      );
    }

    return {
      handler: this.name,
      entriesChecked: verification.entriesChecked,
      verifiedAt: new Date().toISOString(),
    };
  }
}

export function createChainIntegrityHandler(
  audit: AuditService,
  tailSize?: number,
): ChainIntegrityHandler {
  return new ChainIntegrityHandler(audit, tailSize);
}
