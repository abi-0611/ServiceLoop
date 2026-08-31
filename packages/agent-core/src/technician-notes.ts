import { SpeechError, type SpeechPort } from '@serviceloop/adapters';
import type {
  CaptureOutcome,
  StatusSignalParser,
  StatusSignalService,
  StatusTapInput,
  TechnicianNoteCaptureInput,
  TechnicianNotePort,
  TechnicianNoteReadInput,
  TechnicianNoteReading,
} from '@serviceloop/domain';
import { systemClock, type Clock } from '@serviceloop/shared';

/**
 * Staff-group note → transcript → parse → status signal (phase 4.2).
 *
 * The join phase 4 was missing. Every piece existed and was tested — the
 * recogniser, the parser, the routing service — and nothing called them in
 * order from a real inbound message.
 *
 * It lives here rather than in `packages/domain` for the usual reason: it needs
 * a `SpeechPort`, which is an adapter. The domain declares `TechnicianNotePort`
 * and `InboundHandler` calls it; this is the only place that knows a speech
 * provider exists.
 *
 * Two things it does that neither half does alone:
 *
 *   - **Hints the recogniser with the registrations on the floor today.** A
 *     workshop's audio is 8 kHz and full of proper nouns no general model has
 *     heard, and "TN zero nine PX" instead of "BX" is a status signal applied to
 *     the wrong car. The hints are what make the match safe enough to auto-apply.
 *   - **Carries the recogniser's confidence into the parse.** Bad audio must
 *     produce a diffident signal, which asks a human, rather than a confident
 *     one built on a misheard word.
 */

export interface TechnicianNoteIngestorDeps<Tx> {
  readonly speech: SpeechPort;
  readonly parser: StatusSignalParser;
  readonly signals: StatusSignalService<Tx>;
  /**
   * Registrations of the cars actually in the workshop, as recogniser hints.
   *
   * Read per note rather than cached: the whole value of the hint is that it
   * names the cars in the bays *now*, and a list captured at boot would be
   * hinting yesterday's plates by the afternoon.
   */
  readonly hints: (shopId: string) => Promise<readonly string[]>;
  readonly timezone: (shopId: string) => Promise<string>;
  readonly clock?: Clock;
}

/** More hints than this and the provider starts ignoring them. */
const MAX_HINTS = 40;

export class TechnicianNoteIngestor<Tx> implements TechnicianNotePort {
  private readonly clock: Clock;

  constructor(private readonly deps: TechnicianNoteIngestorDeps<Tx>) {
    this.clock = deps.clock ?? systemClock;
  }

  async read(input: TechnicianNoteReadInput): Promise<TechnicianNoteReading | null> {
    let transcript = input.text.trim();
    let transcriptConfidence: number | null = null;
    let language = input.languageHint;

    if (input.audio !== null) {
      const heard = await this.transcribe(input);
      if (heard === null) return null;

      // A caption on a voice note is rare and, when present, is the sender
      // adding a plate they did not say out loud. Both go to the parser.
      transcript = [heard.text, transcript].filter((part) => part.length > 0).join(' ');
      transcriptConfidence = heard.confidence;
      language = heard.language;
    }

    if (transcript.length === 0) return null;

    const parsed = await this.deps.parser.parse({
      shopId: input.shopId,
      transcript,
      languageHint: language,
      now: this.clock.now(),
      timezone: await this.deps.timezone(input.shopId),
      traceId: input.traceId,
      ...(transcriptConfidence === null ? {} : { transcriptConfidence }),
    });

    return { transcript, transcriptConfidence, parsed };
  }

  async capture(input: TechnicianNoteCaptureInput): Promise<CaptureOutcome> {
    return this.deps.signals.capture(input);
  }

  async confirm(input: StatusTapInput): Promise<CaptureOutcome> {
    return this.deps.signals.confirm(input);
  }

  async discard(input: StatusTapInput): Promise<CaptureOutcome> {
    return this.deps.signals.discard(input);
  }

  /**
   * The words, or null.
   *
   * Null rather than a throw for the failures that are facts about the *audio*
   * — a two-second clip, a codec nobody supports, no fixture in the sandbox.
   * Those notes fall back to the intake path, which has its own voice handling
   * and its own apology. A provider outage does throw, because the caller
   * should log a failure rather than silently reclassify a status note as a new
   * job card every time a vendor has a bad afternoon.
   */
  private async transcribe(
    input: TechnicianNoteReadInput,
  ): Promise<{ text: string; confidence: number; language: TechnicianNoteReading['parsed']['language'] } | null> {
    const audio = input.audio;
    if (audio === null) return null;

    const hints = (await this.deps.hints(input.shopId)).slice(0, MAX_HINTS);

    try {
      const transcript = await this.deps.speech.transcribe({
        shopId: input.shopId,
        bytes: audio.bytes,
        contentType: audio.contentType,
        languageHint: input.languageHint,
        traceId: input.traceId,
        ...(hints.length === 0 ? {} : { hints }),
      });

      const text = transcript.text.trim();
      return text.length === 0
        ? null
        : { text, confidence: transcript.confidence, language: transcript.language };
    } catch (error) {
      if (error instanceof SpeechError && !error.retryable) return null;
      throw error;
    }
  }
}
