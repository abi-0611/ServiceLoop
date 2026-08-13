import type { Language, StaffRole } from '@serviceloop/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Database, Executor } from '../client';
import { blindIndex } from '../crypto/pii';
import { shops, staff } from '../schema';

/**
 * Staff identity lookups for authentication.
 *
 * Phones are encrypted, so login resolves through the per-shop blind index. One
 * person may hold roles in several shops (a multi-shop owner), which is why
 * lookup returns memberships rather than a single row — the console's shop
 * switcher is built on this.
 */

export interface StaffMembership {
  readonly staffId: string;
  readonly shopId: string;
  readonly shopName: string;
  readonly shopCity: string;
  readonly role: StaffRole;
  readonly fullName: string;
  readonly preferredLanguage: Language;
}

export class StaffRepository {
  constructor(private readonly db: Database) {}

  /**
   * Finds every active membership whose phone matches, across all shops. The
   * blind index is shop-scoped, so this checks each shop's index in turn — a
   * cheap scan given the number of shops one person belongs to, and it keeps
   * one shop's index from being usable to probe another.
   */
  async findMembershipsByPhone(
    phoneE164: string,
    executor: Executor = this.db,
  ): Promise<StaffMembership[]> {
    const shopRows = await executor
      .select({ id: shops.id, name: shops.name, city: shops.city })
      .from(shops)
      .where(and(eq(shops.isActive, true), isNull(shops.deletedAt)));

    const memberships: StaffMembership[] = [];

    for (const shop of shopRows) {
      const hash = blindIndex(shop.id, phoneE164);
      const rows = await executor
        .select({
          id: staff.id,
          role: staff.role,
          fullName: staff.fullName,
          preferredLanguage: staff.preferredLanguage,
        })
        .from(staff)
        .where(
          and(
            eq(staff.shopId, shop.id),
            eq(staff.phoneHash, hash),
            eq(staff.isActive, true),
            isNull(staff.deletedAt),
          ),
        )
        .limit(1);

      const row = rows[0];
      if (row !== undefined) {
        memberships.push({
          staffId: row.id,
          shopId: shop.id,
          shopName: shop.name,
          shopCity: shop.city,
          role: row.role,
          fullName: row.fullName,
          preferredLanguage: row.preferredLanguage,
        });
      }
    }

    return memberships;
  }

  /**
   * Every membership held by the person who owns `staffId`.
   *
   * The cross-shop link is the phone number itself — blind indexes are
   * shop-scoped and cannot be compared across shops — so this decrypts the
   * staff row's phone and re-resolves from there. Internal use only: it is
   * deliberately not shop-scoped, and is reached only through an already
   * authenticated session.
   */
  async findMembershipsByStaffId(
    staffId: string,
    executor: Executor = this.db,
  ): Promise<StaffMembership[]> {
    const rows = await executor
      .select({ phone: staff.phoneEncrypted })
      .from(staff)
      .where(and(eq(staff.id, staffId), isNull(staff.deletedAt)))
      .limit(1);

    const phone = rows[0]?.phone;
    if (phone === undefined) return [];
    return this.findMembershipsByPhone(phone, executor);
  }

  async findById(
    shopId: string,
    staffId: string,
    executor: Executor = this.db,
  ): Promise<StaffMembership | null> {
    const rows = await executor
      .select({
        id: staff.id,
        role: staff.role,
        fullName: staff.fullName,
        preferredLanguage: staff.preferredLanguage,
        shopId: shops.id,
        shopName: shops.name,
        shopCity: shops.city,
      })
      .from(staff)
      .innerJoin(shops, eq(shops.id, staff.shopId))
      .where(and(eq(staff.id, staffId), eq(staff.shopId, shopId), isNull(staff.deletedAt)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return null;
    return {
      staffId: row.id,
      shopId: row.shopId,
      shopName: row.shopName,
      shopCity: row.shopCity,
      role: row.role,
      fullName: row.fullName,
      preferredLanguage: row.preferredLanguage,
    };
  }
}
