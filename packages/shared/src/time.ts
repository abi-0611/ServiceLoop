import { z } from 'zod';

/**
 * Timezone-aware clock helpers.
 *
 * Quiet hours, escalation ladder rungs and digests are all expressed in the
 * shop's local wall clock (default `Asia/Kolkata`), while everything is stored
 * in UTC. These helpers are the only place that bridges the two, using the
 * platform ICU data rather than a date library.
 */

export const MINUTES_PER_DAY = 24 * 60;

export const HhMmSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Expected HH:MM in 24-hour form');

export const TimeZoneSchema = z.string().refine(isValidTimeZone, {
  message: 'Unknown IANA time zone',
});

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function parseHhMm(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Not an HH:MM value: ${value}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

export function formatHhMm(minutesOfDay: number): string {
  const normalised = ((minutesOfDay % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(normalised / 60);
  const minutes = normalised % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

export interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** 0 = Sunday .. 6 = Saturday */
  readonly weekday: number;
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });

  const lookup: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    lookup[part.type] = part.value;
  }

  // Intl renders midnight as "24" in some ICU versions for hourCycle h24.
  const rawHour = Number(lookup['hour'] ?? '0');

  return {
    year: Number(lookup['year'] ?? '1970'),
    month: Number(lookup['month'] ?? '1'),
    day: Number(lookup['day'] ?? '1'),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(lookup['minute'] ?? '0'),
    second: Number(lookup['second'] ?? '0'),
    weekday: WEEKDAY_INDEX[lookup['weekday'] ?? 'Sun'] ?? 0,
  };
}

export function minutesOfDayInZone(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  return parts.hour * 60 + parts.minute;
}

export interface QuietWindow {
  /** Local wall-clock start, e.g. `21:00`. */
  readonly start: string;
  /** Local wall-clock end, e.g. `08:00`. Wrapping past midnight is expected. */
  readonly end: string;
}

/** A window whose start equals its end is treated as "no quiet hours". */
export function isWithinQuietHours(instant: Date, timeZone: string, window: QuietWindow): boolean {
  const start = parseHhMm(window.start);
  const end = parseHhMm(window.end);
  if (start === end) return false;

  const now = minutesOfDayInZone(instant, timeZone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

/**
 * The earliest instant at or after `instant` that falls outside the quiet
 * window. Used to schedule escalation rungs that would otherwise fire at 2am.
 */
export function nextInstantOutsideQuietHours(
  instant: Date,
  timeZone: string,
  window: QuietWindow,
): Date {
  if (!isWithinQuietHours(instant, timeZone, window)) return instant;

  const end = parseHhMm(window.end);
  let cursor = instant;

  // Two passes are enough for any real zone: the first jumps to the local end
  // time, the second corrects for a UTC-offset change across that boundary.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = minutesOfDayInZone(cursor, timeZone);
    const delta = (end - now + MINUTES_PER_DAY) % MINUTES_PER_DAY;
    cursor = new Date(cursor.getTime() + Math.max(delta, 1) * 60_000);
    if (!isWithinQuietHours(cursor, timeZone, window)) return cursor;
  }
  return cursor;
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

export function addHours(instant: Date, hours: number): Date {
  return addMinutes(instant, hours * 60);
}

export function addDays(instant: Date, days: number): Date {
  return addMinutes(instant, days * MINUTES_PER_DAY);
}

/** Deterministic clock seam so tests never depend on wall time. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(instant: Date): Clock {
  return { now: () => new Date(instant.getTime()) };
}
