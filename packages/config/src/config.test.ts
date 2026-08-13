import { describe, expect, it } from 'vitest';
import { formatAdapterSelection, selectAdapters } from './adapter-selection';
import { DEV_JWT_SECRET, EnvValidationError, loadEnv } from './env';
import { migrateShopConfig } from './shop-config-migrations';
import { SHOP_CONFIG_VERSION, ShopConfigV1Schema, defaultShopConfig } from './shop-config';

describe('env', () => {
  it('defaults to DEMO_MODE and a frozen document', () => {
    const env = loadEnv({});
    expect(env.DEMO_MODE).toBe(true);
    expect(env.NODE_ENV).toBe('development');
    expect(Object.isFrozen(env)).toBe(true);
    expect(() => {
      (env as { NODE_ENV: string }).NODE_ENV = 'production';
    }).toThrow();
  });

  it('parses boolean-ish and numeric strings', () => {
    const env = loadEnv({ DEMO_MODE: 'false', API_PORT: '4000', OUTBOX_BATCH_SIZE: '50' });
    expect(env.DEMO_MODE).toBe(false);
    expect(env.API_PORT).toBe(4000);
    expect(env.OUTBOX_BATCH_SIZE).toBe(50);
  });

  it('fails boot with a readable, field-scoped error', () => {
    let thrown: unknown;
    try {
      loadEnv({ DEMO_MODE: 'sometimes', API_PORT: '99999' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(EnvValidationError);
    const message = (thrown as EnvValidationError).message;
    expect(message).toContain('Invalid environment configuration');
    expect(message).toContain('DEMO_MODE');
    expect(message).toContain('API_PORT');
  });

  it('refuses development placeholders in production', () => {
    expect(() =>
      loadEnv({ NODE_ENV: 'production', DEMO_MODE: 'false', JWT_SECRET: DEV_JWT_SECRET }),
    ).toThrow(/JWT_SECRET still holds the development placeholder/);
    expect(() => loadEnv({ NODE_ENV: 'production', DEMO_MODE: 'true' })).toThrow(
      /DEMO_MODE must be false in production/,
    );
  });

  it('rejects a PII key of the wrong length', () => {
    expect(() => loadEnv({ PII_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow(
      /32-byte key/,
    );
  });
});

describe('adapter selection', () => {
  it('reports a sandbox adapter for every implemented port in DEMO_MODE', () => {
    const selections = selectAdapters(loadEnv({}));
    const storage = selections.find((entry) => entry.port === 'storage');
    expect(storage?.sandbox).toBe(true);
    expect(storage?.implemented).toBe(true);
    expect(formatAdapterSelection(loadEnv({})).join('\n')).toContain('adapter[storage] SANDBOX');
  });

  it('marks unimplemented ports as pending rather than claiming they are live', () => {
    const lines = formatAdapterSelection(loadEnv({}));
    expect(lines.some((line) => line.includes('adapter[whatsapp] PENDING'))).toBe(true);
  });
});

describe('shop config', () => {
  it('defaults every flow to L0 shadow and forbids discounts', () => {
    const config = defaultShopConfig();
    expect(Object.values(config.autonomy).every((level) => level === 'L0_SHADOW')).toBe(true);
    expect(config.pricing.priceFloorPercent).toBe(100);
    expect(config.pricing.discountCeilingPercent).toBe(0);
    expect(config.quietHours.timezone).toBe('Asia/Kolkata');
    expect(config.configVersion).toBe(SHOP_CONFIG_VERSION);
  });

  it('ends every escalation ladder in a human rung or a bounded reminder set', () => {
    const config = defaultShopConfig();
    for (const [objective, ladder] of Object.entries(config.ladders)) {
      expect(ladder.rungs.length, objective).toBeGreaterThan(0);
      const minutes = ladder.rungs.map((rung) => rung.afterMinutes);
      expect(
        [...minutes].sort((a, b) => a - b),
        objective,
      ).toEqual(minutes);
      expect(ladder.giveUpAfterMinutes, objective).toBeGreaterThanOrEqual(
        minutes[minutes.length - 1] ?? 0,
      );
    }
  });

  it('rejects a price floor and discount ceiling that together exceed 100%', () => {
    const config = defaultShopConfig();
    const result = ShopConfigV1Schema.safeParse({
      ...config,
      pricing: { priceFloorPercent: 90, discountCeilingPercent: 20 },
    });
    expect(result.success).toBe(false);
  });

  it('cannot be patched to remove the AI disclosure requirement', () => {
    const config = defaultShopConfig();
    const result = ShopConfigV1Schema.safeParse({
      ...config,
      disclosure: { ...config.disclosure, requireFirstContactDisclosure: false },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a default language that is not enabled', () => {
    const config = defaultShopConfig();
    const result = ShopConfigV1Schema.safeParse({
      ...config,
      languages: { enabled: ['en'], default: 'ta' },
    });
    expect(result.success).toBe(false);
  });
});

describe('shop config migration', () => {
  it('upgrades a legacy document by filling conservative defaults', () => {
    const outcome = migrateShopConfig({
      pricing: { priceFloorPercent: 95, discountCeilingPercent: 5 },
    });
    expect(outcome.migratedFrom).toBe(0);
    expect(outcome.config.configVersion).toBe(SHOP_CONFIG_VERSION);
    expect(outcome.config.pricing.priceFloorPercent).toBe(95);
    expect(outcome.config.autonomy.approval).toBe('L0_SHADOW');
  });

  it('is a no-op for a current document', () => {
    const outcome = migrateShopConfig(defaultShopConfig());
    expect(outcome.migratedFrom).toBeNull();
  });

  it('refuses to downgrade a document written by a newer release', () => {
    expect(() => migrateShopConfig({ configVersion: SHOP_CONFIG_VERSION + 1 })).toThrow(
      /newer release/,
    );
  });
});
