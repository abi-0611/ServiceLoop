import type { Language, StatusSignalType } from '@serviceloop/shared';

/**
 * What the parser heard in a technician's voice note (phase 4.2).
 *
 * Everything here is *what was said*, not what it means for the job card —
 * resolution to a card, to work items and to a state transition is the domain's
 * job, and keeping the two apart is what lets the parser be swapped for a
 * better model without touching a single rule about what may change a card.
 */
export interface ParsedStatusSignal {
  readonly signalType: StatusSignalType;
  /** 0–1. The routing threshold is `AUTO_APPLY_CONFIDENCE`. */
  readonly confidence: number;
  /** Whatever sounded like a plate: "09 BX 4432", "4432", or nothing. */
  readonly registrationFragment: string | null;
  /** A job-card code, when they actually read one out. */
  readonly jobCardCode: string | null;
  /** Free-text descriptions of the work: "brake pads", "காலிபர்". */
  readonly workDescriptions: readonly string[];
  /**
   * A time the technician named, already resolved to an instant against the
   * shop's clock. "part varum 4 maniku" at 11:00 means 16:00 today; the same
   * words at 17:00 mean 16:00 tomorrow, and only the parser has the context to
   * decide which.
   */
  readonly etaHint: Date | null;
  /** One line an advisor can read on a phone screen. */
  readonly summary: string;
  readonly language: Language;
}

/**
 * The parser port.
 *
 * A port rather than a direct LLM call, for the reason every model-touching
 * capability here is one: the domain states the rule and `packages/adapters`
 * implements it over whichever model is live — including, in the sandbox, a
 * deterministic parser that makes every status test real rather than vacuous.
 */
export interface StatusSignalParser {
  parse(input: {
    readonly shopId: string;
    readonly transcript: string;
    readonly languageHint: Language;
    /** Anchors relative times: "in two hours", "4 maniku". */
    readonly now: Date;
    readonly timezone: string;
    readonly traceId: string;
    /**
     * 0–1 from the recogniser. Absent means the note was typed.
     *
     * Multiplied into the parse rather than discarded: a transcript the
     * recogniser was 60% sure of cannot produce a 90%-sure signal, and a
     * pipeline that loses that at the seam auto-applies a misheard word.
     */
    readonly transcriptConfidence?: number;
  }): Promise<ParsedStatusSignal>;
}

/** How a captured signal was handled, and what it did. */
export interface CaptureOutcome {
  readonly signalId: string | null;
  readonly route:
    | 'AUTO_APPLIED'
    | 'PENDING_CONFIRMATION'
    | 'AMBIGUOUS'
    | 'ROUTED_TO_EVIDENCE'
    | 'NO_CARD_MATCH'
    | 'DISCARDED';
  readonly jobCardId: string | null;
  readonly workItemIds: readonly string[];
  /** One line for the trace panel and the audit row. */
  readonly detail: string;
  /** True when this inbound message had already produced a signal. */
  readonly duplicate: boolean;
}
