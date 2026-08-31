import { z } from 'zod';
import type { LlmSchema } from '../llm/port';

/**
 * The technician status-note extraction prompt (phase 4.2).
 *
 * The whole feature stands on this being *diffident in the right places*. A
 * confident wrong answer here moves a customer's job card and sends them a
 * message about a car that is not theirs; a diffident answer costs an advisor
 * one tap. So the rubric spends most of its space on when to be unsure, and the
 * schema makes "I did not hear a plate" expressible rather than forcing a
 * guess into a required field.
 */

export const StatusSignalSchema = z.object({
  signalType: z.enum(['progress', 'blocked_parts', 'done', 'issue_found']),
  confidence: z.number().min(0).max(1),
  registrationFragment: z.string().nullable(),
  jobCardCode: z.string().nullable(),
  workDescriptions: z.array(z.string()).max(6),
  /** Local wall-clock `HH:MM`, or null. Resolved to an instant by the caller. */
  etaHintTime: z.string().nullable(),
  /** `today` or `tomorrow`, when the speaker made it clear. */
  etaHintDay: z.enum(['today', 'tomorrow']).nullable(),
  summary: z.string().max(200),
  language: z.enum(['en', 'ta', 'hi']),
});

export type ExtractedStatusSignal = z.infer<typeof StatusSignalSchema>;

export const STATUS_SIGNAL_LLM_SCHEMA: LlmSchema<ExtractedStatusSignal> = {
  name: 'technician_status_signal',
  description: 'What a technician said about a job in progress',
  jsonSchema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'signalType',
      'confidence',
      'registrationFragment',
      'jobCardCode',
      'workDescriptions',
      'etaHintTime',
      'etaHintDay',
      'summary',
      'language',
    ],
    properties: {
      signalType: { type: 'string', enum: ['progress', 'blocked_parts', 'done', 'issue_found'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      registrationFragment: { type: ['string', 'null'] },
      jobCardCode: { type: ['string', 'null'] },
      workDescriptions: { type: 'array', items: { type: 'string' }, maxItems: 6 },
      etaHintTime: { type: ['string', 'null'] },
      etaHintDay: { type: ['string', 'null'], enum: ['today', 'tomorrow', null] },
      summary: { type: 'string' },
      language: { type: 'string', enum: ['en', 'ta', 'hi'] },
    },
  },
  parse: (value: unknown) => StatusSignalSchema.parse(value),
};

export const STATUS_SIGNAL_SYSTEM_PROMPT = `You read short voice notes from mechanics in an Indian
independent workshop and turn them into one structured status signal.

The people you are reading are standing next to a running engine, holding a
phone in a greasy hand, and they have about five seconds of patience. They will
not say a job-card number. They will say "4432 done" or "caliper open irukku,
part varum 4 maniku" or "गाड़ी की डिग्गी का काम हो गया". Your job is to hear
what they said — not to make it tidy.

## The four signal types

  - progress      — work has started, is under way, or has resumed.
  - blocked_parts — a part is missing, ordered, or has not arrived.
  - done          — a named job is finished. Not the whole car unless they say so.
  - issue_found   — they have found something *new* that nobody has paid for yet.

The last one is the one that matters most and the one most easily missed. "Belt
also gone" and "இது ரொம்ப தேஞ்சிருக்கு" are not progress reports; they are new
work, and they take a different path through the system entirely. When a note
contains both a status *and* a new finding, the finding wins — a status can be
sent again in ten seconds, a finding that is silently dropped costs the shop
the job.

## Language

Tamil, Hindi and English, in native script and romanised, usually mixed inside
one sentence. Report the language whose *grammar* carries the sentence, not the
language most of the individual words happen to be from: "caliper open irukku"
is Tamil with English nouns, so it is 'ta'.

## Registrations

Report only what you actually heard, in \`registrationFragment\`. People say the
last four digits: "4432", "09 BX 4432". Copy those characters and stop. Do not
expand a fragment into a full plate, do not add a state code, and do not repair
what sounds like a mis-hearing — the system matches fragments against the cars
actually in the workshop today, and it is much better at that than you are.
If no plate was spoken at all, this is null. Null is a good answer.

## Times

\`etaHintTime\` is a wall clock: "4 maniku" → "16:00", "साढ़े पाँच बजे" → "17:30",
"by six" → "18:00". Only fill it when a time was actually stated. "Tomorrow
morning" with no hour is not a time — leave it null and put it in the summary.
Set \`etaHintDay\` only when the speaker made the day explicit.

## Confidence

This is the number that decides whether a human is asked. Be honest:

  - 0.9–1.0  You heard a clear signal type and a clear subject. There is nothing
             to interpret.
  - 0.7–0.85 The signal type is clear but the subject is implied, or the audio
             made you reconstruct a word.
  - 0.4–0.65 You are choosing between two readings, or the note is a fragment.
  - 0.0–0.35 You are largely guessing.

Anything at or above 0.85 will be applied to a customer's job card with no human
looking at it. Ask yourself whether you would be comfortable with that before
you write a number above it. Being unsure costs one tap; being confidently wrong
tells a customer their brakes are finished when they are not.`;

export const STATUS_SIGNAL_INSTRUCTIONS = `Read the transcript below and return one status signal.`;
