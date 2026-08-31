import type {
  DraftExtractionPort,
  ExtractedDraft,
  PhotoExtractInput,
  TextExtractInput,
  VoiceExtractInput,
} from '@serviceloop/domain';
import type { OcrPort } from '../ocr/port';
import type { LlmTextDraftExtractor, VoiceNoteDraftExtractor } from './draft-extractors';

/**
 * The three on-ramps behind one port (phase 2.5–2.7).
 *
 * The domain declares `DraftExtractionPort` because it needs *a draft from an
 * input*, not because it wants to know that a photograph goes to a vision model
 * and a voice note goes to a recogniser first. This class is the only place
 * that knows which reader answers which question — which is what lets the eval
 * harness swap the vision adapter for a fixture set, and phase 4 swap the mock
 * recogniser for Sarvam, without either touching the intake pipeline.
 */
export class AdapterDraftExtraction implements DraftExtractionPort {
  constructor(
    private readonly ocr: OcrPort,
    private readonly text: LlmTextDraftExtractor,
    private readonly voice: VoiceNoteDraftExtractor,
  ) {}

  async fromPhoto(input: PhotoExtractInput): Promise<ExtractedDraft> {
    const extraction = await this.ocr.extractJobCard({
      shopId: input.shopId,
      bytes: input.bytes,
      contentType: input.contentType,
      ...(input.languageHint === undefined ? {} : { languageHint: input.languageHint }),
      ...(input.caption === undefined ? {} : { caption: input.caption }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    });

    return {
      draft: extraction.draft,
      model: extraction.model,
      promptHash: extraction.promptHash,
      latencyMs: extraction.latencyMs,
      raw: extraction.raw,
      // The caption is the only text a photograph carries, and it is often the
      // one thing the paper card does not say — "Ravi anna's Swift".
      sourceText: input.caption ?? null,
    };
  }

  async fromText(input: TextExtractInput): Promise<ExtractedDraft> {
    const extraction = await this.text.extractFromText({
      shopId: input.shopId,
      text: input.text,
      ...(input.languageHint === undefined ? {} : { languageHint: input.languageHint }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    });

    return {
      draft: extraction.draft,
      model: extraction.model,
      promptHash: extraction.promptHash,
      latencyMs: extraction.latencyMs,
      raw: extraction.raw,
      sourceText: extraction.sourceText,
    };
  }

  async fromVoice(input: VoiceExtractInput): Promise<ExtractedDraft> {
    const extraction = await this.voice.extractFromVoice({
      shopId: input.shopId,
      bytes: input.bytes,
      contentType: input.contentType,
      ...(input.languageHint === undefined ? {} : { languageHint: input.languageHint }),
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
    });

    return {
      draft: extraction.draft,
      model: extraction.model,
      promptHash: extraction.promptHash,
      latencyMs: extraction.latencyMs,
      raw: extraction.raw,
      // The transcript, not the parse of it. It is evidence in its own right
      // (L7) and is what a later claim about this visit traces back to.
      sourceText: extraction.transcript.text,
    };
  }
}
