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
 * `ExotelTelephonyAdapter` — the primary adapter for India (phase 5.1).
 *
 * Two halves, verified against Exotel's current AgentStream documentation
 * (August 2026):
 *
 *   - **Control** is REST. An outgoing call is placed against
 *     `/v1/Accounts/{sid}/Calls/connect.json` with an App Bazaar flow url; the
 *     flow's Voicebot applet is what hands the leg to our media stream. The
 *     flow id is configuration (`EXOTEL_FLOW_APP_ID`) rather than code, because
 *     a shop that re-publishes its flow gets a new id and should not need a
 *     deploy.
 *   - **Media** is a WebSocket Exotel opens *to us*, carrying `connected`,
 *     `start`, `media`, `dtmf` and `stop` events; we answer with `media`,
 *     `mark` and `clear`. Audio is raw 16-bit 8 kHz mono little-endian PCM,
 *     base64 at `media.payload`, in chunks that must be a multiple of 320
 *     bytes — one 20 ms frame.
 *
 * The socket itself is injected (`attachMediaSocket`). A library has no
 * business binding a network listener; the API process that already owns an
 * HTTP server routes the upgrade and hands the socket here. Everything that can
 * be tested without a telephone — the codec, the state machine, the chunking —
 * is in this package and is tested.
 */

const EXOTEL_CHUNK_BYTES = 320;

/** raw/slin: 16-bit, 8 kHz, mono, little-endian. Exotel's own words. */
export const EXOTEL_LEG_FORMAT: AudioFormat = {
  sampleRate: 8_000,
  channels: 1,
  encoding: 'pcm16',
};

export interface ExotelConfig {
  readonly accountSid: string;
  readonly apiKey: string;
  readonly apiToken: string;
  /** Account region host, e.g. `api.exotel.com` or `api.in.exotel.com`. */
  readonly subdomain: string;
  /** The App Bazaar flow whose Voicebot applet streams to us. */
  readonly flowAppId: string;
  readonly callerId: string;
  /** Public base url the flow's applet and our status callbacks point at. */
  readonly webhookBaseUrl: string;
  readonly timeoutMs?: number;
  readonly frameMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export class ExotelCodec implements ProviderCodec {
  readonly driver = 'exotel' as const;
  readonly legFormat = EXOTEL_LEG_FORMAT;
  readonly chunkBytes = EXOTEL_CHUNK_BYTES;

  decode(raw: string): DecodedFrame {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Exotel frame was not an object');
    }

    const frame = parsed as Record<string, unknown>;
    const event = typeof frame['event'] === 'string' ? frame['event'] : '';

    switch (event) {
      case 'connected':
        return { kind: 'connected' };

      case 'start': {
        const start = asRecord(frame['start']);
        const format = asRecord(start['media_format']);
        const sampleRate = Number(format['sample_rate'] ?? EXOTEL_LEG_FORMAT.sampleRate);

        return {
          kind: 'start',
          streamId: String(frame['stream_sid'] ?? start['stream_sid'] ?? ''),
          callSid: String(start['call_sid'] ?? ''),
          format: {
            sampleRate: Number.isFinite(sampleRate) ? sampleRate : EXOTEL_LEG_FORMAT.sampleRate,
            channels: 1,
            // Exotel reports `audio/x-raw`, which is linear PCM. Anything else
            // is a media format we have not been told about, and guessing μ-law
            // would render a whole call as static.
            encoding: 'pcm16',
          },
          from: asStringOrNull(start['from']),
          to: asStringOrNull(start['to']),
          custom: asStringRecord(start['custom_parameters']),
        };
      }

      case 'media': {
        const media = asRecord(frame['media']);
        return { kind: 'media', payload: Buffer.from(String(media['payload'] ?? ''), 'base64') };
      }

      case 'dtmf': {
        const dtmf = asRecord(frame['dtmf']);
        const digit = asDtmfDigit(String(dtmf['digit'] ?? ''));
        // A digit outside the keypad is a provider bug or a corrupted frame.
        // Ignoring it beats inventing a keypress that decides somebody's money.
        return digit === null ? { kind: 'ignored', event: 'dtmf' } : { kind: 'dtmf', digit };
      }

      case 'mark': {
        const mark = asRecord(frame['mark']);
        return { kind: 'mark', name: String(mark['name'] ?? '') };
      }

      case 'stop': {
        const stop = asRecord(frame['stop']);
        return { kind: 'stop', reason: String(stop['reason'] ?? 'callended') };
      }

      default:
        return { kind: 'ignored', event };
    }
  }

  encodeMedia(streamId: string, payload: Buffer): string {
    return JSON.stringify({
      event: 'media',
      stream_sid: streamId,
      media: { payload: payload.toString('base64') },
    });
  }

  encodeClear(streamId: string): string {
    return JSON.stringify({ event: 'clear', stream_sid: streamId });
  }

  encodeMark(streamId: string, name: string): string {
    return JSON.stringify({ event: 'mark', stream_sid: streamId, mark: { name } });
  }
}

export class ExotelTelephonyAdapter implements TelephonyPort {
  readonly driver = 'exotel' as const;
  readonly callerId: string;

  private readonly codec = new ExotelCodec();
  private readonly sessions = new Map<string, ProviderCallSession>();
  private readonly bySid = new Map<string, string>();
  private readonly listeners = new Set<InboundCallListener>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly config: ExotelConfig) {
    this.callerId = config.callerId;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => new Date());
    this.newId = config.newId ?? randomUUID;
  }

  async originate(input: OriginateInput): Promise<CallSession> {
    const callId = this.newId();
    const body = new URLSearchParams({
      From: input.from ?? this.callerId,
      To: input.to,
      CallerId: this.callerId,
      Url: `http://my.exotel.com/${this.config.accountSid}/exoml/start_voice/${this.config.flowAppId}`,
      StatusCallback: `${this.config.webhookBaseUrl}/voice/exotel/status`,
      // Round-trips our own call id through the provider, so an asynchronous
      // status callback can be matched to a call without a lookup table that
      // could get out of step with the database.
      CustomField: callId,
      TimeLimit: String(input.ringTimeoutSeconds ?? 45),
    });

    const response = await this.request(
      `/v1/Accounts/${this.config.accountSid}/Calls/connect.json`,
      body,
    );

    const providerCallSid = extractCallSid(response);
    const session = this.track(callId, providerCallSid, 'OUTBOUND', input);
    session.markRinging();

    return session;
  }

  /**
   * An inbound leg arrived on the shop's published number.
   *
   * Called by the status webhook, before the media socket attaches. The
   * listener is given the session immediately so the greeting is composed while
   * Exotel is still connecting the stream — the alternative is a customer
   * listening to nothing for a second and a half.
   */
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

  /** Binds the WebSocket the provider opened to the call it belongs to. */
  attachMediaSocket(providerCallSid: string, socket: MediaSocket): void {
    const callId = this.bySid.get(providerCallSid);
    const session = callId === undefined ? undefined : this.sessions.get(callId);
    if (session === undefined) {
      socket.close('unknown call');
      throw new TelephonyError('CALL_NOT_FOUND', `No Exotel call ${providerCallSid}`, {
        providerCallSid,
      });
    }
    session.attachMediaSocket(socket);
  }

  /** Provider status callbacks: `in-progress`, `completed`, `no-answer`, `busy`. */
  applyStatus(providerCallSid: string, status: string): void {
    const callId = this.bySid.get(providerCallSid);
    const session = callId === undefined ? undefined : this.sessions.get(callId);
    if (session === undefined) return;

    switch (status.toLowerCase()) {
      case 'in-progress':
      case 'in_progress':
        session.markAnswered();
        return;
      case 'no-answer':
      case 'no_answer':
        session.markFailed('NO_ANSWER', 'The customer did not answer');
        return;
      case 'busy':
        session.markFailed('BUSY', 'The line was busy');
        return;
      case 'failed':
        session.markFailed('PROVIDER_UNAVAILABLE', 'Exotel reported the call failed');
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
   * The advisor leg of a warm handoff.
   *
   * Exotel's `connect` API joins two numbers directly, so the whisper cannot be
   * played through it; the flow's applet fetches it from us instead, which is
   * what `whisperUrl` addresses. The summary is therefore stored against the
   * call id by the caller before this runs — the adapter only names where the
   * provider should look for it.
   */
  private async dialAdvisorLeg(input: {
    readonly callId: string;
    readonly providerCallSid: string;
    readonly number: string;
  }): Promise<void> {
    const body = new URLSearchParams({
      From: this.callerId,
      To: input.number,
      CallerId: this.callerId,
      Url: `http://my.exotel.com/${this.config.accountSid}/exoml/start_voice/${this.config.flowAppId}`,
      CustomField: `bridge:${input.callId}`,
      StatusCallback: `${this.config.webhookBaseUrl}/voice/exotel/status`,
    });

    await this.request(`/v1/Accounts/${this.config.accountSid}/Calls/connect.json`, body);
  }

  private async request(path: string, body: URLSearchParams): Promise<unknown> {
    const auth = Buffer.from(`${this.config.apiKey}:${this.config.apiToken}`).toString('base64');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 15_000);

    try {
      const response = await this.fetchImpl(`https://${this.config.subdomain}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        throw new TelephonyError(kindForStatus(response.status), `Exotel refused the call`, {
          status: response.status,
          // Truncated: a provider error body can carry the dialled number, and
          // a log line is the wrong place for a customer's phone number.
          body: text.slice(0, 400),
        });
      }

      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof TelephonyError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new TelephonyError('PROVIDER_UNAVAILABLE', 'Exotel timed out', { path });
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

function extractCallSid(response: unknown): string {
  if (typeof response !== 'object' || response === null) {
    throw new TelephonyError('UNKNOWN', 'Exotel returned no call record');
  }
  const call = asRecord((response as Record<string, unknown>)['Call']);
  const sid = call['Sid'];
  if (typeof sid !== 'string' || sid.length === 0) {
    throw new TelephonyError('UNKNOWN', 'Exotel returned a call with no Sid');
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
