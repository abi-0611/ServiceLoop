import { relations } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  createdAt,
  deletedAt,
  encryptedText,
  primaryId,
  timestamptz,
  updatedAt,
} from './columns';
import { languageEnum, staffRoleEnum } from './enums';

/**
 * Tenancy and identity tables.
 *
 * ON DELETE policy (phase 1.3 — designed now, exercised by the DPDP workflows
 * in phase 7):
 *   shops      → everything CASCADE. Offboarding a shop removes its data, with
 *                the deliberate exception of `audit_events` (RESTRICT), which
 *                must be exported before a shop can be dropped.
 *   customers  → vehicles / conversations / consents / ledger CASCADE, because
 *                those rows exist only to serve that customer.
 *   customers  → job_cards RESTRICT. A job card is a financial record; a DPDP
 *                erasure request anonymises the customer row in place (the
 *                encrypted columns are overwritten and the blind index cleared)
 *                rather than destroying service history.
 */

export const shops = pgTable(
  'shops',
  {
    id: primaryId(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    city: text('city').notNull(),
    addressLine: text('address_line'),
    /** IANA zone; quiet hours and digests are computed in it. */
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    contactPhone: text('contact_phone'),
    gstNumber: text('gst_number'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [index('shops_active_idx').on(table.isActive)],
);

export const staff = pgTable(
  'staff',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    role: staffRoleEnum('role').notNull(),
    fullName: text('full_name').notNull(),
    /** Staff phones are PII too: encrypted at rest, searched via the blind index. */
    phoneEncrypted: encryptedText('phone_encrypted').notNull(),
    phoneHash: text('phone_hash').notNull(),
    email: text('email'),
    preferredLanguage: languageEnum('preferred_language').notNull().default('en'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('staff_shop_phone_hash_key').on(table.shopId, table.phoneHash),
    index('staff_phone_hash_idx').on(table.phoneHash),
    index('staff_shop_role_idx').on(table.shopId, table.role),
  ],
);

export const customers = pgTable(
  'customers',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    /** AES-256-GCM at rest. Never logged, never indexed directly. */
    fullNameEncrypted: encryptedText('full_name_encrypted').notNull(),
    phoneEncrypted: encryptedText('phone_encrypted').notNull(),
    /** HMAC blind index, scoped per shop — the only searchable form. */
    phoneHash: text('phone_hash').notNull(),
    preferredLanguage: languageEnum('preferred_language').notNull().default('en'),
    whatsappOptIn: boolean('whatsapp_opt_in').notNull().default(false),
    notes: text('notes'),
    /**
     * The one-way pseudonym this customer's surviving rows are keyed by after
     * an erasure (phase 7.2). Null until a deletion request is raised.
     */
    subjectPseudonym: text('subject_pseudonym'),
    /**
     * When the DPDP cascade destroyed this record's personal data.
     *
     * Distinct from `deletedAt`, which is an ordinary soft delete — an advisor
     * removing a duplicate — and is reversible. `erasedAt` is not: the encrypted
     * columns have been overwritten and there is nothing to restore. The row
     * survives only so foreign keys resolve and so the completion report has
     * something to point at.
     */
    erasedAt: timestamptz('erased_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('customers_shop_phone_hash_key').on(table.shopId, table.phoneHash),
    index('customers_shop_idx').on(table.shopId),
  ],
);

export const vehicles = pgTable(
  'vehicles',
  {
    id: primaryId(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** Exactly what was written on the paper card or typed by the customer. */
    registrationRaw: text('registration_raw').notNull(),
    /** Canonical uppercase, separator-free form — the natural key. */
    registrationNormalised: text('registration_normalised').notNull(),
    make: text('make'),
    model: text('model'),
    variant: text('variant'),
    modelYear: integer('model_year'),
    fuelType: text('fuel_type'),
    colour: text('colour'),
    odometerKm: integer('odometer_km'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (table) => [
    uniqueIndex('vehicles_shop_registration_key').on(table.shopId, table.registrationNormalised),
    index('vehicles_customer_idx').on(table.customerId),
  ],
);

export const shopsRelations = relations(shops, ({ many }) => ({
  staff: many(staff),
  customers: many(customers),
  vehicles: many(vehicles),
}));

export const staffRelations = relations(staff, ({ one }) => ({
  shop: one(shops, { fields: [staff.shopId], references: [shops.id] }),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  shop: one(shops, { fields: [customers.shopId], references: [shops.id] }),
  vehicles: many(vehicles),
}));

export const vehiclesRelations = relations(vehicles, ({ one }) => ({
  shop: one(shops, { fields: [vehicles.shopId], references: [shops.id] }),
  customer: one(customers, { fields: [vehicles.customerId], references: [customers.id] }),
}));
