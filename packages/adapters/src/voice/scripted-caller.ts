import type { DtmfDigit, Language } from '@serviceloop/shared';
import { INTERNAL_SAMPLE_RATE, concatFrames, toFrames, type AudioFrame } from '../telephony/audio';
import type { LoopbackHandset } from '../telephony/loopback-adapter';
import { decodeUtterances, utteranceFrames } from '../speech/mock-streaming-adapter';

/**
 * `ScriptedCaller` — the person on the other end of the line (phase 5.1/5.8).
 *
 * The voice runtime blocks: it speaks, then waits for the caller. Nothing above
 * it can drive a call by calling methods in order, because the caller's turn
 * only exists in the gap the runtime is sitting in. So a call needs *two*
 * concurrent parties, and this is the second one — a customer as a script of
 * things a person does, run against `LoopbackHandset` while the runner runs.
 *
 * It is what the phase-5 tests, the voice persona suite and `demo:phase5` all
 * use, and it is deliberately the same object in each: a persona proven in CI
 * is a persona the demo actually plays back.
 *
 * Three rules shape the loop, and each of them is about *timing*, which is the
 * only thing a telephone adds to a conversation:
 *
 *   - **A turn is taken when the agent stops talking**, which is
 *     `remainingMs() === 0` after something was heard — not when the frame
 *     queue empties. A handset that answered the moment it had finished
 *     *fetching* audio would answer while the customer was still listening.
 *   - **A barge-in is taken while the agent is still talking.** That is the
 *     whole point of the action, so it is timed off milliseconds of agent audio
 *     delivered rather than off the turn boundary.
 *   - **Silence is an action.** A customer who says nothing is exercising the
 *     no-input path, and the only way to express it is to let the runtime's own
 *     wait expire.
 */

export type CallerAction =
  | {
      readonly kind: 'say';
      readonly text: string;
      readonly language?: Language;
      /** Below the shop's floor, this drives the phase-5.5 degradation path. */
      readonly confidence?: number;
    }
  | { readonly kind: 'press'; readonly digit: DtmfDigit }
  | {
      /** Speaks over the agent. `afterMs` of agent audio go by first. */
      readonly kind: 'bargeIn';
      readonly text: string;
      readonly language?: Language;
      readonly confidence?: number;
      readonly afterMs?: number;
    }
  /** Says nothing at all this turn, and lets the runtime's wait expire. */
  | { readonly kind: 'silence' }
  /**
   * Audio the recogniser cannot read: a workshop, a bad line, a dialect.
   *
   * Produced as real frames with no fixture marker, so the mock adapter reaches
   * its unintelligible branch exactly as it would on a noisy call.
   */
  | { readonly kind: 'noise'; readonly durationMs?: number }
  | { readonly kind: 'hangUp'; readonly reason?: string };

export interface CallerOptions {
  readonly language?: Language;
  readonly frameMs?: number;
  /** How often the handset checks the line. A person is not this patient. */
  readonly pollMs?: number;
  /**
   * Quiet time on the line before the caller answers.
   *
   * An agent turn is several *utterances* — the disclosure, the notice, the
   * context, the ask — and the line falls briefly silent between each. A caller
   * that answered on the first of those gaps would press 1 in the middle of the
   * legal disclosure, which is exactly what a person does not do.
   *
   * Measured from the moment the line went quiet, not from the last frame
   * fetched: a handset buffers a whole utterance in one go, so "when did audio
   * last arrive" is the moment the agent *started* talking and is no guide at
   * all to when it stopped.
   *
   * Must stay well under the runtime's endpointing silence, or the caller would
   * be answering a question the runtime had already given up on.
   */
  readonly quietMs?: number;
  /** Gives up if the call neither ends nor asks anything for this long. */
  readonly timeoutMs?: number;
  /** Answers the moment the line rings. False models somebody who does not. */
  readonly autoAnswer?: boolean;
  readonly onHeard?: (text: string) => void;
}

/** What the caller heard and did, in order — the far end's own transcript. */
export interface CallerTranscript {
  readonly heard: readonly string[];
  readonly did: readonly string[];
  /** Actions the script still held when the call ended. */
  readonly unusedActions: number;
  readonly bargeIns: number;
  readonly timedOut: boolean;
}

const NOISE_FRAME_MS = 20;

export class ScriptedCaller {
  private readonly heard: string[] = [];
  private readonly did: string[] = [];
  private readonly remaining: CallerAction[];
  private bargeIns = 0;

  constructor(
    private readonly handset: LoopbackHandset,
    actions: readonly CallerAction[],
    private readonly options: CallerOptions = {},
  ) {
    this.remaining = [...actions];
  }

  /** Everything the agent has said so far. Safe to read while `run` is running. */
  get heardSoFar(): readonly string[] {
    return this.heard;
  }

  async run(): Promise<CallerTranscript> {
    const pollMs = this.options.pollMs ?? 4;
    const quietMs = this.options.quietMs ?? 150;
    const deadline = Date.now() + (this.options.timeoutMs ?? 30_000);
    const autoAnswer = this.options.autoAnswer ?? true;

    /** Agent audio delivered since the caller last took a turn. */
    let sinceTurnMs = 0;
    let heardThisTurn = false;
    /** When the line last went quiet, or null while the agent is talking. */
    let silentSince: number | null = null;
    let timedOut = false;

    for (;;) {
      if (this.handset.isEnded()) break;
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }

      if (autoAnswer && !this.handset.isAnswered()) {
        this.handset.answer();
        this.did.push('answered');
      }

      const frames = this.handset.pullAgentAudio();
      if (frames.length > 0) {
        sinceTurnMs += frames.reduce((total, frame) => total + frame.durationMs, 0);
        for (const said of decodeUtterances(concatFrames(frames))) {
          heardThisTurn = true;
          this.heard.push(said.text);
          this.options.onHeard?.(said.text);
        }
      }

      const remaining = this.handset.remainingMs();
      if (remaining > 0) silentSince = null;
      else silentSince ??= Date.now();

      const next = this.remaining[0];
      if (next === undefined) {
        // Nothing left to do. Stay on the line rather than hanging up: a script
        // that has run out is a customer waiting to be told the call is over,
        // and hanging up here would turn every completed flow into
        // `CUSTOMER_HUNG_UP`.
        await sleep(pollMs);
        continue;
      }

      if (next.kind === 'bargeIn') {
        // Timed off audio *delivered*, not off the turn boundary — the action
        // only means anything while the agent is mid-sentence.
        if (sinceTurnMs < (next.afterMs ?? 200) || remaining <= 0) {
          await sleep(pollMs);
          continue;
        }
      } else if (
        !heardThisTurn ||
        silentSince === null ||
        Date.now() - silentSince < quietMs
      ) {
        await sleep(pollMs);
        continue;
      }

      this.remaining.shift();
      this.act(next);
      sinceTurnMs = 0;
      heardThisTurn = false;
      silentSince = null;
    }

    return {
      heard: [...this.heard],
      did: [...this.did],
      unusedActions: this.remaining.length,
      bargeIns: this.bargeIns,
      timedOut,
    };
  }

  private act(action: CallerAction): void {
    const language = this.options.language ?? 'en';
    const frameMs = this.options.frameMs ?? 20;

    switch (action.kind) {
      case 'say':
      case 'bargeIn': {
        if (action.kind === 'bargeIn') this.bargeIns += 1;
        this.handset.speak(
          utteranceFrames(
            {
              text: action.text,
              language: action.language ?? language,
              ...(action.confidence === undefined ? {} : { confidence: action.confidence }),
            },
            frameMs,
          ),
        );
        this.did.push(`${action.kind}: ${action.text}`);
        return;
      }

      case 'press':
        this.handset.press(action.digit);
        this.did.push(`pressed ${action.digit}`);
        return;

      case 'silence':
        this.did.push('said nothing');
        return;

      case 'noise':
        this.handset.speak(noiseFrames(action.durationMs ?? 900, frameMs));
        this.did.push('made an unintelligible noise');
        return;

      case 'hangUp':
        this.handset.hangUp(action.reason ?? 'The caller hung up');
        this.did.push('hung up');
        return;
    }
  }
}

/**
 * Audio with no fixture marker in it.
 *
 * White-ish noise rather than silence, and loud enough to clear the turn
 * manager's speech-energy threshold: the point of this action is that the
 * caller *did* speak and the recogniser could not read it, which is a different
 * path from a caller who said nothing.
 */
export function noiseFrames(durationMs: number, frameMs = NOISE_FRAME_MS): AudioFrame[] {
  const totalSamples = Math.max(1, Math.round((durationMs / 1000) * INTERNAL_SAMPLE_RATE));
  const pcm = Buffer.alloc(totalSamples * 2);

  // Deterministic rather than random: a noise fixture that differs between runs
  // is a degradation test that passes on Tuesday.
  let seed = 0x2f6e2b1;
  for (let index = 0; index < totalSamples; index += 1) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    pcm.writeInt16LE((seed % 16_000) - 8_000, index * 2);
  }

  return toFrames(pcm, { frameMs });
}

/**
 * The caller's poll tick.
 *
 * Deliberately *not* `unref`'d. A pending poll is the far end of a live
 * telephone call waiting for its turn, which is real work — and an unref'd
 * timer lets a plain `tsx` script exit mid-call with a zero status and no
 * output, which is how a simulator run silently stops after its first persona.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
