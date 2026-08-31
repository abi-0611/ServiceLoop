import type { ParsedStatusSignal, StatusSignalParser } from '@serviceloop/domain';
import {
  instantFromZonedParts,
  parseHhMm,
  zonedParts,
  type Language,
} from '@serviceloop/shared';
import { fencePayload, userText, type LlmPort } from '../llm/port';
import { parseStatusNoteHeuristically } from './heuristic-status';
import {
  STATUS_SIGNAL_INSTRUCTIONS,
  STATUS_SIGNAL_LLM_SCHEMA,
  STATUS_SIGNAL_SYSTEM_PROMPT,
  type ExtractedStatusSignal,
} from './status-prompt';

/**
 * `LlmStatusSignalParser` — transcript in, `StatusSignal` out (phase 4.2).
 *
 * An EXTRACT-class call, so it uses whichever model a shop has configured for
 * turning free text into a typed document — the same one that reads a
 * photographed job card, which is right: both are the same task with different
 * input.
 *
 * Two things it does that the model does not:
 *
 *   - **Resolves the time.** A model can hear "4 maniku"; only the caller knows
 *     it is 17:00 in Chennai and that four o'clock is therefore tomorrow. The
 *     ambiguity is resolved here, deterministically, against the shop's clock.
 *   - **Multiplies the transcript's confidence in.** A shaky recognition should
 *     produce a diffident signal, not a confident one built on a misheard word.
 *     The same principle phase 2.7 applied to voice-note intake, and here it is
 *     what stands between bad audio and an auto-applied transition.
 */

export interface StatusParserOptions {
  /** Falls back to the deterministic parser when the model refuses. */
  readonly fallbackToHeuristic?: boolean;
}

export class LlmStatusSignalParser implements StatusSignalParser {
  constructor(
    private readonly llm: LlmPort,
    private readonly options: StatusParserOptions = {},
  ) {}

  async parse(input: {
    readonly shopId: string;
    readonly transcript: string;
    readonly languageHint: Language;
    readonly now: Date;
    readonly timezone: string;
    readonly traceId: string;
    /** 0–1 from the recogniser. Absent means "assume it heard cleanly". */
    readonly transcriptConfidence?: number;
  }): Promise<ParsedStatusSignal> {
    const extracted = await this.extract(input);
    return toParsedSignal(extracted, {
      now: input.now,
      timezone: input.timezone,
      transcriptConfidence: input.transcriptConfidence ?? 1,
    });
  }

  private async extract(input: {
    readonly shopId: string;
    readonly transcript: string;
    readonly languageHint: Language;
    readonly traceId: string;
  }): Promise<ExtractedStatusSignal> {
    try {
      const result = await this.llm.extract({
        taskClass: 'EXTRACT',
        shopId: input.shopId,
        traceId: input.traceId,
        system: STATUS_SIGNAL_SYSTEM_PROMPT,
        maxOutputTokens: 800,
        schema: STATUS_SIGNAL_LLM_SCHEMA,
        messages: [
          userText(
            `${STATUS_SIGNAL_INSTRUCTIONS}\n\nThe thread's language is ${input.languageHint}, but technicians code-switch freely.\n\n${fencePayload(
              input.transcript,
            )}`,
          ),
        ],
      });
      return result.value;
    } catch (error) {
      if (this.options.fallbackToHeuristic !== true) throw error;
      // A model outage must not silence the status loop. The heuristic parse is
      // markedly less confident by construction, so its signals ask a human
      // rather than applying themselves — which is the correct posture for a
      // system that has just lost its extractor.
      return parseStatusNoteHeuristically(input.transcript, {
        languageHint: input.languageHint,
      });
    }
  }
}

/**
 * `HeuristicStatusSignalParser` — the credential-free parser.
 *
 * Used by the sandbox and by CI. Not a stub: `parseStatusNoteHeuristically` is
 * a genuine keyword-and-regex parser over three languages, which is what makes
 * the phase's fifteen transcript fixtures a real test rather than an assertion
 * that a constant is constant.
 */
export class HeuristicStatusSignalParser implements StatusSignalParser {
  async parse(input: {
    readonly shopId: string;
    readonly transcript: string;
    readonly languageHint: Language;
    readonly now: Date;
    readonly timezone: string;
    readonly traceId: string;
    readonly transcriptConfidence?: number;
  }): Promise<ParsedStatusSignal> {
    return toParsedSignal(
      parseStatusNoteHeuristically(input.transcript, { languageHint: input.languageHint }),
      {
        now: input.now,
        timezone: input.timezone,
        transcriptConfidence: input.transcriptConfidence ?? 1,
      },
    );
  }
}

export function toParsedSignal(
  extracted: ExtractedStatusSignal,
  context: {
    readonly now: Date;
    readonly timezone: string;
    readonly transcriptConfidence: number;
  },
): ParsedStatusSignal {
  return {
    signalType: extracted.signalType,
    // A transcript the recogniser was 60% sure of cannot produce a 90%-sure
    // signal: the parse is only as good as the words it read. Multiplying is
    // blunt and it is the right kind of blunt — it can only ever make the
    // system ask a human more often.
    confidence: Number(
      (extracted.confidence * clamp(context.transcriptConfidence)).toFixed(3),
    ),
    registrationFragment: emptyToNull(extracted.registrationFragment),
    jobCardCode: emptyToNull(extracted.jobCardCode),
    workDescriptions: extracted.workDescriptions,
    etaHint: resolveEtaHint(extracted, context.now, context.timezone),
    summary: extracted.summary,
    language: extracted.language,
  };
}

/**
 * `"16:00"` plus the shop's clock → an instant.
 *
 * The rule that matters is the default when no day was stated: a time that has
 * already passed today means tomorrow. A technician saying "part varum 4
 * maniku" at 17:00 is talking about tomorrow afternoon, and resolving it to
 * four o'clock an hour ago would produce an ETA in the past — which the engine
 * would then dutifully tell a customer.
 */
export function resolveEtaHint(
  extracted: ExtractedStatusSignal,
  now: Date,
  timezone: string,
): Date | null {
  if (extracted.etaHintTime === null) return null;

  let minutes: number;
  try {
    minutes = parseHhMm(extracted.etaHintTime);
  } catch {
    return null;
  }

  const parts = zonedParts(now, timezone);
  const today = instantFromZonedParts(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: Math.floor(minutes / 60),
      minute: minutes % 60,
    },
    timezone,
  );

  if (extracted.etaHintDay === 'today') return today;
  if (extracted.etaHintDay === 'tomorrow') return addDay(today, timezone);
  return today.getTime() > now.getTime() ? today : addDay(today, timezone);
}

function addDay(instant: Date, timezone: string): Date {
  const parts = zonedParts(new Date(instant.getTime() + 24 * 60 * 60 * 1000), timezone);
  const original = zonedParts(instant, timezone);
  return instantFromZonedParts(
    {
      year: parts.year,
      month: parts.month,
      day: parts.day,
      hour: original.hour,
      minute: original.minute,
    },
    timezone,
  );
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
