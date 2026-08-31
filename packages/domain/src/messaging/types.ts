import type {
  ChannelType,
  ConsentPurpose,
  ConversationCategory,
  ConversationKind,
  ConversationState,
  Language,
  MediaKind,
  MessageKind,
  MessageStatus,
} from '@serviceloop/shared';

/**
 * Channel-agnostic messaging vocabulary.
 *
 * The WhatsApp adapter speaks Meta's dialect; SMS and voice will speak theirs.
 * The domain speaks only this, which is why the router, the session manager and
 * the OutboundGate have no idea WhatsApp exists — and why phase 5 can add voice
 * without touching any of them.
 */

/** A media object the channel has told us about but the pipeline has not stored. */
export interface InboundMediaHandle {
  readonly providerMediaId: string;
  readonly mimeType: string;
  readonly kind: MediaKind;
  readonly sha256: string | null;
  readonly fileSizeBytes: number | null;
  readonly filename: string | null;
  readonly isVoiceNote: boolean;
}

export interface InboundMessage {
  readonly channel: ChannelType;
  readonly kind: MessageKind;
  /** Provider message id — the idempotency key for redelivered webhooks. */
  readonly providerMessageId: string;
  /** Sender address in E.164. */
  readonly from: string;
  readonly fromDisplayName: string | null;
  /** Provider group id when the message arrived in a group, else null. */
  readonly groupId: string | null;
  readonly timestamp: Date;
  readonly text: string;
  readonly caption: string | null;
  readonly media: InboundMediaHandle | null;
  /** Set for button/list replies: the id we attached when we sent the prompt. */
  readonly replyId: string | null;
  readonly replyTitle: string | null;
  readonly contextProviderMessageId: string | null;
  readonly location: { readonly latitude: number; readonly longitude: number } | null;
  readonly reaction: { readonly emoji: string | null; readonly targetProviderMessageId: string } | null;
}

/* -------------------------------------------------------------------------- *
 * Outbound content
 * -------------------------------------------------------------------------- */

export interface OutboundButton {
  readonly id: string;
  readonly title: string;
}

export interface OutboundListRow {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}

export interface OutboundListSection {
  readonly title: string;
  readonly rows: readonly OutboundListRow[];
}

/**
 * What is being sent. `template` is the only variant that may leave the 24-hour
 * window, and the gate enforces that rather than trusting the caller.
 */
export type OutboundContent =
  | { readonly kind: 'text'; readonly body: string }
  | {
      readonly kind: 'template';
      readonly templateName: string;
      readonly templateLanguage: string;
      readonly category: ConversationCategory;
      readonly variables: readonly string[];
      /** Rendered copy stored on the message row so the inbox shows real words. */
      readonly preview: string;
    }
  | {
      readonly kind: 'interactive';
      readonly body: string;
      readonly header?: string;
      readonly footer?: string;
      readonly buttons?: readonly OutboundButton[];
      readonly listButtonLabel?: string;
      readonly sections?: readonly OutboundListSection[];
    }
  | {
      readonly kind: 'media';
      readonly mediaId: string;
      readonly mediaKind: MediaKind;
      readonly contentType: string;
      readonly bytes: Buffer;
      readonly caption?: string;
    };

export interface ConversationSnapshot {
  readonly id: string;
  readonly shopId: string;
  readonly kind: ConversationKind;
  readonly channel: ChannelType;
  readonly customerId: string | null;
  readonly externalThreadId: string | null;
  readonly externalAddress: string | null;
  readonly displayName: string | null;
  readonly state: ConversationState;
  readonly language: Language;
  readonly lastInboundAt: Date | null;
  readonly lastOutboundAt: Date | null;
  readonly windowExpiresAt: Date | null;
  readonly unreadCount: number;
  readonly humanOverrideAt: Date | null;
}

export interface MessageSnapshot {
  readonly id: string;
  readonly conversationId: string;
  readonly direction: 'INBOUND' | 'OUTBOUND';
  readonly status: MessageStatus;
  readonly kind: MessageKind;
  readonly purpose: ConsentPurpose;
  readonly body: string;
  readonly sentAt: Date | null;
  readonly createdAt: Date;
}

export interface ConsentSnapshotRow {
  readonly purpose: ConsentPurpose;
  readonly status: 'PENDING' | 'GRANTED' | 'REVOKED';
  readonly grantedAt: Date | null;
  readonly revokedAt: Date | null;
}
