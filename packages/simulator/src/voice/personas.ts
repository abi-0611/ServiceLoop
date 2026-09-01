import { MockLlmAdapter, deterministicJudge, type CallerAction } from '@serviceloop/adapters';
import type { ShopConfig } from '@serviceloop/config';
import type { CustomerDecision, Language } from '@serviceloop/shared';

/**
 * The voice persona suite (phase 5.8).
 *
 * Four customers, each one a *telephone* failure the flow has to survive —
 * which is a different list from the six chat personas, because the things that
 * go wrong on a phone are not the things that go wrong in a thread. Nobody in
 * a WhatsApp conversation talks over you, and nobody's message arrives at 0.15
 * confidence because a lorry went past.
 *
 * They are written as *what a person does with a handset*: speak, press a key,
 * say nothing, make a noise the recogniser cannot read, interrupt. The runner
 * checks the outcome and then re-checks the properties the phase demands of
 * every call — the disclosure was heard, a decision was read back before it was
 * recorded, and the latency markers stayed inside the budget.
 *
 * Scripted mode is CI-required: `MockStreamingSpeechAdapter` for the audio,
 * `MockLlmAdapter` for the agent, a loopback line and no credentials. A
 * live-model / live-speech mode is deliberately absent rather than stubbed —
 * see PROGRESS.md, and the same reasoning the phase-3 suite recorded: a nightly
 * harness nobody has ever run is a claim, not a capability.
 */

export interface VoicePersona {
  readonly name: string;
  readonly description: string;
  readonly language: Language;
  readonly customerName: string;
  readonly direction: 'OUTBOUND' | 'INBOUND';
  /** What the person on the other end does, in order. */
  readonly actions: readonly CallerAction[];
  /**
   * The agent's scripted turns, for personas that make the agent talk.
   *
   * Takes the approval id because a scripted `record_customer_decision` has to
   * name a row that exists, and the row is created with the world — after the
   * persona is defined and before the call is placed.
   */
  script(approvalId: string): MockLlmAdapter | undefined;
  configPatch?: (config: ShopConfig) => ShopConfig;
  readonly expect: {
    readonly decision: CustomerDecision | null;
    readonly handedOff?: boolean;
    readonly degradedToIvr?: boolean;
    /** At least this many. A cut is a cut whether it happened once or twice. */
    readonly bargeIns?: number;
    readonly summarySent?: boolean;
  };
}

/* -------------------------------------------------------------------------- *
 * Script helpers
 * -------------------------------------------------------------------------- */

interface Turn {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<{ readonly name: string; readonly args: unknown }>;
}

function script(name: string, turns: readonly Turn[]): MockLlmAdapter {
  return new MockLlmAdapter(
    {
      name,
      description: `voice persona script: ${name}`,
      model: 'mock-agent',
      turns: turns.map((turn) => ({
        ...turn,
        toolCalls: turn.toolCalls.map((call) => ({ ...call })),
        inputTokens: 900,
        outputTokens: 120,
      })),
    },
    {
      // The script is the agent's turns. The claim judge is delegated so a
      // JUDGE call mid-run cannot consume the agent's next step — and cannot
      // fail the run closed for want of a credential.
      handles: ['AGENT'],
      delegate: deterministicJudge(),
    },
  );
}

/** A compose + speak pair, the shape every spoken turn ends in. */
function say(
  body: string,
  claims: ReadonlyArray<{ text: string; sources: string[] }>,
  language: Language,
  isReadback = false,
): readonly Turn[] {
  return [
    {
      text: '',
      toolCalls: [
        { name: 'compose_customer_message', args: { draft: body, claims, language } },
      ],
    },
    {
      text: '',
      // Resolved from the compose call's own tool result, the way a model reads
      // back an id it was just handed.
      toolCalls: [
        { name: 'speak_to_caller', args: { candidateId: '{{candidateId}}', isReadback } },
      ],
    },
  ];
}

/* -------------------------------------------------------------------------- *
 * The personas
 * -------------------------------------------------------------------------- */

/**
 * The customer this whole phase is for.
 *
 * Tamil, on a keypad, done in two presses. No model is consulted at any point —
 * the script asks, the keypad answers, the readback confirms — which is exactly
 * what makes it the cheapest and most reliable path through the flow, and the
 * reason the keypad is not an afterthought (5.5).
 */
const quickApprover: VoicePersona = {
  name: 'voice_quick_approver',
  description: 'Tamil owner who approves on the keypad without a word',
  language: 'ta',
  customerName: 'Ravi',
  direction: 'OUTBOUND',
  actions: [
    { kind: 'press', digit: '1' },
    { kind: 'press', digit: '1' },
  ],
  script: () => undefined,
  expect: { decision: 'FULL', summarySent: true, handedOff: false },
};

/**
 * The customer who interrupts, argues about the price, and then agrees.
 *
 * Hindi-English, which is what most of this market actually speaks, and the
 * only persona that exercises barge-in against a real cut: they start talking
 * over the evidence recap, which is where a real person interrupts because it
 * is where the number is.
 */
const priceObjector: VoicePersona = {
  name: 'voice_price_objector',
  description: 'Hindi-English driver who talks over the price and then agrees',
  language: 'hi',
  customerName: 'Amit',
  direction: 'OUTBOUND',
  actions: [
    { kind: 'press', digit: '9' },
    { kind: 'bargeIn', text: 'arre itna kyun, kuch kam karo', afterMs: 200 },
    { kind: 'say', text: 'theek hai, kar do' },
  ],
  script: (approvalId) =>
    script('voice_price_objector', [
      ...say(
        'Front brake pads (set) comes to ₹2,400.00. Shall I go ahead — say yes, or press one?',
        [
          {
            text: 'Front brake pads (set) comes to ₹2,400.00.',
            sources: ['line:line-brakes'],
          },
        ],
        'hi',
        true,
      ),
      {
        text: '',
        toolCalls: [
          {
            name: 'record_customer_decision',
            args: {
              approvalId,
              decision: 'FULL',
              approvedWorkItemIds: [],
              note: 'Agreed on the call after asking about the price',
            },
          },
        ],
      },
    ]),
  expect: { decision: 'FULL', bargeIns: 1, summarySent: true },
};

/**
 * The customer the phase exists to include.
 *
 * Says nothing at all — a hearing aid, a loud street, a phone held the wrong
 * way — and then finishes the whole approval on the keypad. If this persona
 * fails, the product has quietly decided that only confident English speakers
 * get to approve work by telephone.
 */
const dtmfElder: VoicePersona = {
  name: 'voice_dtmf_elder',
  description: 'Older owner who says nothing and completes it on the keypad',
  language: 'ta',
  customerName: 'Selvam',
  direction: 'OUTBOUND',
  actions: [
    { kind: 'silence' },
    { kind: 'press', digit: '1' },
    { kind: 'press', digit: '1' },
  ],
  script: () => undefined,
  expect: { decision: 'FULL', summarySent: true },
};

/**
 * The line the recogniser cannot read.
 *
 * Two unintelligible turns and the call drops to pure IVR (5.5), which is the
 * humane outcome: continuing to ask open questions of somebody you cannot hear
 * is how a customer ends up shouting at a robot. They then decline on the
 * keypad, and declining is a real outcome — the ledger keeps it for phase 6 to
 * re-pitch.
 */
const noisyLine: VoicePersona = {
  name: 'voice_noisy_line',
  description: 'Workshop noise the recogniser cannot read; the call becomes IVR',
  language: 'en',
  customerName: 'Ravi',
  direction: 'OUTBOUND',
  actions: [
    { kind: 'noise' },
    { kind: 'noise' },
    // Twice: declining is read back before it is recorded, the same as
    // approving. A misdialled 3 loses the shop the job.
    { kind: 'press', digit: '3' },
    { kind: 'press', digit: '3' },
  ],
  script: () => undefined,
  expect: { decision: 'DECLINED', degradedToIvr: true },
};

/**
 * The inbound line, and the caller who has had enough.
 *
 * "Car ready-aa?" is the call this line exists to answer, and `0` is the
 * escape hatch that has to work from anywhere. A frustrated caller reaching a
 * person in one keypress, with the advisor whispered an eight-second summary
 * before the legs join, is the whole of 5.4c.
 */
const inboundFrustrated: VoicePersona = {
  name: 'voice_inbound_handoff',
  description: 'Inbound caller who presses 0 and is warm-bridged to the advisor',
  language: 'ta',
  customerName: 'Ravi',
  direction: 'INBOUND',
  actions: [{ kind: 'press', digit: '0' }],
  script: () => undefined,
  expect: { decision: null, handedOff: true },
};

export const VOICE_PERSONAS: readonly VoicePersona[] = [
  quickApprover,
  priceObjector,
  dtmfElder,
  noisyLine,
  inboundFrustrated,
];
