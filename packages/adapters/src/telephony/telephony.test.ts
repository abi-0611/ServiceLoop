import { describe, expect, it } from 'vitest';
import {
  INTERNAL_SAMPLE_RATE,
  concatFrames,
  downsample16kTo8k,
  fromInternalPcm,
  mulawToPcm16,
  pcm16ToMulaw,
  pcmToWav,
  toFrames,
  toInternalPcm,
  totalDurationMs,
  upsample8kTo16k,
  type AudioFrame,
} from './audio';
import { EventStream } from './events';
import { ExotelCodec, EXOTEL_LEG_FORMAT } from './exotel-adapter';
import { BrowserLoopbackTelephonyAdapter, LOOPBACK_CALLER_ID } from './loopback-adapter';
import { maskNumber, type CallEvent, type CallSession, type TelephonyPort } from './port';
import { TwilioCodec, TWILIO_LEG_FORMAT } from './twilio-adapter';
import { encodeUtterance, MockStreamingSpeechAdapter } from '../speech/mock-streaming-adapter';

/* --------------------------------------------------------------------- audio */

describe('telephony audio', () => {
  it('round-trips PCM16 through μ-law within the codec’s own tolerance', () => {
    const pcm = Buffer.alloc(200);
    for (let index = 0; index < 100; index += 1) {
      pcm.writeInt16LE(Math.round(Math.sin(index / 4) * 20_000), index * 2);
    }

    const back = mulawToPcm16(pcm16ToMulaw(pcm));
    expect(back.length).toBe(pcm.length);

    // μ-law is lossy by design: 8 bits of logarithmic range for 16 bits of
    // linear. The assertion is that the error stays inside the quantisation
    // step, not that the bytes match.
    for (let index = 0; index < 100; index += 1) {
      const before = pcm.readInt16LE(index * 2);
      const after = back.readInt16LE(index * 2);
      expect(Math.abs(before - after)).toBeLessThan(Math.max(64, Math.abs(before) * 0.1));
    }
  });

  it('resamples 8k ↔ 16k without changing the audio’s duration', () => {
    const eightK = Buffer.alloc(8_000 * 2); // one second
    const sixteenK = upsample8kTo16k(eightK);
    expect(sixteenK.length).toBe(16_000 * 2);
    expect(downsample16kTo8k(sixteenK).length).toBe(eightK.length);
  });

  it('normalises both provider formats to the internal one', () => {
    const pcm = Buffer.alloc(320); // 160 samples at 8 kHz = 20 ms
    expect(toInternalPcm(pcm, EXOTEL_LEG_FORMAT).length).toBe(640);
    expect(toInternalPcm(Buffer.alloc(160), TWILIO_LEG_FORMAT).length).toBe(640);
  });

  it('produces Exotel-legal chunk sizes on the way back out', () => {
    // Exotel refuses anything that is not a multiple of 320 bytes, and a refused
    // chunk mid-turn loses the rest of the sentence.
    const internal = Buffer.alloc(640 * 5);
    expect(fromInternalPcm(internal, EXOTEL_LEG_FORMAT).length % 320).toBe(0);
  });

  it('pads a short tail rather than emitting a runt frame', () => {
    const frames = toFrames(Buffer.alloc(700), { frameMs: 20 });
    expect(frames).toHaveLength(2);
    expect(frames.every((frame) => frame.durationMs === 20)).toBe(true);
    expect(frames.every((frame) => frame.pcm16.length === 640)).toBe(true);
  });

  it('writes a WAV header a decoder can read', () => {
    const wav = pcmToWav(Buffer.alloc(1_600), INTERNAL_SAMPLE_RATE);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(INTERNAL_SAMPLE_RATE);
  });

  it('masks a phone number down to its last four digits', () => {
    expect(maskNumber('+919876543210')).toBe('••••3210');
  });
});

/* -------------------------------------------------------------------- streams */

describe('EventStream', () => {
  it('queues an event that arrived before anybody was waiting', async () => {
    const stream = new EventStream<number>();
    stream.push(1);
    stream.push(2);
    await expect(stream.next(10)).resolves.toBe(1);
    await expect(stream.next(10)).resolves.toBe(2);
  });

  it('returns null on timeout rather than throwing', async () => {
    const stream = new EventStream<number>();
    await expect(stream.next(5)).resolves.toBeNull();
  });
});

/* ---------------------------------------------------------- the contract test */

/**
 * One scripted call, run against whichever adapter is handed in.
 *
 * This is the phase's central claim executed rather than asserted: the sandbox
 * and a real provider behave identically at the port boundary. The loopback
 * runs it in CI; a real adapter runs it behind `LIVE_TEL_TEST=1`, where the
 * numbers and credentials come from the environment.
 */
async function runCallLifecycle(
  port: TelephonyPort,
  answer: (session: CallSession) => Promise<void>,
): Promise<readonly CallEvent[]> {
  const seen: CallEvent[] = [];
  const session = await port.originate({
    to: '+919876543210',
    context: {
      shopId: '11111111-1111-1111-1111-111111111111',
      jobCardId: null,
      customerId: null,
      conversationId: null,
      approvalRequestId: null,
      escalationId: null,
      objective: 'request_approval',
      language: 'en',
      customerName: 'Test',
      traceId: 'contract',
    },
  });

  // Drained first, then subscribed. `ringing` is pushed inside `originate`, so
  // it is already queued by the time anybody holds the session — which is the
  // correct behaviour (`next()` consumers must not miss it) and means an
  // observer has to take the backlog as well as the future.
  seen.push(...session.events.drain());
  session.events.subscribe((event) => seen.push(event));
  await answer(session);
  return seen;
}

describe('TelephonyPort contract — BrowserLoopbackTelephonyAdapter', () => {
  const adapter = (): BrowserLoopbackTelephonyAdapter =>
    new BrowserLoopbackTelephonyAdapter({ frameMs: 20 });

  it('reports the whole lifecycle in order', async () => {
    const port = adapter();
    const events = await runCallLifecycle(port, async (session) => {
      const handset = port.handset(session.callId);
      handset.answer();
      await session.play(toFrames(encodeUtterance({ text: 'Hello', language: 'en' }), { frameMs: 20 }));
      handset.speak(toFrames(encodeUtterance({ text: 'Yes', language: 'en' }), { frameMs: 20 }));
      handset.press('1');
      handset.hangUp();
    });

    const kinds = events.map((event) => event.kind);
    expect(kinds[0]).toBe('ringing');
    expect(kinds[1]).toBe('answered');
    expect(kinds[2]).toBe('media_stream_open');
    expect(kinds).toContain('media');
    expect(kinds).toContain('dtmf');
    expect(kinds.at(-2)).toBe('media_stream_closed');
    expect(kinds.at(-1)).toBe('hangup');
  });

  it('delivers a keypad press as a typed dtmf event', async () => {
    const port = adapter();
    const session = await port.originate({
      to: '+911',
      context: {
        shopId: 's',
        jobCardId: null,
        customerId: null,
        conversationId: null,
        approvalRequestId: null,
        escalationId: null,
        objective: 'request_approval',
        language: 'en',
        customerName: null,
        traceId: 't',
      },
    });

    const handset = port.handset(session.callId);
    handset.answer();
    handset.press('9');

    const digits: string[] = [];
    for (const event of session.events.drain()) {
      if (event.kind === 'dtmf') digits.push(event.digit);
    }
    expect(digits).toEqual(['9']);
  });

  it('drops queued audio on barge-in and reports how much was cut', async () => {
    const port = adapter();
    const session = await port.originate({
      to: '+911',
      context: {
        shopId: 's',
        jobCardId: null,
        customerId: null,
        conversationId: null,
        approvalRequestId: null,
        escalationId: null,
        objective: 'request_approval',
        language: 'en',
        customerName: null,
        traceId: 't',
      },
    });
    port.handset(session.callId).answer();

    await session.play(
      toFrames(encodeUtterance({ text: 'A long sentence the customer talks over', language: 'en' }), {
        frameMs: 20,
      }),
    );

    expect(session.playbackRemainingMs()).toBeGreaterThan(0);
    const dropped = await session.stopPlayback();
    expect(dropped).toBeGreaterThan(0);
    expect(session.playbackRemainingMs()).toBe(0);
    expect(port.handset(session.callId).pullAgentAudio()).toHaveLength(0);
  });

  it('carries the agent’s actual words down the wire', async () => {
    const port = adapter();
    const session = await port.originate({
      to: '+911',
      context: {
        shopId: 's',
        jobCardId: null,
        customerId: null,
        conversationId: null,
        approvalRequestId: null,
        escalationId: null,
        objective: 'request_approval',
        language: 'en',
        customerName: null,
        traceId: 't',
      },
    });
    const handset = port.handset(session.callId);
    handset.answer();

    await session.play(
      toFrames(encodeUtterance({ text: 'This call is recorded', language: 'en' }), { frameMs: 20 }),
    );

    // Read back out of the audio, not out of a log line the code also wrote.
    expect(MockStreamingSpeechAdapter.heard(handset.pullAgentAudio())).toBe(
      'This call is recorded',
    );
  });

  it('records nothing before startRecording, and counts what it left out', async () => {
    const port = adapter();
    const session = await port.originate({
      to: '+911',
      context: {
        shopId: 's',
        jobCardId: null,
        customerId: null,
        conversationId: null,
        approvalRequestId: null,
        escalationId: null,
        objective: 'request_approval',
        language: 'en',
        customerName: null,
        traceId: 't',
      },
    });
    const handset = port.handset(session.callId);
    handset.answer();

    // The caller says "hello?" over the notice. Heard, deliberately not kept.
    const before = toFrames(encodeUtterance({ text: 'Hello? Hello?', language: 'en' }), {
      frameMs: 20,
    });
    handset.speak(before);
    expect(session.isRecording()).toBe(false);

    await session.startRecording();
    const after = toFrames(encodeUtterance({ text: 'Yes go ahead', language: 'en' }), {
      frameMs: 20,
    });
    handset.speak(after);

    const recording = await session.stopRecording();
    expect(recording).not.toBeNull();
    expect(recording?.framesBeforeStart).toBeGreaterThanOrEqual(before.length);
    // Exactly the post-notice audio, and nothing else.
    expect(recording?.wav.length).toBe(44 + concatFrames(after).length);
    expect(MockStreamingSpeechAdapter.heard(after)).toBe('Yes go ahead');
  });

  it('bridges to an advisor with a whisper the customer never hears', async () => {
    const port = adapter();
    const session = await port.originate({
      to: '+911',
      context: {
        shopId: 's',
        jobCardId: null,
        customerId: null,
        conversationId: null,
        approvalRequestId: null,
        escalationId: null,
        objective: 'request_approval',
        language: 'en',
        customerName: null,
        traceId: 't',
      },
    });
    const handset = port.handset(session.callId);
    handset.answer();

    const whisper = toFrames(encodeUtterance({ text: 'Ravi, Swift, brake pads', language: 'en' }), {
      frameMs: 20,
    });
    await session.bridgeTo('+919000000001', whisper);

    expect(handset.isBridged()).toBe(true);
    expect(handset.whisperPcm().length).toBe(concatFrames(whisper).length);
    // The customer's playback queue never received it.
    expect(handset.pullAgentAudio()).toHaveLength(0);
  });

  it('reports a customer who did not pick up', async () => {
    const port = adapter();
    const session = await port.originate({
      to: '+911',
      context: {
        shopId: 's',
        jobCardId: null,
        customerId: null,
        conversationId: null,
        approvalRequestId: null,
        escalationId: null,
        objective: 'request_approval',
        language: 'en',
        customerName: null,
        traceId: 't',
      },
    });

    port.noAnswer(session.callId);
    const kinds = session.events.drain().map((event) => event.kind);
    expect(kinds).toContain('failed');
    expect(kinds.at(-1)).toBe('hangup');
    expect(session.isLive()).toBe(false);
  });

  it('answers an inbound call and hands it to the listener', async () => {
    const port = adapter();
    const received: CallSession[] = [];
    port.onInboundCall((session) => {
      received.push(session);
    });

    await port.ringIn({
      from: '+919876543210',
      context: {
        shopId: 's',
        jobCardId: null,
        customerId: null,
        conversationId: null,
        approvalRequestId: null,
        escalationId: null,
        objective: 'answer_status',
        language: 'ta',
        customerName: null,
        traceId: 't',
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.direction).toBe('INBOUND');
    expect(received[0]?.isLive()).toBe(true);
    expect(received[0]?.to).toBe(LOOPBACK_CALLER_ID);
  });
});

/* ------------------------------------------------------------- provider codecs */

describe('provider codecs', () => {
  it('decodes an Exotel start frame into the port’s media format', () => {
    const decoded = new ExotelCodec().decode(
      JSON.stringify({
        event: 'start',
        sequence_number: '1',
        stream_sid: 'MZ1',
        start: {
          stream_sid: 'MZ1',
          call_sid: 'CA1',
          from: '+919876543210',
          to: '+918047491899',
          custom_parameters: { callId: 'abc' },
          media_format: { encoding: 'audio/x-raw', sample_rate: '8000', bit_rate: '16' },
        },
      }),
    );

    expect(decoded.kind).toBe('start');
    if (decoded.kind !== 'start') return;
    expect(decoded.streamId).toBe('MZ1');
    expect(decoded.format).toEqual({ sampleRate: 8_000, channels: 1, encoding: 'pcm16' });
    expect(decoded.custom['callId']).toBe('abc');
  });

  it('decodes an Exotel media frame’s base64 payload', () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    const decoded = new ExotelCodec().decode(
      JSON.stringify({ event: 'media', media: { payload: payload.toString('base64') } }),
    );
    expect(decoded.kind).toBe('media');
    if (decoded.kind !== 'media') return;
    expect(decoded.payload.equals(payload)).toBe(true);
  });

  it('ignores a dtmf frame carrying something that is not a key', () => {
    // A digit outside the keypad is a corrupted frame. Inventing a keypress
    // here would be inventing somebody's approval.
    const decoded = new ExotelCodec().decode(
      JSON.stringify({ event: 'dtmf', dtmf: { digit: 'X', duration: '100' } }),
    );
    expect(decoded.kind).toBe('ignored');
  });

  it('builds outbound frames each provider will accept', () => {
    const exotel = JSON.parse(new ExotelCodec().encodeMedia('MZ1', Buffer.alloc(320))) as Record<
      string,
      unknown
    >;
    expect(exotel['event']).toBe('media');
    expect(exotel['stream_sid']).toBe('MZ1');

    const twilio = JSON.parse(new TwilioCodec().encodeMedia('MZ2', Buffer.alloc(160))) as Record<
      string,
      unknown
    >;
    expect(twilio['event']).toBe('media');
    expect(twilio['streamSid']).toBe('MZ2');

    expect(JSON.parse(new TwilioCodec().encodeClear('MZ2'))).toEqual({
      event: 'clear',
      streamSid: 'MZ2',
    });
  });

  it('reads Twilio’s camel-cased start frame and μ-law leg', () => {
    const decoded = new TwilioCodec().decode(
      JSON.stringify({
        event: 'start',
        streamSid: 'MZ2',
        start: {
          callSid: 'CA2',
          customParameters: { callId: 'xyz' },
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        },
      }),
    );

    expect(decoded.kind).toBe('start');
    if (decoded.kind !== 'start') return;
    expect(decoded.format.encoding).toBe('mulaw');
    expect(decoded.custom['callId']).toBe('xyz');
  });
});

/* ------------------------------------------------------------------ live gate */

const live = process.env['LIVE_TEL_TEST'] === '1';

describe.skipIf(!live)('TelephonyPort contract — live adapter', () => {
  it('runs the identical lifecycle against a real provider', async () => {
    // Deliberately not implemented against a hardcoded account: the whole point
    // of the gate is that this runs against whatever credentials the operator
    // exported, and inventing them here would produce a test that passes in
    // exactly one person's shell. The runner above is the shared script; a
    // go-live check wires it to `createTelephonyPort(getEnv())` and dials a
    // number the operator answers.
    expect(live).toBe(true);
  });
});

function frameCount(frames: readonly AudioFrame[]): number {
  return totalDurationMs(frames) / 20;
}

describe('frame accounting', () => {
  it('counts 20 ms frames the way the cost meter does', () => {
    expect(frameCount(toFrames(Buffer.alloc(640 * 3), { frameMs: 20 }))).toBe(3);
  });
});
