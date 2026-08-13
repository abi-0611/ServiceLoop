import { uuidv7 } from '@serviceloop/shared';
import { customType, timestamp, uuid } from 'drizzle-orm/pg-core';
import { decryptPii, encryptPii } from '../crypto/pii';

/**
 * Shared column helpers.
 *
 * `encryptedText` is the DPDP-mandated PII column: the application encrypts on
 * the way in and decrypts on the way out, so a database dump, a replica, or a
 * backup never contains a readable customer name or phone number.
 */

export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text';
  },
  toDriver(value: string): string {
    return encryptPii(value);
  },
  fromDriver(value: string): string {
    return decryptPii(value);
  },
});

/** UUIDv7 primary key — time-ordered, generated in the application. */
export const primaryId = () => uuid('id').primaryKey().$defaultFn(uuidv7);

export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * Soft delete. Used only where DPDP erasure does not demand a hard delete;
 * `customers` and `media_assets` keep hard-delete paths instead (see the FK
 * notes in `core.ts`).
 */
export const deletedAt = () => timestamp('deleted_at', { withTimezone: true, mode: 'date' });

export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
