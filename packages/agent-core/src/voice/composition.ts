import type { LlmPort, StreamingSpeechPort, TelephonyPort } from '@serviceloop/adapters';
import type { ShopConfig } from '@serviceloop/config';
import type {
  AdvisorTaskService,
  CallDestinationReader,
  JobCardContextReader,
  OutboundGate,
  ShopConfigStore,
  ShopDirectory,
  UnitOfWork,
  VoiceCallService,
} from '@serviceloop/domain';
import type { AuditAppender, AgentRunStore, ConversationStore, OutboxWriter } from '@serviceloop/domain';
import type { Clock } from '@serviceloop/shared';
import type { AgentRuntime } from '../composition';
import { buildVoiceToolRegistry, type VoiceCallState } from './voice-tools';
import {
  VoiceAgentRunner,
  type VoiceRuntimeSettings,
  type VoiceTraceLine,
} from './voice-runner';

/**
 * The phase-5 composition root.
 *
 * Same reasoning as `createAgentRuntime`: four processes want the identical
 * assembly — the API's softphone, the workers' ladder rung, the voice
 * simulation suite and `demo:phase5` — and each of them building a
 * `VoiceAgentRunner` by hand is how the demo ends up proving something
 * production does not do.
 *
 * The one interesting line is `registryFor`. A voice tool registry is built per
 * *call*, not per process, because the readback guardrail spans turns and a
 * call is several agent runs. Handing the runner a factory rather than a
 * registry is what makes that structural instead of a convention somebody has
 * to remember.
 */

export interface VoiceRuntimeInput<Tx> {
  /** The phase-3 runtime. Its tools, checker and guardrails are reused whole. */
  readonly runtime: AgentRuntime<Tx>;
  readonly telephony: TelephonyPort;
  readonly speech: StreamingSpeechPort;
  readonly calls: VoiceCallService<Tx>;
  readonly destinations: CallDestinationReader<Tx>;
  readonly gate: OutboundGate<Tx>;
  readonly llm: LlmPort;
  readonly stores: {
    readonly uow: UnitOfWork<Tx>;
    readonly runs: AgentRunStore<Tx>;
    readonly cards: JobCardContextReader<Tx>;
    readonly conversations: ConversationStore<Tx>;
    readonly directory: ShopDirectory<Tx>;
    readonly config: ShopConfigStore<Tx>;
    readonly audit: AuditAppender<Tx>;
    readonly outbox: OutboxWriter<Tx>;
  };
  readonly settings: VoiceRuntimeSettings;
  readonly clock?: Clock;
  readonly onTrace?: (line: VoiceTraceLine) => void;
}

/** The runtime defaults, in one place so a test and the API cannot disagree. */
export function voiceSettingsFrom(
  config: ShopConfig,
  overrides: Partial<VoiceRuntimeSettings> = {},
): VoiceRuntimeSettings {
  return {
    endpointSilenceMs: 700,
    maxDeadAirMs: 3_000,
    latencyBudgetMs: config.voice.latencyBudgetMs,
    frameMs: 20,
    noInputWaitMs: 6_000,
    ringTimeoutMs: 25_000,
    retentionDays: config.voice.recordingRetentionDays,
    rates: {
      telcoPaisePerMinute: 60,
      sttPaisePerMinute: 30,
      ttsPaisePerMinute: 40,
    },
    ...overrides,
  };
}

export function createVoiceRuntime<Tx>(input: VoiceRuntimeInput<Tx>): VoiceAgentRunner<Tx> {
  const { runtime, stores } = input;
  const withClock = input.clock === undefined ? {} : { clock: input.clock };

  const runner = new VoiceAgentRunner<Tx>({
    telephony: input.telephony,
    speech: input.speech,
    calls: input.calls,
    destinations: input.destinations,
    uow: stores.uow,
    cards: stores.cards,
    directory: stores.directory,
    config: stores.config,
    tasks: runtime.tasks as AdvisorTaskService<Tx>,
    approvals: runtime.approvals,
    gate: input.gate,
    llm: input.llm,
    agent: {
      uow: stores.uow,
      llm: input.llm,
      runs: stores.runs,
      conversations: stores.conversations,
      audit: stores.audit,
      outbox: stores.outbox,
      ...withClock,
    },
    registryFor: (callState: VoiceCallState) =>
      buildVoiceToolRegistry<Tx>({
        ...runtime.toolDeps,
        checker: runtime.checker,
        callState,
        // Read through the same per-call loader the rest of the tools use, so a
        // shop that changed its sentence limit this morning is governed by the
        // limit it set rather than by whatever was loaded at boot.
        voiceConfig: () => voiceConfigFor(callState),
      }),
    settings: input.settings,
    ...withClock,
    ...(input.onTrace === undefined ? {} : { onTrace: input.onTrace }),
  });

  // The `VOICE_OR_ADVISOR` rung can now ring somebody (phase 5.4a). Wired here
  // rather than passed to `createAgentRuntime`, because the runner is built
  // from the runtime the ladder belongs to and cannot exist before it. Nothing
  // about a shop's own settings changes: the call gate still refuses on
  // `voice.enabled`, quiet hours, consent and the caps, and a refusal that says
  // so falls back to the advisor task the rung raised in phase 3.
  runtime.ladder.attachVoice(runner);

  return runner;
}

/**
 * The voice section a call is governed by.
 *
 * `VoiceCallState` carries it because the tools run inside a call and a tool
 * has no transaction of its own to load a document with. The runner sets it
 * before the first turn; the fallback is the schema's own shipped defaults,
 * which are the conservative end of every setting.
 */
function voiceConfigFor(callState: VoiceCallState): ShopConfig['voice'] {
  return callState.voiceConfig;
}
