import type { LlmPort } from '@serviceloop/adapters';
import { fencePayload, userText } from '@serviceloop/adapters';
import { sourceId, type Claim, type ExplanationWriter } from '@serviceloop/domain';
import { formatPaise, type Language } from '@serviceloop/shared';
import { z } from 'zod';

/**
 * The plain-language explanation for an evidence bundle (phase 3.4).
 *
 * The hard rule is structural, not stylistic: this writer sees the technician
 * notes, the estimate lines and the media captions, and **nothing else**. It
 * cannot restate a diagnosis nobody made because it was never shown one, and
 * the builder re-checks every source id it returns against the sources it was
 * given.
 *
 * The output is `claims[]` — one sentence per entry, each mapped to the source
 * ids it restates — rather than prose the checker would have to segment
 * afterwards. Asking the model to do the mapping while it writes is both more
 * accurate and cheaper than reverse-engineering it later, and it makes the
 * failure mode legible: a sentence with an empty `sources` array is a sentence
 * the model knew it was inventing.
 */

const ExplanationSchema = z.object({
  sentences: z
    .array(
      z.object({
        text: z.string().min(1).max(400),
        sources: z.array(z.string().min(3).max(80)),
      }),
    )
    .min(1)
    .max(12),
});

type Explanation = z.infer<typeof ExplanationSchema>;

const EXPLANATION_LLM_SCHEMA: {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  parse(value: unknown): Explanation;
} = {
  name: 'evidence_explanation',
  description: 'A plain-language explanation, one sentence per entry, each citing its sources',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['sentences'],
    properties: {
      sentences: {
        type: 'array',
        description: 'The explanation, in order. Four to eight sentences is right.',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'sources'],
          properties: {
            text: {
              type: 'string',
              description: 'One sentence, in the customer’s language, at their reading level.',
            },
            sources: {
              type: 'array',
              description:
                'The ids this sentence restates. Empty only for a greeting or a question — never for a statement about the vehicle.',
              items: { type: 'string' },
            },
          },
        },
      },
    },
  },
  parse: (value: unknown) => ExplanationSchema.parse(value),
};

const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  en: 'English',
  ta: 'Tamil',
  hi: 'Hindi',
};

export const EXPLANATION_SYSTEM_PROMPT = `You write the few sentences a vehicle owner reads before deciding
whether to spend money.

You are given: a technician's own words, the estimate lines, and captions for
any photos. That is the whole world. You may restate what is there, in simpler
language and in the customer's own language. You may not add anything.

Specifically, you may not:
  - name a cause the technician did not name;
  - say anything is dangerous, urgent or unsafe unless the technician said so;
  - state a measurement, a percentage or a price that is not in the sources;
  - predict what will happen if the work is not done;
  - promise when the vehicle will be ready;
  - use exclamation marks, sales language, or urgency the notes do not carry.

Every sentence you write must list the ids it restates. A sentence about the
vehicle with no source id will be rejected and the whole message will be held
for a human, so if you cannot source a sentence, do not write it.

Write four to eight short sentences. Say what was found, what it means in plain
terms, what it costs, and stop. A technician's shorthand ("pad 2.1mm, min 3")
becomes "the brake pads have worn down to 2.1 mm; the minimum is 3 mm" — that is
a restatement, not an addition.

Match the customer's language exactly, including code-switching if the
technician's note is code-switched and the customer writes that way.`;

export interface LlmExplanationWriterOptions {
  readonly maxOutputTokens?: number;
}

export class LlmExplanationWriter implements ExplanationWriter {
  constructor(
    private readonly llm: LlmPort,
    private readonly options: LlmExplanationWriterOptions = {},
  ) {}

  async write(input: Parameters<ExplanationWriter['write']>[0]): ReturnType<
    ExplanationWriter['write']
  > {
    const payload = [
      `Customer: ${input.customerName}`,
      `Vehicle: ${input.vehicleLabel}`,
      `Write in: ${LANGUAGE_NAMES[input.language]}`,
      '',
      'TECHNICIAN NOTES:',
      ...input.notes.map(
        (note) => `  ${sourceId({ kind: 'TECHNICIAN_NOTE', id: note.id })} — ${note.text}`,
      ),
      '',
      'ESTIMATE LINES:',
      ...input.lines.map(
        (line) =>
          `  ${sourceId({ kind: 'ESTIMATE_LINE', id: line.id })} — ${line.description}: ${formatPaise(
            line.lineTotalPaise,
          )}`,
      ),
      '',
      'PHOTOS:',
      ...(input.media.length === 0
        ? ['  (none)']
        : input.media.map(
            (asset) =>
              `  ${sourceId({ kind: 'MEDIA', id: asset.id })} — ${asset.caption ?? asset.kind.toLowerCase()}`,
          )),
      '',
      `TOTAL: ${formatPaise(input.totalPaise)}`,
    ].join('\n');

    const result = await this.llm.extract({
      taskClass: 'EXTRACT',
      shopId: input.shopId,
      traceId: input.traceId,
      system: EXPLANATION_SYSTEM_PROMPT,
      maxOutputTokens: this.options.maxOutputTokens ?? 2_000,
      schema: EXPLANATION_LLM_SCHEMA,
      messages: [userText(fencePayload(payload))],
    });

    const claims: Claim[] = result.value.sentences.map((sentence) => ({
      text: sentence.text.trim(),
      sources: sentence.sources,
    }));

    return {
      summaryText: claims.map((claim) => claim.text).join(' '),
      claims,
      model: result.model,
      promptHash: result.promptHash,
    };
  }
}

/**
 * A deterministic writer for the sandbox and for CI.
 *
 * It is not a stub: it produces a real, correctly-anchored explanation by
 * restating each source in a fixed shape. That is exactly what the checker and
 * the simulator need — a bundle whose claims all map to real sources — and it
 * means the whole approval saga runs in CI with no model and no key. When the
 * simulator wants a *bad* explanation it registers a responder that produces
 * one, rather than this class producing one by accident.
 */
export class DeterministicExplanationWriter implements ExplanationWriter {
  async write(input: Parameters<ExplanationWriter['write']>[0]): ReturnType<
    ExplanationWriter['write']
  > {
    const claims: Claim[] = [];

    for (const note of input.notes) {
      claims.push({
        text: `While checking your ${input.vehicleLabel} the technician found: ${note.text.trim()}`,
        sources: [sourceId({ kind: 'TECHNICIAN_NOTE', id: note.id })],
      });
    }

    for (const line of input.lines) {
      claims.push({
        text: `${line.description} comes to ${formatPaise(line.lineTotalPaise)}.`,
        sources: [sourceId({ kind: 'ESTIMATE_LINE', id: line.id })],
      });
    }

    if (input.media.length > 0) {
      claims.push({
        text: `I have attached ${input.media.length === 1 ? 'a photo' : `${input.media.length} photos`} of what was found.`,
        sources: input.media.map((asset) => sourceId({ kind: 'MEDIA', id: asset.id })),
      });
    }

    return {
      summaryText: claims.map((claim) => claim.text).join(' '),
      claims,
      model: 'deterministic-explanation-writer',
      // A stable hash: two identical bundles produce identical audit rows, which
      // is what makes a CI failure reproduce on a developer's machine.
      promptHash: `deterministic:${input.notes.map((note) => note.id).join(',')}`,
    };
  }
}
