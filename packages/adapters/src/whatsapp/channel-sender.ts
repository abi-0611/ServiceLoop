import type {
  ChannelSender,
  ChannelSendRequest,
  ChannelSendResult,
  FetchedMedia,
  MediaFetchPort,
} from '@serviceloop/domain';
import type { ChannelType, WaTemplateCategory } from '@serviceloop/shared';
import type { WhatsAppPort } from './port';
import type { InteractivePayload, SendResult } from './types';

/**
 * The bridge from the domain's channel vocabulary to WhatsApp's.
 *
 * This file lives inside `packages/adapters/src/whatsapp` for a reason that is
 * not stylistic: `no-bypass.test.ts` allows the channel-send methods to be
 * called from exactly three places, and this directory is one of them. Putting
 * the translation here keeps the allowance list short enough that a reviewer
 * notices when it grows.
 *
 * Note what is *not* here: no consent check, no window check, no autonomy
 * check. Every one of those happened in `OutboundGate` before this object was
 * handed anything, and duplicating them here would create a second opinion —
 * which, the first time the two disagree, is how a message reaches someone who
 * asked not to be messaged.
 */
export class WhatsAppChannelSender implements ChannelSender {
  readonly channel: ChannelType = 'WHATSAPP';

  constructor(private readonly whatsapp: WhatsAppPort) {}

  async send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    const result = await this.dispatch(request);
    return {
      providerMessageId: result.providerMessageId,
      providerConversationId: result.providerConversationId,
      category: result.category,
    };
  }

  private async dispatch(request: ChannelSendRequest): Promise<SendResult> {
    const { shopId, to, content } = request;

    switch (content.kind) {
      case 'text':
        return this.whatsapp.sendSessionMessage({ shopId, to, body: content.body });

      case 'template':
        return this.whatsapp.sendTemplate({
          shopId,
          to,
          template: {
            name: content.templateName,
            language: content.templateLanguage,
            category: templateCategory(content.category),
          },
          variables: { body: [...content.variables] },
        });

      case 'interactive':
        return this.whatsapp.sendInteractive({
          shopId,
          to,
          body: content.body,
          ...(content.header === undefined ? {} : { header: content.header }),
          ...(content.footer === undefined ? {} : { footer: content.footer }),
          payload: interactivePayload(content),
        });

      case 'media':
        return this.whatsapp.sendMedia({
          shopId,
          to,
          media: {
            bytes: content.bytes,
            contentType: content.contentType,
            kind: content.mediaKind,
          },
          ...(content.caption === undefined ? {} : { caption: content.caption }),
        });
    }
  }
}

/**
 * A conversation *pricing* category and a template *registration* category are
 * different taxonomies that happen to share three of their names. SERVICE is
 * the one that only exists on the pricing side: a template can never be
 * registered as SERVICE, and the nearest true statement about a service-purpose
 * template is that it is UTILITY.
 */
function templateCategory(category: string): WaTemplateCategory {
  switch (category) {
    case 'MARKETING':
      return 'MARKETING';
    case 'AUTHENTICATION':
      return 'AUTHENTICATION';
    default:
      return 'UTILITY';
  }
}

function interactivePayload(content: {
  readonly buttons?: readonly { readonly id: string; readonly title: string }[];
  readonly listButtonLabel?: string;
  readonly sections?: readonly {
    readonly title: string;
    readonly rows: readonly {
      readonly id: string;
      readonly title: string;
      readonly description?: string;
    }[];
  }[];
}): InteractivePayload {
  const sections = content.sections ?? [];
  if (sections.length > 0) {
    return {
      kind: 'list',
      buttonLabel: content.listButtonLabel ?? 'Choose',
      sections: sections.map((section) => ({
        title: section.title,
        rows: section.rows.map((row) => ({
          id: row.id,
          title: row.title,
          ...(row.description === undefined ? {} : { description: row.description }),
        })),
      })),
    };
  }

  return { kind: 'buttons', buttons: [...(content.buttons ?? [])] };
}

/**
 * Pulls the bytes behind an inbound media reference.
 *
 * Separate from the sender because they are separate capabilities: a channel
 * could deliver media inline and need no fetcher at all, which is exactly what
 * a future SMS/MMS or in-app channel will look like.
 */
export class WhatsAppMediaFetcher implements MediaFetchPort {
  constructor(private readonly whatsapp: WhatsAppPort) {}

  async download(
    shopId: string,
    ref: { readonly providerMediaId: string; readonly mimeType: string },
  ): Promise<FetchedMedia> {
    const downloaded = await this.whatsapp.downloadMedia(shopId, {
      providerMediaId: ref.providerMediaId,
      mimeType: ref.mimeType,
      sha256: null,
      fileSizeBytes: null,
      filename: null,
      isVoiceNote: false,
    });

    return {
      bytes: downloaded.bytes,
      contentType: downloaded.contentType,
      sizeBytes: downloaded.sizeBytes,
      filename: downloaded.filename,
    };
  }
}
