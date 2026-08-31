import { createHash } from 'node:crypto';
import type { ConversationCategory } from '@serviceloop/shared';
import { mapMetaError, WhatsAppError, type MetaErrorBody } from './errors';
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
  MarkReadInput,
  SendInteractiveInput,
  SendMediaInput,
  SendResult,
  SendTemplateInput,
  SendTextInput,
  SubscriptionChallenge,
  WebhookDelivery,
} from './types';
import { normaliseMetaWebhook, verifySignature, verifySubscriptionChallenge } from './webhook';

/**
 * MetaCloudWhatsAppAdapter — the real WhatsApp Cloud API.
 *
 * Verified against the Cloud API reference (graph.facebook.com, `POST
 * /{version}/{phone-number-id}/messages`, media resolved through `GET
 * /{version}/{media-id}` then fetched from the returned short-lived URL with a
 * bearer token). Every outbound call passes the per-shop rate limiter first and
 * records the provider message id and pricing category on the way out, which is
 * what phase 7's billing math reads.
 */

export interface MetaCloudConfig {
  readonly accessToken: string;
  readonly phoneNumberId: string;
  readonly businessAccountId: string;
  readonly appSecret: string;
  readonly verifyToken: string;
  readonly graphVersion: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

/** Injected so tests drive the adapter without a network. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface MetaCloudDependencies {
  readonly fetch?: FetchLike;
  readonly rateLimiter?: WhatsAppRateLimiter;
  readonly now?: () => Date;
}

interface SendEnvelope {
  readonly messaging_product: 'whatsapp';
  readonly recipient_type?: 'individual';
  readonly to: string;
  readonly type: string;
  readonly [key: string]: unknown;
}

const CATEGORY_BY_PRICING: Readonly<Record<string, ConversationCategory>> = {
  service: 'SERVICE',
  utility: 'UTILITY',
  marketing: 'MARKETING',
  authentication: 'AUTHENTICATION',
};

export class MetaCloudWhatsAppAdapter implements WhatsAppPort {
  readonly driver = 'meta-cloud' as const;

  private readonly fetch: FetchLike;
  private readonly rateLimiter: WhatsAppRateLimiter;
  private readonly now: () => Date;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: MetaCloudConfig,
    dependencies: MetaCloudDependencies = {},
  ) {
    this.fetch = dependencies.fetch ?? ((input, init) => fetch(input, init));
    this.rateLimiter = dependencies.rateLimiter ?? new WhatsAppRateLimiter();
    this.now = dependencies.now ?? (() => new Date());
    this.baseUrl = (config.baseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  /* ---------------------------------------------------------------- sends -- */

  async sendSessionMessage(input: SendTextInput): Promise<SendResult> {
    assertValidText(input);
    return this.send(input.shopId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toProviderAddress(input.to),
      type: 'text',
      text: { body: input.body, preview_url: input.previewUrl ?? false },
      ...(input.replyToWaMessageId === undefined
        ? {}
        : { context: { message_id: input.replyToWaMessageId } }),
    });
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    assertValidTemplate(input);

    const components: unknown[] = [];
    const header = input.variables.header ?? [];
    if (header.length > 0) {
      components.push({ type: 'header', parameters: header.map(textParameter) });
    }
    const body = input.variables.body ?? [];
    if (body.length > 0) {
      components.push({ type: 'body', parameters: body.map(textParameter) });
    }
    for (const [index, suffix] of (input.variables.buttonUrlSuffixes ?? []).entries()) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: String(index),
        parameters: [{ type: 'text', text: suffix }],
      });
    }

    return this.send(input.shopId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toProviderAddress(input.to),
      type: 'template',
      template: {
        name: input.template.name,
        language: { code: input.template.language },
        ...(components.length === 0 ? {} : { components }),
      },
    });
  }

  async sendInteractive(input: SendInteractiveInput): Promise<SendResult> {
    assertValidInteractive(input);

    const action =
      input.payload.kind === 'buttons'
        ? {
            buttons: input.payload.buttons.map((button) => ({
              type: 'reply',
              reply: { id: button.id, title: button.title },
            })),
          }
        : {
            button: input.payload.buttonLabel,
            sections: input.payload.sections.map((section) => ({
              title: section.title,
              rows: section.rows.map((row) => ({
                id: row.id,
                title: row.title,
                ...(row.description === undefined ? {} : { description: row.description }),
              })),
            })),
          };

    return this.send(input.shopId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toProviderAddress(input.to),
      type: 'interactive',
      interactive: {
        type: input.payload.kind === 'buttons' ? 'button' : 'list',
        ...(input.header === undefined ? {} : { header: { type: 'text', text: input.header } }),
        body: { text: input.body },
        ...(input.footer === undefined ? {} : { footer: { text: input.footer } }),
        action,
      },
    });
  }

  async sendMedia(input: SendMediaInput): Promise<SendResult> {
    assertValidMedia(input);

    const providerMediaId =
      input.media.providerMediaId ??
      (await this.uploadMedia(input.shopId, input.media.bytes as Buffer, input.media.contentType));

    const slot = MEDIA_SLOT_BY_KIND[input.media.kind];
    return this.send(input.shopId, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toProviderAddress(input.to),
      type: slot,
      [slot]: {
        id: providerMediaId,
        ...(input.caption === undefined || slot === 'audio' ? {} : { caption: input.caption }),
        ...(input.media.filename === undefined || slot !== 'document'
          ? {}
          : { filename: input.media.filename }),
      },
    });
  }

  /**
   * Read receipts are courtesy, not correctness: a failure here must never
   * abort the handling of the message that triggered it.
   */
  async markRead(input: MarkReadInput): Promise<void> {
    await this.request(`/${this.config.phoneNumberId}/messages`, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: input.waMessageId,
      },
    }).catch(() => undefined);
  }

  /* ---------------------------------------------------------------- media -- */

  async downloadMedia(_shopId: string, ref: InboundMediaRef): Promise<DownloadedMedia> {
    // Two hops by design: the id resolves to a URL that lives ~5 minutes, and
    // the URL itself still requires the bearer token.
    const handle = await this.request<{ url?: string; mime_type?: string; sha256?: string }>(
      `/${ref.providerMediaId}?phone_number_id=${encodeURIComponent(this.config.phoneNumberId)}`,
      { method: 'GET' },
    );

    if (typeof handle.url !== 'string') {
      throw new WhatsAppError('MEDIA_ERROR', 'Media handle response carried no download URL', {
        context: { providerMediaId: ref.providerMediaId },
      });
    }

    const response = await this.rawFetch(handle.url, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.config.accessToken}` },
    });

    if (!response.ok) {
      throw new WhatsAppError(
        'MEDIA_ERROR',
        `Media download failed with HTTP ${response.status}`,
        { httpStatus: response.status, context: { providerMediaId: ref.providerMediaId } },
      );
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType =
      handle.mime_type ?? response.headers.get('content-type') ?? ref.mimeType;

    // Meta publishes a sha256 for every asset; a mismatch means a corrupted or
    // substituted download, and evidence must not be corrupted evidence.
    const declared = ref.sha256 ?? handle.sha256 ?? null;
    if (declared !== null) {
      const actual = createHash('sha256').update(bytes).digest('base64');
      if (actual !== declared) {
        throw new WhatsAppError('MEDIA_ERROR', 'Downloaded media failed its sha256 check', {
          context: { providerMediaId: ref.providerMediaId },
        });
      }
    }

    return {
      bytes,
      contentType,
      sizeBytes: bytes.byteLength,
      sha256: declared,
      filename: ref.filename,
    };
  }

  private async uploadMedia(
    shopId: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<string> {
    await this.rateLimiter.acquire(shopId);

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', contentType);
    form.append('file', new Blob([new Uint8Array(bytes)], { type: contentType }), 'upload');

    const url = `${this.baseUrl}/${this.config.graphVersion}/${this.config.phoneNumberId}/media`;
    const response = await this.rawFetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.accessToken}` },
      body: form,
    });

    const payload = (await readJson(response)) as { id?: string; error?: MetaErrorBody };
    if (!response.ok || typeof payload.id !== 'string') {
      throw mapMetaError(response.status, payload.error, 'Media upload failed');
    }
    return payload.id;
  }

  /* -------------------------------------------------------------- inbound -- */

  // `async` so a bad signature rejects rather than throwing synchronously: a
  // method typed `Promise<…>` must never make a caller write both a try/catch
  // and a .catch to be safe.
  async receive(delivery: WebhookDelivery): Promise<InboundBatch> {
    if (!verifySignature(delivery.rawBody, delivery.signatureHeader, this.config.appSecret)) {
      // Raised *before* parsing: a forged body never reaches the normaliser.
      throw new WhatsAppError(
        'SIGNATURE_INVALID',
        'X-Hub-Signature-256 missing or does not match the app secret',
      );
    }
    return normaliseMetaWebhook(delivery.rawBody, delivery.receivedAt);
  }

  verifySubscription(challenge: SubscriptionChallenge): string {
    return verifySubscriptionChallenge(challenge, this.config.verifyToken);
  }

  /* ------------------------------------------------------------- internal -- */

  private async send(shopId: string, envelope: SendEnvelope): Promise<SendResult> {
    const decision = await this.rateLimiter.acquire(shopId);
    if (!decision.allowed) {
      throw new WhatsAppError(
        'RATE_LIMITED',
        'Local per-shop send budget exhausted; the message stays queued',
        { retryAfterMs: decision.retryAfterMs, context: { shopId } },
      );
    }

    const payload = await this.request<{
      messages?: Array<{ id?: string; message_status?: string }>;
      contacts?: Array<{ wa_id?: string }>;
      conversation?: { id?: string };
      pricing?: { category?: string };
    }>(`/${this.config.phoneNumberId}/messages`, { method: 'POST', body: envelope });

    const providerMessageId = payload.messages?.[0]?.id;
    if (typeof providerMessageId !== 'string') {
      throw new WhatsAppError(
        'PROVIDER_UNAVAILABLE',
        'WhatsApp accepted the request but returned no message id',
        { context: { type: envelope.type } },
      );
    }

    const category = payload.pricing?.category;
    return {
      providerMessageId,
      providerConversationId: payload.conversation?.id ?? null,
      category: category === undefined ? null : (CATEGORY_BY_PRICING[category] ?? null),
      acceptedAt: this.now(),
    };
  }

  private async request<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown },
  ): Promise<T> {
    const url = `${this.baseUrl}/${this.config.graphVersion}${path}`;
    const response = await this.rawFetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${this.config.accessToken}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const payload = (await readJson(response)) as T & { error?: MetaErrorBody };
    if (!response.ok) {
      throw mapMetaError(response.status, payload.error, `${init.method} ${path} failed`);
    }
    return payload;
  }

  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      // A transport failure is the provider being unreachable, which is
      // retryable — distinct from the provider telling us "no", which is not.
      throw new WhatsAppError(
        'PROVIDER_UNAVAILABLE',
        `WhatsApp request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
        { context: { cause: error instanceof Error ? error.name : 'unknown' } },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

const MEDIA_SLOT_BY_KIND = {
  PHOTO: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',
  DOCUMENT: 'document',
} as const;

function textParameter(value: string): { type: 'text'; text: string } {
  return { type: 'text', text: value };
}

/** WhatsApp wants bare digits for people and the raw id for groups. */
function toProviderAddress(to: string): string {
  return to.startsWith('group:') ? to.slice('group:'.length) : to.replace(/^\+/, '');
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text().catch(() => '');
  if (text.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}
