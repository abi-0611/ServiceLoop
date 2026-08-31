import { JobCardDraftSchema, LANGUAGES, type JobCardDraft } from '@serviceloop/shared';
import type { LlmSchema } from './port';

/**
 * The wire schema for job-card extraction.
 *
 * Two schemas describe the same document on purpose. This one constrains the
 * *model* — it goes out as `output_config.format`, so the JSON comes back in
 * shape rather than being coaxed there by prompt wording. `JobCardDraftSchema`
 * (zod) then validates what arrives, and it is the authority: bounds, ranges
 * and defaults live there, because structured outputs deliberately support only
 * a subset of JSON Schema (no `minimum`, no `maxLength`, no recursion).
 *
 * Keeping both means a model that satisfies the provider's validator but not
 * ours fails loudly at the boundary instead of writing a bad row.
 */

export const JOB_CARD_DRAFT_SCHEMA_NAME = 'job_card_draft';

function confident(valueSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'confidence', 'region'],
    properties: {
      value: valueSchema,
      confidence: {
        type: 'number',
        description:
          'How certain you are of this exact value, 0 to 1. Be honest: a field you guessed must score low so a human is asked about it.',
      },
      region: { $ref: '#/$defs/sourceRegion' },
    },
  };
}

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
const nullableInteger = { anyOf: [{ type: 'integer' }, { type: 'null' }] };

export const JOB_CARD_DRAFT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'customer',
    'vehicle',
    'complaints',
    'estimateLines',
    'advisorName',
    'promisedAt',
    'language',
    'notes',
  ],
  properties: {
    customer: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'phone'],
      properties: {
        name: confident({ type: 'string' }),
        phone: confident({
          ...nullableString,
          description: 'Exactly the digits written on the card. Do not add a country code.',
        }),
      },
    },
    vehicle: {
      type: 'object',
      additionalProperties: false,
      required: ['registration', 'make', 'model', 'odometerKm'],
      properties: {
        registration: confident({
          type: 'string',
          description:
            'The registration number as written, e.g. "TN 09 BX 4432" or a BH-series "24 BH 1234 AB".',
        }),
        make: confident(nullableString),
        model: confident(nullableString),
        odometerKm: confident({
          ...nullableInteger,
          description: 'Odometer reading in kilometres. Null when the card does not show one.',
        }),
      },
    },
    complaints: {
      type: 'array',
      description: 'What the customer reported, one entry per complaint, in the order written.',
      items: confident({ type: 'string' }),
    },
    estimateLines: {
      type: 'array',
      description: 'Priced work listed on the card, in the order written.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['description', 'quantityMilli', 'unitPricePaise'],
        properties: {
          description: confident({ type: 'string' }),
          quantityMilli: confident({
            type: 'integer',
            description: 'Quantity times 1000. One item is 1000; one and a half is 1500.',
          }),
          unitPricePaise: confident({
            ...nullableInteger,
            description:
              'Unit price in paise (rupees times 100). Null when the line carries no price.',
          }),
        },
      },
    },
    advisorName: confident(nullableString),
    promisedAt: confident({
      ...nullableString,
      description:
        'ISO-8601 timestamp when the card states a resolvable date and time; otherwise the phrase exactly as written ("evening", "tomorrow 5pm"). Never invent a date.',
    }),
    language: {
      type: 'string',
      enum: [...LANGUAGES],
      description: 'The language the card is written in.',
    },
    notes: {
      type: 'string',
      description:
        'Anything legible that did not fit a field above, plus what was struck through or unreadable. Empty string when there is nothing.',
    },
  },
  $defs: {
    sourceRegion: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['x', 'y', 'width', 'height', 'page'],
          description:
            'Where on the image this value was read, as fractions of width and height from the top-left.',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
            page: { type: 'integer' },
          },
        },
        { type: 'null' },
      ],
    },
  },
} as const satisfies Record<string, unknown>;

export const jobCardDraftLlmSchema: LlmSchema<JobCardDraft> = {
  name: JOB_CARD_DRAFT_SCHEMA_NAME,
  description: 'A job card read off a paper form, a forwarded message or a voice note.',
  jsonSchema: JOB_CARD_DRAFT_JSON_SCHEMA,
  parse: (value) => JobCardDraftSchema.parse(value),
};
