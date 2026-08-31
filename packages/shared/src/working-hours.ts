import { z } from 'zod';
import { HhMmSchema, MINUTES_PER_DAY, parseHhMm, zonedParts, type ZonedParts } from './time';

/**
 * Working-hours arithmetic in the shop's own wall clock (phase 4).
 *
 * Two phase-4 features need this and neither is honest without it. The ETA
 * engine must not promise a car at 02:00 because four hours of labour was
 * approved at 22:00; and the silent-bay nudge counts "three hours of silence"
 * in *working* hours, or every shop is nudged about every card at 08:05 on
 * Monday for the crime of having been shut over the weekend.
 *
 * Deliberately built on the platform's ICU data and the existing `zonedParts`
 * rather than a date library: the repo already bridges local-to-UTC in exactly
 * one place (`time.ts`) and a second bridge is a second set of DST bugs.
 */

export const WorkingWindowSchema = z
  .object({
    /** Days the shop turns wheels. 0 = Sunday … 6 = Saturday. */
    days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    open: HhMmSchema,
    close: HhMmSchema,
  })
  .refine((value) => parseHhMm(value.open) < parseHhMm(value.close), {
    message: 'close must be later in the day than open',
    path: ['close'],
  });

export type WorkingWindow = z.infer<typeof WorkingWindowSchema>;

/**
 * The inverse of `zonedParts`: a local wall-clock reading back to an instant.
 *
 * Treat the local reading as if it were UTC, measure how far that lands from
 * the target once rendered back into the zone, and correct. A second pass
 * catches the case where the correction itself crosses a DST boundary — India
 * has no DST, but a shop in a zone that does must not get an ETA an hour out
 * twice a year.
 */
export function instantFromZonedParts(
  parts: {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly second?: number;
  },
  timeZone: string,
): Date {
  const target = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second ?? 0,
  );

  let instant = new Date(target);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rendered = zonedParts(instant, timeZone);
    const renderedUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second,
    );
    const drift = target - renderedUtc;
    if (drift === 0) return instant;
    instant = new Date(instant.getTime() + drift);
  }
  return instant;
}

function minutesOfDay(parts: ZonedParts): number {
  return parts.hour * 60 + parts.minute;
}

export function isWorkingDay(weekday: number, window: WorkingWindow): boolean {
  return window.days.includes(weekday);
}

export function isWithinWorkingHours(
  instant: Date,
  timeZone: string,
  window: WorkingWindow,
): boolean {
  const parts = zonedParts(instant, timeZone);
  if (!isWorkingDay(parts.weekday, window)) return false;
  const now = minutesOfDay(parts);
  return now >= parseHhMm(window.open) && now < parseHhMm(window.close);
}

/** Opening time on the local day `instant` falls in, as a real instant. */
function openingOf(instant: Date, timeZone: string, window: WorkingWindow): Date {
  const parts = zonedParts(instant, timeZone);
  const open = parseHhMm(window.open);
  return instantFromZonedParts(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: Math.floor(open / 60),
      minute: open % 60,
    },
    timeZone,
  );
}

/**
 * Midday on the following local day.
 *
 * Midday rather than midnight on purpose: adding 24 hours to a midnight can
 * land back on the same local date in a zone that shifted its offset, and the
 * only thing this helper is used for is "which calendar day comes next".
 */
function nextLocalDay(instant: Date, timeZone: string): Date {
  const parts = zonedParts(instant, timeZone);
  const noon = instantFromZonedParts(
    { year: parts.year, month: parts.month, day: parts.day, hour: 12, minute: 0 },
    timeZone,
  );
  return new Date(noon.getTime() + MINUTES_PER_DAY * 60_000);
}

/** Iteration guard: a year of days is far more than any real ETA needs. */
const MAX_DAY_STEPS = 400;

/**
 * The first working instant at or after `instant`.
 *
 * A card whose work is approved at 21:30 does not start being worked on at
 * 21:30, and an ETA that pretends otherwise is the "promise of an exact
 * completion time" the post-checker exists to refuse.
 */
export function nextWorkingInstant(
  instant: Date,
  timeZone: string,
  window: WorkingWindow,
): Date {
  const open = parseHhMm(window.open);
  const close = parseHhMm(window.close);
  let cursor = instant;

  for (let step = 0; step < MAX_DAY_STEPS; step += 1) {
    const parts = zonedParts(cursor, timeZone);
    if (!isWorkingDay(parts.weekday, window)) {
      cursor = openingOf(nextLocalDay(cursor, timeZone), timeZone, window);
      continue;
    }
    const now = minutesOfDay(parts);
    if (now < open) return openingOf(cursor, timeZone, window);
    if (now >= close) {
      cursor = openingOf(nextLocalDay(cursor, timeZone), timeZone, window);
      continue;
    }
    return cursor;
  }
  return cursor;
}

/**
 * `instant` advanced by `minutes` of shop-floor time.
 *
 * Zero minutes is not a no-op: it normalises to the next working instant, which
 * is what "the earliest this could be looked at" means for work that arrives
 * out of hours.
 */
export function addWorkingMinutes(
  instant: Date,
  timeZone: string,
  window: WorkingWindow,
  minutes: number,
): Date {
  if (minutes < 0) throw new RangeError('addWorkingMinutes does not run the clock backwards');

  const close = parseHhMm(window.close);
  let cursor = nextWorkingInstant(instant, timeZone, window);
  let remaining = Math.round(minutes);

  for (let step = 0; step < MAX_DAY_STEPS; step += 1) {
    if (remaining === 0) return cursor;

    const parts = zonedParts(cursor, timeZone);
    const available = close - minutesOfDay(parts);
    if (remaining < available) return new Date(cursor.getTime() + remaining * 60_000);

    // Exactly `available` would land on closing time, which is a working
    // instant nobody is working at. Consume the day and let the normaliser move
    // to tomorrow's opening, so a four-hour job in a four-hour day reads as
    // "first thing tomorrow" rather than "the moment we lock up".
    remaining -= available;
    cursor = nextWorkingInstant(
      openingOf(nextLocalDay(cursor, timeZone), timeZone, window),
      timeZone,
      window,
    );
  }

  return cursor;
}

/**
 * Working minutes elapsed over `[from, to)`.
 *
 * The silent-bay scan's input: a card last heard from at 18:50 on Saturday has
 * been quiet for two days of wall clock and perhaps ten minutes of shop time,
 * and only one of those two numbers is a reason to nudge anyone.
 */
export function workingMinutesBetween(
  from: Date,
  to: Date,
  timeZone: string,
  window: WorkingWindow,
): number {
  if (to.getTime() <= from.getTime()) return 0;

  const open = parseHhMm(window.open);
  const close = parseHhMm(window.close);
  let cursor = from;
  let total = 0;

  for (let step = 0; step < MAX_DAY_STEPS; step += 1) {
    if (cursor.getTime() >= to.getTime()) return total;

    const parts = zonedParts(cursor, timeZone);
    if (!isWorkingDay(parts.weekday, window)) {
      cursor = openingOf(nextLocalDay(cursor, timeZone), timeZone, window);
      continue;
    }

    const now = minutesOfDay(parts);
    if (now >= close) {
      cursor = openingOf(nextLocalDay(cursor, timeZone), timeZone, window);
      continue;
    }

    const dayStart = now < open ? openingOf(cursor, timeZone, window) : cursor;
    const dayEndParts = zonedParts(dayStart, timeZone);
    const dayEnd = instantFromZonedParts(
      {
        year: dayEndParts.year,
        month: dayEndParts.month,
        day: dayEndParts.day,
        hour: Math.floor(close / 60),
        minute: close % 60,
      },
      timeZone,
    );

    const segmentEnd = Math.min(dayEnd.getTime(), to.getTime());
    if (segmentEnd > dayStart.getTime()) {
      total += Math.round((segmentEnd - dayStart.getTime()) / 60_000);
    }
    cursor = openingOf(nextLocalDay(dayStart, timeZone), timeZone, window);
  }

  return total;
}

/** True when two instants fall on different local calendar days. */
export function crossesLocalDay(from: Date, to: Date, timeZone: string): boolean {
  const a = zonedParts(from, timeZone);
  const b = zonedParts(to, timeZone);
  return a.year !== b.year || a.month !== b.month || a.day !== b.day;
}
