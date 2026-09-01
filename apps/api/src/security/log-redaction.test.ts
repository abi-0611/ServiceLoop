import { Writable } from 'node:stream';
import {
  describeBody,
  fullBodyWindowOpen,
  isSensitiveKey,
  PII_REDACT_PATHS,
  REDACTED,
  redactDeep,
  shouldLogFullBody,
} from '@serviceloop/shared';
import pino from 'pino';
import { describe, expect, it } from 'vitest';

/**
 * Log redaction (phase 7.4 acceptance gate: "log-redaction test proves no phone
 * number in default logs").
 *
 * The test is written against a *real pino instance with the real policy*,
 * writing to a buffer, rather than against the path list. Asserting the list
 * contains `'*.phone'` proves nothing about whether pino applies it to the
 * shape this codebase actually logs — and the shapes are the whole difficulty.
 */

const PHONE = '+919876543210';
const NAME = 'Ramesh Kumar';
const BODY = 'My Swift is making a grinding noise when I brake';

function capture(): { logger: pino.Logger; lines: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });

  const logger = pino(
    {
      level: 'info',
      redact: { paths: [...PII_REDACT_PATHS], censor: REDACTED },
    },
    sink,
  );

  return { logger, lines: () => chunks.join('') };
}

describe('default logs carry no customer PII', () => {
  it('redacts a phone number wherever it is nested', () => {
    const { logger, lines } = capture();

    logger.info({ customer: { phone: PHONE, fullName: NAME } }, 'inbound message');
    logger.info({ conversation: { phone: PHONE } }, 'thread resolved');
    logger.info({ payload: { customerPhone: PHONE } }, 'event dispatched');
    logger.info({ sms: { to: PHONE } }, 'sms fallback');

    const output = lines();
    expect(output).not.toContain(PHONE);
    // A partial match matters too: a redaction that kept the last four digits
    // would still identify a customer to anybody holding the shop's records.
    expect(output).not.toContain('9876543210');
    expect(output).not.toContain('543210');
  });

  it('redacts customer names', () => {
    const { logger, lines } = capture();
    logger.info({ customer: { fullName: NAME }, draft: { customerName: NAME } }, 'draft built');
    expect(lines()).not.toContain('Ramesh');
  });

  it('redacts message bodies', () => {
    const { logger, lines } = capture();
    logger.info({ message: { body: BODY } }, 'message persisted');
    logger.info({ payload: { body: BODY } }, 'outbox enqueued');
    expect(lines()).not.toContain('grinding');
  });

  it('redacts credentials and provider signatures', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        req: {
          headers: {
            authorization: 'Bearer secret-token',
            cookie: 'sl_access=abc',
            'x-hub-signature-256': 'sha256=deadbeef',
          },
        },
      },
      'request',
    );
    logger.info({ ANTHROPIC_API_KEY: 'sk-ant-live', JWT_SECRET: 'hunter2' }, 'boot config');

    const output = lines();
    for (const secret of ['secret-token', 'sl_access=abc', 'deadbeef', 'sk-ant-live', 'hunter2']) {
      expect(output, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it('still logs the things an operator needs', () => {
    // A redaction policy that ate the trace id and the shop id would be
    // technically compliant and operationally useless.
    const { logger, lines } = capture();
    logger.info(
      { traceId: 'trace-1', shopId: 'shop-1', messageId: 'msg-1', code: undefined },
      'message blocked',
    );
    const output = lines();
    expect(output).toContain('trace-1');
    expect(output).toContain('shop-1');
    expect(output).toContain('msg-1');
  });
});

describe('redactDeep', () => {
  it('reaches into free-form payloads pino cannot path-match', () => {
    const redacted = redactDeep({
      tool: 'send_customer_message',
      arguments: { body: BODY, to: PHONE, jobCardId: 'card-1' },
      nested: [{ customerName: NAME }],
    }) as Record<string, unknown>;

    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain('grinding');
    expect(serialised).not.toContain('9876543210');
    expect(serialised).not.toContain('Ramesh');
    // The non-sensitive keys survive, which is what makes it usable.
    expect(serialised).toContain('card-1');
    expect(serialised).toContain('send_customer_message');
  });

  it('terminates on a cyclic-looking deep structure', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 20; index += 1) deep = { next: deep };
    expect(() => redactDeep(deep)).not.toThrow();
  });

  it.each([
    'phone',
    'customerPhone',
    'full_name',
    'fullName',
    'apiKey',
    'api_key',
    'refreshToken',
    'otp',
    'code',
    'transcript',
    'body',
    // The one that leaked past the first version of this policy.
    'to',
    'toMasked',
    'recipient',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['shopId', 'jobCardId', 'traceId', 'status', 'durationMs'])(
    'does not redact %s',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe('the full-body debug window closes by itself', () => {
  const now = new Date('2026-09-01T12:00:00Z');

  it('is shut when no expiry is configured', () => {
    expect(fullBodyWindowOpen({ sampleRatio: 1 }, now)).toBe(false);
  });

  it('is open before the expiry and shut after it', () => {
    const until = new Date('2026-09-01T13:00:00Z');
    expect(fullBodyWindowOpen({ until, sampleRatio: 1 }, now)).toBe(true);
    expect(fullBodyWindowOpen({ until, sampleRatio: 1 }, new Date('2026-09-01T13:00:01Z'))).toBe(
      false,
    );
  });

  it('samples deterministically, so a sampled conversation is sampled throughout', () => {
    const window = { until: new Date('2026-09-01T13:00:00Z'), sampleRatio: 0.5 };
    const first = shouldLogFullBody(window, 'conversation-abc', now);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(shouldLogFullBody(window, 'conversation-abc', now)).toBe(first);
    }
  });

  it('samples roughly the configured fraction across many conversations', () => {
    const window = { until: new Date('2026-09-01T13:00:00Z'), sampleRatio: 0.1 };
    const sampled = Array.from({ length: 2000 }, (_value, index) =>
      shouldLogFullBody(window, `conversation-${index}`, now),
    ).filter(Boolean).length;
    // Wide bounds: this asserts the hash spreads, not that it is uniform.
    expect(sampled).toBeGreaterThan(120);
    expect(sampled).toBeLessThan(280);
  });

  it('never samples while the window is shut, whatever the ratio', () => {
    expect(shouldLogFullBody({ sampleRatio: 1 }, 'conversation-abc', now)).toBe(false);
  });
});

describe('describeBody', () => {
  it('gives a length rather than the text by default', () => {
    const described = describeBody(BODY);
    expect(described).not.toContain('grinding');
    expect(described).toContain(String(BODY.length));
  });

  it('returns the body verbatim only when explicitly asked', () => {
    expect(describeBody(BODY, { full: true })).toBe(BODY);
  });
});
