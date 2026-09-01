/** DI tokens for infrastructure that is constructed, not decorated. */
export const DATABASE = Symbol('serviceloop.database');
export const REDIS = Symbol('serviceloop.redis');
export const STORAGE = Symbol('serviceloop.storage');
export const NOTIFIER = Symbol('serviceloop.notifier');
export const AUDIT_SERVICE = Symbol('serviceloop.audit');
export const OUTBOX_SERVICE = Symbol('serviceloop.outbox');
export const UNIT_OF_WORK = Symbol('serviceloop.uow');
export const JOB_CARD_REPOSITORY = Symbol('serviceloop.jobCardRepository');
export const STAFF_REPOSITORY = Symbol('serviceloop.staffRepository');
export const JOB_CARD_TRANSITION_SERVICE = Symbol('serviceloop.jobCardTransitions');
export const WORK_ITEM_TRANSITION_SERVICE = Symbol('serviceloop.workItemTransitions');
export const GUARDRAIL_SERVICE = Symbol('serviceloop.guardrails');

/* --- Phase 2: channels & intake ----------------------------------------- */
export const WHATSAPP_PORT = Symbol('serviceloop.whatsapp');
export const CHANNEL_PORTS = Symbol('serviceloop.channelPorts');
export const OUTBOUND_GATE = Symbol('serviceloop.outboundGate');
export const INBOUND_HANDLER = Symbol('serviceloop.inboundHandler');
export const INTAKE_SERVICE = Symbol('serviceloop.intake');
export const INTAKE_PIPELINE = Symbol('serviceloop.intakePipeline');
export const MEDIA_SERVICE = Symbol('serviceloop.media');
export const MEDIA_PIPELINE = Symbol('serviceloop.mediaPipeline');
export const CONSENT_CAPTURE = Symbol('serviceloop.consentCapture');
export const CONSENT_SERVICE = Symbol('serviceloop.consents');
export const CONVERSATION_REPOSITORY = Symbol('serviceloop.conversationRepository');
export const INTAKE_REPOSITORY = Symbol('serviceloop.intakeRepository');
export const SHOP_RESOLVER = Symbol('serviceloop.shopResolver');
export const SESSION_SERVICE = Symbol('serviceloop.sessions');

/* Phase 3 — the agent runtime, assembled once and shared by every controller. */
export const AGENT_RUNTIME = Symbol('serviceloop.agentRuntime');

/* --- Phase 4: status sentinel, delivery & payments ----------------------- */
/**
 * The phase-4 services, assembled once by `createLoopRuntime` and shared by
 * every controller — the same reasoning as `AGENT_RUNTIME`.
 */
export const LOOP_RUNTIME = Symbol('serviceloop.loopRuntime');

/* --- Phase 5: voice ------------------------------------------------------ */
/**
 * One telephony port in the process, chosen by `selectAdapters`.
 *
 * The console's softphone drives it directly, which is only sound because the
 * loopback adapter *is* an adapter: a controller holding this token cannot tell
 * whether the far end is a browser tab or a telephone.
 */
export const VOICE_TELEPHONY = Symbol('serviceloop.voiceTelephony');
/** The gate every origination passes, and the rows it writes either way. */
export const VOICE_CALLS = Symbol('serviceloop.voiceCalls');
/** `VoiceAgentRunner`: the phase-3 agent, on a telephone. */
export const VOICE_RUNTIME = Symbol('serviceloop.voiceRuntime');

/* --- Phase 6: retention, digest & analytics ------------------------------ */
/**
 * Every phase-6 service, assembled once by `createRetentionRuntime`.
 *
 * Lives in `MessagingModule` rather than in its own module for one structural
 * reason: `InboundHandler` needs it, because the ledger's one-tap answers, the
 * feedback faces and the MARKETING ask all arrive as inbound taps. Building it
 * beside the handler is what keeps the module graph acyclic; the controllers
 * that read it live in `RetentionModule`, which imports this one.
 */
export const RETENTION_RUNTIME = Symbol('serviceloop.retentionRuntime');
