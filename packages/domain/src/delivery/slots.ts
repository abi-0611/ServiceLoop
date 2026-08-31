import type { DeliveryConfig } from '@serviceloop/config';
import {
  instantFromZonedParts,
  isWorkingDay,
  MINUTES_PER_DAY,
  parseHhMm,
  zonedParts,
  type WorkingWindow,
} from '@serviceloop/shared';

/**
 * Pickup slotting (phase 4.7) — pure arithmetic, no ports, no clock.
 *
 * "Simple slotting" is the requirement and it is the right one: shop hours,
 * minus the counter-rush windows, minus bins that are already full. What it
 * buys is not scheduling elegance — it is that three customers are not all told
 * "come at six", which is how a workshop ends up with a queue at the gate and
 * three people who each waited twenty minutes deciding the shop is badly run.
 */

export interface Slot {
  readonly start: Date;
  readonly end: Date;
}

export interface SuggestSlotsInput {
  readonly from: Date;
  readonly timezone: string;
  readonly workingHours: WorkingWindow;
  readonly config: DeliveryConfig;
  /** Start instants of pickups already booked, for the per-bin cap. */
  readonly booked: readonly Date[];
  /** How many to offer. Defaults to the shop's configured suggestion count. */
  readonly count?: number;
}

/** Days to look ahead before giving up. A shop shut for a week has a problem. */
const MAX_LOOKAHEAD_DAYS = 14;

/**
 * The next few slots a customer may be offered.
 *
 * Walks forward bin by bin from the earliest acceptable moment, skipping bins
 * that fall in a rush window or are already at capacity. Returns fewer than
 * asked for — possibly none — rather than relaxing a cap: an empty list means
 * the shop is genuinely full, and the ready message says "tell us when suits
 * you" instead of inventing availability the counter cannot honour.
 */
export function suggestSlots(input: SuggestSlotsInput): readonly Slot[] {
  const wanted = input.count ?? input.config.suggestionCount;
  if (wanted <= 0) return [];

  const slotMs = input.config.slotMinutes * 60_000;
  const load = binLoad(input.booked);

  const earliest = new Date(input.from.getTime() + input.config.earliestOffsetMinutes * 60_000);
  const open = parseHhMm(input.workingHours.open);
  const close = parseHhMm(input.workingHours.close);

  const found: Slot[] = [];
  let cursor = earliest;

  for (let day = 0; day <= MAX_LOOKAHEAD_DAYS && found.length < wanted; day += 1) {
    const parts = zonedParts(cursor, input.timezone);

    if (isWorkingDay(parts.weekday, input.workingHours)) {
      const dayOpen = instantFromZonedParts(
        {
          year: parts.year,
          month: parts.month,
          day: parts.day,
          hour: Math.floor(open / 60),
          minute: open % 60,
        },
        input.timezone,
      );

      // Bins are laid out from opening time, so "10:00–10:30" means the same
      // thing every day and a customer who books the 10:00 slot twice gets the
      // same half-hour twice.
      const binsPerDay = Math.floor((close - open) / input.config.slotMinutes);
      for (let bin = 0; bin < binsPerDay && found.length < wanted; bin += 1) {
        const start = new Date(dayOpen.getTime() + bin * slotMs);
        if (start.getTime() < earliest.getTime()) continue;

        const startMinutes = open + bin * input.config.slotMinutes;
        const endMinutes = startMinutes + input.config.slotMinutes;
        if (overlapsRush(startMinutes, endMinutes, input.config)) continue;

        if ((load.get(start.getTime()) ?? 0) >= input.config.maxPickupsPerSlot) continue;

        found.push({ start, end: new Date(start.getTime() + slotMs) });
      }
    }

    cursor = startOfNextLocalDay(cursor, input.timezone);
  }

  return found;
}

/**
 * Is a slot inside a configured rush window?
 *
 * Overlap, not containment: a 30-minute bin starting at 12:45 runs into a
 * 13:00–14:00 rush and offering it would put a customer at the counter exactly
 * when nobody can serve them.
 */
export function overlapsRush(
  startMinutes: number,
  endMinutes: number,
  config: DeliveryConfig,
): boolean {
  return config.rushWindows.some((window) => {
    const rushStart = parseHhMm(window.start);
    const rushEnd = parseHhMm(window.end);
    return startMinutes < rushEnd && endMinutes > rushStart;
  });
}

/**
 * Bookings per bin, keyed on the exact bin start.
 *
 * Exact rather than rounded: a booking is only ever written at a bin start —
 * `chooseSlot` resolves the customer's tap against the slots it offered, and
 * those came from this function's own grid — so rounding would only ever be a
 * way to count one booking twice.
 */
function binLoad(booked: readonly Date[]): ReadonlyMap<number, number> {
  const load = new Map<number, number>();
  for (const at of booked) {
    load.set(at.getTime(), (load.get(at.getTime()) ?? 0) + 1);
  }
  return load;
}

/** Local midnight of the following day, as an instant. */
function startOfNextLocalDay(instant: Date, timeZone: string): Date {
  const parts = zonedParts(instant, timeZone);
  const noon = instantFromZonedParts(
    { year: parts.year, month: parts.month, day: parts.day, hour: 12, minute: 0 },
    timeZone,
  );
  const tomorrow = zonedParts(new Date(noon.getTime() + MINUTES_PER_DAY * 60_000), timeZone);
  return instantFromZonedParts(
    { year: tomorrow.year, month: tomorrow.month, day: tomorrow.day, hour: 0, minute: 0 },
    timeZone,
  );
}

/**
 * Is this slot still offerable?
 *
 * Re-checked when a customer taps, not only when the slots were composed. A
 * ready message sits in WhatsApp for hours, and in that time the shop may have
 * filled the bin — accepting the tap anyway is how two people are promised the
 * same half-hour.
 */
export function slotStillAvailable(
  slot: Date,
  booked: readonly Date[],
  config: DeliveryConfig,
): boolean {
  const taken = booked.filter((at) => at.getTime() === slot.getTime()).length;
  return taken < config.maxPickupsPerSlot;
}
