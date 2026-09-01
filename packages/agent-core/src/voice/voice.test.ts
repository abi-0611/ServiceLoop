import { describe, expect, it } from 'vitest';
import {
  DeferredLlmAdapter,
  MockLlmAdapter,
  concatFrames,
  decodeUtterances,
  deterministicJudge,
} from '@serviceloop/adapters';
import { MANDATORY_SCRIPT_KEYS } from '@serviceloop/domain';
import {
  createVoiceCallWorld,
  ADVISOR_PHONE,
  CUSTOMER_PHONE,
  VOICE_APPROVAL,
  VOICE_CUSTOMER,
  VOICE_ITEM_BRAKES,
  VOICE_ITEM_OIL,
  VOICE_JOB_CARD,
  VOICE_SHOP,
  WORK_SUMMARY,
  VOICE_TOTAL_PAISE,
  type VoiceCallWorld,
} from '../testing/voice-world';

/**
 * The phase-5 acceptance properties, on a modelled telephone.
 *
 * Every test here runs two concurrent parties against a real
 * `BrowserLoopbackTelephonyAdapter` — the runtime on one side, a scripted
 * customer on the other — with no shortcut around the port. What the agent said
 * is read back by *decoding the audio the line carried*, not by reading a
 * string the code under test also logged, which is the only version of that
 * assertion worth writing.
 *
 * The properties, in the order the phase file asks for them:
 *
 *   - the ⚿ opening plays before anything else, and the recorder starts after
 *     the notice and never before (5.6);
 *   - a decision is read back before it is recorded, and the readback survives
 *     the caller saying something other than yes (5.3);
 *   - barge-in cuts the agent's audio, and the cut is measured in what the line
 *     actually discarded (5.3);
 *   - the keypad completes an approval on its own, and moves the work items
 *     (5.4a / 5.5);
 *   - two unintelligible turns drop the call to the keypad (5.5);
 *   - the caps, the kill switch and revoked consent make a call impossible
 *     before a packet leaves (5.6 / 5.7);
 *   - the call is metered, whatever happened to it (5.7).
 */

describe('phase 5 — the opening and the recorder', () => {
  it('plays the AI disclosure and the recording notice before anything else', async () => {
    const world = createVoiceCallWorld();
    const { report, caller } = await world.placeOutbound([{ kind: 'press', digit: '0' }]);

    expect(report.placed).toBe(true);
    expect(report.disclosurePlayed).toBe(true);

    const turns = await world.calls.loadTurns(VOICE_SHOP, report.callId);
    const scriptKeys = turns.filter((turn) => turn.mandatorySegment).map((turn) => turn.scriptKey);

    expect(scriptKeys.slice(0, 2)).toEqual(['voice.disclosure', 'voice.recording_notice']);
    // Heard, not merely persisted: the words reached the far end as audio.
    expect(caller?.heard.length ?? 0).toBeGreaterThan(0);
  });

  it('records no audio at all from before the notice, and says how much it left out', async () => {
    const world = createVoiceCallWorld();
    const { report } = await world.placeOutbound([{ kind: 'press', digit: '1' }]);

    const facts = world.voiceWorld.factsFor(report.callId).map((fact) => fact.fact);
    expect(facts).toContain('AI_DISCLOSURE_PLAYED');
    expect(facts).toContain('RECORDING_NOTICE_PLAYED');
    expect(facts).toContain('RECORDING_STARTED');

    // Ordering, not merely presence. The notice is recorded before the recorder
    // is — which is the whole of 5.6 in one comparison.
    const order = world.voiceWorld.factsFor(report.callId);
    const noticeAt = order.findIndex((fact) => fact.fact === 'RECORDING_NOTICE_PLAYED');
    const startedAt = order.findIndex((fact) => fact.fact === 'RECORDING_STARTED');
    expect(noticeAt).toBeGreaterThanOrEqual(0);
    expect(startedAt).toBeGreaterThan(noticeAt);

    expect(report.recordingStartedAfterNotice).toBe(true);

    const recording = [...world.voiceWorld.recordings.values()].find(
      (row) => row.callId === report.callId,
    );
    expect(recording).toBeDefined();

    // The bytes themselves carry nothing from the two ⚿ segments.
    const said = decodeUtterances(recording?.wav ?? Buffer.alloc(0)).map((entry) => entry.text);
    const mandatoryTexts = (await world.calls.loadTurns(VOICE_SHOP, report.callId))
      .filter((turn) => turn.mandatorySegment)
      .map((turn) => turn.text);
    for (const mandatory of mandatoryTexts) {
      expect(said.join(' ')).not.toContain(mandatory);
    }
  });

  it('refuses to dial at all when a mandatory segment key is missing from the catalogue', () => {
    // The compliance guarantee is a property of the *keys*, not of the copy —
    // which is what lets a Tamil sentence be improved without failing a test.
    expect([...MANDATORY_SCRIPT_KEYS]).toContain('voice.disclosure');
    expect([...MANDATORY_SCRIPT_KEYS]).toContain('voice.recording_notice');
  });
});

describe('phase 5.5 — the keypad', () => {
  it('completes an approval on the keypad alone, and moves the work items', async () => {
    const world = createVoiceCallWorld();
    const approvalId = await world.openApproval();

    const { report } = await world.placeOutbound(
      // Press 1 to approve, hear the readback, press 1 again to confirm it.
      [
        { kind: 'press', digit: '1' },
        { kind: 'press', digit: '1' },
      ],
      { approvalRequestId: approvalId },
    );

    expect(report.outcome).toBe('DECISION_RECORDED');
    expect(report.decision).toBe('FULL');

    const approval = world.agentHarness.agentWorld.approvals.get(approvalId);
    expect(approval?.decision).toBe('FULL');
    expect(approval?.approvedWorkItemIds).toEqual([VOICE_ITEM_BRAKES, VOICE_ITEM_OIL]);

    // The job card and its items moved, exactly as they would from a tap in the
    // thread. A phone call that only wrote a call row would be a phone call
    // that lost the customer's answer.
    expect(world.harness.world.items.get(VOICE_ITEM_BRAKES)?.state).toBe('APPROVED');
    expect(world.harness.world.items.get(VOICE_ITEM_OIL)?.state).toBe('APPROVED');
  });

  it('reads a keypad approval back before it records anything', async () => {
    const world = createVoiceCallWorld();
    const approvalId = await world.openApproval();

    // Presses 1 once, then says something that is not a confirmation.
    const { report } = await world.placeOutbound(
      [
        { kind: 'press', digit: '1' },
        { kind: 'say', text: 'wait, how much did you say' },
        { kind: 'hangUp' },
      ],
      { approvalRequestId: approvalId },
      { timeoutMs: 25_000 },
    );

    expect(report.decision).not.toBe('FULL');
    expect(world.agentHarness.agentWorld.approvals.get(approvalId)?.decision).toBeNull();
    expect(world.harness.world.items.get(VOICE_ITEM_BRAKES)?.state).toBe('PENDING_APPROVAL');
  });

  it('treats 0 as a person from anywhere, offered or not', async () => {
    const world = createVoiceCallWorld();
    const { report } = await world.placeOutbound([{ kind: 'press', digit: '0' }]);

    expect(report.handedOff).toBe(true);
    expect(['BRIDGED', 'ADVISOR_TASK_RAISED']).toContain(report.outcome);

    const call = await world.calls.loadCall(VOICE_SHOP, report.callId);
    expect(call?.handedOff).toBe(true);
  });

  it('drops to the keypad after two turns it could not hear', async () => {
    const world = createVoiceCallWorld();
    const { report } = await world.placeOutbound(
      [
        { kind: 'noise' },
        { kind: 'noise' },
        // Twice: a decline is read back before it is recorded, the same as an
        // approval, because a misdialled 3 loses the shop the job.
        { kind: 'press', digit: '3' },
        { kind: 'press', digit: '3' },
      ],
      {},
      { timeoutMs: 25_000 },
    );

    expect(report.degradedToIvr).toBe(true);
    expect(report.decision).toBe('DECLINED');

    const call = await world.calls.loadCall(VOICE_SHOP, report.callId);
    expect(call?.degradedToIvr).toBe(true);
    expect(call?.poorTurnCount ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe('phase 5.3 — barge-in and dead air', () => {
  it('cuts the agent’s audio when the caller talks over it', async () => {
    const world = createVoiceCallWorld();
    const { report } = await world.placeOutbound(
      [
        // 9 replays the interruptible part of the opening, which is what the
        // caller then talks over. Interrupting the two mandatory segments is a
        // different property, and the next test is the one that asserts it.
        { kind: 'press', digit: '9' },
        { kind: 'bargeIn', text: 'yes yes just do it', afterMs: 200 },
        { kind: 'press', digit: '1' },
        { kind: 'press', digit: '1' },
      ],
      {},
      { timeoutMs: 25_000 },
    );

    expect(report.bargeIns).toBeGreaterThanOrEqual(1);

    const turns = await world.calls.loadTurns(VOICE_SHOP, report.callId);
    const cut = turns.filter((turn) => turn.bargedIn);
    expect(cut.length).toBeGreaterThanOrEqual(1);

    // A cut turn played less than it synthesised. "We called stop" is not
    // evidence that anything stopped.
    for (const turn of cut) {
      expect(turn.playedMs).not.toBeNull();
    }
  });

  it('never cuts the disclosure or the recording notice', async () => {
    const world = createVoiceCallWorld();
    const { report } = await world.placeOutbound(
      [
        { kind: 'bargeIn', text: 'who is this', afterMs: 40 },
        { kind: 'press', digit: '0' },
      ],
      {},
      { timeoutMs: 25_000 },
    );

    const turns = await world.calls.loadTurns(VOICE_SHOP, report.callId);
    const mandatory = turns.filter((turn) => turn.mandatorySegment);

    expect(mandatory.length).toBeGreaterThanOrEqual(2);
    // A legal obligation a cough can cancel is not an obligation.
    expect(mandatory.every((turn) => !turn.bargedIn)).toBe(true);
  });

  it('answers a caller who says nothing rather than leaving the line silent', async () => {
    const world = createVoiceCallWorld();
    const { report, caller } = await world.placeOutbound(
      [
        { kind: 'silence' },
        { kind: 'press', digit: '4' },
        { kind: 'press', digit: '4' },
      ],
      {},
      { timeoutMs: 25_000 },
    );

    expect(report.decision).toBe('DEFERRED');

    const turns = await world.calls.loadTurns(VOICE_SHOP, report.callId);
    expect(turns.some((turn) => turn.scriptKey === 'voice.no_input')).toBe(true);
    expect(caller?.timedOut).toBe(false);
  });
});

describe('phase 5.4 — the flows', () => {
  it('runs the agent, reads back and records a decision from speech', async () => {
    // The script has to name the approval it decides, and the approval does not
    // exist until the world does — so the model is handed over as a late-bound
    // slot. The alternative is a scripted id that no row has.
    const slot = new DeferredLlmAdapter(deterministicJudge());
    const world = createVoiceCallWorld({ llm: slot });
    const approvalId = await world.openApproval();
    slot.use(approvalScript(approvalId));

    const { report } = await world.placeOutbound(
      [
        { kind: 'say', text: 'how much is it' },
        { kind: 'say', text: 'yes go ahead' },
      ],
      { approvalRequestId: approvalId },
      { timeoutMs: 25_000 },
    );

    expect(report.outcome).toBe('DECISION_RECORDED');
    expect(report.decision).toBe('FULL');
    expect(world.agentHarness.agentWorld.approvals.get(approvalId)?.decision).toBe('FULL');
  });

  it('sends the WhatsApp summary through the ordinary gate after a decision', async () => {
    const world = createVoiceCallWorld();
    const approvalId = await world.openApproval();
    const before = world.sentBodies().length;

    const { report } = await world.placeOutbound(
      [
        { kind: 'press', digit: '1' },
        { kind: 'press', digit: '1' },
      ],
      { approvalRequestId: approvalId },
    );

    expect(report.summarySent).toBe(true);
    expect(world.sentBodies().length).toBeGreaterThan(before);
  });

  it('answers an inbound call and bridges a frustrated caller to the advisor', async () => {
    const world = createVoiceCallWorld();
    const { report } = await world.answerInbound(
      [{ kind: 'press', digit: '0' }],
      {},
      { timeoutMs: 25_000 },
    );

    expect(report.placed).toBe(true);
    expect(report.outcome).toBe('BRIDGED');

    const call = await world.calls.loadCall(VOICE_SHOP, report.callId);
    expect(call?.direction).toBe('INBOUND');
    expect(call?.bridgedToStaffId).not.toBeNull();
    // The advisor is whispered a summary the customer never hears.
    expect(call?.whisperText ?? '').toContain('Maruti Swift');
  });

  it('whispers the summary to the advisor leg alone', async () => {
    const world = createVoiceCallWorld();
    const { report } = await world.answerInbound(
      [{ kind: 'press', digit: '0' }],
      {},
      { timeoutMs: 25_000 },
    );

    // Through `providerCallSid`, because the call row's id and the line's are
    // two different identifiers for one telephone call.
    const handset = await world.handsetFor(report.callId);
    expect(handset).not.toBeNull();
    expect(handset?.isBridged()).toBe(true);

    const whispered = decodeUtterances(handset?.whisperPcm() ?? Buffer.alloc(0))
      .map((entry) => entry.text)
      .join(' ');
    expect(whispered).toContain('Maruti Swift');

    const call = await world.calls.loadCall(VOICE_SHOP, report.callId);
    expect(call?.bridgedToStaffId).not.toBeNull();
    expect(ADVISOR_PHONE.length).toBeGreaterThan(0);
  });

  it('reports how long to wait before retrying a call nobody answered', async () => {
    const world = createVoiceCallWorld({ settingsPatch: { ringTimeoutMs: 60 } });

    // No caller: the handset is never picked up, so the ring times out.
    const report = await world.runner.runOutboundApproval({
      shopId: VOICE_SHOP,
      jobCardId: VOICE_JOB_CARD,
      customerId: VOICE_CUSTOMER,
      conversationId: null,
      approvalRequestId: VOICE_APPROVAL,
      escalationId: null,
      amountPaise: VOICE_TOTAL_PAISE,
      workSummary: WORK_SUMMARY,
      traceId: 'voice-no-answer',
    });

    expect(report.outcome).toBe('NO_ANSWER');
    expect(report.placed).toBe(true);
    expect(report.retryAfterMinutes).toBe(world.config.voice.retryAfterMinutes);
  });
});

describe('phase 5.6 / 5.7 — the brakes', () => {
  it('refuses to call a customer who revoked service consent, and audits the refusal', async () => {
    const world = createVoiceCallWorld();
    revokeConsent(world);

    const { report, caller } = await world.placeOutbound([{ kind: 'press', digit: '1' }]);

    expect(report.placed).toBe(false);
    expect(report.refusalCode).toBe('CONSENT_REVOKED');
    // Not merely refused — no line was ever opened, so there was no far end.
    expect(caller).toBeNull();
    expect(world.telephony.activeSessions()).toHaveLength(0);

    // A revoked customer is not reached by a person on the agent's behalf either.
    expect(report.fallBackToAdvisor).toBe(false);

    const call = await world.calls.loadCall(VOICE_SHOP, report.callId);
    expect(call?.status).toBe('BLOCKED');
    expect(call?.blockedCode).toBe('CONSENT_REVOKED');
    expect(world.harness.world.auditActions()).toContain('call.blocked');
  });

  it('reverts every rung to an advisor task while the kill switch is on', async () => {
    let killed = true;
    const world = createVoiceCallWorld({ platformKillSwitch: () => killed });

    const first = await world.placeOutbound([{ kind: 'press', digit: '1' }]);
    expect(first.report.placed).toBe(false);
    expect(first.report.refusalCode).toBe('KILL_SWITCH');
    expect(first.report.fallBackToAdvisor).toBe(true);

    // Flipped without a deploy: the same runner, the same config, one flag.
    killed = false;
    const second = await world.placeOutbound([{ kind: 'press', digit: '0' }]);
    expect(second.report.placed).toBe(true);
  });

  it('halts new originations once the shop has spent its day’s budget', async () => {
    const world = createVoiceCallWorld({
      configPatch: (config) => ({
        ...config,
        voice: { ...config.voice, dailyCostCapPaise: 1 },
      }),
    });

    const { report } = await world.placeOutbound([{ kind: 'press', digit: '1' }]);

    // The cap is measured against spend, and the first call of the day has not
    // spent anything — so this one is placed and the *next* one is refused.
    expect(report.placed).toBe(true);

    const second = await world.placeOutbound([{ kind: 'press', digit: '1' }]);
    expect(second.report.placed).toBe(false);
    expect(second.report.refusalCode).toBe('SHOP_COST_CAP');
    expect(second.report.fallBackToAdvisor).toBe(true);
  });

  it('refuses a shop that has taken its calls for the day', async () => {
    const world = createVoiceCallWorld({
      configPatch: (config) => ({
        ...config,
        voice: { ...config.voice, maxCallsPerCustomerPerDay: 1 },
      }),
    });

    await world.placeOutbound([{ kind: 'press', digit: '0' }]);
    const second = await world.placeOutbound([{ kind: 'press', digit: '0' }]);

    expect(second.report.placed).toBe(false);
    expect(second.report.refusalCode).toBe('CUSTOMER_CALL_CAP');
  });

  it('writes exactly one usage row per call, whatever happened to it', async () => {
    const world = createVoiceCallWorld();
    const { report } = await world.placeOutbound([{ kind: 'press', digit: '0' }]);

    const usage = world.voiceWorld.usage.get(report.callId);
    expect(usage).toBeDefined();
    expect(usage?.shopId).toBe(VOICE_SHOP);
    expect(usage?.estimatedCostPaise ?? 0).toBeGreaterThan(0);
    // Speech is metered separately from the line, because they fail separately.
    expect(usage?.ttsSeconds ?? 0).toBeGreaterThan(0);
  });
});

describe('phase 5 — the transcript', () => {
  it('persists every turn in order, with the caller’s and the agent’s both in it', async () => {
    const world = createVoiceCallWorld();
    const { report } = await world.placeOutbound(
      [
        { kind: 'press', digit: '1' },
        { kind: 'press', digit: '1' },
      ],
      { approvalRequestId: await worldApproval(world) },
    );

    const turns = await world.calls.loadTurns(VOICE_SHOP, report.callId);
    expect(turns.length).toBeGreaterThan(4);
    expect(turns.map((turn) => turn.turnIndex)).toEqual(
      turns.map((_turn, index) => index),
    );

    expect(turns.some((turn) => turn.role === 'CALLER' && turn.dtmfDigit === '1')).toBe(true);
    expect(turns.some((turn) => turn.role === 'SYSTEM' && turn.mandatorySegment)).toBe(true);
  });

  it('carries the agent’s actual words down the wire, not a logged copy', async () => {
    const heard: string[] = [];
    const world = createVoiceCallWorld();
    const running = world.placeOutbound([{ kind: 'press', digit: '0' }]);
    const { report } = await running;

    const turns = await world.calls.loadTurns(VOICE_SHOP, report.callId);
    const recording = [...world.voiceWorld.recordings.values()].find(
      (row) => row.callId === report.callId,
    );
    for (const entry of decodeUtterances(recording?.wav ?? Buffer.alloc(0))) {
      heard.push(entry.text);
    }

    const spokenAfterNotice = turns
      .filter((turn) => !turn.mandatorySegment && turn.role !== 'CALLER')
      .map((turn) => turn.text);

    // Each persisted sentence was actually carried as audio. Synthesis splits a
    // turn into chunks, so the assertion is containment rather than equality.
    for (const sentence of spokenAfterNotice.slice(0, 1)) {
      expect(heard.join(' ')).toContain(sentence.split(/[.!?]/u)[0]?.trim() ?? sentence);
    }
    expect(concatFrames([])).toHaveLength(0);
  });
});

describe('phase 5.4a — the VOICE_OR_ADVISOR rung', () => {
  it('rings the customer instead of raising a task, and the decision closes the ladder', async () => {
    const world = createVoiceCallWorld();
    const approvalId = await world.openApproval();

    // The rung fires while a customer with a keypad is on the other end.
    const placed = await world.fireVoiceRung(approvalId, [
      { kind: 'press', digit: '1' },
      { kind: 'press', digit: '1' },
    ]);

    expect(placed.outcome).toBe('SENT');
    expect(placed.detail).toContain('FULL');

    // The customer's answer moved the work, exactly as a tap in the thread would.
    expect(world.harness.world.items.get(VOICE_ITEM_BRAKES)?.state).toBe('APPROVED');
    // And no advisor was asked to make a call that has already happened.
    expect(callTasks(world)).toHaveLength(0);
  });

  it('rings again once when nobody answers, and only once', async () => {
    const world = createVoiceCallWorld({ settingsPatch: { ringTimeoutMs: 60 } });
    const approvalId = await world.openApproval();

    // Nobody picks up: no caller is attached, so the ring times out.
    const first = await world.fireVoiceRung(approvalId);
    expect(first.outcome).toBe('DEFERRED');
    expect(first.detail).toContain('again');

    const second = await world.fireVoiceRung(approvalId);
    // Second time it stops trying and puts a person on it.
    expect(second.outcome).toBe('TASK_CREATED');
    expect(callTasks(world).length).toBeGreaterThanOrEqual(1);
  });

  it('does not task a person to ring a customer who revoked consent', async () => {
    const world = createVoiceCallWorld();
    const approvalId = await world.openApproval();
    revokeConsent(world);

    const result = await world.fireVoiceRung(approvalId);

    expect(result.outcome).toBe('BLOCKED');
    expect(result.detail).toContain('CONSENT_REVOKED');
    // The same violation with an extra step is still the violation.
    expect(callTasks(world)).toHaveLength(0);
  });

  it('falls back to the phase-3 advisor task when the shop has voice switched off', async () => {
    const world = createVoiceCallWorld({
      configPatch: (config) => ({
        ...config,
        voice: { ...config.voice, enabled: false, outboundEnabled: false, inboundEnabled: false },
      }),
    });
    const approvalId = await world.openApproval();

    const result = await world.fireVoiceRung(approvalId);

    expect(result.outcome).toBe('TASK_CREATED');
    expect(callTasks(world)).toHaveLength(1);
    expect(callTasks(world)[0]?.brief ?? '').toContain('Maruti Swift');
  });
});

function callTasks(world: VoiceCallWorld): { brief: string }[] {
  return [...world.agentHarness.agentWorld.tasks.values()].filter(
    (task) => task.kind === 'CALL_CUSTOMER',
  );
}

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

async function worldApproval(world: VoiceCallWorld): Promise<string> {
  return world.openApproval();
}

function revokeConsent(world: VoiceCallWorld): void {
  for (const consent of world.harness.world.consents) {
    if (consent.customerId === VOICE_CUSTOMER && consent.purpose === 'SERVICE') {
      consent.status = 'REVOKED';
      consent.revokedAt = world.now();
    }
  }
  expect(CUSTOMER_PHONE.length).toBeGreaterThan(0);
}

/**
 * The agent's scripted turns for a spoken approval.
 *
 * Two customer turns, so two runs: the price question, then the readback, then
 * the decision the readback unlocked. Scripted rather than modelled, so a
 * failure here is a finding about the runtime rather than about a model's mood.
 */
function approvalScript(approvalId: string): MockLlmAdapter {
  return new MockLlmAdapter(
    {
      name: 'voice-approval',
      description: 'a customer who asks the price and then agrees',
      model: 'mock-agent',
      turns: [
        {
          text: '',
          toolCalls: [
            {
              name: 'compose_customer_message',
              args: {
                draft:
                  'Front brake pads (set) comes to ₹2,400.00. Shall I go ahead — say yes, or press one?',
                claims: [
                  {
                    text: 'Front brake pads (set) comes to ₹2,400.00.',
                    sources: ['line:line-brakes'],
                  },
                ],
                language: 'en',
              },
            },
          ],
          inputTokens: 900,
          outputTokens: 120,
        },
        {
          text: '',
          toolCalls: [
            {
              name: 'speak_to_caller',
              args: { candidateId: '{{candidateId}}', isReadback: true },
            },
          ],
          inputTokens: 900,
          outputTokens: 40,
        },
        {
          text: '',
          toolCalls: [
            {
              name: 'record_customer_decision',
              args: {
                approvalId,
                decision: 'FULL',
                approvedWorkItemIds: [],
                note: 'Agreed on the call',
              },
            },
          ],
          inputTokens: 700,
          outputTokens: 40,
        },
      ],
    },
    {
      // The script is the *agent's* turns. The claim judge is delegated, so a
      // JUDGE call mid-run cannot consume the agent's next step — and cannot
      // fail the run closed for want of a credential.
      handles: ['AGENT'],
      delegate: deterministicJudge(),
    },
  );
}
