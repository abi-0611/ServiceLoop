import type { Env } from './env';

/**
 * Ports & adapters doctrine (master §5): at boot every app prints exactly which
 * adapter is live for every port, and why. DEMO_MODE forces the sandbox
 * adapter; otherwise a real adapter activates on the presence of credentials.
 */

export const PORTS = [
  'storage',
  'notifier',
  'llm',
  'ocr',
  'whatsapp',
  'telephony',
  'speech',
  'payments',
] as const;
export type PortName = (typeof PORTS)[number];

export interface AdapterSelection {
  readonly port: PortName;
  readonly adapter: string;
  readonly sandbox: boolean;
  readonly reason: string;
  /** False when the port has no implementation in this phase yet. */
  readonly implemented: boolean;
}

export function selectAdapters(env: Env): readonly AdapterSelection[] {
  const demo = env.DEMO_MODE;

  const storage: AdapterSelection = demo
    ? env.STORAGE_DRIVER === 'memory'
      ? {
          port: 'storage',
          adapter: 'InMemoryStorage',
          sandbox: true,
          reason: 'DEMO_MODE with STORAGE_DRIVER=memory',
          implemented: true,
        }
      : {
          port: 'storage',
          adapter: 'S3Storage(MinIO)',
          sandbox: true,
          reason: `DEMO_MODE with STORAGE_DRIVER=${env.STORAGE_DRIVER} → S3-compatible dev endpoint`,
          implemented: true,
        }
    : env.STORAGE_DRIVER === 'gcs'
      ? {
          port: 'storage',
          adapter: 'GcsStorage',
          sandbox: false,
          reason: 'STORAGE_DRIVER=gcs',
          implemented: false,
        }
      : {
          port: 'storage',
          adapter: 'S3Storage',
          sandbox: false,
          reason: `STORAGE_DRIVER=${env.STORAGE_DRIVER}`,
          implemented: true,
        };

  const notifier: AdapterSelection =
    demo || env.NOTIFIER_DRIVER !== 'sms'
      ? {
          port: 'notifier',
          adapter: env.NOTIFIER_DRIVER === 'memory' ? 'InMemoryNotifier' : 'LoggingNotifier',
          sandbox: true,
          reason: demo
            ? 'DEMO_MODE forces the sandbox notifier'
            : `NOTIFIER_DRIVER=${env.NOTIFIER_DRIVER}`,
          implemented: true,
        }
      : {
          port: 'notifier',
          adapter: 'SmsNotifier',
          sandbox: false,
          reason: 'NOTIFIER_DRIVER=sms with SMS_PROVIDER_API_KEY present',
          implemented: false,
        };

  /**
   * DEMO_MODE forces the sandbox regardless of credentials (master §5), so a
   * developer with a live token in their shell cannot message a real customer
   * by accident.
   */
  const whatsapp: AdapterSelection =
    demo || env.WHATSAPP_DRIVER === 'sandbox'
      ? {
          port: 'whatsapp',
          adapter: 'SandboxWhatsAppAdapter',
          sandbox: true,
          reason: demo
            ? 'DEMO_MODE forces the sandbox WhatsApp adapter'
            : `WHATSAPP_DRIVER=${env.WHATSAPP_DRIVER}`,
          implemented: true,
        }
      : {
          port: 'whatsapp',
          adapter: 'MetaCloudWhatsAppAdapter',
          sandbox: false,
          reason: `WHATSAPP_DRIVER=meta on Graph ${env.WHATSAPP_GRAPH_VERSION} with credentials present`,
          implemented: true,
        };

  const llm: AdapterSelection =
    demo || env.LLM_DRIVER === 'sandbox' || env.ANTHROPIC_API_KEY === undefined
      ? {
          port: 'llm',
          adapter: 'SandboxLlmAdapter',
          sandbox: true,
          reason: demo
            ? 'DEMO_MODE forces the sandbox LLM adapter'
            : env.ANTHROPIC_API_KEY === undefined
              ? 'no ANTHROPIC_API_KEY present'
              : `LLM_DRIVER=${env.LLM_DRIVER}`,
          implemented: true,
        }
      : {
          port: 'llm',
          adapter: `AnthropicLlmAdapter(${env.LLM_AGENT_MODEL})`,
          sandbox: false,
          reason: 'LLM_DRIVER=anthropic with ANTHROPIC_API_KEY present',
          implemented: true,
        };

  /**
   * OCR has no provider of its own — a vision-capable model reads the card
   * through `LlmPort` (master §2). It still gets its own line in the boot log,
   * because "which thing read my customer's job card" is exactly the question
   * an operator needs answered, and the sandbox answer (a fixture set that
   * refuses unknown images) is materially different from the live one.
   */
  const ocr: AdapterSelection = llm.sandbox
    ? {
        port: 'ocr',
        adapter: 'FixtureOcrAdapter',
        sandbox: true,
        reason: 'the LLM port is sandboxed, so job cards resolve against registered fixtures',
        implemented: true,
      }
    : {
        port: 'ocr',
        adapter: `VisionLlmOcrAdapter(${env.LLM_EXTRACT_MODEL})`,
        sandbox: false,
        reason: `vision extraction over the live LLM adapter`,
        implemented: true,
      };

  /**
   * The port and its mock land in phase 2.7 so the voice-note intake path is
   * real end to end; phase 4.1 adds the batch Sarvam and Google adapters behind
   * a failover policy. The *streaming* half is still phase 5's job — and the
   * boot log says which of the two is answering, because "which thing heard my
   * technician" is the operator's question the moment a status goes wrong.
   */
  const speech: AdapterSelection =
    demo || env.SPEECH_DRIVER === 'mock'
      ? {
          port: 'speech',
          adapter: 'MockSpeechAdapter',
          sandbox: true,
          reason: demo
            ? 'DEMO_MODE forces the mock speech adapter'
            : `SPEECH_DRIVER=${env.SPEECH_DRIVER}`,
          implemented: true,
        }
      : env.SPEECH_DRIVER === 'sarvam'
        ? {
            port: 'speech',
            adapter: canFallBackToGoogle(env)
              ? `FailoverSpeech(Sarvam:${env.SARVAM_STT_MODEL} → Google:${env.GOOGLE_SPEECH_MODEL})`
              : `SarvamSpeechAdapter(${env.SARVAM_STT_MODEL})`,
            sandbox: false,
            reason: canFallBackToGoogle(env)
              ? `SPEECH_DRIVER=sarvam with a Google fallback configured (${env.SPEECH_FAILOVER_THRESHOLD} consecutive failures switch over)`
              : 'SPEECH_DRIVER=sarvam with no Google fallback configured',
            implemented: true,
          }
        : {
            port: 'speech',
            adapter: `GoogleSpeechAdapter(${env.GOOGLE_SPEECH_MODEL})`,
            sandbox: false,
            reason: 'SPEECH_DRIVER=google',
            implemented: true,
          };

  /**
   * Payments (phase 4.9). DEMO_MODE forces the mock for the same reason
   * WhatsApp is forced: a developer must not be able to put a live payment link
   * in front of a customer by having a key in their shell.
   */
  const payments: AdapterSelection =
    demo || env.PAYMENTS_DRIVER === 'mock'
      ? {
          port: 'payments',
          adapter: 'MockPaymentsAdapter',
          sandbox: true,
          reason: demo
            ? 'DEMO_MODE forces the mock payments adapter'
            : `PAYMENTS_DRIVER=${env.PAYMENTS_DRIVER}`,
          implemented: true,
        }
      : {
          port: 'payments',
          adapter: 'RazorpayPaymentsAdapter',
          sandbox: false,
          reason: 'PAYMENTS_DRIVER=razorpay with key, secret and webhook secret present',
          implemented: true,
        };

  const laterPhases: Array<[PortName, string, string]> = [
    ['telephony', 'ExotelTelephony', 'phase 5 — voice'],
  ];

  return [
    storage,
    notifier,
    llm,
    ocr,
    whatsapp,
    speech,
    payments,
    ...laterPhases.map(([port, adapter, reason]) => ({
      port,
      adapter,
      sandbox: demo,
      reason: `not wired yet (${reason})`,
      implemented: false,
    })),
  ];
}

/**
 * Is a Google fallback actually usable?
 *
 * Both the recogniser resource *and* a token: one without the other is a
 * fallback that would fail on its first call, and reporting it as configured in
 * the boot log would be the log telling an operator something untrue at exactly
 * the moment they most need it to be accurate.
 */
function canFallBackToGoogle(env: Env): boolean {
  return env.GOOGLE_SPEECH_RECOGNIZER !== undefined && env.GOOGLE_SPEECH_ACCESS_TOKEN !== undefined;
}

export function formatAdapterSelection(env: Env): string[] {
  return selectAdapters(env).map((selection) => {
    const mode = selection.implemented ? (selection.sandbox ? 'SANDBOX' : 'LIVE') : 'PENDING';
    return `adapter[${selection.port}] ${mode} → ${selection.adapter} (${selection.reason})`;
  });
}
