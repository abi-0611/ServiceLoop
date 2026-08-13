import { maskPhone, uuidv7 } from '@serviceloop/shared';
import type { DeliveryReceipt, Notification, NotifierPort } from './port';

/**
 * Sandbox notifiers.
 *
 * `LoggingNotifier` writes the OTP to the process log so a developer can sign
 * in without an SMS provider. The log *is* the delivery channel here, so the
 * code is printed in full — which is exactly why the env schema refuses this
 * driver in production. It writes through its own sink rather than the
 * application's pino logger, whose redaction policy would (correctly) censor
 * the code and leave the developer with nothing to type.
 *
 * The recipient number is still masked: it is customer/staff PII, not the
 * thing being delivered.
 *
 * `InMemoryNotifier` captures deliveries for assertions and for the console's
 * DEMO_MODE code display.
 */

export type LogSink = (line: string, fields: Record<string, unknown>) => void;

const defaultSink: LogSink = (line, fields) => {
  console.info(line, fields);
};

function describe(notification: Notification): Record<string, unknown> {
  switch (notification.kind) {
    case 'STAFF_OTP':
      return {
        kind: notification.kind,
        to: maskPhone(notification.to),
        code: notification.code,
        ttlSeconds: notification.ttlSeconds,
      };
    case 'TRANSACTIONAL_SMS':
      return {
        kind: notification.kind,
        to: maskPhone(notification.to),
        dltTemplateId: notification.dltTemplateId,
        bodyLength: notification.body.length,
      };
  }
}

export class LoggingNotifier implements NotifierPort {
  readonly driver = 'log' as const;

  constructor(private readonly sink: LogSink = defaultSink) {}

  async deliver(notification: Notification): Promise<DeliveryReceipt> {
    const providerMessageId = uuidv7();
    this.sink('[notifier:log] delivered', { ...describe(notification), providerMessageId });
    return {
      accepted: true,
      providerMessageId,
      deliveredAt: new Date(),
      adapter: 'LoggingNotifier',
    };
  }
}

export interface CapturedNotification {
  readonly notification: Notification;
  readonly receipt: DeliveryReceipt;
}

export class InMemoryNotifier implements NotifierPort {
  readonly driver = 'memory' as const;

  private readonly captured: CapturedNotification[] = [];

  async deliver(notification: Notification): Promise<DeliveryReceipt> {
    const receipt: DeliveryReceipt = {
      accepted: true,
      providerMessageId: uuidv7(),
      deliveredAt: new Date(),
      adapter: 'InMemoryNotifier',
    };
    this.captured.push({ notification, receipt });
    return receipt;
  }

  all(): readonly CapturedNotification[] {
    return this.captured;
  }

  lastTo(phone: string): CapturedNotification | null {
    for (let index = this.captured.length - 1; index >= 0; index -= 1) {
      const entry = this.captured[index];
      if (entry?.notification.to === phone) return entry;
    }
    return null;
  }

  clear(): void {
    this.captured.length = 0;
  }
}
