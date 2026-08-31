import type {
  ConversationCategory,
  Language,
  MediaKind,
  WaTemplateCategory,
} from '@serviceloop/shared';

/**
 * The normalised WhatsApp vocabulary.
 *
 * Nothing above this file ever sees a Meta-shaped payload: the adapter's whole
 * job is to turn provider JSON into these types and back. The sandbox adapter
 * produces exactly the same shapes, which is what lets one contract suite hold
 * both adapters to the same behaviour.
 */

/* -------------------------------------------------------------------------- *
 * Inbound
 * -------------------------------------------------------------------------- */

/** A media object we have been told about but not yet downloaded. */
export interface InboundMediaRef {
  readonly providerMediaId: string;
  readonly mimeType: string;
  readonly sha256: string | null;
  readonly fileSizeBytes: number | null;
  readonly filename: string | null;
  /** True for WhatsApp voice notes, as opposed to attached audio files. */
  readonly isVoiceNote: boolean;
}

export interface InboundEventBase {
  readonly waMessageId: string;
  /** Sender in E.164 (`+91…`); the adapter normalises the raw `wa_id`. */
  readonly from: string;
  /** WhatsApp profile name, when the provider supplies one. */
  readonly fromDisplayName: string | null;
  /** The business phone-number id the message arrived on. */
  readonly to: string;
  readonly timestamp: Date;
  /** Set when the message arrived in a group rather than a 1:1 thread. */
  readonly groupId: string | null;
  /** The message this one replies to, when the customer used the reply UI. */
  readonly contextMessageId: string | null;
}

export type InboundEvent = InboundEventBase &
  (
    | { readonly kind: 'text'; readonly text: string }
    | {
        readonly kind: 'media';
        readonly mediaKind: MediaKind;
        readonly media: InboundMediaRef;
        readonly caption: string | null;
      }
    | { readonly kind: 'button_reply'; readonly replyId: string; readonly title: string }
    | {
        readonly kind: 'list_reply';
        readonly replyId: string;
        readonly title: string;
        readonly description: string | null;
      }
    | {
        readonly kind: 'location';
        readonly latitude: number;
        readonly longitude: number;
        readonly name: string | null;
        readonly address: string | null;
      }
    | {
        readonly kind: 'reaction';
        /** Null when the customer *removed* a reaction. */
        readonly emoji: string | null;
        readonly targetMessageId: string;
      }
    /** A type this build does not model. Recorded, acknowledged, never thrown on. */
    | { readonly kind: 'unsupported'; readonly providerType: string }
  );

export type DeliveryState = 'sent' | 'delivered' | 'read' | 'failed';

/** A delivery-receipt webhook for a message we sent earlier. */
export interface StatusUpdate {
  readonly waMessageId: string;
  readonly state: DeliveryState;
  readonly timestamp: Date;
  readonly recipient: string;
  readonly providerConversationId: string | null;
  readonly category: ConversationCategory | null;
  readonly billable: boolean | null;
  readonly errorCode: number | null;
  readonly errorTitle: string | null;
}

/** One webhook POST, fully normalised. */
export interface InboundBatch {
  readonly events: readonly InboundEvent[];
  readonly statuses: readonly StatusUpdate[];
  /** The business number the delivery was addressed to, when stated. */
  readonly phoneNumberId: string | null;
}

/** The raw HTTP delivery, before anything has parsed it. */
export interface WebhookDelivery {
  /**
   * The body exactly as received. Signature verification is defined over these
   * bytes, so it must never be a re-serialised object.
   */
  readonly rawBody: string;
  readonly signatureHeader: string | null;
  readonly receivedAt: Date;
}

export interface SubscriptionChallenge {
  readonly mode: string | null;
  readonly verifyToken: string | null;
  readonly challenge: string | null;
}

/* -------------------------------------------------------------------------- *
 * Outbound
 * -------------------------------------------------------------------------- */

export interface SendTarget {
  readonly shopId: string;
  /** E.164 for a person, or `group:<id>` for the staff evidence channel. */
  readonly to: string;
}

export interface SendTextInput extends SendTarget {
  readonly body: string;
  /** Suppresses WhatsApp's link preview card; on by default for service copy. */
  readonly previewUrl?: boolean;
  readonly replyToWaMessageId?: string;
}

export interface TemplateVariables {
  readonly header?: readonly string[];
  readonly body?: readonly string[];
  /** Positional URL-button suffixes, if the template declares dynamic buttons. */
  readonly buttonUrlSuffixes?: readonly string[];
}

export interface TemplateRef {
  readonly name: string;
  readonly language: string;
  readonly category: WaTemplateCategory;
}

export interface SendTemplateInput extends SendTarget {
  readonly template: TemplateRef;
  readonly variables: TemplateVariables;
}

export interface ReplyButton {
  readonly id: string;
  /** WhatsApp truncates past 20 characters; the port validates instead. */
  readonly title: string;
}

export interface ListRow {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}

export interface ListSection {
  readonly title: string;
  readonly rows: readonly ListRow[];
}

export type InteractivePayload =
  | { readonly kind: 'buttons'; readonly buttons: readonly ReplyButton[] }
  | {
      readonly kind: 'list';
      readonly buttonLabel: string;
      readonly sections: readonly ListSection[];
    };

export interface SendInteractiveInput extends SendTarget {
  readonly body: string;
  readonly header?: string;
  readonly footer?: string;
  readonly payload: InteractivePayload;
}

export interface OutboundMedia {
  /** A media id already uploaded to the provider, or raw bytes to upload now. */
  readonly providerMediaId?: string;
  readonly bytes?: Buffer;
  readonly contentType: string;
  readonly filename?: string;
  readonly kind: MediaKind;
}

export interface SendMediaInput extends SendTarget {
  readonly media: OutboundMedia;
  readonly caption?: string;
}

export interface MarkReadInput {
  readonly shopId: string;
  readonly waMessageId: string;
}

export interface SendResult {
  readonly providerMessageId: string;
  /** Meta's conversation id, when the response carries one (cost metering). */
  readonly providerConversationId: string | null;
  readonly category: ConversationCategory | null;
  readonly acceptedAt: Date;
}

export interface DownloadedMedia {
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly filename: string | null;
}

/** WhatsApp language tags (`en`, `en_US`, `ta`, `hi`) from our own `Language`. */
export const WA_LANGUAGE_BY_LANGUAGE: Readonly<Record<Language, string>> = {
  en: 'en',
  ta: 'ta',
  hi: 'hi',
};
