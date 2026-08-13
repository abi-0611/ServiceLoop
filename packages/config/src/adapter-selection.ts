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

  const laterPhases: Array<[PortName, string, string]> = [
    ['llm', 'AnthropicLlm', 'phase 2 — vision intake'],
    ['whatsapp', 'MetaCloudWhatsApp', 'phase 2 — channels'],
    ['telephony', 'ExotelTelephony', 'phase 5 — voice'],
    ['speech', 'SarvamSpeech', 'phase 5 — voice'],
    ['payments', 'RazorpayPayments', 'phase 4 — payments'],
  ];

  return [
    storage,
    notifier,
    ...laterPhases.map(([port, adapter, reason]) => ({
      port,
      adapter,
      sandbox: demo,
      reason: `not wired yet (${reason})`,
      implemented: false,
    })),
  ];
}

export function formatAdapterSelection(env: Env): string[] {
  return selectAdapters(env).map((selection) => {
    const mode = selection.implemented ? (selection.sandbox ? 'SANDBOX' : 'LIVE') : 'PENDING';
    return `adapter[${selection.port}] ${mode} → ${selection.adapter} (${selection.reason})`;
  });
}
