import { describe, expect, it } from 'vitest';
import { formatAdapterSelection, selectAdapters } from './adapter-selection';
import { DEV_JWT_SECRET, EnvValidationError, loadEnv } from './env';
import { migrateShopConfig } from './shop-config-migrations';
import { SHOP_CONFIG_VERSION, ShopConfigSchema, defaultShopConfig } from './shop-config';

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
    // Telephony is phase 5's. It is the only port left with no implementation,
    // and the boot log must never claim a capability that does not exist.
    expect(lines.some((line) => line.includes('adapter[telephony] PENDING'))).toBe(true);
    expect(lines.some((line) => line.includes('PENDING')) && lines.filter((line) => line.includes('PENDING')).length).toBe(1);
  });

  it('reports every implemented port as a live sandbox adapter in DEMO_MODE', () => {
    const lines = formatAdapterSelection(loadEnv({}));
    // `payments` joined this list in phase 4.9: the mock adapter is a real
    // adapter — it mints links, keeps a ledger and signs webhook payloads — so
    // reporting it as PENDING would now understate what the process can do.
    for (const port of ['whatsapp', 'llm', 'ocr', 'speech', 'payments']) {
      expect(lines.some((line) => line.includes(`adapter[${port}] SANDBOX`)), port).toBe(true);
    }
  });

  it('ties the OCR adapter to whichever LLM adapter is live', () => {
    // OCR has no provider of its own — it is a vision model behind LlmPort —
    // so the boot log must never claim a live reader while the LLM is sandboxed.
    const sandboxed = selectAdapters(loadEnv({})).find((entry) => entry.port === 'ocr');
    expect(sandboxed?.adapter).toBe('FixtureOcrAdapter');
    expect(sandboxed?.sandbox).toBe(true);

    const live = selectAdapters(
      loadEnv({
        DEMO_MODE: 'false',
        LLM_DRIVER: 'anthropic',
        ANTHROPIC_API_KEY: 'sk-test',
        WHATSAPP_DRIVER: 'meta',
        WHATSAPP_ACCESS_TOKEN: 'token',
        WHATSAPP_PHONE_NUMBER_ID: '123',
        WHATSAPP_APP_SECRET: 'secret',
        WHATSAPP_VERIFY_TOKEN: 'verify',
      }),
    ).find((entry) => entry.port === 'ocr');
    expect(live?.sandbox).toBe(false);
    expect(live?.adapter).toContain('VisionLlmOcrAdapter');
  });

  it('refuses to boot with the live WhatsApp adapter but no credentials', () => {
    expect(() => loadEnv({ DEMO_MODE: 'false', WHATSAPP_DRIVER: 'meta' })).toThrow(
      /WHATSAPP_ACCESS_TOKEN is required/,
    );
  });

  it('keeps the sandbox WhatsApp adapter in DEMO_MODE even when credentials exist', () => {
    // A developer with a live token in their shell must not be able to message
    // a real customer by accident.
    const selections = selectAdapters(
      loadEnv({
        WHATSAPP_DRIVER: 'meta',
        WHATSAPP_ACCESS_TOKEN: 'token',
        WHATSAPP_PHONE_NUMBER_ID: '123',
        WHATSAPP_APP_SECRET: 'secret',
        WHATSAPP_VERIFY_TOKEN: 'verify',
      }),
    );
    const whatsapp = selections.find((entry) => entry.port === 'whatsapp');
    expect(whatsapp?.sandbox).toBe(true);
    expect(whatsapp?.adapter).toBe('SandboxWhatsAppAdapter');
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
    const result = ShopConfigSchema.safeParse({
      ...config,
      pricing: { priceFloorPercent: 90, discountCeilingPercent: 20 },
    });
    expect(result.success).toBe(false);
  });

  it('cannot be patched to remove the AI disclosure requirement', () => {
    const config = defaultShopConfig();
    const result = ShopConfigSchema.safeParse({
      ...config,
      disclosure: { ...config.disclosure, requireFirstContactDisclosure: false },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a default language that is not enabled', () => {
    const config = defaultShopConfig();
    const result = ShopConfigSchema.safeParse({
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
