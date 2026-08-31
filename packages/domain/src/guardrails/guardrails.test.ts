import { defaultShopConfig, SHOP_CONFIG_VERSION } from '@serviceloop/config';
import { fixedClock, ValidationError, uuidv7 } from '@serviceloop/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../audit/chain';
import type { Actor } from '../job-card/context';
import { createDomainTestHarness, type DomainTestHarness } from '../testing/in-memory';
import { GuardrailService } from './guardrail-service';
import {
  autonomyFor,
  checkClaimAnchoring,
  checkConsent,
  checkDisclosure,
  checkFrequencyCaps,
  checkOfferedPrice,
  evaluateQuietHours,
  resolveSendMode,
} from './policies';

const SHOP_ID = uuidv7();
const OWNER: Actor = { type: 'STAFF', id: uuidv7(), displayName: 'Owner' };
const NOW = new Date('2026-04-01T09:00:00.000Z');

describe('GuardrailService', () => {
  let harness: DomainTestHarness;
  let service: GuardrailService<{ id: string }>;

  beforeEach(() => {
    harness = createDomainTestHarness(() => NOW);
    harness.world.addShop(SHOP_ID);
    service = new GuardrailService({
      uow: harness.uow,
      store: harness.config,
      audit: harness.audit,
      outbox: harness.outbox,
      clock: fixedClock(NOW),
    });
  });

  it('returns conservative defaults for a shop with no stored config', async () => {
    const { config, migratedFrom } = await service.get(SHOP_ID);
    expect(migratedFrom).toBe(0);
    expect(config.autonomy.approval).toBe('L0_SHADOW');
    expect(config.pricing.discountCeilingPercent).toBe(0);
  });

  it('round-trips a valid patch and audits the field-level diff', async () => {
    harness.world.configs.set(SHOP_ID, defaultShopConfig());

    const result = await service.validateAndPatch(
      SHOP_ID,
      { autonomy: { status: 'L1_TEMPLATED' }, quietHours: { start: '22:00' } },
      OWNER,
      'trace-cfg-1',
    );

    expect(result.config.autonomy.status).toBe('L1_TEMPLATED');
    expect(result.config.autonomy.approval).toBe('L0_SHADOW');
    expect(result.config.quietHours.start).toBe('22:00');
    expect(result.diffs.map((diff) => diff.path).sort()).toEqual([
      'autonomy.status',
      'quietHours.start',
    ]);

    const reread = await service.get(SHOP_ID);
    expect(reread.config.autonomy.status).toBe('L1_TEMPLATED');

    const audit = harness.world.auditFor(SHOP_ID);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.action).toBe('shop_config.updated');
    expect(audit[0]?.actorId).toBe(OWNER.id);
    expect(audit[0]?.payload).toMatchObject({
      diffs: [
        { path: 'autonomy.status', before: 'L0_SHADOW', after: 'L1_TEMPLATED' },
        { path: 'quietHours.start', before: '21:00', after: '22:00' },
      ],
    });
    expect(verifyAuditChain(audit).valid).toBe(true);
    expect(harness.world.outbox[0]?.type).toBe('shop_config.updated');
  });

  it('rejects an invalid patch with field-level errors and writes nothing', async () => {
    harness.world.configs.set(SHOP_ID, defaultShopConfig());

    const attempt = service.validateAndPatch(
      SHOP_ID,
      { pricing: { priceFloorPercent: 150 }, quietHours: { end: '25:00' } },
      OWNER,
      'trace-cfg-2',
    );

    await expect(attempt).rejects.toBeInstanceOf(ValidationError);
    await expect(attempt).rejects.toMatchObject({
      details: {
        fieldErrors: expect.arrayContaining([
          expect.objectContaining({ path: 'pricing.priceFloorPercent' }),
          expect.objectContaining({ path: 'quietHours.end' }),
        ]),
      },
    });

    const stored = await service.get(SHOP_ID);
    expect(stored.config.pricing.priceFloorPercent).toBe(100);
    expect(harness.world.auditFor(SHOP_ID)).toHaveLength(0);
  });

  it('cannot be patched to disable the AI disclosure', async () => {
    harness.world.configs.set(SHOP_ID, defaultShopConfig());
    await expect(
      service.validateAndPatch(
        SHOP_ID,
        { disclosure: { requireFirstContactDisclosure: false } },
        OWNER,
        'trace-cfg-3',
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('replaces an escalation ladder wholesale rather than merging rungs', async () => {
    harness.world.configs.set(SHOP_ID, defaultShopConfig());

    const result = await service.validateAndPatch(
      SHOP_ID,
      {
        ladders: {
          APPROVAL: {
            enabled: true,
            rungs: [{ afterMinutes: 0, type: 'WHATSAPP', label: 'Single attempt' }],
            giveUpAfterMinutes: 120,
          },
        },
      },
      OWNER,
      'trace-cfg-4',
    );

    expect(result.config.ladders.APPROVAL.rungs).toHaveLength(1);
    expect(result.config.ladders.STATUS.rungs.length).toBeGreaterThan(1);
  });

  it('does not audit a no-op patch', async () => {
    harness.world.configs.set(SHOP_ID, defaultShopConfig());
    const result = await service.validateAndPatch(SHOP_ID, {}, OWNER, 'trace-cfg-5');
    expect(result.diffs).toHaveLength(0);
    expect(result.auditEventId).toBeNull();
    expect(harness.world.auditFor(SHOP_ID)).toHaveLength(0);
  });

  it('persists and audits when it migrates a legacy document forward', async () => {
    harness.world.configs.set(SHOP_ID, {
      pricing: { priceFloorPercent: 90, discountCeilingPercent: 10 },
    });
    const result = await service.validateAndPatch(SHOP_ID, {}, OWNER, 'trace-cfg-6');
    expect(result.auditEventId).not.toBeNull();
    // Tracks the constant rather than a literal: every future version bump must
    // still carry a legacy document all the way forward on first write.
    expect(result.config.configVersion).toBe(SHOP_CONFIG_VERSION);
    expect((await service.get(SHOP_ID)).migratedFrom).toBeNull();
  });
});

describe('guardrail policies', () => {
  const config = defaultShopConfig();

  it('never auto-sends in shadow mode', () => {
    expect(resolveSendMode('L0_SHADOW', { templated: true, channel: 'WHATSAPP' })).toBe(
      'HITL_REQUIRED',
    );
    expect(autonomyFor(config, 'approval')).toBe('L0_SHADOW');
  });

  it('auto-sends only templated messages at L1 and free-form at L2', () => {
    expect(resolveSendMode('L1_TEMPLATED', { templated: true, channel: 'WHATSAPP' })).toBe(
      'AUTO_SEND',
    );
    expect(resolveSendMode('L1_TEMPLATED', { templated: false, channel: 'WHATSAPP' })).toBe(
      'HITL_REQUIRED',
    );
    expect(resolveSendMode('L2_CONVERSATIONAL', { templated: false, channel: 'WHATSAPP' })).toBe(
      'AUTO_SEND',
    );
  });

  it('requires L3 for voice regardless of chat autonomy', () => {
    expect(resolveSendMode('L2_CONVERSATIONAL', { templated: true, channel: 'VOICE' })).toBe(
      'HITL_REQUIRED',
    );
    expect(resolveSendMode('L3_VOICE', { templated: false, channel: 'VOICE' })).toBe('AUTO_SEND');
  });

  it('blocks sends inside quiet hours and reports when they may resume', () => {
    const blocked = evaluateQuietHours(config, new Date('2026-04-01T18:00:00Z')); // 23:30 IST
    expect(blocked.withinQuietHours).toBe(true);
    expect(blocked.deferUntil).toBeInstanceOf(Date);

    const allowed = evaluateQuietHours(config, new Date('2026-04-01T06:30:00Z')); // 12:00 IST
    expect(allowed.withinQuietHours).toBe(false);
    expect(allowed.deferUntil).toBeNull();
  });

  it('enforces the price floor and the discount ceiling', () => {
    expect(checkOfferedPrice(config, 100_000, 100_000).allowed).toBe(true);
    expect(checkOfferedPrice(config, 100_000, 99_999)).toMatchObject({
      allowed: false,
      code: 'PRICE_BELOW_FLOOR',
    });

    const generous = { ...config, pricing: { priceFloorPercent: 80, discountCeilingPercent: 10 } };
    expect(checkOfferedPrice(generous, 100_000, 92_000).allowed).toBe(true);
    expect(checkOfferedPrice(generous, 100_000, 85_000)).toMatchObject({
      allowed: false,
      code: 'DISCOUNT_ABOVE_CEILING',
    });
    expect(checkOfferedPrice(config, 100_000, -1)).toMatchObject({ code: 'NEGATIVE_PRICE' });
    expect(checkOfferedPrice(config, 0, 5_000)).toMatchObject({ code: 'NO_LIST_PRICE' });
  });

  it('enforces frequency caps and the minimum interval', () => {
    const now = new Date('2026-04-01T09:00:00Z');
    const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3600_000);

    expect(checkFrequencyCaps(config, { sentAt: [] }, now).allowed).toBe(true);
    expect(
      checkFrequencyCaps(config, { sentAt: [hoursAgo(2), hoursAgo(4), hoursAgo(6)] }, now),
    ).toMatchObject({ code: 'DAILY_CAP_REACHED' });
    expect(checkFrequencyCaps(config, { sentAt: [hoursAgo(0.25)] }, now)).toMatchObject({
      code: 'MIN_INTERVAL_NOT_ELAPSED',
    });

    const weekly = {
      ...config,
      frequencyCaps: {
        ...config.frequencyCaps,
        maxOutboundPerCustomerPerDay: 50,
        maxOutboundPerCustomerPerWeek: 2,
        minMinutesBetweenMessages: 0,
      },
    };
    expect(checkFrequencyCaps(weekly, { sentAt: [hoursAgo(30), hoursAgo(50)] }, now)).toMatchObject(
      {
        code: 'WEEKLY_CAP_REACHED',
      },
    );
  });

  it('gates outbound on purpose-specific consent', () => {
    expect(checkConsent('SERVICE', [{ purpose: 'SERVICE', status: 'GRANTED' }]).allowed).toBe(true);
    expect(checkConsent('MARKETING', [{ purpose: 'SERVICE', status: 'GRANTED' }])).toMatchObject({
      code: 'CONSENT_MISSING',
    });
    expect(checkConsent('SERVICE', [{ purpose: 'SERVICE', status: 'REVOKED' }])).toMatchObject({
      code: 'CONSENT_REVOKED',
    });
    expect(checkConsent('SERVICE', [{ purpose: 'SERVICE', status: 'PENDING' }])).toMatchObject({
      code: 'CONSENT_PENDING',
    });
  });

  it('blocks a claim with no evidence behind it (L7)', () => {
    expect(
      checkClaimAnchoring([
        { text: 'Front brake pads are at 2mm', evidence: [{ kind: 'MEDIA', id: 'm1' }] },
      ]).allowed,
    ).toBe(true);
    expect(
      checkClaimAnchoring([
        { text: 'Front brake pads are at 2mm', evidence: [] },
        { text: 'Your clutch is about to fail', evidence: [] },
      ]),
    ).toMatchObject({ allowed: false, code: 'CLAIM_NOT_ANCHORED' });
  });

  it('requires the AI disclosure on first contact and on every voice call', () => {
    expect(
      checkDisclosure(config, {
        isFirstContactInSession: true,
        isVoiceCall: false,
        bodyIncludesDisclosure: false,
      }),
    ).toMatchObject({ code: 'DISCLOSURE_MISSING' });
    expect(
      checkDisclosure(config, {
        isFirstContactInSession: false,
        isVoiceCall: true,
        bodyIncludesDisclosure: false,
      }),
    ).toMatchObject({ code: 'DISCLOSURE_MISSING' });
    expect(
      checkDisclosure(config, {
        isFirstContactInSession: true,
        isVoiceCall: false,
        bodyIncludesDisclosure: true,
      }).allowed,
    ).toBe(true);
    expect(
      checkDisclosure(config, {
        isFirstContactInSession: false,
        isVoiceCall: false,
        bodyIncludesDisclosure: false,
      }).allowed,
    ).toBe(true);
  });
});
