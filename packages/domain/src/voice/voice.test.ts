import { defaultShopConfig, type ShopConfig } from '@serviceloop/config';
import { uuidv7 } from '@serviceloop/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createDomainTestHarness,
  createVoiceTestHarness,
  InMemoryConsentStore,
  VoiceWorld,
  type DomainTestHarness,
  type MemoryTx,
  type VoiceTestHarness,
} from '../testing';
import { evaluateCallGate, callDayWindow } from './call-gate';
import { VoiceCallService } from './call-service';
import { estimateCallCostPaise, evaluateCap, startOfShopDay, toBilledSeconds } from './cost-meter';
import {
  APPROVAL_DTMF,
  GLOBAL_DTMF,
  INBOUND_DTMF,
  dtmfOptions,
  isPoorTurn,
  ivrModeSegment,
  noInputSegment,
  notUnderstoodSegment,
  resolveDtmf,
  shouldDegradeToIvr,
} from './dtmf';
import {
  approvalCallScript,
  approvalDtmfOptions,
  assertMandatorySegments,
  closingSegments,
  decisionReadbackSegment,
  fillerSegment,
  gracefulExitSegment,
  inboundGreetingScript,
  pipelineFailureSegment,
  readbackSegment,
  spokenTurnSentenceCount,
  trimToSpokenTurn,
  voiceMaxSentences,
  whisperText,
} from './scripts';

/**
 * The voice layer's *rules*, without a telephone (phase 5).
 *
 * `packages/agent-core` owns the runtime and has its own suite that runs whole
 * calls against a modelled line. What is tested here is everything that has to
 * be true before a packet leaves and after the last one arrives: whether a call
 * may be placed at all, what it costs, what the keypad means, and which
 * sentences may never be removed from a script.
 *
 * That split is the same one phase 3 made between `ApprovalService` and
 * `AgentRunner`, and for the same reason: a guardrail that can only be
 * exercised by holding a line open is a guardrail nobody exercises.
 */

const SHOP = '01920000-0000-7000-8000-0000000000aa';
const CUSTOMER = '01920000-0000-7000-8000-0000000000bb';
const JOB_CARD = '01920000-0000-7000-8000-0000000000dd';

/** 2026-08-14, 14:00 IST — a Thursday afternoon, inside business hours. */
const T0 = new Date('2026-08-14T08:30:00.000Z');

function voiceConfig(patch: Partial<ShopConfig['voice']> = {}): ShopConfig {
  const base = defaultShopConfig('Asia/Kolkata');
  return {
    ...base,
    voice: {
      ...base.voice,
      enabled: true,
      outboundEnabled: true,
      inboundEnabled: true,
      ...patch,
    },
  };
}

describe('phase 5.6 — the call gate', () => {
  const allowed = {
    config: voiceConfig(),
    now: T0,
    platformKillSwitch: false,
    direction: 'OUTBOUND' as const,
    consents: [{ purpose: 'SERVICE' as const, status: 'GRANTED' as const }],
    customerId: CUSTOMER,
    hasPhoneNumber: true,
    callsToCustomerToday: 0,
    callsFromShopToday: 0,
    shopSpentTodayPaise: 0,
    platformSpentTodayPaise: 0,
    platformCapPaise: 1_000_000,
    alertRatio: 0.8,
  };

  it('lets a consenting customer be called inside business hours', () => {
    expect(evaluateCallGate(allowed)).toMatchObject({ allowed: true });
  });

  it('refuses everything while the platform kill switch is on', () => {
    // Above the shop's own settings, and checked first: an operator who has
    // pulled the brake wants to be told the brake is on, not that the shop is
    // over budget — even when both are true.
    const verdict = evaluateCallGate({
      ...allowed,
      platformKillSwitch: true,
      config: voiceConfig({ dailyCostCapPaise: 1 }),
      shopSpentTodayPaise: 999_999,
    });

    expect(verdict).toMatchObject({ allowed: false, code: 'KILL_SWITCH', fallBackToAdvisor: true });
  });

  it('refuses a shop that has not switched voice on', () => {
    expect(evaluateCallGate({ ...allowed, config: voiceConfig({ enabled: false, outboundEnabled: false, inboundEnabled: false }) })).toMatchObject({
      allowed: false,
      code: 'VOICE_DISABLED',
    });
  });

  it('refuses outbound while still answering inbound', () => {
    const config = voiceConfig({ outboundEnabled: false });
    expect(evaluateCallGate({ ...allowed, config })).toMatchObject({
      allowed: false,
      code: 'OUTBOUND_DISABLED',
    });
    expect(evaluateCallGate({ ...allowed, config, direction: 'INBOUND' })).toMatchObject({
      allowed: true,
    });
  });

  it('makes a call to a revoked customer impossible, and does not task a person either', () => {
    const verdict = evaluateCallGate({
      ...allowed,
      consents: [{ purpose: 'SERVICE', status: 'REVOKED' }],
    });

    expect(verdict).toMatchObject({ allowed: false, code: 'CONSENT_REVOKED' });
    // The same violation with an extra step is still the violation.
    expect(verdict).toMatchObject({ fallBackToAdvisor: false });
  });

  it('refuses an outbound call with no identified customer or no number', () => {
    expect(evaluateCallGate({ ...allowed, customerId: null })).toMatchObject({
      allowed: false,
      code: 'NO_CONSENT',
    });
    expect(evaluateCallGate({ ...allowed, hasPhoneNumber: false })).toMatchObject({
      allowed: false,
      code: 'NO_PHONE_NUMBER',
    });
  });

  it('refuses a call in quiet hours, because a call is louder than a message', () => {
    // 22:40 IST.
    const late = new Date('2026-08-14T17:10:00.000Z');
    expect(evaluateCallGate({ ...allowed, now: late })).toMatchObject({
      allowed: false,
      code: 'QUIET_HOURS',
      fallBackToAdvisor: true,
    });
  });

  it('still answers the phone in quiet hours', () => {
    const late = new Date('2026-08-14T17:10:00.000Z');
    expect(evaluateCallGate({ ...allowed, now: late, direction: 'INBOUND' })).toMatchObject({
      allowed: true,
    });
  });

  it('honours the per-customer and per-shop call caps', () => {
    expect(
      evaluateCallGate({ ...allowed, callsToCustomerToday: 2, config: voiceConfig({ maxCallsPerCustomerPerDay: 2 }) }),
    ).toMatchObject({ allowed: false, code: 'CUSTOMER_CALL_CAP' });

    expect(
      evaluateCallGate({ ...allowed, callsFromShopToday: 5, config: voiceConfig({ maxOutboundCallsPerDay: 5 }) }),
    ).toMatchObject({ allowed: false, code: 'SHOP_CALL_CAP' });
  });

  it('alerts before it halts, and never halts without having alerted', () => {
    const config = voiceConfig({ dailyCostCapPaise: 1_000 });

    const warned = evaluateCallGate({ ...allowed, config, shopSpentTodayPaise: 850 });
    expect(warned).toMatchObject({ allowed: true });
    expect(warned.allowed ? warned.warnings : []).toHaveLength(1);

    expect(evaluateCallGate({ ...allowed, config, shopSpentTodayPaise: 1_000 })).toMatchObject({
      allowed: false,
      code: 'SHOP_COST_CAP',
    });
  });

  it('halts on the platform cap as well as the shop’s own', () => {
    expect(
      evaluateCallGate({ ...allowed, platformSpentTodayPaise: 1_000_000, platformCapPaise: 1_000_000 }),
    ).toMatchObject({ allowed: false, code: 'PLATFORM_COST_CAP' });
  });

  it('measures the day in the shop’s own timezone', () => {
    // A "daily" cap that reset at midnight UTC would reset at 05:30 IST, in the
    // middle of the shift it exists to govern.
    const start = callDayWindow(voiceConfig(), T0);
    expect(start.toISOString()).toBe('2026-08-13T18:30:00.000Z');
  });
});

describe('phase 5.7 — what a call costs', () => {
  const rates = {
    telcoPaisePerMinute: 60,
    sttPaisePerMinute: 30,
    ttsPaisePerMinute: 40,
    usdMicrosToPaise: 9_000,
  };

  it('rounds up, because a cap that under-estimates is a cap a busy shop walks through', () => {
    const cost = estimateCallCostPaise(
      { telcoSeconds: 61, sttSeconds: 1, ttsSeconds: 1, llmInputTokens: 0, llmOutputTokens: 0, llmCostUsdMicros: 0 },
      rates,
    );
    // 61s of telco is 61 paise; one second of speech is half a paisa each way
    // and is billed as one. Up rather than nearest, deliberately — the error on
    // a single call is a fraction of a rupee against a budget in hundreds.
    expect(cost).toBe(61 + 1 + 1);
  });

  it('meters the three currencies separately, because they fail separately', () => {
    const telcoOnly = estimateCallCostPaise(
      { telcoSeconds: 60, sttSeconds: 0, ttsSeconds: 0, llmInputTokens: 0, llmOutputTokens: 0, llmCostUsdMicros: 0 },
      rates,
    );
    const speechOnly = estimateCallCostPaise(
      { telcoSeconds: 0, sttSeconds: 60, ttsSeconds: 60, llmInputTokens: 0, llmOutputTokens: 0, llmCostUsdMicros: 0 },
      rates,
    );
    expect(telcoOnly).toBe(60);
    expect(speechOnly).toBe(70);
  });

  it('treats a cap of zero as no ceiling, not as no calls', () => {
    // A shop that wants voice off turns `voice.enabled` off, which says what it
    // means.
    expect(evaluateCap({ spentPaise: 10_000, capPaise: 0, alertRatio: 0.8, scope: 'SHOP_DAILY' })).toMatchObject(
      { state: 'OK' },
    );
  });

  it('bills a partial second as a whole one', () => {
    expect(toBilledSeconds(1)).toBe(1);
    expect(toBilledSeconds(1_001)).toBe(2);
    expect(toBilledSeconds(0)).toBe(0);
  });

  it('starts the shop’s day at local midnight', () => {
    expect(startOfShopDay(T0, 'Asia/Kolkata').toISOString()).toBe('2026-08-13T18:30:00.000Z');
  });
});

describe('phase 5.5 — the keypad', () => {
  it('always means a person on 0, offered or not', () => {
    expect(resolveDtmf('0', APPROVAL_DTMF)).toBe('HANDOFF');
    expect(resolveDtmf('0', INBOUND_DTMF)).toBe('HANDOFF');
    // Even against a map that tried to take the key for something else.
    expect(resolveDtmf('0', { '0': 'APPROVE' })).toBe('HANDOFF');
  });

  it('always repeats on 9 unless a flow deliberately takes the key', () => {
    expect(resolveDtmf('9', APPROVAL_DTMF)).toBe('REPEAT');
    expect(GLOBAL_DTMF['9']).toBe('REPEAT');
    expect(resolveDtmf('9', { '9': 'BOOKING' })).toBe('BOOKING');
  });

  it('returns null for a key the flow does not offer', () => {
    expect(resolveDtmf('7', APPROVAL_DTMF)).toBeNull();
  });

  it('never calls a keypress a poor turn', () => {
    // A key is the one input on a phone line that cannot be mis-heard.
    expect(isPoorTurn({ confidence: null, text: '', minConfidence: 0.6, inputMode: 'DTMF' })).toBe(
      false,
    );
  });

  it('calls silence a poor turn, so the caller is offered the keypad', () => {
    expect(isPoorTurn({ confidence: null, text: '', minConfidence: 0.6, inputMode: 'NONE' })).toBe(
      true,
    );
  });

  it('calls a low-confidence or empty transcript poor', () => {
    expect(isPoorTurn({ confidence: 0.2, text: 'mm', minConfidence: 0.6, inputMode: 'SPEECH' })).toBe(true);
    expect(isPoorTurn({ confidence: 0.9, text: '   ', minConfidence: 0.6, inputMode: 'SPEECH' })).toBe(true);
    expect(isPoorTurn({ confidence: 0.9, text: 'yes go ahead', minConfidence: 0.6, inputMode: 'SPEECH' })).toBe(false);
  });

  it('drops to the keypad on the second consecutive poor turn, not the first', () => {
    // One bad turn is a lorry going past; two is a line the recogniser is not
    // going to cope with.
    expect(shouldDegradeToIvr({ consecutivePoorTurns: 1, threshold: 2, alreadyDegraded: false })).toBe(false);
    expect(shouldDegradeToIvr({ consecutivePoorTurns: 2, threshold: 2, alreadyDegraded: false })).toBe(true);
    // And it never climbs back out mid-call.
    expect(shouldDegradeToIvr({ consecutivePoorTurns: 0, threshold: 2, alreadyDegraded: true })).toBe(true);
  });

  it('labels every key it offers', () => {
    const options = dtmfOptions(APPROVAL_DTMF, 'en', 'Meena');
    expect(options.map((option) => option.digit)).toEqual(['0', '1', '2', '3', '4', '9']);
    expect(options.every((option) => option.label.length > 0)).toBe(true);
  });

  it('offers the approval keypad in the caller’s own language', () => {
    const tamil = approvalDtmfOptions({ language: 'ta', advisorName: 'Meena' });
    expect(tamil.map((option) => option.action)).toEqual(['APPROVE', 'HANDOFF', 'REPEAT']);
    expect(tamil[1]?.label).toContain('Meena');
  });

  it('has a sentence for every way a turn can go wrong', () => {
    for (const language of ['en', 'ta', 'hi'] as const) {
      expect(noInputSegment(language).text.length).toBeGreaterThan(0);
      expect(notUnderstoodSegment(language, 'Meena').text.length).toBeGreaterThan(0);
      expect(ivrModeSegment(language, 'Meena').text).toContain('Meena');
    }
  });
});

describe('phase 5.4 — the scripts', () => {
  const context = {
    language: 'en' as const,
    shopName: 'Sri Murugan Auto Works',
    customerName: 'Ravi',
    advisorName: 'Meena',
    vehicleLabel: 'Maruti Swift',
    jobCardCode: 'JC-2026-0042',
    workSummary: 'front brake pads worn to 2.1mm',
    amountPaise: 240_000,
  };

  it('opens every outbound call with the disclosure and then the notice', () => {
    const script = approvalCallScript(context);
    const mandatory = script.filter((segment) => segment.mandatory).map((segment) => segment.key);

    expect(mandatory).toEqual(['voice.disclosure', 'voice.recording_notice']);
    expect(script[0]?.key).toBe('voice.disclosure');
    expect(script[1]?.key).toBe('voice.recording_notice');
  });

  it('opens every inbound call the same way, worded for a caller', () => {
    const script = inboundGreetingScript({
      language: 'en',
      shopName: context.shopName,
      advisorName: context.advisorName,
    });
    expect(script[0]).toMatchObject({ key: 'voice.inbound.greeting', mandatory: true });
    expect(script[1]).toMatchObject({ key: 'voice.recording_notice', mandatory: true });
  });

  it('builds all three languages without leaving a placeholder behind', () => {
    for (const language of ['en', 'ta', 'hi'] as const) {
      for (const segment of approvalCallScript({ ...context, language })) {
        expect(segment.text).not.toMatch(/\{[a-zA-Z]+\}/u);
        expect(segment.text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('refuses a script with a mandatory segment missing', () => {
    const stripped = approvalCallScript(context).filter(
      (segment) => segment.key !== 'voice.recording_notice',
    );
    expect(() => assertMandatorySegments(stripped, 'OUTBOUND')).toThrow(/recording_notice/);
    // And it checks the *keys*, so improving a translation cannot break it.
    expect(() => assertMandatorySegments(approvalCallScript({ ...context, language: 'ta' }), 'OUTBOUND')).not.toThrow();
  });

  it('knows an inbound script needs a different opener', () => {
    expect(() => assertMandatorySegments(approvalCallScript(context), 'INBOUND')).toThrow(
      /inbound\.greeting/,
    );
  });

  it('reads a decision back in words that match the decision', () => {
    const approval = readbackSegment(context);
    const decline = decisionReadbackSegment('DECLINED', context);
    const defer = decisionReadbackSegment('DEFERRED', context);

    // All three are filed under the readback key, so one query over a
    // transcript answers "was this decision read back?" whatever it was.
    expect([approval.key, decline.key, defer.key]).toEqual([
      'voice.readback',
      'voice.readback',
      'voice.readback',
    ]);
    // But the words differ, because reading "so I'll go ahead" back to somebody
    // who just declined would be worse than saying nothing.
    expect(decline.text).not.toBe(approval.text);
    expect(defer.text).not.toBe(decline.text);
  });

  it('whispers the advisor a summary the customer never hears', () => {
    const whisper = whisperText({
      language: 'en',
      customerName: 'Ravi',
      vehicleLabel: 'Maruti Swift',
      jobCardCode: 'JC-2026-0042',
      reason: 'approval chase',
      amountPaise: 240_000,
    });

    expect(whisper).toContain('Ravi');
    expect(whisper).toContain('Maruti Swift');
    expect(whisper).toContain('JC-2026-0042');
  });

  it('trims a turn to the shop’s spoken-sentence limit rather than refusing it', () => {
    const long = 'One. Two. Three. Four.';
    expect(spokenTurnSentenceCount(long)).toBe(4);
    expect(trimToSpokenTurn(long, 2)).toBe('One. Two.');
    // Dropping a later sentence can only remove information not yet given;
    // refusing the whole turn leaves dead air, which the phase forbids.
    expect(trimToSpokenTurn('Just one.', 2)).toBe('Just one.');
    expect(voiceMaxSentences(voiceConfig())).toBeGreaterThan(0);
  });

  it('has something to say for every way a call can end', () => {
    expect(gracefulExitSegment('en', 'Meena').text).toContain('Meena');
    expect(pipelineFailureSegment('en', 'Meena').text).toContain('Meena');
    expect(fillerSegment('ta').text.length).toBeGreaterThan(0);
    expect(closingSegments({ language: 'en', summarySent: true })).toHaveLength(2);
    expect(closingSegments({ language: 'en', summarySent: false })).toHaveLength(1);
  });
});

describe('phase 5 — VoiceCallService', () => {
  let harness: DomainTestHarness;
  let voice: VoiceTestHarness;
  let world: VoiceWorld;
  let service: VoiceCallService<MemoryTx>;
  let killSwitch: boolean;
  let alerts: string[];

  const request = {
    shopId: SHOP,
    driver: 'loopback',
    to: '+919841100001',
    toMasked: '••••0001',
    fromNumber: '+911140000000',
    jobCardId: JOB_CARD,
    customerId: CUSTOMER,
    conversationId: null,
    approvalRequestId: null,
    escalationId: null,
    objective: 'request_approval',
    language: 'en' as const,
    traceId: 'voice-domain-test',
  };

  beforeEach(() => {
    killSwitch = false;
    alerts = [];
    harness = createDomainTestHarness(() => T0);
    world = new VoiceWorld();
    voice = createVoiceTestHarness(world);

    harness.world.addShop(SHOP, 'Asia/Kolkata');
    harness.world.configs.set(SHOP, voiceConfig());
    harness.world.consents.push({
      id: uuidv7(),
      shopId: SHOP,
      customerId: CUSTOMER,
      purpose: 'SERVICE',
      status: 'GRANTED',
      channel: 'WHATSAPP',
      source: 'SEED',
      evidence: null,
      grantedAt: new Date(T0.getTime() - 86_400_000),
      revokedAt: null,
      createdAt: new Date(T0.getTime() - 86_400_000),
    });

    service = new VoiceCallService<MemoryTx>({
      uow: harness.uow,
      calls: voice.calls,
      turns: voice.turns,
      consentEvents: voice.consentEvents,
      usage: voice.usage,
      consents: new InMemoryConsentStore(harness.world),
      config: harness.config,
      audit: harness.audit,
      outbox: harness.outbox,
      recordings: voice.recordings,
      rates: {
        telcoPaisePerMinute: 60,
        sttPaisePerMinute: 30,
        ttsPaisePerMinute: 40,
        usdMicrosToPaise: 9_000,
      },
      platformCapPaise: 1_000_000,
      alertRatio: 0.8,
      platformKillSwitch: () => killSwitch,
      retentionDays: 180,
      clock: { now: () => T0 },
      onCapAlert: (alert) => alerts.push(alert.message),
    });
  });

  it('opens a call row and audits the origination with the mask, never the number', async () => {
    const decision = await service.authorise(request);
    expect(decision.allowed).toBe(true);

    const row = world.calls.get(decision.callId);
    expect(row).toMatchObject({ status: 'ORIGINATING', direction: 'OUTBOUND' });

    const audit = harness.world.auditFor(SHOP);
    const originated = audit.find((entry) => entry.action === 'call.originated');
    expect(originated).toBeDefined();
    // A call log is a list of who a shop rang.
    expect(JSON.stringify(originated?.payload)).not.toContain('9841100001');
    expect(JSON.stringify(originated?.payload)).toContain('••••0001');
  });

  it('writes a BLOCKED row rather than nothing when it refuses', async () => {
    killSwitch = true;
    const decision = await service.authorise(request);

    expect(decision).toMatchObject({ allowed: false, code: 'KILL_SWITCH' });

    // Silence is indistinguishable from a crash. A rung that decided not to
    // dial is a fact the ladder and phase 6's metrics both need.
    const row = world.calls.get(decision.callId);
    expect(row).toMatchObject({ status: 'BLOCKED', outcome: 'NOT_PLACED', blockedCode: 'KILL_SWITCH' });
    expect(harness.world.auditActions()).toContain('call.blocked');
  });

  it('does not count a blocked call against anybody’s daily cap', async () => {
    killSwitch = true;
    await service.authorise(request);
    await service.authorise(request);
    killSwitch = false;

    const counted = await harness.uow.transaction((tx) =>
      voice.calls.countForCustomerSince(tx, SHOP, CUSTOMER, new Date(T0.getTime() - 86_400_000)),
    );
    expect(counted).toBe(0);
  });

  it('records the provider’s own id when the line starts ringing', async () => {
    const decision = await service.authorise(request);
    await service.markRinging(SHOP, decision.callId, 'loopback:abc');

    const row = await service.loadCall(SHOP, decision.callId);
    expect(row).toMatchObject({ status: 'RINGING', providerCallSid: 'loopback:abc' });
  });

  it('will not let a recorder start before the notice has been played', async () => {
    const decision = await service.authorise(request);
    expect(await service.mayStartRecording(SHOP, decision.callId)).toBe(false);

    await service.recordConsentFact({
      shopId: SHOP,
      callId: decision.callId,
      fact: 'RECORDING_NOTICE_PLAYED',
      turnIndex: 1,
      traceId: request.traceId,
    });

    expect(await service.mayStartRecording(SHOP, decision.callId)).toBe(true);
  });

  it('refuses to store a recording for a call whose notice was never played', async () => {
    const decision = await service.authorise(request);

    const mediaId = await service.attachRecording({
      shopId: SHOP,
      callId: decision.callId,
      wav: Buffer.from('not a wav'),
      durationMs: 1_000,
      traceId: request.traceId,
    });

    // Re-checked at the moment the bytes would be persisted, not only where the
    // recorder started: between those two moments a call can have been
    // transferred, retried or replayed.
    expect(mediaId).toBeNull();
    expect(world.recordings.size).toBe(0);
  });

  it('records a consent fact once, and audits it', async () => {
    const decision = await service.authorise(request);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await service.recordConsentFact({
        shopId: SHOP,
        callId: decision.callId,
        fact: 'AI_DISCLOSURE_PLAYED',
        turnIndex: 0,
        traceId: request.traceId,
      });
    }

    expect(world.factsFor(decision.callId)).toHaveLength(1);
    expect(harness.world.auditActions().filter((action) => action === 'call.consent_fact')).toHaveLength(1);
  });

  it('appends a transcript that a retry cannot duplicate', async () => {
    const decision = await service.authorise(request);
    const turn = {
      callId: decision.callId,
      shopId: SHOP,
      turnIndex: 0,
      role: 'SYSTEM' as const,
      inputMode: 'NONE' as const,
      text: 'I am an AI assistant, not a person.',
      dtmfDigit: null,
      confidence: null,
      languageTag: 'en-IN',
      mandatorySegment: true,
      scriptKey: 'voice.disclosure',
      bargedIn: false,
      playedMs: 4_000,
      latencyMs: null,
      latencyStages: {},
      toolCalls: [],
      checkerVerdicts: [],
      agentRunId: null,
      startedAt: T0,
    };

    await service.appendTurn(turn);
    await service.appendTurn(turn);

    // A duplicated sentence in a transcript an auditor reads as the record of
    // what a customer was told is worse than a missing one.
    expect(await service.loadTurns(SHOP, decision.callId)).toHaveLength(1);
  });

  it('bridges to an advisor, audits it, and emits the handoff event', async () => {
    const decision = await service.authorise(request);
    await service.recordBridge({
      shopId: SHOP,
      callId: decision.callId,
      advisorStaffId: 'staff-1',
      whisperText: 'Ravi, Maruti Swift, JC-2026-0042.',
      traceId: request.traceId,
    });

    expect(world.calls.get(decision.callId)).toMatchObject({
      handedOff: true,
      bridgedToStaffId: 'staff-1',
    });
    expect(harness.world.auditActions()).toContain('call.bridged');
    expect(harness.world.eventsOfType('call.handoff_bridged')).toHaveLength(1);
  });

  it('meters the call whatever happened to it, exactly once', async () => {
    const decision = await service.authorise(request);
    const finish = {
      callId: decision.callId,
      shopId: SHOP,
      status: 'COMPLETED' as const,
      outcome: 'NO_ANSWER' as const,
      endReason: 'PROVIDER_ERROR' as const,
      endedAt: T0,
      durationSeconds: 20,
      turnCount: 0,
      handedOff: false,
      degradedToIvr: false,
      poorTurnCount: 0,
      bargeInCount: 0,
      maxTurnLatencyMs: 0,
      intent: null,
      decision: null,
      agentRunId: null,
      traceId: request.traceId,
      telcoMs: 20_000,
      sttMs: 0,
      ttsMs: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
      llmCostUsdMicros: 0,
    };

    const usage = await service.finish(finish);
    // A ringing leg that nobody answered still consumed telco seconds, and a
    // cap that only counted successful calls is a cap a shop can exhaust
    // without it noticing.
    expect(usage.telcoSeconds).toBe(20);
    expect(usage.estimatedCostPaise).toBeGreaterThan(0);

    await service.finish(finish);
    expect(world.usage.size).toBe(1);

    expect(harness.world.eventsOfType('call.ended')).toHaveLength(2);
    expect(harness.world.eventsOfType('call.usage_recorded')).toHaveLength(2);
  });

  it('alerts the moment a cap is breached, not the call after', async () => {
    harness.world.configs.set(SHOP, voiceConfig({ dailyCostCapPaise: 10 }));
    const decision = await service.authorise(request);

    const usage = await service.finish({
      callId: decision.callId,
      shopId: SHOP,
      status: 'COMPLETED',
      outcome: 'DECISION_RECORDED',
      endReason: 'OBJECTIVE_MET',
      endedAt: T0,
      durationSeconds: 120,
      turnCount: 8,
      handedOff: false,
      degradedToIvr: false,
      poorTurnCount: 0,
      bargeInCount: 1,
      maxTurnLatencyMs: 900,
      intent: null,
      decision: 'FULL',
      agentRunId: null,
      traceId: request.traceId,
      telcoMs: 120_000,
      sttMs: 30_000,
      ttsMs: 40_000,
      llmInputTokens: 1_800,
      llmOutputTokens: 200,
      llmCostUsdMicros: 0,
    });

    expect(usage.capBreached).toBe('SHOP_DAILY');
    expect(alerts.join(' ')).toContain('SHOP_DAILY');
    expect(await service.spendToday(SHOP)).toBe(usage.estimatedCostPaise);
  });

  it('counts a rung’s attempts from the call rows, not from a flag', async () => {
    const withRung = { ...request, escalationId: 'rung-1' };
    expect(await service.attemptsForEscalation(SHOP, 'rung-1')).toBe(0);

    await service.authorise(withRung);
    expect(await service.attemptsForEscalation(SHOP, 'rung-1')).toBe(1);

    // A refused attempt never rang anybody, so it does not spend the retry.
    killSwitch = true;
    await service.authorise(withRung);
    expect(await service.attemptsForEscalation(SHOP, 'rung-1')).toBe(1);
  });

  it('answers the phone without asking about consent or quiet hours', async () => {
    harness.world.configs.set(SHOP, voiceConfig());
    const decision = await service.acceptInbound({
      ...request,
      customerId: null,
      objective: 'answer_status',
      providerCallSid: 'loopback:in',
    });

    expect(decision.allowed).toBe(true);
    // Those guardrails exist to stop a shop *initiating*; refusing to answer a
    // customer who dialled would be the opposite of what they protect.
    expect(world.calls.get(decision.callId)).toMatchObject({
      direction: 'INBOUND',
      status: 'IN_PROGRESS',
      providerCallSid: 'loopback:in',
    });
  });
});
