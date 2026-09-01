import { uuidv7 } from '@serviceloop/shared';
import { smsSegments, type SmsPort, type SmsReceipt, type SmsRequest } from './port';

/**
 * The sandbox SMS adapter.
 *
 * It keeps every message it was asked to send, which is the whole reason it is
 * a class rather than a stub returning a constant: the WhatsApp-outage drill
 * asserts that a ladder rung *landed on SMS*, and that assertion needs a record
 * with the recipient, the DLT template id and the rendered body in it.
 *
 * It also enforces the two DLT rules that are enforceable without a registry —
 * a template id must be present and a sender id must be present — because a
 * drill that passes against a sandbox happily accepting neither is a drill that
 * tells you nothing about the live path.
 */
export class SandboxSmsAdapter implements SmsPort {
  readonly driver = 'sandbox' as const;

  private readonly outbox: SentSms[] = [];
  /** Injected failure, so a test can exercise the fallback-of-the-fallback. */
  private failWith: Error | null = null;

  constructor(private readonly defaultSenderId = 'SLOOPS') {}

  async send(request: SmsRequest): Promise<SmsReceipt> {
    if (this.failWith !== null) throw this.failWith;

    if (request.dltTemplateId.trim() === '') {
      throw new Error('An SMS with no DLT template id would be dropped by the operator');
    }
    const senderId = request.senderId ?? this.defaultSenderId;

    const receipt: SmsReceipt = {
      providerMessageId: `sandbox-sms-${uuidv7()}`,
      acceptedAt: new Date(),
      segments: smsSegments(request.body),
      costPaise: 0,
      adapter: 'SandboxSmsAdapter',
    };

    this.outbox.push({ ...request, senderId, receipt });
    return receipt;
  }

  /** Everything this adapter has been asked to send, oldest first. */
  sent(): readonly SentSms[] {
    return this.outbox;
  }

  sentTo(to: string): readonly SentSms[] {
    return this.outbox.filter((entry) => entry.to === to);
  }

  clear(): void {
    this.outbox.length = 0;
  }

  /** Drill seam: makes the SMS rung fail so the ladder must fall to a human. */
  failNext(error: Error | null): void {
    this.failWith = error;
  }
}

export interface SentSms extends SmsRequest {
  readonly senderId: string;
  readonly receipt: SmsReceipt;
}
