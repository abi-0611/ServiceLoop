import type { InboundMediaHandle, InboundMessage } from '@serviceloop/domain';
import type { MessageKind } from '@serviceloop/shared';
import type { InboundEvent } from './types';

/**
 * WhatsApp's vocabulary → the domain's.
 *
 * The adapter has already turned Meta's JSON into `InboundEvent`; this turns
 * that into the channel-agnostic `InboundMessage` the router understands. The
 * two shapes look similar today because WhatsApp is the only channel — the
 * translation exists so that phase 5's voice channel and a future SMS channel
 * produce the same `InboundMessage` without the router learning a third dialect.
 */

const KIND_BY_MEDIA = {
  PHOTO: 'IMAGE',
  VIDEO: 'VIDEO',
  AUDIO: 'AUDIO',
  DOCUMENT: 'DOCUMENT',
} as const satisfies Record<string, MessageKind>;

export function toInboundMessage(event: InboundEvent): InboundMessage {
  const base = {
    channel: 'WHATSAPP' as const,
    providerMessageId: event.waMessageId,
    from: event.from,
    fromDisplayName: event.fromDisplayName,
    groupId: event.groupId,
    timestamp: event.timestamp,
    contextProviderMessageId: event.contextMessageId,
  };

  const empty = {
    text: '',
    caption: null,
    media: null as InboundMediaHandle | null,
    replyId: null as string | null,
    replyTitle: null as string | null,
    location: null,
    reaction: null,
  };

  switch (event.kind) {
    case 'text':
      return { ...base, ...empty, kind: 'TEXT', text: event.text };

    case 'media':
      return {
        ...base,
        ...empty,
        kind: KIND_BY_MEDIA[event.mediaKind],
        caption: event.caption,
        media: {
          providerMediaId: event.media.providerMediaId,
          mimeType: event.media.mimeType,
          kind: event.mediaKind,
          sha256: event.media.sha256,
          fileSizeBytes: event.media.fileSizeBytes,
          filename: event.media.filename,
          isVoiceNote: event.media.isVoiceNote,
        },
      };

    case 'button_reply':
      return {
        ...base,
        ...empty,
        kind: 'BUTTON_REPLY',
        replyId: event.replyId,
        replyTitle: event.title,
      };

    case 'list_reply':
      return {
        ...base,
        ...empty,
        kind: 'LIST_REPLY',
        replyId: event.replyId,
        replyTitle: event.title,
      };

    case 'location':
      return {
        ...base,
        ...empty,
        kind: 'LOCATION',
        location: { latitude: event.latitude, longitude: event.longitude },
      };

    case 'reaction':
      return {
        ...base,
        ...empty,
        kind: 'REACTION',
        reaction: { emoji: event.emoji, targetProviderMessageId: event.targetMessageId },
      };

    case 'unsupported':
      // Recorded, acknowledged, never thrown on: a message type this build does
      // not model still belongs in the thread, so an advisor can see that the
      // customer sent *something* rather than wondering why they went quiet.
      return { ...base, ...empty, kind: 'UNSUPPORTED', text: `[${event.providerType}]` };
  }
}

/** Delivery receipts map onto the message lifecycle the inbox renders as ticks. */
export const MESSAGE_STATUS_BY_DELIVERY_STATE = {
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  failed: 'FAILED',
} as const;
