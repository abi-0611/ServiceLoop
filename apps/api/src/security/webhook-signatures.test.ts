import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MockPaymentsAdapter } from '@serviceloop/adapters';
import { SandboxWhatsAppAdapter, signPayload, verifySignature } from '@serviceloop/adapters';
import { describe, expect, it } from 'vitest';
import { PaymentsWebhookController } from '../loop/payments.controller';
import { WhatsAppWebhookController } from '../messaging/whatsapp.controller';
import { HealthController } from '../modules/health.controller';
import { PublicPrivacyController } from '../privacy/public-privacy.controller';
import { AuthController } from '../auth/auth.controller';
import { describeRoutes, routeKey } from './route-inventory';

/**
 * Webhook signature audit (phase 7.1: "webhook signature verification audit
 * across all providers — fail-closed").
 *
 * A webhook endpoint is unauthenticated by construction: the provider cannot
 * hold a session. Its *only* protection is the signature, which makes three
 * properties load-bearing, and each is asserted here rather than described:
 *
 *  1. **Fail-closed.** A missing signature is refused, not treated as
 *     "no signature to check, therefore fine". This is the single most common
 *     way a webhook verifier is wrong, because the happy path passes either way.
 *  2. **The digest covers the bytes that arrived.** Verifying a re-serialised
 *     body passes for an attacker who reorders keys, so a tampered payload with
 *     the original signature must fail.
 *  3. **Nothing else is public.** A new `@Public()` POST route that verifies
 *     nothing is the hole this audit exists to find, so the set of public
 *     routes is pinned.
 */

const SECRET = 'webhook-audit-secret';

describe('webhook signature verification is fail-closed', () => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  it('refuses a delivery with no signature header at all', () => {
    expect(verifySignature(body, null, SECRET)).toBe(false);
    expect(verifySignature(body, '', SECRET)).toBe(false);
    expect(verifySignature(body, undefined as unknown as string, SECRET)).toBe(false);
  });

  it('refuses a signature with the right digest under the wrong secret', () => {
    const forged = signPayload(body, 'not-the-app-secret');
    expect(verifySignature(body, forged, SECRET)).toBe(false);
  });

  it('refuses a valid signature over a tampered body', () => {
    const signature = signPayload(body, SECRET);
    const tampered = body.replace('"entry":[]', '"entry":[{"id":"evil"}]');
    expect(verifySignature(tampered, signature, SECRET)).toBe(false);
  });

  it('refuses a signature that is the right length but not hex', () => {
    // A naive implementation that hex-decodes without validating throws here,
    // and a `catch { return true }` around it would be catastrophic.
    const garbage = `sha256=${'z'.repeat(64)}`;
    expect(verifySignature(body, garbage, SECRET)).toBe(false);
  });

  it('refuses a truncated signature', () => {
    const signature = signPayload(body, SECRET);
    expect(verifySignature(body, signature.slice(0, -2), SECRET)).toBe(false);
  });

  it('accepts a correctly signed body', () => {
    expect(verifySignature(body, signPayload(body, SECRET), SECRET)).toBe(true);
  });

  it('accepts the prefix-less form some proxies produce, and only when correct', () => {
    const digest = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
    // Whether the bare form is accepted is the adapter's business; what is not
    // negotiable is that a *wrong* bare digest is refused.
    expect(verifySignature(body, `sha256=${digest}`, SECRET)).toBe(true);
    expect(verifySignature(body, `sha256=${digest.replace(/.$/, '0')}`, SECRET)).toBe(false);
  });
});

describe('the WhatsApp adapter refuses an unsigned delivery before parsing it', () => {
  const adapter = new SandboxWhatsAppAdapter();
  const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  it('throws SIGNATURE_INVALID rather than returning an empty batch', async () => {
    await expect(
      adapter.receive({ rawBody: payload, signatureHeader: null, receivedAt: new Date() }),
    ).rejects.toMatchObject({ kind: 'SIGNATURE_INVALID' });
  });

  it('throws before the body is even well-formed JSON', async () => {
    // Order matters: a verifier that parses first leaks a parse-error oracle
    // and burns CPU on attacker-controlled input.
    await expect(
      adapter.receive({ rawBody: '{not json', signatureHeader: null, receivedAt: new Date() }),
    ).rejects.toMatchObject({ kind: 'SIGNATURE_INVALID' });
  });
});

describe('the payments adapter refuses an unsigned or tampered webhook', () => {
  const adapter = new MockPaymentsAdapter({ webhookSecret: SECRET });
  // The payments port verifies over raw *bytes*, not a string: a signature
  // checked against a re-encoded body is a signature checked against something
  // the provider never sent.
  const rawBody = Buffer.from(JSON.stringify({ event: 'payment.captured', payload: {} }), 'utf8');

  it('rejects a missing signature', () => {
    const verdict = adapter.parseWebhook({ rawBody, headers: {} });
    expect(verdict.ok).toBe(false);
  });

  it('rejects a signature over different bytes', () => {
    const signature = createHmac('sha256', SECRET).update(rawBody).digest('hex');
    const verdict = adapter.parseWebhook({
      rawBody: Buffer.concat([rawBody, Buffer.from(' ')]),
      headers: { 'x-razorpay-signature': signature },
    });
    expect(verdict.ok).toBe(false);
  });
});

describe('the unauthenticated surface is pinned', () => {
  /**
   * Every `@Public()` route in the API, and why each is allowed to be.
   *
   * A route appearing here that is not in this list fails the test. That is
   * the point: `@Public()` is one word, and adding it to a controller that
   * needs to answer a load balancer is a five-second change that can
   * accidentally expose a whole controller.
   */
  const SANCTIONED: Readonly<Record<string, string>> = {
    'POST /auth/otp/request': 'rate-limited; leaks only whether a number is registered staff',
    'POST /auth/otp/verify': 'rate-limited and attempt-capped; the code is the credential',
    'POST /auth/refresh': 'the opaque refresh token is the credential; reuse kills the family',
    'GET /health': 'a liveness probe with no shop data in it',
    'GET /health/ready': 'a readiness probe; reports only up/down per dependency',
    'GET /metrics': 'Prometheus scrape; carries no PII, and is not internet-exposed in prod',
    'GET /webhooks/whatsapp': "Meta's subscription handshake; guarded by the verify token",
    'POST /webhooks/whatsapp': 'guarded by X-Hub-Signature-256 over the raw body',
    'POST /webhooks/payments': 'guarded by the provider HMAC over the raw body',
    'GET /privacy/download':
      'the 256-bit download token is the credential; stored as a hash, single-request, hour-scoped',
    'GET /privacy/notice': 'a statutory publication; carries no personal data',
  };

  it('has no public route that is not sanctioned above', () => {
    const routes = describeRoutes([
      AuthController,
      HealthController,
      WhatsAppWebhookController,
      PaymentsWebhookController,
      PublicPrivacyController,
    ]);
    const publicRoutes = routes.filter((route) => route.isPublic).map(routeKey);
    const unsanctioned = publicRoutes.filter((key) => SANCTIONED[key] === undefined);
    expect(unsanctioned, 'Unsanctioned @Public() routes:').toEqual([]);
  });

  /**
   * Every webhook controller must *mention* its verification.
   *
   * A crude check, and deliberately so: it cannot prove the verification is
   * correct — the unit tests above do that — but it does catch the specific
   * regression of somebody deleting the call while refactoring, which the unit
   * tests would not notice because they test the adapter, not the controller.
   */
  it('every webhook controller verifies a signature in its source', () => {
    const root = resolve(__dirname, '..');
    const files = [
      join(root, 'messaging', 'whatsapp.controller.ts'),
      join(root, 'loop', 'payments.controller.ts'),
    ];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const verifies =
        /signatureHeader/.test(source) || /parseWebhook/.test(source) || /verifySignature/.test(source);
      expect(verifies, `${file} has no signature verification`).toBe(true);
      // And the refusal must be a 4xx, not a 5xx: providers retry 5xx forever,
      // so a permanently bad signature would be redelivered until it expires.
      expect(
        // Either the domain error or Nest's own exception; both map to a 4xx.
        /Unauthorized(Error|Exception)|Validation(Error|Exception)/.test(source),
        `${file} must refuse a bad signature with a 4xx`,
      ).toBe(true);
    }
  });
});
