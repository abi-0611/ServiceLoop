import { migrateShopConfig } from '@serviceloop/config';
import type { IntakeSource, JobCardDraft, Language } from '@serviceloop/shared';
import type { Actor } from '../job-card/context';
import type { OutboundButton, OutboundContent } from '../messaging/types';
import type { ShopConfigStore, UnitOfWork } from '../ports';
import { buildDraftSummary, DRAFT_ACTION_IDS, type DraftSummary } from './confirmation';
import type { IntakeService } from './intake-service';

/**
 * The intake pipeline (phase 2.5–2.7).
 *
 * One entry point per on-ramp — a photographed card, a forwarded message, a
 * voice note, a console form — and one exit: a persisted draft plus the
 * interactive summary a human confirms. Everything downstream of here is
 * on-ramp agnostic, which is what makes the paper path first-class rather than
 * a special case bolted onto a digital flow.
 *
 * Extraction sits behind a port so the domain never imports a model client, and
 * so the eval harness, the sandbox and production all drive the same pipeline.
 */

export interface ExtractedDraft {
  readonly draft: JobCardDraft;
  readonly model: string;
  readonly promptHash: string;
  readonly latencyMs: number;
  readonly raw: string;
  /** The text the draft came from: the caption, the message, the transcript. */
  readonly sourceText: string | null;
}

export interface PhotoExtractInput {
  readonly shopId: string;
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly caption?: string | null;
  readonly languageHint?: Language;
  readonly traceId?: string;
}

export interface TextExtractInput {
  readonly shopId: string;
  readonly text: string;
  readonly languageHint?: Language;
  readonly traceId?: string;
}

export interface VoiceExtractInput {
  readonly shopId: string;
  readonly bytes: Buffer;
  readonly contentType: string;
  readonly languageHint?: Language;
  readonly traceId?: string;
}

/**
 * Implemented in `packages/adapters` over `OcrPort`, `LlmPort` and `SpeechPort`.
 * The domain declares what it needs; the adapters decide what reads it.
 */
export interface DraftExtractionPort {
  fromPhoto(input: PhotoExtractInput): Promise<ExtractedDraft>;
  fromText(input: TextExtractInput): Promise<ExtractedDraft>;
  fromVoice(input: VoiceExtractInput): Promise<ExtractedDraft>;
}

/** Raised when an extractor could not produce a draft at all. */
export class IntakeExtractionFailedError extends Error {
  constructor(
    readonly source: IntakeSource,
    override readonly cause: unknown,
  ) {
    super(
      `Could not read a job card from this ${source.toLowerCase().replace('_', ' ')}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'IntakeExtractionFailedError';
  }
}

export interface IntakePipelineDeps<Tx> {
  readonly uow: UnitOfWork<Tx>;
  readonly extraction: DraftExtractionPort;
  readonly intake: IntakeService<Tx>;
  readonly config: ShopConfigStore<Tx>;
}

export interface RunIntakeInput {
  readonly shopId: string;
  readonly source: IntakeSource;
  /** Set for PHOTO and VOICE_NOTE. */
  readonly bytes?: Buffer;
  readonly contentType?: string;
  /** Set for FORWARDED_TEXT, and used as the caption on the photo path. */
  readonly text?: string | null;
  /**
   * A transcript the caller already has (phase 4.2).
   *
   * The status sentinel reads every staff voice note *before* intake sees it,
   * to decide whether the note is about a car already in the workshop. When it
   * turns out not to be, transcribing the same five seconds a second time costs
   * the shop another provider call and the technician another wait. The words
   * are passed through instead; the draft's source stays `VOICE_NOTE`, because
   * that is how it arrived and that is what the on-ramp report counts.
   */
  readonly transcript?: string | null;
  readonly language: Language;
  readonly conversationId?: string | null;
  readonly messageId?: string | null;
  readonly mediaId?: string | null;
  readonly submittedByStaffId?: string | null;
  readonly actor: Actor;
  readonly traceId: string;
}

export interface IntakeRunResult {
  readonly draftId: string;
  readonly draft: JobCardDraft;
  readonly summary: DraftSummary;
  readonly overallConfidence: number;
  readonly lowConfidencePaths: readonly string[];
  readonly model: string;
  /** The interactive message a human confirms. Send it through `OutboundGate`. */
  readonly content: OutboundContent;
}

export class IntakePipeline<Tx> {
  constructor(private readonly deps: IntakePipelineDeps<Tx>) {}

  async run(input: RunIntakeInput): Promise<IntakeRunResult> {
    const extracted = await this.extract(input);

    const recorded = await this.deps.intake.recordDraft({
      shopId: input.shopId,
      source: input.source,
      draft: extracted.draft,
      conversationId: input.conversationId ?? null,
      messageId: input.messageId ?? null,
      mediaId: input.mediaId ?? null,
      submittedByStaffId: input.submittedByStaffId ?? null,
      rawInput: extracted.sourceText,
      extractorModel: extracted.model,
      extractorPromptHash: extracted.promptHash,
      extractionMs: extracted.latencyMs,
      actor: input.actor,
      traceId: input.traceId,
    });

    const threshold = await this.confirmationThreshold(input.shopId);
    const language = extracted.draft.language ?? input.language;
    const summary = buildDraftSummary(extracted.draft, threshold, language);

    return {
      draftId: recorded.draftId,
      draft: extracted.draft,
      summary,
      overallConfidence: recorded.overallConfidence,
      lowConfidencePaths: recorded.lowConfidencePaths,
      model: extracted.model,
      content: draftSummaryContent(summary, recorded.draftId, language),
    };
  }

  /** Rebuilds the summary for a draft that has since been corrected. */
  async summarise(
    shopId: string,
    draftId: string,
    fallbackLanguage: Language,
  ): Promise<{ summary: DraftSummary; content: OutboundContent } | null> {
    const record = await this.deps.intake.load(shopId, draftId);
    if (record === null) return null;

    const threshold = await this.confirmationThreshold(shopId);
    const language = record.draft.language ?? fallbackLanguage;
    const summary = buildDraftSummary(record.draft, threshold, language);
    return { summary, content: draftSummaryContent(summary, draftId, language) };
  }

  private async extract(input: RunIntakeInput): Promise<ExtractedDraft> {
    try {
      switch (input.source) {
        case 'PHOTO': {
          if (input.bytes === undefined || input.contentType === undefined) {
            throw new Error('A photo intake needs image bytes and their content type');
          }
          return await this.deps.extraction.fromPhoto({
            shopId: input.shopId,
            bytes: input.bytes,
            contentType: input.contentType,
            caption: input.text ?? null,
            languageHint: input.language,
            traceId: input.traceId,
          });
        }

        case 'VOICE_NOTE': {
          const heard = (input.transcript ?? '').trim();
          if (heard.length > 0) {
            return await this.deps.extraction.fromText({
              shopId: input.shopId,
              text: heard,
              languageHint: input.language,
              traceId: input.traceId,
            });
          }

          if (input.bytes === undefined || input.contentType === undefined) {
            throw new Error('A voice-note intake needs audio bytes and their content type');
          }
          return await this.deps.extraction.fromVoice({
            shopId: input.shopId,
            bytes: input.bytes,
            contentType: input.contentType,
            languageHint: input.language,
            traceId: input.traceId,
          });
        }

        case 'FORWARDED_TEXT':
        case 'CONSOLE_FORM': {
          const text = (input.text ?? '').trim();
          if (text.length === 0) throw new Error('There is no text to read a job card from');
          return await this.deps.extraction.fromText({
            shopId: input.shopId,
            text,
            languageHint: input.language,
            traceId: input.traceId,
          });
        }
      }
    } catch (error) {
      if (error instanceof IntakeExtractionFailedError) throw error;
      throw new IntakeExtractionFailedError(input.source, error);
    }
  }

  private async confirmationThreshold(shopId: string): Promise<number> {
    return this.deps.uow.transaction(async (tx) => {
      const stored = await this.deps.config.load(tx, shopId);
      const timezone = (await this.deps.config.loadShopTimezone(tx, shopId)) ?? 'Asia/Kolkata';
      return migrateShopConfig(stored?.raw ?? {}, timezone).config.intake.confirmationThreshold;
    });
  }
}

/* -------------------------------------------------------------------------- *
 * The confirmation message
 * -------------------------------------------------------------------------- */

/** WhatsApp allows three reply buttons, and this flow needs exactly three. */
export function draftActionButtons(draftId: string): readonly OutboundButton[] {
  return [
    { id: DRAFT_ACTION_IDS.confirm(draftId), title: 'Confirm' },
    { id: DRAFT_ACTION_IDS.edit(draftId), title: 'Edit in console' },
    { id: DRAFT_ACTION_IDS.discard(draftId), title: 'Discard' },
  ];
}

/**
 * WhatsApp caps an interactive body at 1024 characters, and a job card with
 * fifteen estimate lines will exceed it. The tail is what gets trimmed: the
 * summary puts the count of uncertain fields in its first line and the "Edit in
 * console" button is right there, so a human who needs the full list has one
 * tap to it. Truncating anywhere else would hide a line silently.
 */
const INTERACTIVE_BODY_LIMIT = 1024;

export function draftSummaryContent(
  summary: DraftSummary,
  draftId: string,
  _language: Language,
): OutboundContent {
  // `summary.body` already ends with the correction prompt in the thread's
  // language; repeating it in a footer would say the same thing twice.
  const body =
    summary.body.length <= INTERACTIVE_BODY_LIMIT
      ? summary.body
      : `${summary.body.slice(0, INTERACTIVE_BODY_LIMIT - 1)}…`;

  return { kind: 'interactive', body, buttons: draftActionButtons(draftId) };
}
