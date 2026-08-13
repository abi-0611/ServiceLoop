import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json';
import { LANGUAGES } from './enums';
import { EventEnvelopeSchema, queueForEventType } from './events';
import { catalogueKeys, requiredParams, t } from './i18n';
import { CATALOGUES } from './i18n/catalogue';
import { isUuid, uuidv7, uuidv7Timestamp } from './ids';
import { applyRateBp, formatPaise, lineTotal, rupeesToPaise } from './money';
import { formatPhoneForDisplay, maskPhone, normalisePhone } from './phone';
import { formatRegistrationForDisplay, normaliseRegistration } from './registration';
import {
  formatHhMm,
  isWithinQuietHours,
  minutesOfDayInZone,
  nextInstantOutsideQuietHours,
  parseHhMm,
} from './time';

describe('uuidv7', () => {
  it('produces well-formed, version-7 identifiers', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('is monotonically increasing even within one millisecond', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('embeds the creation timestamp', () => {
    const before = Date.now();
    const extracted = uuidv7Timestamp(uuidv7());
    expect(extracted).not.toBeNull();
    expect(extracted!).toBeGreaterThanOrEqual(before - 1);
    expect(extracted!).toBeLessThanOrEqual(Date.now() + 1);
  });
});

describe('normalisePhone', () => {
  const accepted: Array<[string, string]> = [
    ['9876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['098765-43210', '+919876543210'],
    ['0091 9876543210', '+919876543210'],
    ['91 9876543210', '+919876543210'],
    ['  6123456789 ', '+916123456789'],
  ];

  it.each(accepted)('normalises %s', (input, expected) => {
    const result = normalisePhone(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(expected);
  });

  const rejected: Array<[string, string]> = [
    ['', 'EMPTY'],
    ['12345', 'TOO_SHORT'],
    ['98765432101234', 'TOO_LONG'],
    ['1234567890', 'INVALID_INDIAN_MOBILE'],
    ['5876543210', 'INVALID_INDIAN_MOBILE'],
  ];

  it.each(rejected)('rejects %s', (input, kind) => {
    const result = normalisePhone(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe(kind);
  });

  it('masks and formats without leaking the middle digits', () => {
    expect(formatPhoneForDisplay('+919876543210')).toBe('+91 98765 43210');
    expect(maskPhone('+919876543210')).toBe('+9198xxxxx210');
  });
});

describe('normaliseRegistration', () => {
  it('canonicalises standard registrations with zero padding', () => {
    const result = normaliseRegistration('tn-9 bx 234');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.normalised).toBe('TN09BX0234');
      expect(result.value.kind).toBe('STANDARD');
      expect(result.value.stateCode).toBe('TN');
    }
  });

  it('supports BH-series registrations', () => {
    const result = normaliseRegistration('24 BH 1234 A');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe('BH_SERIES');
      expect(result.value.normalised).toBe('24BH1234A');
    }
  });

  it('repairs common OCR confusions in the state and RTO positions', () => {
    // Letter O read where the RTO code's digit 0 belongs.
    const result = normaliseRegistration('TNO9BX1234');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.normalised).toBe('TN09BX1234');

    // Digit 0 read where the state code's letter O belongs.
    const state = normaliseRegistration('0D02AB1234');
    expect(state.ok).toBe(true);
    if (state.ok) expect(state.value.normalised).toBe('OD02AB1234');
  });

  it('rejects unrecognisable input', () => {
    expect(normaliseRegistration('!!!').ok).toBe(false);
    expect(normaliseRegistration('').ok).toBe(false);
  });

  it('formats for display', () => {
    expect(formatRegistrationForDisplay('TN09BX1234')).toBe('TN 09 BX 1234');
    expect(formatRegistrationForDisplay('24BH1234A')).toBe('24 BH 1234 A');
  });
});

describe('canonicalJson', () => {
  it('is stable regardless of key insertion order', () => {
    const a = canonicalJson({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 4 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":4},"b":1}');
  });

  it('drops undefined properties but preserves array holes as null', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('renders dates as ISO strings and bigints as decimal strings', () => {
    expect(canonicalJson({ at: new Date('2026-01-02T03:04:05.000Z') })).toBe(
      '{"at":"2026-01-02T03:04:05.000Z"}',
    );
    expect(canonicalJson({ n: 10n })).toBe('{"n":"10"}');
  });

  it('throws on cycles and non-finite numbers', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/circular/);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
  });
});

describe('money', () => {
  it('keeps arithmetic in integer paise', () => {
    expect(rupeesToPaise(1234.56)).toBe(123456);
    expect(applyRateBp(100000, 1800)).toBe(18000);
    expect(lineTotal(1500, 40000)).toBe(60000);
  });

  it('formats with Indian digit grouping', () => {
    expect(formatPaise(12345600)).toBe('₹1,23,456.00');
    expect(formatPaise(12345600, { withSymbol: false })).toBe('1,23,456.00');
  });
});

describe('quiet hours', () => {
  const IST = 'Asia/Kolkata';

  it('reads the local wall clock in the shop timezone', () => {
    // 18:30 UTC == 00:00 IST next day
    expect(minutesOfDayInZone(new Date('2026-03-01T18:30:00Z'), IST)).toBe(0);
    expect(formatHhMm(parseHhMm('21:00'))).toBe('21:00');
  });

  it('handles windows that wrap past midnight', () => {
    const window = { start: '21:00', end: '08:00' };
    // 22:00 IST
    expect(isWithinQuietHours(new Date('2026-03-01T16:30:00Z'), IST, window)).toBe(true);
    // 07:59 IST
    expect(isWithinQuietHours(new Date('2026-03-02T02:29:00Z'), IST, window)).toBe(true);
    // 12:00 IST
    expect(isWithinQuietHours(new Date('2026-03-01T06:30:00Z'), IST, window)).toBe(false);
  });

  it('treats an empty window as always allowed', () => {
    expect(isWithinQuietHours(new Date(), IST, { start: '00:00', end: '00:00' })).toBe(false);
  });

  it('advances a blocked instant to the end of the window', () => {
    const window = { start: '21:00', end: '08:00' };
    const at = new Date('2026-03-01T18:00:00Z'); // 23:30 IST
    const next = nextInstantOutsideQuietHours(at, IST, window);
    expect(isWithinQuietHours(next, IST, window)).toBe(false);
    expect(minutesOfDayInZone(next, IST)).toBe(parseHhMm('08:00'));
    expect(next.getTime()).toBeGreaterThan(at.getTime());
  });

  it('leaves an allowed instant untouched', () => {
    const at = new Date('2026-03-01T06:30:00Z');
    expect(nextInstantOutsideQuietHours(at, IST, { start: '21:00', end: '08:00' })).toBe(at);
  });
});

describe('i18n', () => {
  it('exposes every key in every launch language (L4)', () => {
    const keys = catalogueKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const language of LANGUAGES) {
      for (const key of keys) {
        expect(CATALOGUES[language][key], `${language}/${key}`).toBeTruthy();
      }
    }
  });

  it('keeps placeholders identical across languages', () => {
    for (const key of catalogueKeys()) {
      const expected = [...requiredParams(key, 'en')].sort();
      for (const language of LANGUAGES) {
        expect([...requiredParams(key, language)].sort(), `${language}/${key}`).toEqual(expected);
      }
    }
  });

  it('interpolates parameters', () => {
    expect(t('en', 'auth.otp.body', { code: '123456', minutes: 5 })).toContain('123456');
    expect(t('ta', 'auth.otp.body', { code: '123456', minutes: 5 })).toContain('123456');
  });

  it('throws rather than shipping a half-rendered string to a customer', () => {
    expect(() => t('en', 'auth.otp.body', { code: '123456' })).toThrow(/missing parameter/);
  });
});

describe('event envelope', () => {
  it('validates a well-formed envelope and routes it to a queue', () => {
    const envelope = EventEnvelopeSchema.parse({
      id: uuidv7(),
      type: 'job_card.state_changed',
      occurredAt: new Date().toISOString(),
      shopId: uuidv7(),
      traceId: 'trace-1',
      payload: {
        jobCardId: uuidv7(),
        from: 'OPEN',
        to: 'IN_DIAGNOSIS',
        event: 'BEGIN_DIAGNOSIS',
        actor: { type: 'STAFF', id: uuidv7() },
      },
    });
    expect(envelope.type).toBe('job_card.state_changed');
    if (envelope.type === 'job_card.state_changed') {
      expect(envelope.payload.meta).toEqual({});
      expect(envelope.payload.to).toBe('IN_DIAGNOSIS');
    }
    expect(queueForEventType(envelope.type)).toBe('jobcard-events');
  });

  it('rejects a payload that does not match its event type', () => {
    expect(() =>
      EventEnvelopeSchema.parse({
        id: uuidv7(),
        type: 'job_card.state_changed',
        occurredAt: new Date().toISOString(),
        shopId: uuidv7(),
        traceId: 'trace-1',
        payload: { jobCardId: uuidv7() },
      }),
    ).toThrow();
  });
});
