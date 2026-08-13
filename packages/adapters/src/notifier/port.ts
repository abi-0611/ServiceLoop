import type { Language } from '@serviceloop/shared';

/**
 * NotifierPort — out-of-band notifications that are not part of the customer
 * conversation: staff OTP codes today, TRAI-DLT SMS fallback later.
 *
 * Template ids for the DLT-registered SMS path are configuration, never
 * hardcoded (master §7), so they travel on the notification itself.
 */

export interface OtpNotification {
  readonly kind: 'STAFF_OTP';
  readonly to: string;
  readonly code: string;
  readonly ttlSeconds: number;
  readonly language: Language;
}

export interface TransactionalSmsNotification {
  readonly kind: 'TRANSACTIONAL_SMS';
  readonly to: string;
  readonly body: string;
  readonly language: Language;
  /** DLT-registered template id, supplied by shop config. */
  readonly dltTemplateId: string;
}

export type Notification = OtpNotification | TransactionalSmsNotification;

export interface DeliveryReceipt {
  readonly accepted: boolean;
  readonly providerMessageId: string;
  readonly deliveredAt: Date;
  readonly adapter: string;
}

export interface NotifierPort {
  deliver(notification: Notification): Promise<DeliveryReceipt>;
  readonly driver: 'log' | 'memory' | 'sms';
}
