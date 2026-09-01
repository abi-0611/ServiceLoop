import type { RetentionConfig, SeasonWindow } from '@serviceloop/config';
import { addDays, isWithinSeason, type DeclineReason } from '@serviceloop/shared';
import type { LedgerItem, OdometerReading, TriggerHit, TriggerRationale } from './types';

/**
 * The pure half of the declined-work ledger and its trigger engine
 * (phases 6.1 and 6.2).
 *
 * Everything here is a function of (config, item, clock) with no I/O, which is
 * what makes the phase's "fake-clock and seeded-scenario tests for each
 * trigger" possible: the service answers *may we*, and these functions answer
 * *is it due*. Keeping the two apart is also why the season trigger can be
 * tested on a December afternoon in a build whose wall clock says August.
 */

export const SEASON_TAG_PREFIX = 'season:';
export const ODOMETER_TAG_PREFIX = 'odometer:+';
export const NEXT_VISIT_TAG = 'next_visit';

/**
 * The follow-up horizon for a newly ledgered item.
 *
 * Precedence, and it matters:
 *
 *   1. **An explicit customer promise wins.** "Call me after Diwali" is worth
 *      more than a table, and a shop that re-pitches on day 75 to somebody who
 *      named a date has ignored them in order to follow a rule.
 *   2. **The shop's category rule.** The phase's own numbers — brake wear
 *      60–90 days, tyres 90 — live in shop config, not here.
 *   3. **The shop's default**, which ships as `null`.
 *
 * `null` is a real answer and not a failure: it means this item is never
 * re-pitched *on a timer*. It still exists, still surfaces on the customer's
 * next visit, and still counts in the denominator of the recovery rate. That is
 * the correct treatment of cosmetic work, which the phase names explicitly, and
 * the conservative treatment of anything a shop has not categorised.
 */
export function horizonFor(
  config: RetentionConfig,
  input: {
    readonly category: string | null;
    readonly declinedAt: Date;
    readonly customerPromisedAt?: Date | null;
  },
): Date | null {
  if (input.customerPromisedAt != null) return new Date(input.customerPromisedAt);

  const byCategory =
    input.category === null ? undefined : config.horizonDaysByCategory[input.category];
  const days = byCategory === undefined ? config.defaultHorizonDays : byCategory;
  return days === null ? null : addDays(input.declinedAt, days);
}

/**
 * The trigger tags a new ledger item carries.
 *
 * Derived from the shop's own season calendar rather than hardcoded, so a shop
 * in Punjab tagging underbody work for a winter window and a shop in Chennai
 * tagging wipers for the north-east monsoon use the same code path. An item is
 * tagged for a season if its *category* appears in that window's tag list —
 * which is why the config holds tags like `season:monsoon` and not category
 * names: one window may wake several categories, and one category may belong to
 * two windows.
 *
 * `next_visit` is on every item, always. It costs the customer nothing — the
 * vehicle is already in the workshop — and it is the cheapest conversion moment
 * the phase names.
 */
export function triggerTagsFor(
  config: RetentionConfig,
  input: { readonly category: string | null; readonly declineReason: DeclineReason },
): readonly string[] {
  const tags = new Set<string>([NEXT_VISIT_TAG]);

  const category = input.category;
  if (category !== null) {
    for (const season of config.seasons) {
      if (season.tags.includes(`${SEASON_TAG_PREFIX}${category}`) || season.tags.includes(category)) {
        tags.add(`${SEASON_TAG_PREFIX}${season.key}`);
      }
    }
    // A category named directly in a window's tags is the common case; the
    // shipped defaults spell it `season:monsoon` and match on the tag itself.
    for (const season of config.seasons) {
      if (SEASON_CATEGORY_HINTS[season.key]?.includes(category) === true) {
        tags.add(`${SEASON_TAG_PREFIX}${season.key}`);
      }
    }
  }

  if (config.odometerAskEnabled) {
    tags.add(`${ODOMETER_TAG_PREFIX}${config.odometerTriggerKm}`);
  }

  // A price objection is not woken by a season. The customer did not say "not
  // now", they said "not at that price", and re-pitching the identical quote
  // when the rains start is the shop failing to hear them. It keeps its
  // next-visit tag, where an advisor is standing in front of them and can talk
  // about the price like a person.
  if (input.declineReason === 'price') {
    for (const tag of [...tags]) {
      if (tag.startsWith(SEASON_TAG_PREFIX)) tags.delete(tag);
    }
  }

  return [...tags].sort();
}

/**
 * Which categories a shipped season window is about.
 *
 * A default, not a rule: a shop that edits `seasons[].tags` overrides it
 * entirely. It exists because the shipped config names windows (`monsoon`)
 * rather than enumerating every category an Indian workshop might call its
 * wiper work, and a shop that has never opened the retention settings should
 * still get a sensible monsoon trigger.
 */
const SEASON_CATEGORY_HINTS: Readonly<Record<string, readonly string[]>> = {
  monsoon: ['brakes', 'wipers', 'underbody', 'tyres'],
  monsoon_ne: ['brakes', 'wipers', 'underbody', 'tyres'],
};

export interface TriggerContext {
  readonly now: Date;
  readonly timezone: string;
  readonly config: RetentionConfig;
  /** Cards opened for this customer's vehicles right now — the next-visit hit. */
  readonly openVisitByVehicleId: ReadonlyMap<string, string>;
  /** Latest customer-volunteered reading per vehicle, and the ledger baseline. */
  readonly odometerNow: ReadonlyMap<string, OdometerReading>;
  readonly odometerAtDecline: ReadonlyMap<string, OdometerReading>;
}

/**
 * What is due for one ledger item, right now.
 *
 * Returns at most one hit per item, and the order of the checks is the order of
 * *cheapness to the customer*:
 *
 *   1. **next_visit** — the vehicle is in the workshop. Nothing is cheaper.
 *   2. **odometer** — the customer told us they have driven the distance the
 *      technician's finding was about. Nothing is better evidenced.
 *   3. **season** — the weather has made the finding relevant.
 *   4. **time_elapsed** — the horizon has simply arrived.
 *
 * An item that is due on two triggers is pitched once, on the better one. Two
 * messages about one brake pad is precisely what the twenty-one-day floor and
 * the two-pitch cap exist to prevent, and the cheapest way to honour them is to
 * not generate the second candidate in the first place.
 */
export function evaluateTriggers(item: LedgerItem, context: TriggerContext): TriggerHit | null {
  if (item.status !== 'OPEN' && item.status !== 'RE_PITCHED') return null;
  if (item.repitchCount >= context.config.maxRepitchesPerItem) return null;

  const { now, config } = context;

  if (config.nextVisitPromptEnabled && item.vehicleId !== null) {
    const jobCardId = context.openVisitByVehicleId.get(item.vehicleId);
    // The card the item was declined on is not a new visit; a card that is
    // still open from that same visit would otherwise re-pitch the customer
    // about work they declined this morning.
    if (jobCardId !== undefined && jobCardId !== item.jobCardId) {
      return {
        ledgerItemId: item.id,
        trigger: 'next_visit',
        rationale: { kind: 'next_visit', jobCardId },
        dueAt: now,
      };
    }
  }

  const odometerHit = odometerDelta(item, context);
  if (odometerHit !== null) {
    return {
      ledgerItemId: item.id,
      trigger: 'odometer',
      rationale: { kind: 'odometer', kmSince: odometerHit },
      dueAt: now,
    };
  }

  const season = seasonHit(item, config.seasons, now, context.timezone);
  if (season !== null) {
    // A season only wakes an item whose horizon is not still in the future by
    // more than the season itself. Pitching brake pads in the first week of the
    // monsoon when the technician said "look at this in six months" would be
    // using the weather as an excuse to shorten a promise.
    const horizonRespected =
      item.followUpAfter === null || item.followUpAfter.getTime() <= now.getTime();
    if (horizonRespected) {
      return {
        ledgerItemId: item.id,
        trigger: 'season',
        rationale: { kind: 'season', season },
        dueAt: now,
      };
    }
  }

  if (item.followUpAfter !== null && item.followUpAfter.getTime() <= now.getTime()) {
    const months = Math.max(
      1,
      Math.round((now.getTime() - item.createdAt.getTime()) / (30 * 24 * 60 * 60_000)),
    );
    return {
      ledgerItemId: item.id,
      trigger: 'time_elapsed',
      rationale: { kind: 'time_elapsed', months },
      dueAt: item.followUpAfter,
    };
  }

  return null;
}

/**
 * Kilometres driven since the item was ledgered, when that crosses the tagged
 * threshold — and only from readings the customer volunteered.
 *
 * The phase is explicit that the odometer trigger runs on customer-reported
 * numbers. So is this: a reading whose source is `INTAKE` (an advisor reading
 * the dashboard) or `CONSOLE` never reaches here, because the store's
 * `latest`/`asOf` are asked for volunteered readings and the tag itself only
 * exists when the shop has enabled the ask.
 */
function odometerDelta(item: LedgerItem, context: TriggerContext): number | null {
  if (item.vehicleId === null) return null;

  const tag = item.triggerTags.find((candidate) => candidate.startsWith(ODOMETER_TAG_PREFIX));
  if (tag === undefined) return null;

  const threshold = Number(tag.slice(ODOMETER_TAG_PREFIX.length));
  if (!Number.isFinite(threshold) || threshold <= 0) return null;

  const current = context.odometerNow.get(item.vehicleId);
  if (current === undefined || current.source !== 'CUSTOMER_VOLUNTEERED') return null;

  const baseline = context.odometerAtDecline.get(item.vehicleId);
  if (baseline === undefined) return null;

  const delta = current.odometerKm - baseline.odometerKm;
  return delta >= threshold ? delta : null;
}

function seasonHit(
  item: LedgerItem,
  seasons: readonly SeasonWindow[],
  now: Date,
  timezone: string,
): string | null {
  for (const season of seasons) {
    if (!item.triggerTags.includes(`${SEASON_TAG_PREFIX}${season.key}`)) continue;
    if (isWithinSeason(now, timezone, season)) return season.key;
  }
  return null;
}

/** The i18n key naming the rationale, so the composer never writes prose. */
export function rationaleKey(
  rationale: TriggerRationale,
):
  | 'retention.reason.season'
  | 'retention.reason.time_elapsed'
  | 'retention.reason.next_visit'
  | 'retention.reason.odometer'
  | 'retention.reason.manual' {
  switch (rationale.kind) {
    case 'season':
      return 'retention.reason.season';
    case 'time_elapsed':
      return 'retention.reason.time_elapsed';
    case 'next_visit':
      return 'retention.reason.next_visit';
    case 'odometer':
      return 'retention.reason.odometer';
    case 'manual':
      return 'retention.reason.manual';
  }
}

/**
 * SERVICE or MARKETING for one re-pitch (phase 6.3).
 *
 * The phase's rule verbatim: SERVICE when the item is tied to a safety-relevant
 * technician finding, MARKETING otherwise. "Safety-relevant" is decided by two
 * facts the ledger already holds — a technician wrote a note about it, and its
 * category is one the shop's own safety list names — rather than by a model
 * reading the note, because the consequence of getting it wrong is sending a
 * marketing message to somebody who only ever consented to service updates.
 *
 * When in doubt this returns MARKETING, which is the restrictive answer: the
 * gate then demands the explicit second grant, and an item that could have
 * ridden SERVICE consent simply waits for one.
 */
const SAFETY_CATEGORIES: ReadonlySet<string> = new Set([
  'brakes',
  'tyres',
  'suspension',
  'steering',
  'lights',
  'underbody',
]);

export function purposeFor(item: {
  readonly category: string | null;
  readonly technicianNote: string | null;
}): 'SERVICE' | 'MARKETING' {
  if (item.technicianNote === null || item.technicianNote.trim().length === 0) return 'MARKETING';
  if (item.category === null) return 'MARKETING';
  return SAFETY_CATEGORIES.has(item.category) ? 'SERVICE' : 'MARKETING';
}

/**
 * The dedupe key for one re-pitch of one item.
 *
 * `<ledgerItemId>:<n>` where `n` is the re-pitch this would be. A scan running
 * every ten minutes therefore produces one row for the first re-pitch and
 * collides with itself on every subsequent pass, which is what makes the cap
 * enforceable by an index rather than by a race.
 */
export function repitchDedupeKey(ledgerItemId: string, repitchNumber: number): string {
  return `repitch:${ledgerItemId}:${repitchNumber}`;
}
