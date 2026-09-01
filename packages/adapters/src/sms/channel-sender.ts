import type {
  ChannelSender,
  ChannelSendRequest,
  ChannelSendResult,
} from '@serviceloop/domain';
import { templateByKey, type ChannelType } from '@serviceloop/shared';
import { SmsSendError, type SmsPort } from './port';

/**
 * The SMS half of the failover pair.
 *
 * It is a `ChannelSender` like the WhatsApp one, so `ChannelFailoverSender` can
 * hold both behind one interface and the gate can hold that. What it is *not*
 * is a general-purpose transport: it refuses everything except a message whose
 * composer supplied `fallback`, for the reason spelled out on
 * `SmsFallbackContent` — an Indian SMS carries registered content or it carries
 * nothing, and a rendering this class invented would be accepted by the gateway
 * and discarded by the operator.
 *
 * The refusal is loud (a thrown `SmsSendError`) rather than quiet (a receipt
 * for a message nobody will get), because the gate turns a throw into a FAILED
 * message row and the ladder turns that into an advisor task. A person ringing
 * the customer is the correct end state for a message that cannot be sent.
 */
export class SmsChannelSender implements ChannelSender {
  readonly channel: ChannelType = 'SMS';

  constructor(
    private readonly sms: SmsPort,
    /**
     * The shop's DLT registration. A function rather than a value because it is
     * read from shop config, which an owner can change without a restart — and
     * because the failover sender is constructed once at boot, long before any
     * particular shop is in scope.
     */
    private readonly settings: (shopId: string) => Promise<SmsShopSettings | null>,
  ) {}

  async send(request: ChannelSendRequest): Promise<ChannelSendResult> {
    const fallback = request.fallback;
    if (fallback === undefined) {
      throw new SmsSendError(
        `This message has no SMS fallback (${request.content.kind}); there is no registered DLT template it could be sent under`,
        'SMS_NO_FALLBACK_CONTENT',
        false,
      );
    }

    // The staff evidence group is a WhatsApp group id, not a handset.
    if (request.to.startsWith('group:')) {
      throw new SmsSendError(
        'The staff evidence group exists only on WhatsApp; there is no SMS equivalent to fall back to',
        'SMS_NO_GROUP_CHANNEL',
        false,
      );
    }

    const settings = await this.settings(request.shopId);
    if (settings === null || !settings.enabled) {
      throw new SmsSendError(
        'This shop has not enabled the SMS fallback rung',
        'SMS_FALLBACK_DISABLED',
        false,
      );
    }

    const spec = templateByKey(fallback.templateKey);
    if (spec === undefined) {
      throw new SmsSendError(
        `"${fallback.templateKey}" is not a template in the manifest`,
        'SMS_UNKNOWN_TEMPLATE',
        false,
      );
    }

    const dltTemplateId = settings.dltTemplateIds[fallback.templateKey];
    if (dltTemplateId === undefined || dltTemplateId.trim() === '') {
      throw new SmsSendError(
        `No DLT template id registered for "${fallback.templateKey}"; the operator would drop this message`,
        'SMS_TEMPLATE_NOT_REGISTERED',
        false,
      );
    }

    const receipt = await this.sms.send({
      shopId: request.shopId,
      to: request.to,
      dltTemplateId,
      body: fallback.body,
      language: fallback.language,
      ...(settings.senderId === null ? {} : { senderId: settings.senderId }),
    });

    return {
      providerMessageId: receipt.providerMessageId,
      providerConversationId: null,
      // SMS has no WhatsApp conversation pricing category. Null rather than a
      // guess: the cost meter reads the SMS receipt for this channel, and a
      // fabricated UTILITY here would double-count the message in the WhatsApp
      // conversation rollup.
      category: null,
      channel: 'SMS',
    };
  }
}

export interface SmsShopSettings {
  readonly enabled: boolean;
  readonly senderId: string | null;
  readonly dltTemplateIds: Readonly<Record<string, string>>;
}
