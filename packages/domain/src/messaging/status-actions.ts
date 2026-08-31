/**
 * Channel vocabulary for the phase-4 taps: the technician status confirmation
 * and the customer's pickup-slot choice.
 *
 * Here rather than in `status/` or `delivery/` for the same dependency reason
 * the approval buttons are here (see `approval-actions.ts`): whoever reads
 * inbound messages has to recognise these ids, and the inbound handler cannot
 * import a module that imports `OutboundGate` without closing a cycle.
 *
 * The ids carry their subject. A status confirmation arrives hours after it was
 * asked, possibly after two other cards were discussed in the same group, and
 * "yes" with no subject is a tap that could be applied to the wrong vehicle.
 */

const STATUS_CONFIRM_PREFIX = 'status:confirm:';
const STATUS_EDIT_PREFIX = 'status:edit:';
const STATUS_DISCARD_PREFIX = 'status:discard:';
const SLOT_PREFIX = 'slot:pick:';

export const STATUS_ACTION_IDS = {
  /**
   * `jobCardId` is present only on the disambiguation ask, where the tap is
   * answering *which car* as well as *yes*. Carrying it in the id rather than
   * inferring it later is what makes the answer unambiguous at the point it is
   * recorded: the alternative is re-running the same failed match.
   */
  confirm: (signalId: string, jobCardId?: string): string =>
    jobCardId === undefined
      ? `${STATUS_CONFIRM_PREFIX}${signalId}`
      : `${STATUS_CONFIRM_PREFIX}${signalId}${SUBJECT_SEPARATOR}${jobCardId}`,
  edit: (signalId: string): string => `${STATUS_EDIT_PREFIX}${signalId}`,
  discard: (signalId: string): string => `${STATUS_DISCARD_PREFIX}${signalId}`,
} as const;

const SUBJECT_SEPARATOR = '~';

export type StatusActionKind = 'CONFIRM' | 'EDIT' | 'DISCARD';

export interface ParsedStatusAction {
  readonly kind: StatusActionKind;
  readonly signalId: string;
  /** The card the tap chose, when the ask was "which of these two?". */
  readonly jobCardId: string | null;
}

/**
 * A reply id → the status action it means, or null.
 *
 * Prefix match *with* a non-empty remainder, and the remainder is the subject.
 * `status:confirm:` on its own is not an action — it is a malformed id, and
 * treating it as "confirm the most recent signal" is how a technician's tap
 * closes a work item on somebody else's car.
 */
export function parseStatusAction(replyId: string | null): ParsedStatusAction | null {
  if (replyId === null) return null;

  for (const [prefix, kind] of [
    [STATUS_CONFIRM_PREFIX, 'CONFIRM'],
    [STATUS_EDIT_PREFIX, 'EDIT'],
    [STATUS_DISCARD_PREFIX, 'DISCARD'],
  ] as const) {
    if (!replyId.startsWith(prefix)) continue;

    const rest = replyId.slice(prefix.length);
    const separator = rest.indexOf(SUBJECT_SEPARATOR);
    const signalId = separator === -1 ? rest : rest.slice(0, separator);
    const jobCardId = separator === -1 ? null : rest.slice(separator + 1);

    if (signalId.length === 0) return null;
    return { kind, signalId, jobCardId: jobCardId === '' ? null : jobCardId };
  }

  return null;
}

export const SLOT_ACTION_IDS = {
  /** `index` is the position in the offered list, not a timestamp. */
  pick: (bookingId: string, index: number): string => `${SLOT_PREFIX}${bookingId}:${index}`,
} as const;

export interface ParsedSlotAction {
  readonly bookingId: string;
  readonly slotIndex: number;
}

/**
 * A slot reply id → which booking and which offered slot.
 *
 * The *index* travels rather than the instant, so a customer tapping a stale
 * button cannot book a time the shop is no longer offering: the index is
 * resolved against the slots stored on the booking row, and an index the
 * booking does not have is refused.
 */
export function parseSlotAction(replyId: string | null): ParsedSlotAction | null {
  if (replyId === null || !replyId.startsWith(SLOT_PREFIX)) return null;

  const rest = replyId.slice(SLOT_PREFIX.length);
  const separator = rest.lastIndexOf(':');
  if (separator <= 0) return null;

  const bookingId = rest.slice(0, separator);
  const index = Number(rest.slice(separator + 1));
  if (bookingId.length === 0) return null;
  if (!Number.isInteger(index) || index < 0) return null;

  return { bookingId, slotIndex: index };
}
