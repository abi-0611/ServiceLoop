import {
  ConfigurationError,
  deepMerge,
  isPlainObject,
  type EscalationRungType,
  type PlainObject,
} from '@serviceloop/shared';
import {
  SHOP_CONFIG_VERSION,
  ShopConfigSchema,
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
  /**
   * v1 → v2 (phase 2): adds `messaging`, `intake` and `consent`. Merging the
   * defaults *under* the stored document means a shop that has already tuned
   * its ladders keeps them, and picks up the new blocks at their conservative
   * settings: no staff group, no templates, implied consent off.
   */
  1: (document, timezone) => ({
    ...deepMerge(defaultShopConfig(timezone) as unknown as PlainObject, document),
    configVersion: 2,
  }),
  /**
   * v2 → v3 (phase 3): adds the `agent` block and re-expresses every ladder
   * rung's `channel` as a `type`.
   *
   * The rung rewrite runs *before* the defaults are merged in, because a
   * deep-merge cannot fix a rung: a stored `{afterMinutes, channel, label}`
   * object would keep its `channel` key and gain no `type`, and the schema
   * would reject the whole document — silently dropping a shop's tuned
   * cadence back to defaults, which is exactly the kind of quiet guardrail
   * change §6 forbids. `VOICE` becomes `VOICE_OR_ADVISOR`, which is what that
   * rung has always meant in a build with no telephony adapter.
   */
  2: (document, timezone) => ({
    ...deepMerge(
      defaultShopConfig(timezone) as unknown as PlainObject,
      withRungTypes(document),
    ),
    configVersion: 3,
  }),
  /**
   * v3 → v4 (phase 4): adds `workingHours`, `eta`, `statusComms`, `delivery`
   * and `invoice`, and widens `payments`.
   *
   * A plain deep-merge does the whole job here — every new block is additive
   * and every new `payments` field has a conservative default, so a shop that
   * has tuned nothing gains sensible hours and no invoice identity, and a shop
   * that set `paymentBeforeDelivery: false` keeps it. The one thing worth
   * naming is what *isn't* inferred: `invoice.gstin` and `invoice.legalName`
   * stay null rather than being guessed from the shop record, because a tax
   * document is not somewhere to put a guess.
   */
  3: (document, timezone) => ({
    ...deepMerge(defaultShopConfig(timezone) as unknown as PlainObject, document),
    configVersion: 4,
  }),
};

const RUNG_TYPE_BY_LEGACY_CHANNEL: Readonly<Record<string, EscalationRungType>> = {
  WHATSAPP: 'WHATSAPP',
  SMS: 'SMS',
  VOICE: 'VOICE_OR_ADVISOR',
  HUMAN: 'HUMAN',
};

/** Rewrites `ladders.*.rungs[].channel` into `type`, leaving everything else. */
function withRungTypes(document: PlainObject): PlainObject {
  const ladders = document['ladders'];
  if (!isPlainObject(ladders)) return document;

  const migrated: PlainObject = {};
  for (const [objective, ladder] of Object.entries(ladders)) {
    if (!isPlainObject(ladder) || !Array.isArray(ladder['rungs'])) {
      migrated[objective] = ladder;
      continue;
    }
    migrated[objective] = {
      ...ladder,
      rungs: ladder['rungs'].map((rung) => {
        if (!isPlainObject(rung)) return rung;
        const { channel, ...rest } = rung;
        if (typeof rest['type'] === 'string') return rest;
        const legacy = typeof channel === 'string' ? RUNG_TYPE_BY_LEGACY_CHANNEL[channel] : undefined;
        return { ...rest, type: legacy ?? 'HUMAN' };
      }),
    };
  }

  return { ...document, ladders: migrated };
}

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
    config: ShopConfigSchema.parse(document),
    migratedFrom: storedVersion === SHOP_CONFIG_VERSION ? null : storedVersion,
  };
}
