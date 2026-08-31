import { describe, expect, it } from 'vitest';
import { JobCardDraftSchema } from '@serviceloop/shared';
import { extractDraftFromText } from './heuristic-draft';
import {
  hashPrompt,
  LlmError,
  parseJsonObject,
  requestImage,
  requestText,
  userText,
  type LlmRequest,
} from './port';
import { SandboxLlmAdapter } from './sandbox-adapter';
import { jobCardDraftLlmSchema, JOB_CARD_DRAFT_JSON_SCHEMA } from './schemas';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000',
  'hex',
);

function request(text: string): LlmRequest {
  return { taskClass: 'CLASSIFY', messages: [userText(text)] };
}

describe('prompt hashing', () => {
  it('is stable for the same prompt and differs for any change', () => {
    const a = hashPrompt(request('brake pad'), 'job_card_draft');
    const b = hashPrompt(request('brake pad'), 'job_card_draft');
    const c = hashPrompt(request('brake pads'), 'job_card_draft');
    const d = hashPrompt(request('brake pad'), 'other_schema');

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });

  it('folds image bytes in by hash rather than by content', () => {
    const withImage: LlmRequest = {
      taskClass: 'EXTRACT',
      messages: [{ role: 'user', content: [{ kind: 'image', mediaType: 'image/png', bytes: PNG }] }],
    };
    const other: LlmRequest = {
      taskClass: 'EXTRACT',
      messages: [
        {
          role: 'user',
          content: [{ kind: 'image', mediaType: 'image/png', bytes: Buffer.concat([PNG, PNG]) }],
        },
      ],
    };

    expect(hashPrompt(withImage)).toHaveLength(64);
    expect(hashPrompt(withImage)).not.toBe(hashPrompt(other));
  });
});

describe('response parsing', () => {
  it('accepts bare JSON, fenced JSON and JSON with a preamble', () => {
    const expected = { a: 1 };
    expect(parseJsonObject('{"a":1}', 'm')).toEqual(expected);
    expect(parseJsonObject('```json\n{"a":1}\n```', 'm')).toEqual(expected);
    expect(parseJsonObject('Here you go:\n{"a":1}', 'm')).toEqual(expected);
  });

  it('raises a schema mismatch rather than guessing when there is no JSON', () => {
    expect(() => parseJsonObject('I could not read the card.', 'm')).toThrow(LlmError);
    try {
      parseJsonObject('nope', 'm');
    } catch (error) {
      expect((error as LlmError).kind).toBe('SCHEMA_MISMATCH');
    }
  });
});

describe('request helpers', () => {
  it('collects text in order and finds the first image', () => {
    const req: LlmRequest = {
      taskClass: 'EXTRACT',
      messages: [
        {
          role: 'user',
          content: [
            { kind: 'text', text: 'one' },
            { kind: 'image', mediaType: 'image/png', bytes: PNG },
            { kind: 'text', text: 'two' },
          ],
        },
      ],
    };

    expect(requestText(req)).toBe('one\ntwo');
    expect(requestImage(req)?.mediaType).toBe('image/png');
    expect(requestImage(request('x'))).toBeNull();
  });
});

describe('job-card wire schema', () => {
  it('is a closed object, as structured outputs require', () => {
    expect(JOB_CARD_DRAFT_JSON_SCHEMA.type).toBe('object');
    expect(JOB_CARD_DRAFT_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('closes every nested object too', () => {
    const open: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
        return;
      }
      const record = node as Record<string, unknown>;
      if (record['type'] === 'object' && record['additionalProperties'] !== false) {
        open.push(path);
      }
      for (const [key, value] of Object.entries(record)) walk(value, `${path}.${key}`);
    };

    walk(JOB_CARD_DRAFT_JSON_SCHEMA, '$');
    expect(open).toEqual([]);
  });

  it('carries no constraint keyword structured outputs would reject', () => {
    const banned = ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf', 'pattern'];
    const found: string[] = [];
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (banned.includes(key)) found.push(key);
        walk(value);
      }
    };

    walk(JOB_CARD_DRAFT_JSON_SCHEMA);
    expect(found).toEqual([]);
  });
});

describe('SandboxLlmAdapter', () => {
  it('extracts a job card from text, deterministically', async () => {
    const llm = new SandboxLlmAdapter();
    const message = 'Ravi anna Swift MH12 brake pad + oil change 3500 evening delivery';

    const first = await llm.extract({
      taskClass: 'CLASSIFY',
      messages: [userText(message)],
      schema: jobCardDraftLlmSchema,
    });
    const second = await llm.extract({
      taskClass: 'CLASSIFY',
      messages: [userText(message)],
      schema: jobCardDraftLlmSchema,
    });

    expect(first.value).toEqual(second.value);
    expect(first.promptHash).toBe(second.promptHash);
    expect(first.value.customer.name.value).toBe('Ravi');
    expect(first.value.vehicle.model.value).toBe('Swift');
  });

  it('resolves a registered image fixture by content hash', async () => {
    const llm = new SandboxLlmAdapter();
    const draft = extractDraftFromText('Kumar sir TN09BX4432 Alto oil change 2400 today').draft;
    llm.registerImageFixture(PNG, draft);

    const result = await llm.extract({
      taskClass: 'EXTRACT',
      messages: [
        { role: 'user', content: [{ kind: 'image', mediaType: 'image/png', bytes: PNG }] },
      ],
      schema: jobCardDraftLlmSchema,
    });

    expect(result.value.vehicle.registration.value).toBe('TN09BX4432');
    expect(llm.recordedCalls()[0]?.responder).toBe('image-fixture');
  });

  it('refuses an unregistered image rather than inventing a card', async () => {
    const llm = new SandboxLlmAdapter();
    await expect(
      llm.extract({
        taskClass: 'EXTRACT',
        messages: [
          { role: 'user', content: [{ kind: 'image', mediaType: 'image/png', bytes: PNG }] },
        ],
        schema: jobCardDraftLlmSchema,
      }),
    ).rejects.toMatchObject({ kind: 'NO_RESPONDER' });
  });

  it('holds its own responders to the schema contract', async () => {
    const llm = new SandboxLlmAdapter({
      responders: [
        {
          name: 'bad',
          matches: (_request, schemaName) => schemaName === 'job_card_draft',
          extract: () => ({ nonsense: true }),
        },
      ],
    });

    await expect(
      llm.extract({
        taskClass: 'CLASSIFY',
        messages: [userText('anything')],
        schema: jobCardDraftLlmSchema,
      }),
    ).rejects.toMatchObject({ kind: 'SCHEMA_MISMATCH' });
  });

  it('reports the configured model ids so the boot log and audit agree', () => {
    const llm = new SandboxLlmAdapter({ models: { EXTRACT: 'sandbox-extract-2' } });
    expect(llm.modelFor('EXTRACT')).toBe('sandbox-extract-2');
    expect(llm.modelFor('JUDGE')).toBe('sandbox-judge');
    expect(llm.driver).toBe('sandbox');
  });
});

describe('heuristic draft extraction', () => {
  it('produces a draft the shared schema accepts', () => {
    const { draft } = extractDraftFromText('Swift TN09BX4432 oil change 2400');
    expect(() => JobCardDraftSchema.parse(draft)).not.toThrow();
  });

  it('scores a repaired registration far below a clean one', () => {
    const clean = extractDraftFromText('TN09BX4432 oil change').draft;
    // The classic OCR slip: a letter O read where the RTO digit belongs.
    const repaired = extractDraftFromText('TNO9BX4432 oil change').draft;

    expect(clean.vehicle.registration.value).toBe('TN09BX4432');
    expect(repaired.vehicle.registration.value).toBe('TN09BX4432');
    expect(repaired.vehicle.registration.confidence).toBeLessThan(
      clean.vehicle.registration.confidence,
    );
  });

  it('will not repair a plate into a state code that does not exist', () => {
    // `1N` looks like `TN`, but `IN` is not an RTO code and inventing one
    // creates a vehicle record nobody can ever match again.
    const { draft } = extractDraftFromText('1N09BX4432 oil change');
    expect(draft.vehicle.registration.value).toBe('');
    expect(draft.vehicle.registration.confidence).toBe(0);
  });

  it('scores an inferred make below the model that was actually written', () => {
    const { draft } = extractDraftFromText('Baleno KA05MG1234 brake pad');
    expect(draft.vehicle.model.value).toBe('Baleno');
    expect(draft.vehicle.make.value).toBe('Maruti Suzuki');
    expect(draft.vehicle.make.confidence).toBeLessThan(draft.vehicle.model.confidence);
  });

  it('refuses to split one quoted amount across several items', () => {
    const { draft } = extractDraftFromText('brake pad + oil change 3500 total');
    const priced = draft.estimateLines.filter((line) => line.unitPricePaise.value !== null);

    expect(draft.estimateLines).toHaveLength(2);
    expect(priced).toHaveLength(1);
    expect(priced[0]?.unitPricePaise.value).toBe(350_000);
    // One figure for two jobs is an attribution guess, and is scored as one.
    expect(priced[0]?.unitPricePaise.confidence).toBeLessThan(0.5);
  });

  it('keeps a vague promised time as words rather than inventing a timestamp', () => {
    const { draft } = extractDraftFromText('Swift oil change evening delivery');
    expect(draft.promisedAt.value).toBe('this evening');
    expect(Number.isNaN(new Date(draft.promisedAt.value ?? '').getTime())).toBe(true);
  });

  it('ignores an RTO code when reading prices', () => {
    const { draft } = extractDraftFromText('MH12 AB 1234 oil change 2400');
    const prices = draft.estimateLines.map((line) => line.unitPricePaise.value);
    expect(prices).toEqual([240_000]);
  });
});
