import { isNormalisedPhone } from '@serviceloop/shared';
import { WhatsAppError } from './errors';
import type {
  DownloadedMedia,
  InboundBatch,
  InboundMediaRef,
  MarkReadInput,
  SendInteractiveInput,
  SendMediaInput,
  SendResult,
  SendTemplateInput,
  SendTextInput,
  SubscriptionChallenge,
  WebhookDelivery,
} from './types';

/**
 * WhatsAppPort — the only way ServiceLoop touches WhatsApp (master §5).
 *
 * Two adapters ship with it: `MetaCloudWhatsAppAdapter` (the real Cloud API)
 * and `SandboxWhatsAppAdapter` (in-process, drives the console simulator). Both
 * are held to `runWhatsAppContract` in `contract.ts`.
 *
 * Note what is *not* here: consent, quiet hours, autonomy. The port moves
 * bytes. Whether a message may be sent at all is the `OutboundGate`'s decision,
 * in `packages/domain`, and nothing may reach this port without passing it.
 */
export interface WhatsAppPort {
  readonly driver: 'meta-cloud' | 'sandbox';

  /** Free-form message. Only legal inside the 24-hour customer-service window. */
  sendSessionMessage(input: SendTextInput): Promise<SendResult>;

  /** An approved template. The only business-initiated send outside the window. */
  sendTemplate(input: SendTemplateInput): Promise<SendResult>;

  /** Quick-reply buttons or a list picker. */
  sendInteractive(input: SendInteractiveInput): Promise<SendResult>;

  sendMedia(input: SendMediaInput): Promise<SendResult>;

  /** Blue ticks on an inbound message. Best-effort: failures never block a flow. */
  markRead(input: MarkReadInput): Promise<void>;

  /** Fetches the bytes behind an inbound media reference. */
  downloadMedia(shopId: string, ref: InboundMediaRef): Promise<DownloadedMedia>;

  /**
   * Verifies and normalises one webhook POST.
   *
   * Throws `WhatsAppError('SIGNATURE_INVALID')` before parsing anything when
   * the signature does not match, so a forged payload cannot reach the router.
   */
  receive(delivery: WebhookDelivery): Promise<InboundBatch>;

  /**
   * The GET subscription handshake. Returns the challenge to echo back, or
   * throws when the verify token does not match.
   */
  verifySubscription(challenge: SubscriptionChallenge): string;
}

/* -------------------------------------------------------------------------- *
 * Shared validation
 *
 * WhatsApp silently truncates over-long titles and rejects malformed payloads
 * with opaque codes. Catching it here means a bug surfaces in a unit test with
 * the field name in the message, not as a 132000 in production.
 * -------------------------------------------------------------------------- */

export const WA_LIMITS = {
  textBody: 4096,
  interactiveBody: 1024,
  interactiveHeader: 60,
  interactiveFooter: 60,
  buttonTitle: 20,
  maxButtons: 3,
  listButtonLabel: 20,
  listRowTitle: 24,
  listRowDescription: 72,
  listSectionTitle: 24,
  maxListRows: 10,
  caption: 1024,
} as const;

function invalid(message: string, context: Record<string, unknown> = {}): WhatsAppError {
  return new WhatsAppError('INVALID_REQUEST', message, { context });
}

/** `+919876543210` for a person, `group:120363…` for the staff evidence group. */
export function assertValidRecipient(to: string): void {
  if (to.startsWith('group:')) {
    if (to.length <= 'group:'.length) throw invalid('Group recipient has no group id', { to });
    return;
  }
  if (!isNormalisedPhone(to)) {
    throw invalid(
      'Recipient must be an E.164 Indian mobile number or a `group:<id>` address',
      // The number itself is PII and deliberately not echoed.
      { length: to.length },
    );
  }
}

function assertLength(field: string, value: string, max: number): void {
  if (value.length === 0) throw invalid(`${field} must not be empty`);
  if (value.length > max) {
    throw invalid(`${field} is ${value.length} characters; WhatsApp allows ${max}`, {
      field,
      max,
      actual: value.length,
    });
  }
}

export function assertValidText(input: SendTextInput): void {
  assertValidRecipient(input.to);
  assertLength('text body', input.body, WA_LIMITS.textBody);
}

export function assertValidInteractive(input: SendInteractiveInput): void {
  assertValidRecipient(input.to);
  assertLength('interactive body', input.body, WA_LIMITS.interactiveBody);
  if (input.header !== undefined) {
    assertLength('interactive header', input.header, WA_LIMITS.interactiveHeader);
  }
  if (input.footer !== undefined) {
    assertLength('interactive footer', input.footer, WA_LIMITS.interactiveFooter);
  }

  if (input.payload.kind === 'buttons') {
    const { buttons } = input.payload;
    if (buttons.length === 0) throw invalid('An interactive button message needs a button');
    if (buttons.length > WA_LIMITS.maxButtons) {
      throw invalid(`WhatsApp allows at most ${WA_LIMITS.maxButtons} reply buttons`, {
        actual: buttons.length,
      });
    }
    const ids = new Set<string>();
    for (const button of buttons) {
      assertLength('button title', button.title, WA_LIMITS.buttonTitle);
      if (button.id.length === 0) throw invalid('Every reply button needs an id');
      if (ids.has(button.id)) throw invalid(`Duplicate button id "${button.id}"`);
      ids.add(button.id);
    }
    return;
  }

  const { sections, buttonLabel } = input.payload;
  assertLength('list button label', buttonLabel, WA_LIMITS.listButtonLabel);
  if (sections.length === 0) throw invalid('An interactive list needs at least one section');

  const rowIds = new Set<string>();
  let rowCount = 0;
  for (const section of sections) {
    assertLength('list section title', section.title, WA_LIMITS.listSectionTitle);
    for (const row of section.rows) {
      assertLength('list row title', row.title, WA_LIMITS.listRowTitle);
      if (row.description !== undefined) {
        assertLength('list row description', row.description, WA_LIMITS.listRowDescription);
      }
      if (row.id.length === 0) throw invalid('Every list row needs an id');
      if (rowIds.has(row.id)) throw invalid(`Duplicate list row id "${row.id}"`);
      rowIds.add(row.id);
      rowCount += 1;
    }
  }
  if (rowCount === 0) throw invalid('An interactive list needs at least one row');
  if (rowCount > WA_LIMITS.maxListRows) {
    throw invalid(`WhatsApp allows at most ${WA_LIMITS.maxListRows} list rows`, {
      actual: rowCount,
    });
  }
}

export function assertValidMedia(input: SendMediaInput): void {
  assertValidRecipient(input.to);
  if (input.media.providerMediaId === undefined && input.media.bytes === undefined) {
    throw invalid('Outbound media needs either a providerMediaId or bytes to upload');
  }
  if (input.caption !== undefined) {
    assertLength('media caption', input.caption, WA_LIMITS.caption);
  }
}

export function assertValidTemplate(input: SendTemplateInput): void {
  assertValidRecipient(input.to);
  if (input.template.name.length === 0) throw invalid('Template name is required');
  if (input.template.language.length === 0) throw invalid('Template language is required');
}
