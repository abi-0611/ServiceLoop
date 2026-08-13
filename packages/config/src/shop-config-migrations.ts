import {
  ConfigurationError,
  deepMerge,
  isPlainObject,
  type PlainObject,
} from '@serviceloop/shared';
import {
  SHOP_CONFIG_VERSION,
  ShopConfigV1Schema,
  defaultShopConfig,
  type ShopConfig,
} from './shop-config';

/**
 * In-code migrations for stored configuration documents (phase 1.6).
 *
 * A shop's config row can be older than the running build. Rather than
 * back-filling with SQL, the document is migrated forward on read, validated,
 * and — when the caller writes it back — persisted at the current version.
 *
 * Version 0 means "written before `configVersion` existed": such documents are
 * merged over the conservative defaults, so an absent field can only ever
 * become *more* restrictive, never less.
 */

type MigrationStep = (document: PlainObject, timezone: string) => PlainObject;

const MIGRATIONS: Readonly<Record<number, MigrationStep>> = {
  0: (document, timezone) => ({
    ...deepMerge(defaultShopConfig(timezone) as unknown as PlainObject, document),
    configVersion: 1,
  }),
};

export interface MigrationOutcome {
  readonly config: ShopConfig;
  /** Null when the stored document was already current. */
  readonly migratedFrom: number | null;
}

export function migrateShopConfig(raw: unknown, timezone = 'Asia/Kolkata'): MigrationOutcome {
  let document: PlainObject = isPlainObject(raw) ? { ...raw } : {};
  const storedVersion =
    typeof document['configVersion'] === 'number' ? document['configVersion'] : 0;

  if (storedVersion > SHOP_CONFIG_VERSION) {
    throw new ConfigurationError(
      `Shop config was written by a newer release (found v${storedVersion}, this build understands v${SHOP_CONFIG_VERSION}). Refusing to downgrade a guardrail document.`,
      { storedVersion, supportedVersion: SHOP_CONFIG_VERSION },
    );
  }

  let version = storedVersion;
  while (version < SHOP_CONFIG_VERSION) {
    const step = MIGRATIONS[version];
    if (step === undefined) {
      throw new ConfigurationError(`No migration registered from shop config v${version}`, {
        version,
      });
    }
    document = step(document, timezone);
    const next = document['configVersion'];
    version = typeof next === 'number' ? next : version + 1;
  }

  return {
    config: ShopConfigV1Schema.parse(document),
    migratedFrom: storedVersion === SHOP_CONFIG_VERSION ? null : storedVersion,
  };
}
