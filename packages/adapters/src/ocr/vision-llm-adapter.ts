import { jobCardDraftLlmSchema } from '../llm/schemas';
import type { LlmPort } from '../llm/port';
import { toVisionMediaType, type OcrExtractInput, type OcrExtraction, type OcrPort } from './port';
import { buildVisionUserPrompt, VISION_SYSTEM_PROMPT } from './vision-prompt';

/**
 * `VisionLlmOcrAdapter` — the real OCR path, over `LlmPort`.
 *
 * It holds no provider knowledge of its own: whichever LLM adapter is live
 * underneath, this class sends the same system prompt, the same image and the
 * same output schema. That is what makes the sandbox honest — the *identical*
 * code path runs in CI, with the sandbox LLM resolving the image against a
 * registered fixture instead of calling out.
 */

export interface VisionOcrOptions {
  /**
   * Output budget for the extraction. A dense card with fifteen priced lines
   * runs to a few thousand tokens of JSON, and a truncated response is a hard
   * failure rather than a partial card.
   */
  readonly maxOutputTokens?: number;
}

export class VisionLlmOcrAdapter implements OcrPort {
  readonly driver = 'vision-llm' as const;

  constructor(
    private readonly llm: LlmPort,
    private readonly options: VisionOcrOptions = {},
  ) {}

  async extractJobCard(input: OcrExtractInput): Promise<OcrExtraction> {
    const mediaType = toVisionMediaType(input.contentType);

    const result = await this.llm.extract({
      taskClass: 'EXTRACT',
      system: VISION_SYSTEM_PROMPT,
      maxOutputTokens: this.options.maxOutputTokens ?? 8_000,
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      schema: jobCardDraftLlmSchema,
      messages: [
        {
          role: 'user',
          content: [
            // Image first: the model reads the page, then the instructions
            // about what to do with it, which keeps the instructions closest to
            // the generation boundary.
            { kind: 'image', mediaType, bytes: input.bytes },
            {
              kind: 'text',
              text: buildVisionUserPrompt({
                ...(input.languageHint === undefined ? {} : { languageHint: input.languageHint }),
                ...(input.caption === undefined ? {} : { caption: input.caption }),
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
    };
  }
}
