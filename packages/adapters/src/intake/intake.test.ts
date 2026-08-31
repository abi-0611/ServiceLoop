import { describe, expect, it } from 'vitest';
import type { JobCardDraft } from '@serviceloop/shared';
import { extractDraftFromText } from '../llm/heuristic-draft';
import { SandboxLlmAdapter } from '../llm/sandbox-adapter';
import { MockSpeechAdapter } from '../speech/mock-adapter';
import { EmptyIntakeTextError, LlmTextDraftExtractor, VoiceNoteDraftExtractor } from './draft-extractors';
import { INTAKE_MESSAGE_FIXTURES } from './intake-fixtures';

function complaintTexts(draft: JobCardDraft): string {
  return [
    ...draft.complaints.map((entry) => entry.value),
    ...draft.estimateLines.map((line) => line.description.value),
  ].join(' | ');
}

function quotedPaise(draft: JobCardDraft): number {
  return draft.estimateLines.reduce((sum, line) => sum + (line.unitPricePaise.value ?? 0), 0);
}

/**
 * Phase 2.7's acceptance check: ten forwarded messages, including Tamil-English
 * and Hindi-English code-switch, parse to correct drafts.
 */
describe('forwarded-message corpus', () => {
  it('has ten fixtures spanning every launch language', () => {
    expect(INTAKE_MESSAGE_FIXTURES).toHaveLength(10);
    const languages = new Set(INTAKE_MESSAGE_FIXTURES.map((fixture) => fixture.expect.language));
    expect([...languages].sort()).toEqual(['en', 'hi', 'ta']);
  });

  for (const fixture of INTAKE_MESSAGE_FIXTURES) {
    it(`parses ${fixture.id} (${fixture.register})`, () => {
      const { draft } = extractDraftFromText(fixture.text);
      const expected = fixture.expect;

      expect(draft.language, 'language').toBe(expected.language);

      if (expected.customerName !== undefined) {
        expect(draft.customer.name.value, 'customer name').toBe(expected.customerName);
      }
      if (expected.registration !== undefined) {
        expect(draft.vehicle.registration.value, 'registration').toBe(expected.registration);
      }
      if (expected.model !== undefined) {
        expect(draft.vehicle.model.value, 'model').toBe(expected.model);
      }
      if (expected.make !== undefined) {
        expect(draft.vehicle.make.value, 'make').toBe(expected.make);
      }
      if (expected.phone !== undefined) {
        expect(draft.customer.phone.value, 'phone').toBe(expected.phone);
      }
      if (expected.promisedAt !== undefined) {
        expect(draft.promisedAt.value, 'promised at').toBe(expected.promisedAt);
      }
      if (expected.totalQuotedPaise !== undefined) {
        expect(quotedPaise(draft), 'quoted total').toBe(expected.totalQuotedPaise);
      }

      const haystack = complaintTexts(draft).toLowerCase();
      for (const needle of expected.complaints) {
        expect(haystack, `complaint "${needle}"`).toContain(needle.toLowerCase());
      }
    });
  }

  it('never invents a field the message did not carry', () => {
    for (const fixture of INTAKE_MESSAGE_FIXTURES) {
      const { draft } = extractDraftFromText(fixture.text);
      if (fixture.expect.phone === undefined) {
        expect(draft.customer.phone.value, fixture.id).toBeNull();
      }
      // No message in the corpus states an odometer reading or an advisor.
      expect(draft.vehicle.odometerKm.value, fixture.id).toBeNull();
      expect(draft.advisorName.value, fixture.id).toBeNull();
    }
  });

  it('keeps every confidence inside 0–1 and leaves absent fields at zero', () => {
    for (const fixture of INTAKE_MESSAGE_FIXTURES) {
      const { draft } = extractDraftFromText(fixture.text);
      expect(draft.advisorName.confidence, fixture.id).toBe(0);
      expect(draft.vehicle.odometerKm.confidence, fixture.id).toBe(0);
      for (const line of draft.estimateLines) {
        expect(line.description.confidence).toBeGreaterThan(0);
        expect(line.description.confidence).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('LlmTextDraftExtractor', () => {
  it('runs the whole path through the port and returns provenance', async () => {
    const extractor = new LlmTextDraftExtractor(new SandboxLlmAdapter());

    const result = await extractor.extractFromText({
      shopId: 'shop-1',
      text: 'Ravi anna Swift MH12 brake pad + oil change 3500 evening delivery',
    });

    expect(result.draft.customer.name.value).toBe('Ravi');
    // EXTRACT, not CLASSIFY: producing a typed document from free text is the
    // same task class as reading a photographed card (phase 3.1).
    expect(result.model).toBe('sandbox-extract');
    expect(result.promptHash).toHaveLength(64);
    expect(result.sourceText).toContain('Ravi anna');
    expect(JSON.parse(result.raw)).toEqual(result.draft);
  });

  it('refuses an empty message instead of producing a blank card', async () => {
    const extractor = new LlmTextDraftExtractor(new SandboxLlmAdapter());
    await expect(
      extractor.extractFromText({ shopId: 'shop-1', text: '   ' }),
    ).rejects.toBeInstanceOf(EmptyIntakeTextError);
  });
});

describe('VoiceNoteDraftExtractor', () => {
  const audio = Buffer.from('RIFF....WAVEfmt ', 'ascii');

  it('transcribes then parses, and keeps the transcript as evidence', async () => {
    const speech = new MockSpeechAdapter();
    speech.register(audio, {
      text: 'Selvam thambi vandi TN10CD9090 Ertiga battery replace pannunga 5600 inniku',
      language: 'ta',
    });

    const extractor = new VoiceNoteDraftExtractor(
      speech,
      new LlmTextDraftExtractor(new SandboxLlmAdapter()),
    );

    const result = await extractor.extractFromVoice({
      shopId: 'shop-1',
      bytes: audio,
      contentType: 'audio/wav',
    });

    expect(result.transcript.language).toBe('ta');
    expect(result.draft.vehicle.registration.value).toBe('TN10CD9090');
    expect(result.sourceText).toContain('Selvam');
  });

  it('surfaces unregistered audio rather than returning an empty transcript', async () => {
    const extractor = new VoiceNoteDraftExtractor(
      new MockSpeechAdapter(),
      new LlmTextDraftExtractor(new SandboxLlmAdapter()),
    );

    await expect(
      extractor.extractFromVoice({
        shopId: 'shop-1',
        bytes: Buffer.from('unknown'),
        contentType: 'audio/wav',
      }),
    ).rejects.toMatchObject({ kind: 'NO_FIXTURE' });
  });
});
