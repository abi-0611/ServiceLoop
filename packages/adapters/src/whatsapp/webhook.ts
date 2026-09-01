import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalisePhone, type ConversationCategory, type MediaKind } from '@serviceloop/shared';
import { WhatsAppError } from './errors';
import type {
  DeliveryState,
  InboundBatch,
  InboundEvent,
  InboundEventBase,
  InboundMediaRef,
  StatusUpdate,
  SubscriptionChallenge,
} from './types';

/**
 * Meta webhook verification and normalisation.
 *
 * Kept apart from the adapter so it can be unit-tested against recorded
 * payloads with no HTTP anywhere near it, and so the signature check is a
 * single, auditable function rather than a step inside a request handler.
 */

export const SIGNATURE_HEADER = 'x-hub-signature-256';
const SIGNATURE_PREFIX = 'sha256=';

/**
 * HMAC-SHA256 of the *raw* body keyed with the app secret, compared in
 * constant time. A re-serialised body will not match — key ordering and
 * whitespace are part of the signed bytes — which is why `WebhookDelivery`
 * carries the original string.
 */
export function verifySignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  // `typeof` rather than `=== null`, because the value comes off an HTTP header
  // and Express hands back `undefined` for an absent one. A TypeError here
  // would surface as a 500, and Meta retries 5xx — so a delivery with no
  // signature at all would be redelivered for days instead of being refused
  // once. Fail-closed means returning false, not throwing.
  if (typeof signatureHeader !== 'string' || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const provided = signatureHeader.slice(SIGNATURE_PREFIX.length).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;

  const expected = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}

/** The signature a sender would attach — used by the sandbox and by tests. */
export function signPayload(rawBody: string, appSecret: string): string {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')}`;
}

/**
 * GET handshake: Meta calls the webhook once with a verify token and expects
 * the challenge echoed back verbatim. A mismatch must not echo anything.
 */
export function verifySubscriptionChallenge(
  challenge: SubscriptionChallenge,
  expectedVerifyToken: string,
): string {
  if (challenge.mode !== 'subscribe') {
    throw new WhatsAppError('INVALID_REQUEST', `Unsupported hub.mode "${challenge.mode ?? ''}"`);
  }
  const provided = challenge.verifyToken ?? '';
  const expectedBytes = Buffer.from(expectedVerifyToken, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  const matches =
    expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);

  if (!matches) {
    throw new WhatsAppError('AUTH_FAILED', 'Webhook verify token does not match');
  }
  if (challenge.challenge === null || challenge.challenge.length === 0) {
    throw new WhatsAppError('INVALID_REQUEST', 'Subscription handshake carried no hub.challenge');
  }
  return challenge.challenge;
}

/* -------------------------------------------------------------------------- *
 * Payload normalisation
 * -------------------------------------------------------------------------- */

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** WhatsApp timestamps are Unix seconds, delivered as strings. */
function asTimestamp(value: unknown, fallback: Date): Date {
  const seconds = asNumber(value);
  return seconds === null ? fallback : new Date(seconds * 1000);
}

/**
 * `wa_id` values are bare national/international digit strings (`919841100001`).
 * Everything downstream keys on E.164, so normalise once, here. A number we
 * cannot normalise is passed through with a `+` rather than dropped: an
 * unrecognised sender still deserves the identification prompt.
 */
function toE164(waId: string): string {
  const result = normalisePhone(waId);
  return result.ok ? result.value : `+${waId.replace(/[^\d]/g, '')}`;
}

const MEDIA_KIND_BY_TYPE: Readonly<Record<string, MediaKind>> = {
  image: 'PHOTO',
  sticker: 'PHOTO',
  audio: 'AUDIO',
  voice: 'AUDIO',
  video: 'VIDEO',
  document: 'DOCUMENT',
};

const CATEGORY_BY_PRICING: Readonly<Record<string, ConversationCategory>> = {
  service: 'SERVICE',
  utility: 'UTILITY',
  marketing: 'MARKETING',
  authentication: 'AUTHENTICATION',
};

const DELIVERY_STATES: ReadonlySet<string> = new Set(['sent', 'delivered', 'read', 'failed']);

function mediaRef(node: Json, isVoiceNote: boolean): InboundMediaRef | null {
  const providerMediaId = asString(node['id']);
  if (providerMediaId === null) return null;
  return {
    providerMediaId,
    mimeType: asString(node['mime_type']) ?? 'application/octet-stream',
    sha256: asString(node['sha256']),
    fileSizeBytes: asNumber(node['file_size']),
    filename: asString(node['filename']),
    isVoiceNote,
  };
}

function normaliseMessage(
  message: Json,
  contactNames: ReadonlyMap<string, string>,
  phoneNumberId: string | null,
  receivedAt: Date,
): InboundEvent | null {
  const waMessageId = asString(message['id']);
  const fromRaw = asString(message['from']);
  if (waMessageId === null || fromRaw === null) return null;

  const context = asObject(message['context']);
  const base: InboundEventBase = {
    waMessageId,
    from: toE164(fromRaw),
    fromDisplayName: contactNames.get(fromRaw) ?? null,
    to: phoneNumberId ?? '',
    timestamp: asTimestamp(message['timestamp'], receivedAt),
    // Cloud API surfaces a group id on the message context when the thread is
    // a group; 1:1 threads simply omit it.
    groupId: context === null ? null : asString(context['group_id']),
    contextMessageId: context === null ? null : asString(context['id']),
  };

  const type = asString(message['type']) ?? 'unknown';

  switch (type) {
    case 'text': {
      const text = asObject(message['text']);
      return { ...base, kind: 'text', text: asString(text?.['body']) ?? '' };
    }

    case 'image':
    case 'audio':
    case 'video':
    case 'document':
    case 'sticker': {
      const node = asObject(message[type]);
      if (node === null) return { ...base, kind: 'unsupported', providerType: type };
      const isVoiceNote = type === 'audio' && node['voice'] === true;
      const ref = mediaRef(node, isVoiceNote);
      if (ref === null) return { ...base, kind: 'unsupported', providerType: type };
      return {
        ...base,
        kind: 'media',
        mediaKind: MEDIA_KIND_BY_TYPE[type] ?? 'DOCUMENT',
        media: ref,
        caption: asString(node['caption']),
      };
    }

    case 'interactive': {
      const interactive = asObject(message['interactive']);
      const interactiveType = asString(interactive?.['type']);
      if (interactiveType === 'button_reply') {
        const reply = asObject(interactive?.['button_reply']);
        return {
          ...base,
          kind: 'button_reply',
          replyId: asString(reply?.['id']) ?? '',
          title: asString(reply?.['title']) ?? '',
        };
      }
      if (interactiveType === 'list_reply') {
        const reply = asObject(interactive?.['list_reply']);
        return {
          ...base,
          kind: 'list_reply',
          replyId: asString(reply?.['id']) ?? '',
          title: asString(reply?.['title']) ?? '',
          description: asString(reply?.['description']),
        };
      }
      return { ...base, kind: 'unsupported', providerType: `interactive.${interactiveType ?? '?'}` };
    }

    case 'button': {
      // A quick-reply tapped on a *template* arrives as `button`, not
      // `interactive` — same user gesture, different envelope.
      const button = asObject(message['button']);
      return {
        ...base,
        kind: 'button_reply',
        replyId: asString(button?.['payload']) ?? asString(button?.['text']) ?? '',
        title: asString(button?.['text']) ?? '',
      };
    }

    case 'location': {
      const location = asObject(message['location']);
      const latitude = asNumber(location?.['latitude']);
      const longitude = asNumber(location?.['longitude']);
      if (latitude === null || longitude === null) {
        return { ...base, kind: 'unsupported', providerType: 'location' };
      }
      return {
        ...base,
        kind: 'location',
        latitude,
        longitude,
        name: asString(location?.['name']),
        address: asString(location?.['address']),
      };
    }

    case 'reaction': {
      const reaction = asObject(message['reaction']);
      const targetMessageId = asString(reaction?.['message_id']);
      if (targetMessageId === null) {
        return { ...base, kind: 'unsupported', providerType: 'reaction' };
      }
      return { ...base, kind: 'reaction', emoji: asString(reaction?.['emoji']), targetMessageId };
    }

    default:
      return { ...base, kind: 'unsupported', providerType: type };
  }
}

function normaliseStatus(status: Json, receivedAt: Date): StatusUpdate | null {
  const waMessageId = asString(status['id']);
  const state = asString(status['status']);
  if (waMessageId === null || state === null || !DELIVERY_STATES.has(state)) return null;

  const conversation = asObject(status['conversation']);
  const pricing = asObject(status['pricing']);
  const firstError = asObject(asArray(status['errors'])[0]);
  const category = asString(pricing?.['category']);

  return {
    waMessageId,
    state: state as DeliveryState,
    timestamp: asTimestamp(status['timestamp'], receivedAt),
    recipient: toE164(asString(status['recipient_id']) ?? ''),
    providerConversationId: conversation === null ? null : asString(conversation['id']),
    category: category === null ? null : (CATEGORY_BY_PRICING[category] ?? null),
    billable: typeof pricing?.['billable'] === 'boolean' ? (pricing['billable'] as boolean) : null,
    errorCode: firstError === null ? null : asNumber(firstError['code']),
    errorTitle: firstError === null ? null : asString(firstError['title']),
  };
}

/**
 * Turns one webhook body into normalised events.
 *
 * Deliberately forgiving about *unknown* shapes and strict about the envelope:
 * Meta adds message types without warning, and a workshop's inbound pipeline
 * must not fall over because a customer sent a poll. Anything unrecognised
 * becomes an `unsupported` event, which is still recorded and acknowledged.
 */
export function normaliseMetaWebhook(rawBody: string, receivedAt: Date): InboundBatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new WhatsAppError('MALFORMED_PAYLOAD', 'Webhook body is not valid JSON');
  }

  const root = asObject(parsed);
  if (root === null) throw new WhatsAppError('MALFORMED_PAYLOAD', 'Webhook body is not an object');

  const entries = asArray(root['entry']);
  if (entries.length === 0 && asString(root['object']) === null) {
    throw new WhatsAppError(
      'MALFORMED_PAYLOAD',
      'Webhook body carries neither an `object` nor an `entry` array',
    );
  }

  const events: InboundEvent[] = [];
  const statuses: StatusUpdate[] = [];
  let phoneNumberId: string | null = null;

  for (const rawEntry of entries) {
    const entry = asObject(rawEntry);
    if (entry === null) continue;

    for (const rawChange of asArray(entry['changes'])) {
      const change = asObject(rawChange);
      const value = asObject(change?.['value']);
      if (value === null) continue;

      const metadata = asObject(value['metadata']);
      phoneNumberId ??= metadata === null ? null : asString(metadata['phone_number_id']);

      const contactNames = new Map<string, string>();
      for (const rawContact of asArray(value['contacts'])) {
        const contact = asObject(rawContact);
        const waId = asString(contact?.['wa_id']);
        const name = asString(asObject(contact?.['profile'])?.['name']);
        if (waId !== null && name !== null) contactNames.set(waId, name);
      }

      for (const rawMessage of asArray(value['messages'])) {
        const message = asObject(rawMessage);
        if (message === null) continue;
        const event = normaliseMessage(message, contactNames, phoneNumberId, receivedAt);
        if (event !== null) events.push(event);
      }

      for (const rawStatus of asArray(value['statuses'])) {
        const status = asObject(rawStatus);
        if (status === null) continue;
        const normalised = normaliseStatus(status, receivedAt);
        if (normalised !== null) statuses.push(normalised);
      }
    }
  }

  return { events, statuses, phoneNumberId };
}
