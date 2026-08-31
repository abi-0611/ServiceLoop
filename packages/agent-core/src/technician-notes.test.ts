import { HeuristicStatusSignalParser, MockSpeechAdapter, SpeechError } from '@serviceloop/adapters';
import type {
  CaptureOutcome,
  StatusSignalService,
  TechnicianNoteCaptureInput,
} from '@serviceloop/domain';
import { AUTO_APPLY_CONFIDENCE, noteIdentifiesAVehicle } from '@serviceloop/domain';
import { fixedClock } from '@serviceloop/shared';
import { describe, expect, it } from 'vitest';
import { TechnicianNoteIngestor } from './technician-notes';

/**
 * The join phase 4 was missing (4.2): audio → words → parse → signal.
 *
 * Driven with the *real* recogniser double and the *real* deterministic parser,
 * not stubs of either. What is stubbed is the status service, because what is
 * under test here is the seam — that the plates on the floor reach the
 * recogniser as hints, that the recogniser's confidence reaches the parse, and
 * that a note nobody can hear does not silently become a confident signal.
 */

const SHOP = '01920000-0000-7000-8000-0000000000aa';
const NOW = new Date('2026-08-17T05:30:00.000Z'); // 11:00 IST, a Monday
const AUDIO = Buffer.from('tamil-english-voice-note');

class RecordingSignals {
  readonly captured: TechnicianNoteCaptureInput[] = [];

  async capture(input: TechnicianNoteCaptureInput): Promise<CaptureOutcome> {
    this.captured.push(input);
    return {
      signalId: 'signal-1',
      route: 'AUTO_APPLIED',
      jobCardId: 'card-1',
      workItemIds: [],
      detail: 'applied',
      duplicate: false,
    };
  }

  async confirm(): Promise<CaptureOutcome> {
    throw new Error('not used');
  }

  async discard(): Promise<CaptureOutcome> {
    throw new Error('not used');
  }
}

function build(options: { hints?: readonly string[]; confidence?: number } = {}) {
  const speech = new MockSpeechAdapter();
  speech.register(AUDIO, {
    // The phase's own example: Tamil grammar, English nouns, a spoken plate
    // fragment and a time.
    text: 'caliper open irukku 4432, part varum 4 maniku',
    language: 'ta',
    ...(options.confidence === undefined ? {} : { confidence: options.confidence }),
  });

  const signals = new RecordingSignals();
  const hintsSeen: string[][] = [];

  const ingestor = new TechnicianNoteIngestor({
    speech: {
      driver: speech.driver,
      transcribe: async (input) => {
        hintsSeen.push([...(input.hints ?? [])]);
        return speech.transcribe(input);
      },
    },
    parser: new HeuristicStatusSignalParser(),
    signals: signals as unknown as StatusSignalService<unknown>,
    hints: async () => options.hints ?? ['TN09BX4432', 'TN10AB1111'],
    timezone: async () => 'Asia/Kolkata',
    clock: fixedClock(NOW),
  });

  return { ingestor, signals, hintsSeen, speech };
}

describe('TechnicianNoteIngestor', () => {
  it('turns a Tamil-English voice note into a signal confident enough to apply itself', async () => {
    const { ingestor } = build();

    const reading = await ingestor.read({
      shopId: SHOP,
      text: '',
      audio: { bytes: AUDIO, contentType: 'audio/wav' },
      languageHint: 'en',
      traceId: 'trace-1',
    });

    expect(reading).not.toBeNull();
    expect(reading?.transcript).toContain('4432');
    expect(reading?.parsed.signalType).toBe('blocked_parts');
    expect(reading?.parsed.registrationFragment).toBe('4432');
    // "4 maniku" at 11:00 IST is four this afternoon, not four tomorrow.
    expect(reading?.parsed.etaHint?.toISOString()).toBe('2026-08-17T10:30:00.000Z');
    // The recogniser heard Tamil; the hint said English, and what was heard wins.
    expect(reading?.parsed.language).toBe('ta');

    expect(noteIdentifiesAVehicle({ parsed: reading!.parsed, hasReplyContext: false })).toBe(true);
    expect(reading!.parsed.confidence).toBeGreaterThanOrEqual(AUTO_APPLY_CONFIDENCE);
  });

  it('hints the recogniser with the plates actually in the workshop', async () => {
    const { ingestor, hintsSeen } = build({ hints: ['TN09BX4432', 'TN22CJ7781'] });

    await ingestor.read({
      shopId: SHOP,
      text: '',
      audio: { bytes: AUDIO, contentType: 'audio/wav' },
      languageHint: 'ta',
      traceId: 'trace-1',
    });

    expect(hintsSeen[0]).toEqual(['TN09BX4432', 'TN22CJ7781']);
  });

  it('carries the recogniser doubt into the parse rather than dropping it at the seam', async () => {
    const clean = build();
    const shaky = build({ confidence: 0.6 });

    const input = {
      shopId: SHOP,
      text: '',
      audio: { bytes: AUDIO, contentType: 'audio/wav' },
      languageHint: 'ta' as const,
      traceId: 'trace-1',
    };

    const heardWell = await clean.ingestor.read(input);
    const heardBadly = await shaky.ingestor.read(input);

    expect(heardBadly?.transcriptConfidence).toBe(0.6);
    expect(heardBadly!.parsed.confidence).toBeLessThan(heardWell!.parsed.confidence);
    // The property that matters: bad audio cannot move a customer's job card.
    expect(heardBadly!.parsed.confidence).toBeLessThan(AUTO_APPLY_CONFIDENCE);
  });

  it('reads a typed note without going near the recogniser', async () => {
    const { ingestor, hintsSeen } = build();

    const reading = await ingestor.read({
      shopId: SHOP,
      text: 'TN09BX4432 brake pads done',
      audio: null,
      languageHint: 'en',
      traceId: 'trace-1',
    });

    expect(hintsSeen).toEqual([]);
    expect(reading?.transcriptConfidence).toBeNull();
    expect(reading?.parsed.signalType).toBe('done');
  });

  it('returns null for audio nobody can transcribe, so the note falls back to intake', async () => {
    const { ingestor } = build();

    const reading = await ingestor.read({
      shopId: SHOP,
      text: '',
      audio: { bytes: Buffer.from('unregistered'), contentType: 'audio/wav' },
      languageHint: 'ta',
      traceId: 'trace-1',
    });

    expect(reading).toBeNull();
  });

  it('rethrows a provider outage rather than reclassifying every note as a new job card', async () => {
    const ingestor = new TechnicianNoteIngestor({
      speech: {
        driver: 'mock',
        transcribe: async () => {
          throw new SpeechError('PROVIDER_UNAVAILABLE', 'the recogniser is down');
        },
      },
      parser: new HeuristicStatusSignalParser(),
      signals: new RecordingSignals() as unknown as StatusSignalService<unknown>,
      hints: async () => [],
      timezone: async () => 'Asia/Kolkata',
      clock: fixedClock(NOW),
    });

    await expect(
      ingestor.read({
        shopId: SHOP,
        text: '',
        audio: { bytes: AUDIO, contentType: 'audio/wav' },
        languageHint: 'ta',
        traceId: 'trace-1',
      }),
    ).rejects.toThrow('the recogniser is down');
  });

  it('passes the capture straight through to the status service', async () => {
    const { ingestor, signals } = build();

    const reading = await ingestor.read({
      shopId: SHOP,
      text: '',
      audio: { bytes: AUDIO, contentType: 'audio/wav' },
      languageHint: 'ta',
      traceId: 'trace-1',
    });

    await ingestor.capture({
      shopId: SHOP,
      parsed: reading!.parsed,
      source: 'VOICE_NOTE',
      transcript: reading!.transcript,
      transcriptConfidence: reading!.transcriptConfidence,
      conversationId: 'conv-1',
      messageId: 'msg-1',
      mediaId: null,
      senderStaffId: 'staff-1',
      replyToMessageId: null,
      actor: { type: 'STAFF', id: 'staff-1' },
      traceId: 'trace-1',
    });

    expect(signals.captured).toHaveLength(1);
    expect(signals.captured[0]?.source).toBe('VOICE_NOTE');
  });
});
