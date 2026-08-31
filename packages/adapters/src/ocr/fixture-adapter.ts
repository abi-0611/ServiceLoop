import { createHash } from 'node:crypto';
import { JobCardDraftSchema, type JobCardDraft } from '@serviceloop/shared';
import { LlmError } from '../llm/port';
import { JOB_CARD_DRAFT_SCHEMA_NAME } from '../llm/schemas';
import { toVisionMediaType, type OcrExtractInput, type OcrExtraction, type OcrPort } from './port';

/**
 * `FixtureOcrAdapter` — the deterministic OCR adapter.
 *
 * Images are keyed by the sha256 of their bytes, so a fixture that is re-encoded
 * or re-rendered stops matching instead of silently drifting away from its
 * expected JSON. `pnpm eval:ocr` uses it as the control arm, the seeded demo
 * uses it so a photo intake works with no credentials, and CI uses it because a
 * flaky OCR run is worse than no OCR run.
 *
 * It never falls back to a guess. An unregistered image raises, because the one
 * thing a fixture adapter must not do is invent a job card that a later test
 * then asserts against.
 */
export class FixtureOcrAdapter implements OcrPort {
  readonly driver = 'fixture' as const;

  private readonly byHash = new Map<string, { draft: JobCardDraft; label: string }>();

  constructor(fixtures: ReadonlyArray<{ bytes: Buffer; draft: unknown; label?: string }> = []) {
    for (const fixture of fixtures) {
      this.register(fixture.bytes, fixture.draft, fixture.label);
    }
  }

  register(bytes: Buffer, draft: unknown, label?: string): string {
    const hash = sha256(bytes);
    this.byHash.set(hash, {
      draft: JobCardDraftSchema.parse(draft),
      label: label ?? hash.slice(0, 12),
    });
    return hash;
  }

  has(bytes: Buffer): boolean {
    return this.byHash.has(sha256(bytes));
  }

  get size(): number {
    return this.byHash.size;
  }

  async extractJobCard(input: OcrExtractInput): Promise<OcrExtraction> {
    // Validate the type even though we will not decode the image: a caller that
    // hands a PDF to the fixture adapter has a bug the real adapter would also
    // have found, and it should surface in the cheap run, not the expensive one.
    toVisionMediaType(input.contentType);

    const hash = sha256(input.bytes);
    const fixture = this.byHash.get(hash);
    if (fixture === undefined) {
      throw new LlmError(
        'NO_RESPONDER',
        `No OCR fixture is registered for image ${hash.slice(0, 12)}; register one before extracting`,
        { model: 'fixture-ocr', context: { registered: this.byHash.size } },
      );
    }

    const raw = JSON.stringify(fixture.draft);
    return {
      draft: fixture.draft,
      model: `fixture-ocr:${fixture.label}`,
      // Stable across runs, and distinct per fixture, so provenance on a draft
      // still answers "which extraction produced this".
      promptHash: createHash('sha256')
        .update(`${JOB_CARD_DRAFT_SCHEMA_NAME}:${hash}`)
        .digest('hex'),
      latencyMs: 0,
      raw,
    };
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
