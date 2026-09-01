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
  'sms',
  'antivirus',
  'telephony',
  'speech',
  'speech-stream',
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

  /**
   * Telephony (phase 5.1).
   *
   * DEMO_MODE forces the browser loopback for the same reason it forces the
   * WhatsApp sandbox: a developer with an Exotel token in their shell must not
   * be able to ring a real customer by clicking a button in the console. The
   * loopback is a complete adapter — the same PCM frame interface, the same
   * typed call events, the same recording lifecycle — so a flow that works
   * against it is a flow that works against Exotel.
   */
  const telephony: AdapterSelection =
    demo || env.TELEPHONY_DRIVER === 'loopback'
      ? {
          port: 'telephony',
          adapter: 'BrowserLoopbackTelephonyAdapter',
          sandbox: true,
          reason: demo
            ? 'DEMO_MODE forces the browser softphone; no telco account is involved'
            : `TELEPHONY_DRIVER=${env.TELEPHONY_DRIVER}`,
          implemented: true,
        }
      : env.TELEPHONY_DRIVER === 'exotel'
        ? {
            port: 'telephony',
            adapter: `ExotelTelephonyAdapter(${env.EXOTEL_SUBDOMAIN})`,
            sandbox: false,
            reason: 'TELEPHONY_DRIVER=exotel with account sid, key and flow app id present',
            implemented: true,
          }
        : {
            port: 'telephony',
            adapter: 'TwilioTelephonyAdapter',
            sandbox: false,
            reason: 'TELEPHONY_DRIVER=twilio with account sid and auth token present',
            implemented: true,
          };

  /**
   * The streaming half of the speech port (phase 5.2).
   *
   * It gets its own line rather than sharing the batch one, because the two can
   * legitimately differ: a shop can transcribe voice notes with Google in batch
   * and stream live calls through Sarvam, and an operator debugging a call that
   * went deaf needs to know which of the two was answering.
   */
  const speechStream: AdapterSelection =
    demo || env.SPEECH_STREAM_DRIVER === 'mock'
      ? {
          port: 'speech-stream',
          adapter: 'MockStreamingSpeechAdapter',
          sandbox: true,
          reason: demo
            ? 'DEMO_MODE forces the scripted streaming recogniser and synthesiser'
            : `SPEECH_STREAM_DRIVER=${env.SPEECH_STREAM_DRIVER}`,
          implemented: true,
        }
      : env.SPEECH_STREAM_DRIVER === 'sarvam'
        ? {
            port: 'speech-stream',
            adapter: `SarvamStreamingAdapter(${env.SARVAM_STREAM_STT_MODEL} / ${env.SARVAM_TTS_MODEL})`,
            sandbox: false,
            reason: 'SPEECH_STREAM_DRIVER=sarvam with SARVAM_API_KEY present',
            implemented: true,
          }
        : {
            port: 'speech-stream',
            adapter: `GoogleStreamingSpeechAdapter(${env.GOOGLE_SPEECH_MODEL})`,
            sandbox: false,
            reason: 'SPEECH_STREAM_DRIVER=google with a streaming recognizer configured',
            implemented: true,
          };

  /**
   * The SMS rung (phase 7.3).
   *
   * It gets a line of its own even though most shops will never see it fire,
   * because the question it answers - "what happened when WhatsApp was down?" -
   * is asked exactly once, in an incident, by somebody who needs the answer in
   * the first thirty seconds. `DEMO_MODE` forces the sandbox for the reason it
   * forces every other transport: a developer with a provider key in their
   * shell must not be able to bill a real message to a real handset.
   */
  const sms: AdapterSelection =
    demo || env.SMS_DRIVER === 'sandbox'
      ? {
          port: 'sms',
          adapter: 'SandboxSmsAdapter',
          sandbox: true,
          reason: demo
            ? 'DEMO_MODE forces the sandbox SMS adapter'
            : `SMS_DRIVER=${env.SMS_DRIVER}`,
          implemented: true,
        }
      : {
          port: 'sms',
          adapter: `DltSmsAdapter(${env.SMS_SENDER_ID ?? 'no-header'})`,
          sandbox: false,
          reason: `SMS_DRIVER=dlt with entity ${env.SMS_DLT_ENTITY_ID ?? 'unset'} registered`,
          implemented: true,
        };

  /**
   * Upload scanning (phase 7.1). `none` is a real adapter that accepts
   * everything and says so in the boot log, which is materially different from
   * a port that is not wired at all: an operator reading this line learns that
   * nothing is scanning, rather than learning nothing.
   */
  const antivirus: AdapterSelection =
    env.ANTIVIRUS_DRIVER === 'clamav'
      ? {
          port: 'antivirus',
          adapter: `ClamAvScanner(${env.CLAMAV_HOST}:${env.CLAMAV_PORT})`,
          sandbox: false,
          reason: `ANTIVIRUS_DRIVER=clamav, ${env.ANTIVIRUS_FAIL_CLOSED ? 'fail-closed' : 'fail-open'} when the daemon is unreachable`,
          implemented: true,
        }
      : {
          port: 'antivirus',
          adapter: 'PermissiveScanner',
          sandbox: true,
          reason: 'ANTIVIRUS_DRIVER=none — uploads are accepted without being scanned',
          implemented: true,
        };

  return [
    storage,
    notifier,
    llm,
    ocr,
    whatsapp,
    sms,
    antivirus,
    speech,
    speechStream,
    telephony,
    payments,
  ];
}

/**
 * The production adapter allow-list (phase 7.7).
 *
 * `NODE_ENV=production` already refuses the sandbox for the ports where a
 * sandbox would be catastrophic. This is the other direction: production says
 * out loud which adapter each port *is*, and a boot that disagrees stops.
 *
 * The two checks catch different mistakes. The refusals in `env.ts` catch "we
 * forgot to configure the real thing"; this catches "a deploy script selected
 * the wrong real thing", which is the failure that survives review because
 * every value in it is plausible.
 *
 * Entries are `port:AdapterName`, matched on the adapter's *name* rather than
 * its full label, so `llm:AnthropicLlmAdapter` keeps matching when the model in
 * the parenthesised suffix changes.
 */
export function checkAdapterAllowList(env: Env): readonly string[] {
  if (env.DEPLOY_ENV !== 'prod') return [];
  if (env.ADAPTER_ALLOWLIST.length === 0) {
    return ['ADAPTER_ALLOWLIST is empty; production requires every live adapter to be named'];
  }

  const allowed = new Map<string, Set<string>>();
  const violations: string[] = [];
  for (const entry of env.ADAPTER_ALLOWLIST) {
    const [port, adapter] = entry.split(':', 2);
    if (port === undefined || adapter === undefined || adapter === '') {
      violations.push(`ADAPTER_ALLOWLIST entry "${entry}" is not of the form port:AdapterName`);
      continue;
    }
    if (!(PORTS as readonly string[]).includes(port)) {
      violations.push(`ADAPTER_ALLOWLIST names unknown port "${port}"`);
      continue;
    }
    const set = allowed.get(port) ?? new Set<string>();
    set.add(adapter);
    allowed.set(port, set);
  }

  for (const selection of selectAdapters(env)) {
    const permitted = allowed.get(selection.port);
    const name = adapterName(selection.adapter);
    if (permitted === undefined) {
      violations.push(
        `port "${selection.port}" resolved to ${name} but ADAPTER_ALLOWLIST says nothing about it`,
      );
      continue;
    }
    if (!permitted.has(name)) {
      violations.push(
        `port "${selection.port}" resolved to ${name}, which is not in the allow-list [${[...permitted].join(', ')}]`,
      );
    }
  }

  return violations;
}

/** `FailoverSpeech(Sarvam:x → Google:y)` → `FailoverSpeech`. */
function adapterName(label: string): string {
  const open = label.indexOf('(');
  return open === -1 ? label : label.slice(0, open);
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
  const lines = selectAdapters(env).map((selection) => {
    const mode = selection.implemented ? (selection.sandbox ? 'SANDBOX' : 'LIVE') : 'PENDING';
    return `adapter[${selection.port}] ${mode} → ${selection.adapter} (${selection.reason})`;
  });

  // The allow-list result is part of the boot banner rather than a separate
  // debug call, because "which adapters is prod running" and "were they the
  // ones we said" are the same question asked by the same person at the same
  // moment.
  if (env.DEPLOY_ENV === 'prod') {
    const violations = checkAdapterAllowList(env);
    lines.push(
      violations.length === 0
        ? `adapter-allowlist OK (${env.ADAPTER_ALLOWLIST.join(', ')})`
        : `adapter-allowlist VIOLATED: ${violations.join(' | ')}`,
    );
  }

  return lines;
}
