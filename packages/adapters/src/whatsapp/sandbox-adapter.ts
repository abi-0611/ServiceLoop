import { createHash, randomUUID } from 'node:crypto';
import type { MediaKind } from '@serviceloop/shared';
import { WhatsAppError } from './errors';
import {
  assertValidInteractive,
  assertValidMedia,
  assertValidTemplate,
  assertValidText,
  type WhatsAppPort,
} from './port';
import { WhatsAppRateLimiter } from './rate-limiter';
import type {
  DownloadedMedia,
  InboundBatch,
  InboundMediaRef,
  InteractivePayload,
  MarkReadInput,
  SendInteractiveInput,
  SendMediaInput,
  SendResult,
  SendTemplateInput,
  SendTextInput,
  SubscriptionChallenge,
  TemplateRef,
  TemplateVariables,
  WebhookDelivery,
} from './types';
import { normaliseMetaWebhook, signPayload, verifySignature, verifySubscriptionChallenge } from './webhook';

/**
 * SandboxWhatsAppAdapter — a complete WhatsApp implementation with no Meta.
 *
 * The design decision that makes this worth trusting: injected inbound messages
 * are rendered as *real Cloud API webhook envelopes*, signed with the sandbox
 * app secret, and pushed through the same `normaliseMetaWebhook` the live
 * adapter uses. Nothing takes a shortcut around the parser, so a payload shape
 * the sandbox handles is a payload shape production handles.
 *
 * Outbound sends land in `messages` exactly as they do in production — the
 * persistence lives in the send path above the port, not in the adapter, so
 * both adapters write identical rows. What the sandbox adds is an observable
 * transcript the console simulator subscribes to, plus a delivery-receipt
 * simulator so message-state ticks are exercised in dev.
 */

export interface SandboxOutbound {
  readonly providerMessageId: string;
  readonly shopId: string;
  readonly to: string;
  readonly sentAt: Date;
  readonly kind: 'text' | 'template' | 'interactive' | 'media';
  readonly body: string;
  readonly template: (TemplateRef & { readonly variables: TemplateVariables }) | null;
  readonly interactive: InteractivePayload | null;
  readonly media: { readonly kind: MediaKind; readonly contentType: string } | null;
  readonly caption: string | null;
}

export interface InjectedInboundBase {
  readonly from: string;
  readonly displayName?: string;
  readonly groupId?: string;
  readonly replyToWaMessageId?: string;
  readonly at?: Date;
}

export type InjectedInbound = InjectedInboundBase &
  (
    | { readonly kind: 'text'; readonly text: string }
    | {
        readonly kind: 'media';
        readonly mediaKind: MediaKind;
        readonly bytes: Buffer;
        readonly contentType: string;
        readonly caption?: string;
        readonly filename?: string;
        readonly isVoiceNote?: boolean;
      }
    | { readonly kind: 'button_reply'; readonly replyId: string; readonly title: string }
    | {
        readonly kind: 'list_reply';
        readonly replyId: string;
        readonly title: string;
        readonly description?: string;
      }
    | {
        readonly kind: 'location';
        readonly latitude: number;
        readonly longitude: number;
        readonly name?: string;
        readonly address?: string;
      }
    | {
        readonly kind: 'reaction';
        readonly emoji: string | null;
        readonly targetMessageId: string;
      }
  );

export interface SandboxOptions {
  readonly phoneNumberId?: string;
  readonly appSecret?: string;
  readonly verifyToken?: string;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly rateLimiter?: WhatsAppRateLimiter;
  /**
   * `instant` emits sent → delivered → read receipts as soon as a send is
   * accepted, which is what the console needs to show ticks. `manual` leaves
   * receipts to the caller so a test can control them.
   */
  readonly deliveryMode?: 'instant' | 'manual';
}

export const SANDBOX_APP_SECRET = 'sandbox-app-secret';
export const SANDBOX_VERIFY_TOKEN = 'sandbox-verify-token';
export const SANDBOX_PHONE_NUMBER_ID = '000000000000000';

type Listener = (outbound: SandboxOutbound) => void;

export class SandboxWhatsAppAdapter implements WhatsAppPort {
  readonly driver = 'sandbox' as const;
  readonly appSecret: string;
  readonly verifyToken: string;
  readonly phoneNumberId: string;

  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly rateLimiter: WhatsAppRateLimiter;
  private readonly deliveryMode: 'instant' | 'manual';

  private readonly outbox: SandboxOutbound[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly mediaStore = new Map<string, DownloadedMedia>();
  private readonly readReceipts = new Set<string>();
  private readonly pendingStatuses: Array<{
    waMessageId: string;
    recipient: string;
    state: 'sent' | 'delivered' | 'read';
  }> = [];

  constructor(options: SandboxOptions = {}) {
    this.appSecret = options.appSecret ?? SANDBOX_APP_SECRET;
    this.verifyToken = options.verifyToken ?? SANDBOX_VERIFY_TOKEN;
    this.phoneNumberId = options.phoneNumberId ?? SANDBOX_PHONE_NUMBER_ID;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? (() => randomUUID());
    this.rateLimiter = options.rateLimiter ?? new WhatsAppRateLimiter();
    this.deliveryMode = options.deliveryMode ?? 'instant';
  }

  /* ---------------------------------------------------------------- sends -- */

  async sendSessionMessage(input: SendTextInput): Promise<SendResult> {
    assertValidText(input);
    return this.record(input.shopId, input.to, {
      kind: 'text',
      body: input.body,
      template: null,
      interactive: null,
      media: null,
      caption: null,
    });
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    assertValidTemplate(input);
    return this.record(
      input.shopId,
      input.to,
      {
        kind: 'template',
        body: renderTemplatePreview(input.template, input.variables),
        template: { ...input.template, variables: input.variables },
        interactive: null,
        media: null,
        caption: null,
      },
      // Outside the window a template opens a *new* billable conversation, and
      // its category is the template's own. The console shows this so a
      // developer sees the cost consequence of the send they just made.
      input.template.category,
    );
  }

  async sendInteractive(input: SendInteractiveInput): Promise<SendResult> {
    assertValidInteractive(input);
    return this.record(input.shopId, input.to, {
      kind: 'interactive',
      body: input.body,
      template: null,
      interactive: input.payload,
      media: null,
      caption: null,
    });
  }

  async sendMedia(input: SendMediaInput): Promise<SendResult> {
    assertValidMedia(input);

    if (input.media.bytes !== undefined) {
      const providerMediaId = `sbmedia-${this.newId()}`;
      this.mediaStore.set(providerMediaId, {
        bytes: input.media.bytes,
        contentType: input.media.contentType,
        sizeBytes: input.media.bytes.byteLength,
        sha256: createHash('sha256').update(input.media.bytes).digest('base64'),
        filename: input.media.filename ?? null,
      });
    }

    return this.record(input.shopId, input.to, {
      kind: 'media',
      body: input.caption ?? '',
      template: null,
      interactive: null,
      media: { kind: input.media.kind, contentType: input.media.contentType },
      caption: input.caption ?? null,
    });
  }

  markRead(input: MarkReadInput): Promise<void> {
    this.readReceipts.add(input.waMessageId);
    return Promise.resolve();
  }

  hasReadReceipt(waMessageId: string): boolean {
    return this.readReceipts.has(waMessageId);
  }

  /* ---------------------------------------------------------------- media -- */

  downloadMedia(_shopId: string, ref: InboundMediaRef): Promise<DownloadedMedia> {
    const stored = this.mediaStore.get(ref.providerMediaId);
    if (stored === undefined) {
      return Promise.reject(
        new WhatsAppError('MEDIA_ERROR', `Sandbox holds no media for ${ref.providerMediaId}`, {
          context: { providerMediaId: ref.providerMediaId },
        }),
      );
    }
    return Promise.resolve(stored);
  }

  /* -------------------------------------------------------------- inbound -- */

  // See `MetaCloudWhatsAppAdapter.receive`: rejects rather than throwing
  // synchronously, so both adapters fail the same way for a caller.
  async receive(delivery: WebhookDelivery): Promise<InboundBatch> {
    if (!verifySignature(delivery.rawBody, delivery.signatureHeader, this.appSecret)) {
      throw new WhatsAppError(
        'SIGNATURE_INVALID',
        'X-Hub-Signature-256 missing or does not match the sandbox app secret',
      );
    }
    return normaliseMetaWebhook(delivery.rawBody, delivery.receivedAt);
  }

  verifySubscription(challenge: SubscriptionChallenge): string {
    return verifySubscriptionChallenge(challenge, this.verifyToken);
  }

  /**
   * Renders an injected message as a signed Cloud API webhook delivery.
   *
   * This is the whole point of the sandbox: the simulator does not call some
   * private back door, it produces the same bytes Meta would and lets the real
   * webhook handler take it from there.
   */
  injectInbound(injected: InjectedInbound): WebhookDelivery {
    const at = injected.at ?? this.now();
    const waMessageId = `wamid.SBX${this.newId().replace(/-/g, '').toUpperCase()}`;
    const waId = injected.from.replace(/^\+/, '');

    const message: Record<string, unknown> = {
      id: waMessageId,
      from: waId,
      timestamp: String(Math.floor(at.getTime() / 1000)),
    };

    const context: Record<string, unknown> = {};
    if (injected.replyToWaMessageId !== undefined) context['id'] = injected.replyToWaMessageId;
    if (injected.groupId !== undefined) context['group_id'] = injected.groupId;
    if (Object.keys(context).length > 0) message['context'] = context;

    switch (injected.kind) {
      case 'text':
        message['type'] = 'text';
        message['text'] = { body: injected.text };
        break;

      case 'media': {
        const providerMediaId = `sbmedia-${this.newId()}`;
        const sha256 = createHash('sha256').update(injected.bytes).digest('base64');
        this.mediaStore.set(providerMediaId, {
          bytes: injected.bytes,
          contentType: injected.contentType,
          sizeBytes: injected.bytes.byteLength,
          sha256,
          filename: injected.filename ?? null,
        });

        const slot = PROVIDER_TYPE_BY_MEDIA_KIND[injected.mediaKind];
        message['type'] = slot;
        message[slot] = {
          id: providerMediaId,
          mime_type: injected.contentType,
          sha256,
          file_size: injected.bytes.byteLength,
          ...(injected.caption === undefined ? {} : { caption: injected.caption }),
          ...(injected.filename === undefined ? {} : { filename: injected.filename }),
          ...(injected.isVoiceNote === true ? { voice: true } : {}),
        };
        break;
      }

      case 'button_reply':
        message['type'] = 'interactive';
        message['interactive'] = {
          type: 'button_reply',
          button_reply: { id: injected.replyId, title: injected.title },
        };
        break;

      case 'list_reply':
        message['type'] = 'interactive';
        message['interactive'] = {
          type: 'list_reply',
          list_reply: {
            id: injected.replyId,
            title: injected.title,
            ...(injected.description === undefined ? {} : { description: injected.description }),
          },
        };
        break;

      case 'location':
        message['type'] = 'location';
        message['location'] = {
          latitude: injected.latitude,
          longitude: injected.longitude,
          ...(injected.name === undefined ? {} : { name: injected.name }),
          ...(injected.address === undefined ? {} : { address: injected.address }),
        };
        break;

      case 'reaction':
        message['type'] = 'reaction';
        message['reaction'] = {
          message_id: injected.targetMessageId,
          ...(injected.emoji === null ? {} : { emoji: injected.emoji }),
        };
        break;
    }

    return this.envelope(
      {
        contacts:
          injected.displayName === undefined
            ? undefined
            : [{ profile: { name: injected.displayName }, wa_id: waId }],
        messages: [message],
      },
      at,
    );
  }

  /**
   * Drains the delivery receipts queued by `instant` mode into one signed
   * webhook delivery, so message-state ticks travel the production path too.
   */
  drainStatusDelivery(at: Date = this.now()): WebhookDelivery | null {
    if (this.pendingStatuses.length === 0) return null;

    const statuses = this.pendingStatuses.splice(0, this.pendingStatuses.length).map((status) => ({
      id: status.waMessageId,
      status: status.state,
      timestamp: String(Math.floor(at.getTime() / 1000)),
      recipient_id: status.recipient.replace(/^\+/, ''),
      conversation: { id: `sbconv-${status.waMessageId.slice(-8)}`, origin: { type: 'service' } },
      pricing: { billable: true, pricing_model: 'CBP', category: 'service' },
    }));

    return this.envelope({ statuses }, at);
  }

  /** Queues a failure receipt — how a test drives the failed-send path. */
  queueFailure(waMessageId: string, recipient: string, code: number, title: string): WebhookDelivery {
    return this.envelope(
      {
        statuses: [
          {
            id: waMessageId,
            status: 'failed',
            timestamp: String(Math.floor(this.now().getTime() / 1000)),
            recipient_id: recipient.replace(/^\+/, ''),
            errors: [{ code, title }],
          },
        ],
      },
      this.now(),
    );
  }

  /* ------------------------------------------------------------ simulator -- */

  /** Everything this adapter has been asked to send, oldest first. */
  transcript(): readonly SandboxOutbound[] {
    return [...this.outbox];
  }

  onOutbound(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.outbox.length = 0;
    this.pendingStatuses.length = 0;
    this.mediaStore.clear();
    this.readReceipts.clear();
  }

  /* ------------------------------------------------------------- internal -- */

  private async record(
    shopId: string,
    to: string,
    fields: Omit<SandboxOutbound, 'providerMessageId' | 'shopId' | 'to' | 'sentAt'>,
    category: SendResult['category'] = 'SERVICE',
  ): Promise<SendResult> {
    const decision = await this.rateLimiter.acquire(shopId);
    if (!decision.allowed) {
      // The sandbox enforces the same budget as production; a developer who
      // writes a send loop finds out here rather than at go-live.
      throw new WhatsAppError(
        'RATE_LIMITED',
        'Sandbox per-shop send budget exhausted; the message stays queued',
        { retryAfterMs: decision.retryAfterMs, context: { shopId } },
      );
    }

    const sentAt = this.now();
    const providerMessageId = `wamid.SBXOUT${this.newId().replace(/-/g, '').toUpperCase()}`;
    const outbound: SandboxOutbound = { providerMessageId, shopId, to, sentAt, ...fields };

    this.outbox.push(outbound);
    for (const listener of this.listeners) listener(outbound);

    if (this.deliveryMode === 'instant' && !to.startsWith('group:')) {
      for (const state of ['sent', 'delivered', 'read'] as const) {
        this.pendingStatuses.push({ waMessageId: providerMessageId, recipient: to, state });
      }
    }

    return {
      providerMessageId,
      providerConversationId: `sbconv-${providerMessageId.slice(-8)}`,
      category,
      acceptedAt: sentAt,
    };
  }

  private envelope(value: Record<string, unknown>, at: Date): WebhookDelivery {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'sandbox-waba',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: '919000000000',
                  phone_number_id: this.phoneNumberId,
                },
                ...value,
              },
            },
          ],
        },
      ],
    });

    return {
      rawBody: body,
      signatureHeader: signPayload(body, this.appSecret),
      receivedAt: at,
    };
  }
}

const PROVIDER_TYPE_BY_MEDIA_KIND: Readonly<Record<MediaKind, string>> = {
  PHOTO: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
};

/**
 * Renders `{{1}}`-style placeholders so the simulator shows what the customer
 * would actually read, rather than the raw template name.
 */
function renderTemplatePreview(template: TemplateRef, variables: TemplateVariables): string {
  const body = variables.body ?? [];
  const header = variables.header ?? [];
  const parts = [
    header.length > 0 ? header.join(' ') : null,
    `[${template.name}/${template.language}]`,
    body.length > 0 ? body.join(' · ') : null,
  ].filter((part): part is string => part !== null);
  return parts.join(' ');
}
