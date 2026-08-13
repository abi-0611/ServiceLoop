import type { ShopConfig } from '@serviceloop/config';
import type { ShopConfigStore, StoredShopConfig } from '@serviceloop/domain';
import { eq } from 'drizzle-orm';
import type { Tx } from '../client';
import { shopConfig, shops } from '../schema';

/**
 * Postgres implementation of the shop-config port. Reads are raw — the domain
 * migrates and validates the document — and writes always go through
 * `GuardrailService.validateAndPatch`, never directly.
 */
export class PgShopConfigStore implements ShopConfigStore<Tx> {
  async load(tx: Tx, shopId: string): Promise<StoredShopConfig | null> {
    const [row] = await tx
      .select({ config: shopConfig.config, configVersion: shopConfig.configVersion })
      .from(shopConfig)
      .where(eq(shopConfig.shopId, shopId))
      .limit(1);

    if (row === undefined) return null;
    return { raw: row.config, configVersion: row.configVersion };
  }

  async save(tx: Tx, shopId: string, config: ShopConfig, actorId: string | null): Promise<void> {
    await tx
      .insert(shopConfig)
      .values({
        shopId,
        configVersion: config.configVersion,
        config: config as unknown as Record<string, unknown>,
        updatedById: actorId,
      })
      .onConflictDoUpdate({
        target: shopConfig.shopId,
        set: {
          configVersion: config.configVersion,
          config: config as unknown as Record<string, unknown>,
          updatedById: actorId,
          updatedAt: new Date(),
        },
      });
  }

  async loadShopTimezone(tx: Tx, shopId: string): Promise<string | null> {
    const [row] = await tx
      .select({ timezone: shops.timezone })
      .from(shops)
      .where(eq(shops.id, shopId))
      .limit(1);
    return row?.timezone ?? null;
  }
}
