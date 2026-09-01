import {
  frameEnergy,
  type AudioFrame,
  type CallEvent,
  type CallSession,
  type StreamingSpeechPort,
  type SynthesisStream,
  type TranscribeStream,
  type TranscriptEvent,
} from '@serviceloop/adapters';
import type { DtmfDigit, Language, VoiceLatencyStage } from '@serviceloop/shared';

/**
 * The turn manager (phase 5.3).
 *
 * Everything about a phone call that a chat thread does not have lives here:
 * knowing when the customer has finished talking, cutting the agent off the
 * instant they start again, and getting the first syllable of a reply out
 * inside 1.2 seconds. The objective, the tools and the guardrails are phase
 * 3's, unchanged — this is the layer that makes them survive a telephone.
 *
 * Four behaviours, each of which exists because its absence is a specific,
 * recognisable kind of bad call:
 *
 *   - **Endpointing on finality plus silence.** A recogniser's `final` is not
 *     the end of a turn; people pause mid-sentence. Waiting a further 700 ms of
 *     silence is what stops the agent talking over somebody who was drawing
 *     breath — and what stops it waiting forever for somebody who was not.
 *   - **Barge-in cuts synthesis, and commits what was heard.** A customer who
 *     interrupts has *already decided*; continuing to read them the estimate is
 *     the single most infuriating thing a voice bot does. The partial they
 *     talked over is committed as heard, so the next turn knows how far they
 *     got.
 *   - **A keypress ends a turn immediately.** No endpointing, no confidence, no
 *     recogniser. A key is the one input on a phone line that cannot be
 *     mis-heard, and making it wait for silence would make the keypad feel
 *     broken (phase 5.5).
 *   - **Dead air is filled, never allowed.** If planning outruns the budget the
 *     line gets "oru nimisham…" rather than nothing. Three seconds of silence
 *     on a phone is a call the customer assumes has dropped.
 */

export interface TurnManagerOptions {
  readonly session: CallSession;
  readonly speech: StreamingSpeechPort;
  readonly shopId: string;
  readonly language: Language;
  /** Silence after a final transcript that ends the caller's turn. */
  readonly endpointSilenceMs: number;
  /** Longest the manager waits for a caller who says nothing at all. */
  readonly maxWaitMs: number;
  /** Speech-end → speech-start. Breaching it fills; it never ends the call. */
  readonly latencyBudgetMs: number;
  /** Longest the line may be silent before the comfort filler plays. */
  readonly maxDeadAirMs: number;
  readonly voiceRef?: string;
  readonly hints?: readonly string[];
  readonly frameMs: number;
  readonly traceId: string;
  readonly now?: () => Date;
}

export interface SpokenTurn {
  readonly text: string;
  /** Milliseconds of audio actually handed to the line. */
  readonly synthesisedMs: number;
  /** True when the customer talked over it and synthesis was cut. */
  readonly bargedIn: boolean;
  /** Milliseconds discarded by the cut. Zero when nothing was cut. */
  readonly droppedMs: number;
  readonly firstFrameAt: Date | null;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

export interface HeardTurn {
  readonly text: string;
  readonly confidence: number | null;
  readonly languageTag: string | null;
  readonly inputMode: 'SPEECH' | 'DTMF' | 'NONE';
  readonly dtmf: DtmfDigit | null;
  /** Milliseconds of caller audio the recogniser consumed. */
  readonly audioMs: number;
  readonly startedAt: Date;
  readonly speechEndedAt: Date | null;
  /** True when the caller hung up during this turn. */
  readonly hangup: boolean;
  readonly partials: readonly string[];
}

/** RMS above this counts as somebody talking. Digital silence is exactly zero. */
const SPEECH_ENERGY_THRESHOLD = 0.02;

export class VoiceTurnManager {
  private readonly now: () => Date;
  /** Frames that arrived while the agent was speaking, kept for the next listen. */
  private carriedFrames: AudioFrame[] = [];
  private pendingDtmf: DtmfDigit | null = null;
  private callerHungUp = false;
  private sttMs = 0;
  private ttsMs = 0;

  constructor(private readonly options: TurnManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  get sttMillis(): number {
    return this.sttMs;
  }

  get ttsMillis(): number {
    return this.ttsMs;
  }

  get hungUp(): boolean {
    return this.callerHungUp;
  }

  /**
   * Says something, and stops the moment the caller starts talking.
   *
   * `allowBargeIn` is false for exactly two things: the AI disclosure and the
   * recording notice. Not because the customer may not interrupt — they can
   * hang up, and often will — but because a legal obligation that a cough can
   * cancel is not an obligation. Everything else is interruptible.
   */
  async speak(
    text: string,
    options: { readonly allowBargeIn?: boolean } = {},
  ): Promise<SpokenTurn> {
    const allowBargeIn = options.allowBargeIn ?? true;
    const startedAt = this.now();

    const synthesis: SynthesisStream = this.options.speech.streamSynthesize({
      shopId: this.options.shopId,
      callId: this.options.session.callId,
      language: this.options.language,
      frameMs: this.options.frameMs,
      traceId: this.options.traceId,
      ...(this.options.voiceRef === undefined ? {} : { voiceRef: this.options.voiceRef }),
    });

    await synthesis.write(text);
    await synthesis.end();

    let bargedIn = false;
    let droppedMs = 0;
    const played: AudioFrame[] = [];

    for (;;) {
      const frame = await synthesis.frames.next(0);
      if (frame === null) break;
      played.push(frame);
    }

    // The frames are handed to the line in one go and the *line* is what plays
    // them over time; barge-in then means telling the line to discard what it
    // has not yet played, which is exactly what `stopPlayback` does on all
    // three adapters.
    if (played.length > 0) await this.options.session.play(played);
    this.ttsMs += synthesis.synthesisedMs();

    if (allowBargeIn) {
      const interruption = await this.watchForInterruption();
      if (interruption) {
        await synthesis.cancel();
        droppedMs = await this.options.session.stopPlayback();
        bargedIn = true;
      }
    } else {
      // Still drained, so a keypress during the notice is not lost — it is
      // simply not allowed to cut the notice short.
      await this.drainWhileSpeaking();
    }

    return {
      text,
      synthesisedMs: synthesis.synthesisedMs(),
      bargedIn,
      droppedMs,
      firstFrameAt: synthesis.firstFrameAt(),
      startedAt,
      finishedAt: this.now(),
    };
  }

  /**
   * Listens for one caller turn.
   *
   * Ends on the first of: a keypress, a final transcript followed by silence,
   * the caller hanging up, or `maxWaitMs` with nothing said at all — which is
   * its own answer and is reported as `NONE` rather than as an empty string, so
   * the flow above can offer the keypad instead of guessing.
   */
  async listen(): Promise<HeardTurn> {
    const startedAt = this.now();

    if (this.pendingDtmf !== null) {
      const digit = this.pendingDtmf;
      this.pendingDtmf = null;
      return {
        text: '',
        confidence: null,
        languageTag: null,
        inputMode: 'DTMF',
        dtmf: digit,
        audioMs: 0,
        startedAt,
        speechEndedAt: this.now(),
        hangup: this.callerHungUp,
        partials: [],
      };
    }

    const stream: TranscribeStream = this.options.speech.streamTranscribe({
      shopId: this.options.shopId,
      callId: this.options.session.callId,
      languageHint: this.options.language,
      traceId: this.options.traceId,
      ...(this.options.hints === undefined ? {} : { hints: this.options.hints }),
    });

    const partials: string[] = [];
    let finalEvent: TranscriptEvent | null = null;
    let audioMs = 0;
    let lastAudioAt: Date | null = null;
    let sawAudio = false;

    const consume = (): void => {
      for (;;) {
        const event = stream.events.drain().shift();
        if (event === undefined) break;
        if (event.kind === 'partial') partials.push(event.text);
        else finalEvent = event;
      }
    };

    // Anything that arrived while the agent was talking is the start of this
    // turn, not noise to throw away — a customer who begins answering before
    // the question ends is the normal case, not an edge one.
    for (const frame of this.carriedFrames.splice(0)) {
      stream.push(frame);
      audioMs += frame.durationMs;
      sawAudio = true;
      lastAudioAt = this.now();
    }
    consume();

    const deadline = Date.now() + this.options.maxWaitMs;

    while (Date.now() < deadline) {
      const waitMs =
        finalEvent !== null
          ? this.options.endpointSilenceMs
          : Math.min(200, Math.max(10, deadline - Date.now()));

      const event = await this.options.session.events.next(waitMs);

      if (event === null) {
        consume();
        // A final that has been followed by silence is a finished turn. This is
        // the endpointing rule, and it is the whole reason `final` alone is not
        // enough: people pause mid-sentence.
        if (finalEvent !== null) break;
        if (sawAudio && lastAudioAt !== null) {
          const quietFor = this.now().getTime() - lastAudioAt.getTime();
          if (quietFor >= this.options.endpointSilenceMs) break;
        }
        continue;
      }

      const outcome = this.classify(event);

      if (outcome === 'dtmf' && event.kind === 'dtmf') {
        stream.close();
        const digit = event.digit;
        this.pendingDtmf = null;
        return {
          text: '',
          confidence: null,
          languageTag: null,
          inputMode: 'DTMF',
          dtmf: digit,
          audioMs,
          startedAt,
          speechEndedAt: this.now(),
          hangup: this.callerHungUp,
          partials,
        };
      }

      if (outcome === 'hangup') {
        stream.close();
        return {
          text: finalEvent === null ? '' : (finalEvent as TranscriptEvent).text,
          confidence: null,
          languageTag: null,
          inputMode: 'NONE',
          dtmf: null,
          audioMs,
          startedAt,
          speechEndedAt: lastAudioAt,
          hangup: true,
          partials,
        };
      }

      if (outcome === 'media' && event.kind === 'media') {
        stream.push(event.frame);
        audioMs += event.frame.durationMs;
        if (frameEnergy(event.frame) >= SPEECH_ENERGY_THRESHOLD) {
          sawAudio = true;
          lastAudioAt = this.now();
        }
        consume();
      }
    }

    consume();
    if (finalEvent === null) {
      await stream.end();
      consume();
    } else {
      stream.close();
    }

    this.sttMs += audioMs;

    const resolved = finalEvent as TranscriptEvent | null;
    const text = resolved?.text ?? '';

    return {
      text,
      confidence: resolved?.confidence ?? (sawAudio ? 0 : null),
      languageTag: resolved?.languageTag ?? null,
      inputMode: text.length > 0 || sawAudio ? 'SPEECH' : 'NONE',
      dtmf: null,
      audioMs,
      startedAt,
      speechEndedAt: lastAudioAt,
      hangup: this.callerHungUp,
      partials,
    };
  }

  /**
   * Runs `plan` while keeping the line alive.
   *
   * If planning outruns the dead-air limit the filler is spoken and planning
   * continues underneath it. The filler is not a fallback for a failed plan —
   * it is what a person does when they say "one moment" and keep looking.
   */
  async planWithFiller<T>(
    plan: () => Promise<T>,
    filler: string,
  ): Promise<{ readonly value: T; readonly filled: boolean; readonly plannedMs: number }> {
    const started = Date.now();
    let filled = false;

    const timer = setTimeout(() => {
      filled = true;
      void this.speak(filler, { allowBargeIn: true }).catch(() => undefined);
    }, this.options.maxDeadAirMs);
    timer.unref?.();

    try {
      const value = await plan();
      return { value, filled, plannedMs: Date.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The stage markers behind one turn's latency budget. */
  static latencyStages(input: {
    readonly speechEndedAt: Date | null;
    readonly finalAt: Date;
    readonly planReadyAt: Date;
    readonly firstFrameAt: Date | null;
    readonly speechStartedAt: Date;
  }): Partial<Record<VoiceLatencyStage, number>> {
    const stages: Partial<Record<VoiceLatencyStage, number>> = {};
    const { speechEndedAt, finalAt, planReadyAt, firstFrameAt, speechStartedAt } = input;

    if (speechEndedAt !== null) {
      stages.SPEECH_END_TO_FINAL = Math.max(0, finalAt.getTime() - speechEndedAt.getTime());
      stages.SPEECH_END_TO_SPEECH_START = Math.max(
        0,
        speechStartedAt.getTime() - speechEndedAt.getTime(),
      );
    }
    stages.FINAL_TO_PLAN = Math.max(0, planReadyAt.getTime() - finalAt.getTime());
    if (firstFrameAt !== null) {
      stages.PLAN_TO_FIRST_SYNTH_BYTE = Math.max(
        0,
        firstFrameAt.getTime() - planReadyAt.getTime(),
      );
      stages.FIRST_SYNTH_BYTE_TO_SPEECH_START = Math.max(
        0,
        speechStartedAt.getTime() - firstFrameAt.getTime(),
      );
    }

    return stages;
  }

  /* ------------------------------------------------------------------ private */

  /**
   * Watches for the caller talking or pressing a key while the agent speaks.
   *
   * Returns as soon as one is seen, so the cut happens within one event rather
   * than at the end of the utterance. Frames observed here are *carried* into
   * the next listen: the words a customer said over the top of the agent are
   * the words that matter most.
   */
  private async watchForInterruption(): Promise<boolean> {
    for (;;) {
      const remaining = this.options.session.playbackRemainingMs();
      if (remaining <= 0) return false;

      const event = await this.options.session.events.next(
        Math.min(50, Math.max(5, remaining)),
      );
      if (event === null) continue;

      const outcome = this.classify(event);
      if (outcome === 'dtmf') return true;
      if (outcome === 'hangup') return false;

      if (outcome === 'media' && event.kind === 'media') {
        this.carriedFrames.push(event.frame);
        if (frameEnergy(event.frame) >= SPEECH_ENERGY_THRESHOLD) return true;
      }
    }
  }

  /** The non-interruptible variant: keep the queue moving, cut nothing. */
  private async drainWhileSpeaking(): Promise<void> {
    for (;;) {
      const remaining = this.options.session.playbackRemainingMs();
      if (remaining <= 0) return;

      const event = await this.options.session.events.next(
        Math.min(50, Math.max(5, remaining)),
      );
      if (event === null) continue;

      const outcome = this.classify(event);
      if (outcome === 'hangup') return;
      if (outcome === 'media' && event.kind === 'media') this.carriedFrames.push(event.frame);
    }
  }

  private classify(event: CallEvent): 'media' | 'dtmf' | 'hangup' | 'other' {
    switch (event.kind) {
      case 'media':
        return 'media';
      case 'dtmf':
        this.pendingDtmf = event.digit;
        return 'dtmf';
      case 'hangup':
      case 'media_stream_closed':
        if (event.kind === 'hangup') this.callerHungUp = true;
        return event.kind === 'hangup' ? 'hangup' : 'other';
      case 'failed':
        return 'other';
      default:
        return 'other';
    }
  }
}
