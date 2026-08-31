import { type Clock, systemClock } from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { UnitOfWork } from '../ports';
import type { GateOutcome, OutboundGate, OutboundRequest } from './outbound-gate';
import type { MessageStore, ScheduledMessage } from './ports';
import type { OutboundButton, OutboundContent, OutboundListSection } from './types';

/**
 * Quiet-hours release (phase 2.9).
 *
 * The gate's promise is that a message held for quiet hours is *deferred, not
 * dropped* — and a promise nothing keeps is a message the customer never gets.
 * This is the thing that keeps it: it claims holds whose time has come and
 * pushes each back through `OutboundGate.release`.
 *
 * Release re-runs every customer protection. A customer who opted out at
 * 23:00 does not receive the 21:30 message at 08:00 because it was "already
 * approved"; it is blocked, with the reason recorded, exactly as a fresh send
 * would be.
 */

export interface MediaBytesLoader {
  /** Null when the object has been erased — a DPDP deletion is a valid answer. */
  load(
    shopId: string,
    mediaId: string,
  ): Promise<{ readonly bytes: Buffer; readonly contentType: string } | null>;
}

export interface DeferredSendDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly messages: MessageStore<Tx>;
  readonly gate: OutboundGate<Tx>;
  /** Needed only to re-send a held media message; text and templates do not. */
  readonly media?: MediaBytesLoader;
  readonly clock?: Clock;
}

export interface DrainResult {
  readonly claimed: number;
  readonly sent: number;
  readonly blocked: number;
  readonly deferredAgain: number;
  readonly failed: number;
  readonly outcomes: readonly { readonly messageId: string; readonly status: string }[];
}

const SYSTEM_ACTOR: Actor = { type: 'SYSTEM', id: null };

export class DeferredSendService<Tx> {
  private readonly clock: Clock;

  constructor(private readonly deps: DeferredSendDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  async drain(
    options: { readonly shopId?: string | null; readonly limit?: number } = {},
  ): Promise<DrainResult> {
    const now = this.clock.now();

    // The claim is its own transaction and the sends are not: holding a lock
    // across a network round trip to Meta for every message in a batch would
    // pin a connection for as long as the batch takes.
    const due = await this.deps.uow.transaction(async (tx) =>
      this.deps.messages.claimDueScheduled(tx, {
        shopId: options.shopId ?? null,
        dueBefore: now,
        limit: options.limit ?? 50,
      }),
    );

    const outcomes: { messageId: string; status: string }[] = [];
    let sent = 0;
    let blocked = 0;
    let deferredAgain = 0;
    let failed = 0;

    for (const message of due) {
      const outcome = await this.release(message);
      outcomes.push({ messageId: message.id, status: outcome.status });

      switch (outcome.status) {
        case 'SENT':
          sent += 1;
          break;
        case 'BLOCKED':
          blocked += 1;
          break;
        case 'DEFERRED':
          deferredAgain += 1;
          break;
        default:
          failed += 1;
      }
    }

    return { claimed: due.length, sent, blocked, deferredAgain, failed, outcomes };
  }

  private async release(message: ScheduledMessage): Promise<GateOutcome> {
    const content = await this.contentFor(message);
    if (content === null) {
      return {
        status: 'FAILED',
        messageId: message.id,
        code: 'MEDIA_UNAVAILABLE',
        reason:
          'The media this held message referred to is no longer in storage, so it cannot be sent',
      };
    }

    const request: OutboundRequest = {
      shopId: message.shopId,
      conversationId: message.conversationId,
      customerId: message.customerId,
      purpose: message.purpose,
      content,
      actor: SYSTEM_ACTOR,
      traceId: `deferred-release:${message.id}`,
      flow: 'status',
      language: message.language,
      jobCardId: message.jobCardId,
      createdByAgent: message.createdByAgent,
      isHumanReply: message.isHumanReply,
      approvedByStaffId: message.approvedByStaffId,
      agentRunId: message.agentRunId,
      mediaId: message.mediaId,
      // The message already passed the disclosure and autonomy checks when it
      // was composed; what must be re-checked is everything that could have
      // changed while it waited, which is what `release` re-runs.
      systemReply: true,
    };

    return this.deps.gate.release(request, message.id, message.approvedByStaffId);
  }

  private async contentFor(message: ScheduledMessage): Promise<OutboundContent | null> {
    return rebuildOutboundContent(message, this.deps.media);
  }
}

/**
 * Rebuilds the content from the stored row.
 *
 * The row is the record of what was composed, so this reconstruction — not a
 * cached object — is what actually goes out. A message that sat overnight, or
 * sat in the HITL queue until an advisor approved it, is sent as the words that
 * were audited, not as whatever a re-render would produce today.
 *
 * Shared by the quiet-hours drain and the phase-3 review queue, because two
 * reconstructions of the same row would eventually disagree — and the
 * disagreement would be a customer receiving something no one reviewed.
 */
export async function rebuildOutboundContent(
  message: ScheduledMessage,
  media?: MediaBytesLoader,
): Promise<OutboundContent | null> {
  {
    if (message.templateName !== null) {
      return {
        kind: 'template',
        templateName: message.templateName,
        templateLanguage: message.templateLanguage ?? message.language,
        category: message.conversationCategory ?? 'UTILITY',
        variables: message.templateVariables ?? [],
        preview: message.body,
      };
    }

    if (message.kind === 'INTERACTIVE') {
      const parsed = parseInteractive(message.interactive);
      return {
        kind: 'interactive',
        body: message.body,
        ...(parsed.header === null ? {} : { header: parsed.header }),
        ...(parsed.footer === null ? {} : { footer: parsed.footer }),
        ...(parsed.buttons.length > 0 ? { buttons: parsed.buttons } : {}),
        ...(parsed.sections.length > 0
          ? { sections: parsed.sections, listButtonLabel: parsed.listButtonLabel ?? 'Choose' }
          : {}),
      };
    }

    if (MEDIA_KINDS.has(message.kind) && message.mediaId !== null) {
      if (media === undefined) return null;
      const bytes = await media.load(message.shopId, message.mediaId);
      if (bytes === null) return null;

      return {
        kind: 'media',
        mediaId: message.mediaId,
        mediaKind:
          message.kind === 'IMAGE'
            ? 'PHOTO'
            : message.kind === 'AUDIO'
              ? 'AUDIO'
              : message.kind === 'VIDEO'
                ? 'VIDEO'
                : 'DOCUMENT',
        contentType: bytes.contentType,
        bytes: bytes.bytes,
        ...(message.body.length === 0 ? {} : { caption: message.body }),
      };
    }

    return { kind: 'text', body: message.body };
  }
}

const MEDIA_KINDS = new Set(['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT']);

interface ParsedInteractive {
  readonly buttons: readonly OutboundButton[];
  readonly sections: readonly OutboundListSection[];
  readonly listButtonLabel: string | null;
  readonly header: string | null;
  readonly footer: string | null;
}

/**
 * The `interactive` column is `jsonb`, so it is `unknown` on the way back and
 * has to be narrowed rather than cast. A malformed payload degrades to a plain
 * body with no buttons — the words still reach the customer.
 */
function parseInteractive(value: unknown): ParsedInteractive {
  const empty: ParsedInteractive = {
    buttons: [],
    sections: [],
    listButtonLabel: null,
    header: null,
    footer: null,
  };
  if (typeof value !== 'object' || value === null) return empty;

  const record = value as Record<string, unknown>;
  const buttons = Array.isArray(record['buttons'])
    ? record['buttons'].filter(isButton)
    : [];
  const sections = Array.isArray(record['sections'])
    ? record['sections'].filter(isSection)
    : [];

  return {
    buttons,
    sections,
    listButtonLabel:
      typeof record['listButtonLabel'] === 'string' ? record['listButtonLabel'] : null,
    header: typeof record['header'] === 'string' ? record['header'] : null,
    footer: typeof record['footer'] === 'string' ? record['footer'] : null,
  };
}

function isButton(value: unknown): value is OutboundButton {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['id'] === 'string' && typeof record['title'] === 'string';
}

function isSection(value: unknown): value is OutboundListSection {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['title'] === 'string' && Array.isArray(record['rows']);
}
