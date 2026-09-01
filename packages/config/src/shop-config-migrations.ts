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
  /**
   * v4 → v5 (phase 5): adds the `voice` block.
   *
   * Purely additive, and every default in it is off — which is the whole point.
   * A shop that upgrades into a build with telephony must not discover it by
   * a customer being phoned. The owner turns voice on deliberately, in the
   * console, and that write is audited like every other guardrail change.
   */
  4: (document, timezone) => ({
    ...deepMerge(defaultShopConfig(timezone) as unknown as PlainObject, document),
    configVersion: 5,
  }),
  /**
   * v5 → v6 (phase 6): adds `retention`, `feedback`, `digest`, `alerts` and
   * `analytics`.
   *
   * Additive, and the split between what arrives on and what arrives off is the
   * whole content of this step. `retention` and `feedback` arrive **off**: both
   * put messages in front of customers, and a shop must not discover an upgrade
   * by one of its customers being re-pitched. `digest` and `alerts` arrive
   * **on**, because both write to the shop's own staff, about the shop's own
   * work — there is no customer to protect, and an owner who upgrades into a
   * build that can tell them their day went badly should be told.
   *
   * `feedback.reviewLink` stays null rather than being guessed from the shop
   * record, for the reason `invoice.gstin` does: a link that points at the wrong
   * business sends a customer's goodwill to somebody else.
   *
   * One thing a deep-merge would get wrong if it were left to chance, and does
   * not: `retention.horizonDaysByCategory` is a record, so `deepMerge` unions a
   * shop's own categories with the defaults rather than replacing either. A shop
   * that has never seen this block gets the defaults; a shop whose document
   * somehow carries one category keeps it *and* gains the rest, which is the
   * conservative direction — more categories means more items with a horizon,
   * and every one of them still has to pass the gate.
   */
  5: (document, timezone) => ({
    ...deepMerge(defaultShopConfig(timezone) as unknown as PlainObject, document),
    configVersion: 6,
  }),
  /**
   * v6 -> v7 (phase 7): adds `smsFallback` and `privacy`.
   *
   * Additive, and both new blocks default to the restrictive setting: SMS
   * fallback off, no shop-specific grievance contact, a three-day deletion
   * grace. A shop that upgrades into this version therefore gains no new way
   * to message anybody and no shortened deletion window - which is the only
   * acceptable direction for a migration to move a guardrail (master section 6).
   */
  6: (document, timezone) => ({
    ...deepMerge(defaultShopConfig(timezone) as unknown as PlainObject, document),
    configVersion: 7,
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
