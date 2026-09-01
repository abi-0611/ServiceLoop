import { assertFetchableUrl } from '@serviceloop/shared';
import { smsSegments, SmsSendError, type SmsPort, type SmsReceipt, type SmsRequest } from './port';

/**
 * A TRAI-DLT-compliant SMS adapter.
 *
 * Written against the shape every Indian aggregator has converged on — a JSON
 * POST carrying `entity_id`, `template_id`, `sender`/`header`, the destination
 * and the body — because they are all reselling the same operator gateways and
 * the DLT fields are mandated rather than invented. The *envelope* differs per
 * provider; that difference is a base URL and a header, both configuration.
 *
 * Read the current provider docs before pointing this at a live account: the
 * field names below are the common denominator, not a contract. What is not
 * negotiable, and what this adapter refuses to send without, is the entity id,
 * the registered header and the registered template id — those three are the
 * operator's own match criteria, and a message missing any of them is not
 * rejected with an error, it is *accepted and dropped*, which is far worse.
 */

export interface DltSmsConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Principal entity id from the DLT registry. */
  readonly entityId: string;
  /** Registered header, e.g. `SLOOPS`. */
  readonly senderId: string;
  readonly timeoutMs: number;
}

interface ProviderResponse {
  readonly message_id?: string;
  readonly id?: string;
  readonly status?: string;
  readonly error?: string;
  readonly price_paise?: number;
}

export class DltSmsAdapter implements SmsPort {
  readonly driver = 'dlt' as const;

  constructor(
    private readonly config: DltSmsConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(request: SmsRequest): Promise<SmsReceipt> {
    if (request.dltTemplateId.trim() === '') {
      throw new SmsSendError(
        'Refusing to send: no DLT template id. The operator would accept this and drop it.',
        'DLT_TEMPLATE_MISSING',
        false,
      );
    }

    // The base URL comes from configuration a person typed. The SSRF guard is
    // cheap here and closes the "point the SMS gateway at the metadata server"
    // hole that an owner-editable field would otherwise open.
    const url = assertFetchableUrl(`${this.config.baseUrl.replace(/\/$/, '')}/v1/sms/send`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          entity_id: this.config.entityId,
          template_id: request.dltTemplateId,
          sender: request.senderId ?? this.config.senderId,
          to: request.to,
          message: request.body,
          // Operators route Unicode differently; declaring it wrong is how a
          // Tamil message arrives as a screen of question marks.
          unicode: request.language !== 'en',
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // A timeout or a connection reset is retryable; the ladder's next rung is
      // not the right answer to a slow gateway.
      throw new SmsSendError(
        `SMS gateway unreachable: ${error instanceof Error ? error.message : String(error)}`,
        'SMS_GATEWAY_UNREACHABLE',
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let body: ProviderResponse = {};
    try {
      body = JSON.parse(text) as ProviderResponse;
    } catch {
      // Some gateways answer 200 with a bare message id. Tolerated, because
      // failing a delivered message is worse than parsing loosely.
      body = { message_id: text.trim() };
    }

    if (!response.ok) {
      throw new SmsSendError(
        `SMS gateway refused the message: ${body.error ?? response.statusText}`,
        `SMS_HTTP_${response.status}`,
        response.status >= 500 || response.status === 429,
      );
    }

    const providerMessageId = body.message_id ?? body.id;
    if (providerMessageId === undefined || providerMessageId === '') {
      throw new SmsSendError(
        'SMS gateway returned 200 with no message id; delivery cannot be tracked',
        'SMS_NO_MESSAGE_ID',
        false,
      );
    }

    return {
      providerMessageId,
      acceptedAt: new Date(),
      segments: smsSegments(request.body),
      costPaise: body.price_paise ?? 0,
      adapter: 'DltSmsAdapter',
    };
  }
}
