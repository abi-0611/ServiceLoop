import type { JobCardDraft, Language } from '@serviceloop/shared';
import type { LlmPort } from '../llm/port';
import { jobCardDraftLlmSchema } from '../llm/schemas';
import type { SpeechPort, Transcript } from '../speech/port';
import { buildTextUserPrompt, TEXT_SYSTEM_PROMPT } from './text-prompt';

/**
 * The other two intake on-ramps (phase 2.7): a forwarded message, and a voice
 * note.
 *
 * Both land in the same `JobCardDraft` as a photographed card, and both go
 * through the same confirmation flow. That equivalence is the whole point of
 * L2 — the paper path is not special-cased, it produces the same artefact
 * everything else does, so nothing downstream needs to know which on-ramp a
 * card came in through.
 */

export interface DraftExtraction {
  readonly draft: JobCardDraft;
  readonly model: string;
  readonly promptHash: string;
  readonly latencyMs: number;
  readonly raw: string;
  /** The text the draft was extracted from. Stored on the draft row verbatim. */
  readonly sourceText: string;
}

export interface TextExtractInput {
  readonly shopId: string;
  readonly text: string;
  readonly languageHint?: Language;
  readonly traceId?: string;
}

export interface TextDraftExtractorPort {
  extractFromText(input: TextExtractInput): Promise<DraftExtraction>;
}

export class EmptyIntakeTextError extends Error {
  constructor() {
    super('There is no text to read a job card from');
    this.name = 'EmptyIntakeTextError';
  }
}

export class LlmTextDraftExtractor implements TextDraftExtractorPort {
  constructor(
    private readonly llm: LlmPort,
    private readonly options: { readonly maxOutputTokens?: number } = {},
  ) {}

  async extractFromText(input: TextExtractInput): Promise<DraftExtraction> {
    return this.extract(input.text, {
      ...(input.languageHint === undefined ? {} : { languageHint: input.languageHint }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    });
  }

  /** Shared by the text and voice paths; the voice path adds transcript hints. */
  async extract(
    text: string,
    options: {
      readonly languageHint?: Language;
      readonly traceId?: string;
      readonly fromTranscript?: boolean;
      readonly transcriptConfidence?: number;
    } = {},
  ): Promise<DraftExtraction> {
    const trimmed = text.trim();
    if (trimmed.length === 0) throw new EmptyIntakeTextError();

    const result = await this.llm.extract({
      // Producing a typed document from free text is `EXTRACT` work — the same
      // task class as reading a photographed card, because it is the same job
      // with a different input medium. One model id serves both, so a shop
      // cannot end up with a careful reader for photos and a careless one for
      // forwarded messages.
      taskClass: 'EXTRACT',
      system: TEXT_SYSTEM_PROMPT,
      maxOutputTokens: this.options.maxOutputTokens ?? 4_000,
      ...(options.traceId === undefined ? {} : { traceId: options.traceId }),
      schema: jobCardDraftLlmSchema,
      messages: [
        {
          role: 'user',
          content: [
            {
              kind: 'text',
              text: buildTextUserPrompt(trimmed, {
                ...(options.languageHint === undefined
                  ? {}
                  : { languageHint: options.languageHint }),
                ...(options.fromTranscript === undefined
                  ? {}
                  : { fromTranscript: options.fromTranscript }),
                ...(options.transcriptConfidence === undefined
                  ? {}
                  : { transcriptConfidence: options.transcriptConfidence }),
              }),
            },
          ],
        },
      ],
    });

    return {
      draft: result.value,
      model: result.model,
      promptHash: result.promptHash,
      latencyMs: result.latencyMs,
      raw: result.raw,
      sourceText: trimmed,
    };
  }
}

/* -------------------------------------------------------------------------- *
 * Voice notes
 * -------------------------------------------------------------------------- */

export interface VoiceExtractInput {
  readonly shopId: string;
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly languageHint?: Language;
  readonly traceId?: string;
}

export interface VoiceDraftExtraction extends DraftExtraction {
  readonly transcript: Transcript;
}

export interface VoiceDraftExtractorPort {
  extractFromVoice(input: VoiceExtractInput): Promise<VoiceDraftExtraction>;
}

/**
 * Transcribe, then parse.
 *
 * The two steps stay separate rather than becoming one "audio to job card"
 * call, because the transcript is evidence in its own right: it is stored on
 * the draft, shown to the advisor beside the fields, and — under L7 — is what a
 * later customer-facing claim about this visit traces back to.
 *
 * The recogniser's confidence is passed into the parse rather than discarded.
 * A shaky transcript should produce a *diffident* draft, and a pipeline that
 * loses that signal at the seam produces a confident job card built on a
 * misheard word.
 */
export class VoiceNoteDraftExtractor implements VoiceDraftExtractorPort {
  constructor(
    private readonly speech: SpeechPort,
    private readonly text: LlmTextDraftExtractor,
  ) {}

  async extractFromVoice(input: VoiceExtractInput): Promise<VoiceDraftExtraction> {
    const transcript = await this.speech.transcribe({
      shopId: input.shopId,
      bytes: input.bytes,
      contentType: input.contentType,
      ...(input.languageHint === undefined ? {} : { languageHint: input.languageHint }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    });

    const extraction = await this.text.extract(transcript.text, {
      // What the recogniser heard beats what the thread was set to.
      languageHint: transcript.language,
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      fromTranscript: true,
      transcriptConfidence: transcript.confidence,
    });

    return { ...extraction, transcript };
  }
}
