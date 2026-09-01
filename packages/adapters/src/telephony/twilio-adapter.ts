import { randomUUID } from 'node:crypto';
import type { AudioFormat } from './audio';
import {
  TelephonyError,
  type CallSession,
  type InboundCallListener,
  type OriginateInput,
  type TelephonyPort,
} from './port';
import {
  ProviderCallSession,
  asDtmfDigit,
  type DecodedFrame,
  type MediaSocket,
  type ProviderCodec,
} from './streaming-session';

/**
 * `TwilioTelephonyAdapter` — the documented alternative (phase 5.1).
 *
 * Kept behind the identical contract so a shop outside India, or one whose
 * Exotel account is in trouble, is a configuration change rather than a
 * project. The differences from Exotel are exactly three, and all of them live
 * in the codec:
 *
 *   - Media Streams carry **8 kHz μ-law**, not linear PCM. `audio.ts` converts
 *     at the edge and nothing above the port notices.
 *   - Field names are camel-ish (`streamSid`, `mediaFormat`) rather than
 *     snake_case.
 *   - The control API takes TwiML rather than an App Bazaar flow id.
 *
 * The `clear` and `mark` messages, and therefore barge-in, are the same idea in
 * both — which is why the session state machine is shared rather than written
 * twice.
 */

/** Twilio Media Streams: 8 kHz μ-law, 160 bytes per 20 ms frame. */
export const TWILIO_LEG_FORMAT: AudioFormat = {
  sampleRate: 8_000,
  channels: 1,
  encoding: 'mulaw',
};

const TWILIO_CHUNK_BYTES = 160;

export interface TwilioConfig {
  readonly accountSid: string;
  readonly authToken: string;
  readonly callerId: string;
  readonly webhookBaseUrl: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly frameMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export class TwilioCodec implements ProviderCodec {
  readonly driver = 'twilio' as const;
  readonly legFormat = TWILIO_LEG_FORMAT;
  readonly chunkBytes = TWILIO_CHUNK_BYTES;

  decode(raw: string): DecodedFrame {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Twilio frame was not an object');
    }

    const frame = parsed as Record<string, unknown>;
    const event = typeof frame['event'] === 'string' ? frame['event'] : '';

    switch (event) {
      case 'connected':
        return { kind: 'connected' };

      case 'start': {
        const start = asRecord(frame['start']);
        const format = asRecord(start['mediaFormat']);
        const sampleRate = Number(format['sampleRate'] ?? TWILIO_LEG_FORMAT.sampleRate);

        return {
          kind: 'start',
          streamId: String(frame['streamSid'] ?? start['streamSid'] ?? ''),
          callSid: String(start['callSid'] ?? ''),
          format: {
            sampleRate: Number.isFinite(sampleRate) ? sampleRate : TWILIO_LEG_FORMAT.sampleRate,
            channels: 1,
            encoding: format['encoding'] === 'audio/x-mulaw' ? 'mulaw' : 'mulaw',
          },
          from: asStringOrNull(asRecord(start['customParameters'])['from']),
          to: asStringOrNull(asRecord(start['customParameters'])['to']),
          custom: asStringRecord(start['customParameters']),
        };
      }

      case 'media': {
        const media = asRecord(frame['media']);
        return { kind: 'media', payload: Buffer.from(String(media['payload'] ?? ''), 'base64') };
      }

      case 'dtmf': {
        const dtmf = asRecord(frame['dtmf']);
        const digit = asDtmfDigit(String(dtmf['digit'] ?? ''));
        return digit === null ? { kind: 'ignored', event: 'dtmf' } : { kind: 'dtmf', digit };
      }

      case 'mark':
        return { kind: 'mark', name: String(asRecord(frame['mark'])['name'] ?? '') };

      case 'stop':
        return { kind: 'stop', reason: 'stream stopped' };

      default:
        return { kind: 'ignored', event };
    }
  }

  encodeMedia(streamId: string, payload: Buffer): string {
    return JSON.stringify({
      event: 'media',
      streamSid: streamId,
      media: { payload: payload.toString('base64') },
    });
  }

  encodeClear(streamId: string): string {
    return JSON.stringify({ event: 'clear', streamSid: streamId });
  }

  encodeMark(streamId: string, name: string): string {
    return JSON.stringify({ event: 'mark', streamSid: streamId, mark: { name } });
  }
}

export class TwilioTelephonyAdapter implements TelephonyPort {
  readonly driver = 'twilio' as const;
  readonly callerId: string;

  private readonly codec = new TwilioCodec();
  private readonly sessions = new Map<string, ProviderCallSession>();
  private readonly bySid = new Map<string, string>();
  private readonly listeners = new Set<InboundCallListener>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly config: TwilioConfig) {
    this.callerId = config.callerId;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => new Date());
    this.newId = config.newId ?? randomUUID;
  }

  async originate(input: OriginateInput): Promise<CallSession> {
    const callId = this.newId();
    const streamUrl = `${this.config.webhookBaseUrl.replace(/^http/u, 'ws')}/voice/twilio/stream`;

    const body = new URLSearchParams({
      From: input.from ?? this.callerId,
      To: input.to,
      // Inline TwiML rather than a hosted url: the instruction is one bidirectional
      // <Connect><Stream>, and hosting a static document to say so would be one
      // more thing that can 404 at the moment a customer picks up.
      Twiml: `<Response><Connect><Stream url="${streamUrl}"><Parameter name="callId" value="${callId}"/></Stream></Connect></Response>`,
      StatusCallback: `${this.config.webhookBaseUrl}/voice/twilio/status`,
      StatusCallbackEvent: 'initiated ringing answered completed',
      Timeout: String(input.ringTimeoutSeconds ?? 45),
    });

    const response = await this.request(
      `/2010-04-01/Accounts/${this.config.accountSid}/Calls.json`,
      body,
    );

    const providerCallSid = extractSid(response);
    const session = this.track(callId, providerCallSid, 'OUTBOUND', input);
    session.markRinging();
    return session;
  }

  async acceptInbound(input: {
    readonly providerCallSid: string;
    readonly from: string;
    readonly to: string;
    readonly context: OriginateInput['context'];
  }): Promise<CallSession> {
    const callId = this.newId();
    const session = this.track(callId, input.providerCallSid, 'INBOUND', {
      to: input.to,
      from: input.from,
      context: input.context,
    });

    for (const listener of [...this.listeners]) await listener(session);
    return session;
  }

  attachMediaSocket(providerCallSid: string, socket: MediaSocket): void {
    const callId = this.bySid.get(providerCallSid);
    const session = callId === undefined ? undefined : this.sessions.get(callId);
    if (session === undefined) {
      socket.close('unknown call');
      throw new TelephonyError('CALL_NOT_FOUND', `No Twilio call ${providerCallSid}`, {
        providerCallSid,
      });
    }
    session.attachMediaSocket(socket);
  }

  applyStatus(providerCallSid: string, status: string): void {
    const callId = this.bySid.get(providerCallSid);
    const session = callId === undefined ? undefined : this.sessions.get(callId);
    if (session === undefined) return;

    switch (status.toLowerCase()) {
      case 'ringing':
        session.markRinging();
        return;
      case 'in-progress':
      case 'answered':
        session.markAnswered();
        return;
      case 'no-answer':
        session.markFailed('NO_ANSWER', 'The customer did not answer');
        return;
      case 'busy':
        session.markFailed('BUSY', 'The line was busy');
        return;
      case 'failed':
      case 'canceled':
        session.markFailed('PROVIDER_UNAVAILABLE', `Twilio reported the call ${status}`);
        return;
      default:
        return;
    }
  }

  onInboundCall(listener: InboundCallListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  activeSessions(): readonly CallSession[] {
    return [...this.sessions.values()];
  }

  session(callId: string): CallSession | null {
    return this.sessions.get(callId) ?? null;
  }

  async shutdown(reason: string): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      await session.hangup(reason).catch(() => undefined);
    }
  }

  private track(
    callId: string,
    providerCallSid: string,
    direction: 'OUTBOUND' | 'INBOUND',
    input: { readonly to: string; readonly from?: string; readonly context: OriginateInput['context'] },
  ): ProviderCallSession {
    const session = new ProviderCallSession({
      callId,
      providerCallSid,
      direction,
      to: input.to,
      from: input.from ?? this.callerId,
      context: input.context,
      codec: this.codec,
      frameMs: this.config.frameMs ?? 20,
      now: this.now,
      dialAdvisorLeg: (bridge) => this.dialAdvisorLeg(bridge),
      onEnded: (ended) => {
        this.sessions.delete(ended);
        this.bySid.delete(providerCallSid);
      },
    });

    this.sessions.set(callId, session);
    this.bySid.set(providerCallSid, callId);
    return session;
  }

  /**
   * The advisor leg.
   *
   * `<Say>` would be simpler and would read the whisper in a synthesiser the
   * shop has not chosen; `<Play>` points at the summary we already synthesised
   * in the customer's own voice pipeline, so the advisor hears the same voice
   * every other summary is spoken in.
   */
  private async dialAdvisorLeg(input: {
    readonly callId: string;
    readonly number: string;
  }): Promise<void> {
    const whisperUrl = `${this.config.webhookBaseUrl}/voice/whisper/${input.callId}.wav`;
    const body = new URLSearchParams({
      From: this.callerId,
      To: input.number,
      Twiml: `<Response><Play>${whisperUrl}</Play><Dial><Conference>call-${input.callId}</Conference></Dial></Response>`,
      StatusCallback: `${this.config.webhookBaseUrl}/voice/twilio/status`,
    });

    await this.request(`/2010-04-01/Accounts/${this.config.accountSid}/Calls.json`, body);
  }

  private async request(path: string, body: URLSearchParams): Promise<unknown> {
    const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString(
      'base64',
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);

    try {
      const response = await this.fetchImpl(
        `${this.config.baseUrl ?? 'https://api.twilio.com'}${path}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
          signal: controller.signal,
        },
      );

      const text = await response.text();
      if (!response.ok) {
        throw new TelephonyError(kindForStatus(response.status), 'Twilio refused the call', {
          status: response.status,
          body: text.slice(0, 400),
        });
      }

      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof TelephonyError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TelephonyError('PROVIDER_UNAVAILABLE', 'Twilio timed out', { path });
      }
      throw new TelephonyError('UNKNOWN', error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
    }
  }
}

function kindForStatus(status: number): 'AUTH_FAILED' | 'RATE_LIMITED' | 'PROVIDER_UNAVAILABLE' {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  return 'PROVIDER_UNAVAILABLE';
}

function extractSid(response: unknown): string {
  if (typeof response !== 'object' || response === null) {
    throw new TelephonyError('UNKNOWN', 'Twilio returned no call record');
  }
  const sid = (response as Record<string, unknown>)['sid'];
  if (typeof sid !== 'string' || sid.length === 0) {
    throw new TelephonyError('UNKNOWN', 'Twilio returned a call with no sid');
  }
  return sid;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}
