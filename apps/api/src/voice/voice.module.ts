import { forwardRef, Module } from '@nestjs/common';
import {
  createVoiceRuntime,
  voiceSettingsFrom,
  type AgentRuntime,
  type VoiceAgentRunner,
} from '@serviceloop/agent-core';
import {
  createTelephonyPort,
  createStreamingSpeechPort,
  type StoragePort,
  type ChannelPorts,
  type StreamingSpeechPort,
  type TelephonyPort,
} from '@serviceloop/adapters';
import { defaultShopConfig, getEnv } from '@serviceloop/config';
import {
  PgAgentRunStore,
  PgCallRecordingWriter,
  PgConsentStore,
  PgConversationStore,
  PgGeneratedMediaWriter,
  PgJobCardContextReader,
  PgShopConfigStore,
  PgShopDirectory,
  createVoiceStores,
  type AuditService,
  type OutboxService,
  type PgUnitOfWork,
  type Tx,
} from '@serviceloop/db';
import { VoiceCallService, type OutboundGate } from '@serviceloop/domain';
import {
  AGENT_RUNTIME,
  AUDIT_SERVICE,
  CHANNEL_PORTS,
  OUTBOUND_GATE,
  OUTBOX_SERVICE,
  STORAGE,
  UNIT_OF_WORK,
  VOICE_CALLS,
  VOICE_RUNTIME,
  VOICE_TELEPHONY,
} from '../infra/tokens';
import { MessagingModule } from '../messaging/messaging.module';
import { SoftphoneController } from './softphone.controller';
import { CallsController } from './calls.controller';

/**
 * The voice layer (phase 5).
 *
 * One `TelephonyPort` in the process, chosen by `selectAdapters` — the browser
 * loopback in a sandboxed deployment, Exotel or Twilio when credentials are
 * configured — and the controllers above it cannot tell which they have. That
 * is the whole point of building the softphone as an adapter rather than as a
 * demo mode: a flow developed against the console's `/softphone` page is a flow
 * that has already been developed against a telephone.
 *
 * `VOICE_RUNTIME` is created here rather than in `LoopModule` because building
 * it has a side effect worth naming: it attaches the telephone to the phase-3
 * escalation ladder, so `VOICE_OR_ADVISOR` rungs start ringing customers
 * instead of raising advisor tasks. Nothing about a shop's own settings
 * changes — the call gate still refuses on `voice.enabled`, quiet hours,
 * consent and the caps — but the capability is switched on by this module
 * existing, which is a fact that should be visible in one file.
 */
@Module({
  imports: [forwardRef(() => MessagingModule)],
  controllers: [SoftphoneController, CallsController],
  providers: [
    {
      provide: VOICE_TELEPHONY,
      useFactory: (): TelephonyPort => createTelephonyPort(getEnv()),
    },
    {
      provide: VOICE_CALLS,
      useFactory: (
        uow: PgUnitOfWork,
        audit: AuditService,
        outbox: OutboxService,
        storage: StoragePort,
      ): VoiceCallService<Tx> => {
        const env = getEnv();
        const stores = createVoiceStores();

        return new VoiceCallService<Tx>({
          uow,
          calls: stores.calls,
          turns: stores.turns,
          consentEvents: stores.consentEvents,
          usage: stores.usage,
          consents: new PgConsentStore(),
          config: new PgShopConfigStore(),
          audit,
          outbox,
          recordings: new PgCallRecordingWriter(
            new PgGeneratedMediaWriter(storage, (work) => uow.transaction(work)),
          ),
          rates: {
            telcoPaisePerMinute: env.VOICE_TELCO_PAISE_PER_MINUTE,
            sttPaisePerMinute: env.VOICE_STT_PAISE_PER_MINUTE,
            ttsPaisePerMinute: env.VOICE_TTS_PAISE_PER_MINUTE,
            // ₹1 ≈ 1.2 US cents of model spend, at the rupee's long-run rate.
            // A number rather than a setting because the cap it feeds is a
            // *daily* budget in paise, and a shop that wanted a different
            // exchange rate would change the budget, not the arithmetic.
            usdMicrosToPaise: 9_000,
          },
          platformCapPaise: env.VOICE_PLATFORM_DAILY_CAP_PAISE,
          alertRatio: env.VOICE_COST_ALERT_RATIO,
          // Read per call, not captured at boot: the whole value of a kill
          // switch is that it takes effect without a deploy.
          platformKillSwitch: () => getEnv().VOICE_KILL_SWITCH,
          retentionDays: env.VOICE_RECORDING_RETENTION_DAYS,
        });
      },
      inject: [UNIT_OF_WORK, AUDIT_SERVICE, OUTBOX_SERVICE, STORAGE],
    },
    {
      provide: VOICE_RUNTIME,
      useFactory: (
        telephony: TelephonyPort,
        calls: VoiceCallService<Tx>,
        uow: PgUnitOfWork,
        audit: AuditService,
        outbox: OutboxService,
        gate: OutboundGate<Tx>,
        ports: ChannelPorts,
        agent: AgentRuntime<Tx>,
      ): VoiceAgentRunner<Tx> => {
        const env = getEnv();
        const speech: StreamingSpeechPort = createStreamingSpeechPort(env);
        const stores = createVoiceStores();

        return createVoiceRuntime<Tx>({
          runtime: agent,
          telephony,
          speech,
          calls,
          destinations: stores.destinations,
          gate,
          llm: ports.llm,
          stores: {
            uow,
            // The same table a chat run writes to. A call's transcript is
            // replayable through exactly the same `agent_steps` machinery, which
            // is what makes the audit story on a phone as strong as in a thread.
            runs: new PgAgentRunStore(),
            cards: new PgJobCardContextReader(),
            conversations: new PgConversationStore(),
            directory: new PgShopDirectory(),
            config: new PgShopConfigStore(),
            audit,
            outbox,
          },
          settings: voiceSettingsFrom(defaultShopConfig(env.DEFAULT_TIMEZONE), {
            endpointSilenceMs: env.VOICE_ENDPOINT_SILENCE_MS,
            frameMs: env.VOICE_FRAME_MS,
            latencyBudgetMs: env.VOICE_LATENCY_BUDGET_MS,
          }),
        });
      },
      inject: [
        VOICE_TELEPHONY,
        VOICE_CALLS,
        UNIT_OF_WORK,
        AUDIT_SERVICE,
        OUTBOX_SERVICE,
        OUTBOUND_GATE,
        CHANNEL_PORTS,
        AGENT_RUNTIME,
      ],
    },
  ],
  exports: [VOICE_RUNTIME, VOICE_CALLS, VOICE_TELEPHONY],
})
export class VoiceModule {}
