'use client';

import {
  DTMF_DIGITS,
  SoftphonePollResponseSchema,
  SoftphoneStateSchema,
  type SoftphoneCall,
  type SoftphonePollResponse,
  type SoftphoneState,
  type SoftphoneTurn,
} from '@serviceloop/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Input, Select } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * The softphone (phase 5.1).
 *
 * The browser is the *customer's handset*. Everything on this page is something
 * a person can do with a telephone — pick up, say a sentence, press a key, talk
 * over the agent, hang up — and every one of them travels the same
 * `TelephonyPort` an Exotel call would. There is no back door: the words a
 * customer "says" are encoded into real PCM frames and decoded back out by the
 * recogniser, which is what makes a flow developed here a flow that works on a
 * telephone.
 *
 * The layout answers the three questions asked constantly while building a
 * voice flow: *who is on the line* (the call header), *what did the agent say*
 * (the transcript), and *what can the customer do about it* (the keypad and the
 * say box). The screen-pop is the fourth, and it only appears when it matters —
 * the moment the agent bridges to a person.
 *
 * Audio is played rather than only read. The poll returns the PCM the line
 * delivered; `AudioContext` plays it. A page that showed the words without
 * playing them would let a developer ship a call that is unlistenable.
 */

const POLL_MS = 400;

export function Softphone({ initial }: { initial: SoftphoneState }): React.JSX.Element {
  const [state, setState] = useState<SoftphoneState>(initial);
  const [personaId, setPersonaId] = useState(initial.personas[0]?.id ?? '');
  const [call, setCall] = useState<SoftphoneCall | null>(null);
  const [turns, setTurns] = useState<SoftphoneTurn[]>([]);
  const [screenPop, setScreenPop] = useState<SoftphonePollResponse['screenPop']>(null);
  const [utterance, setUtterance] = useState('');
  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const cursor = useRef(0);
  const audio = useRef<AudioContext | null>(null);
  const playAt = useRef(0);

  const callId = call?.callId ?? null;
  const live = call !== null && call.endedAt === null;

  /* ------------------------------------------------------------- the line */

  const play = useCallback(
    (base64: string, sampleRate: number): void => {
      if (muted || base64.length === 0) return;

      // Created lazily: a browser refuses an AudioContext until the page has
      // been interacted with, and the first interaction here is always a click.
      audio.current ??= new AudioContext();
      const context = audio.current;

      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      const buffer = context.createBuffer(1, samples.length, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index += 1) {
        channel[index] = (samples[index] ?? 0) / 32_768;
      }

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);

      // Queued end-to-end rather than played on arrival: each poll carries a
      // fragment, and starting every one "now" would overlap them into noise.
      const startAt = Math.max(context.currentTime, playAt.current);
      source.start(startAt);
      playAt.current = startAt + buffer.duration;
    },
    [muted],
  );

  const poll = useCallback(async (): Promise<void> => {
    if (callId === null) return;

    const response = await fetch(
      `/api/voice/softphone/${callId}/poll?cursor=${String(cursor.current)}`,
    );
    if (!response.ok) return;

    const body = SoftphonePollResponseSchema.parse(await response.json());
    cursor.current = body.cursor;
    if (body.call !== null) setCall(body.call);
    if (body.turns.length > 0) setTurns((existing) => [...existing, ...body.turns]);
    if (body.screenPop !== null) setScreenPop(body.screenPop);
    play(body.audioBase64, body.sampleRate);
  }, [callId, play]);

  useEffect(() => {
    if (callId === null) return;
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  }, [callId, poll]);

  /* ---------------------------------------------------------- the actions */

  async function post(path: string, body: unknown = {}): Promise<unknown | null> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/voice/softphone${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? 'The softphone was refused.');
        return null;
      }
      return await response.json();
    } catch {
      setError('Could not reach the API.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  function startedCall(result: unknown): void {
    const parsed = result as {
      call: SoftphoneCall | null;
      refusal: { code: string; reason: string } | null;
    } | null;

    if (parsed === null) return;
    if (parsed.call === null) {
      // A refusal is the interesting outcome, not an error: "the shop is in
      // quiet hours" and "the customer revoked consent" are the two things a
      // developer most needs to see spelled out.
      setError(
        parsed.refusal === null
          ? 'The call was refused.'
          : `${parsed.refusal.code} — ${parsed.refusal.reason}`,
      );
      return;
    }

    cursor.current = 0;
    setTurns([]);
    setScreenPop(null);
    setAnswered(false);
    playAt.current = 0;
    setCall(parsed.call);
  }

  async function refresh(): Promise<void> {
    const response = await fetch('/api/voice/softphone');
    if (response.ok) setState(SoftphoneStateSchema.parse(await response.json()));
  }

  /* ------------------------------------------------------------ rendering */

  if (!state.enabled) {
    return (
      <Card className="p-6">
        <p className="text-sm font-medium">The softphone is not available here.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {state.driver === 'loopback'
            ? 'This shop has not switched voice on. Turn it on in guardrails first — a shop starts with voice off, deliberately.'
            : `This process is wired to ${state.driver}. A softphone that could pick up a real customer's call would be a way to eavesdrop.`}
        </p>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
      <div className="space-y-4">
        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">The handset</h2>
            <Badge tone={state.killSwitch ? 'danger' : 'neutral'}>
              {state.killSwitch ? 'kill switch on' : state.driver}
            </Badge>
          </div>

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">Answer as</span>
            <Select
              data-testid="softphone-persona"
              value={personaId}
              onChange={(event) => setPersonaId(event.target.value)}
            >
              {state.personas.map((persona) => (
                <option key={persona.id} value={persona.id}>
                  {persona.label} · {persona.description}
                </option>
              ))}
            </Select>
          </label>

          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="softphone-ring-customer"
              disabled={busy || live}
              onClick={() => void post('/originate').then(startedCall)}
            >
              Ring the customer
            </Button>
            <Button
              data-testid="softphone-ring-shop"
              variant="secondary"
              disabled={busy || live || personaId.length === 0}
              onClick={() => void post('/inbound', { personaId }).then(startedCall)}
            >
              Ring the shop
            </Button>
          </div>

          {state.killSwitch ? (
            <p className="text-xs text-muted-foreground">
              VOICE_KILL_SWITCH is set: every rung falls back to an advisor task and no call will be
              placed.
            </p>
          ) : null}

          {error === null ? null : (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </Card>

        {call === null ? null : (
          <Card className="space-y-3 p-4">
            <div>
              <p className="text-sm font-semibold">
                {call.customerName ?? call.toMasked}{' '}
                <span className="font-normal text-muted-foreground">
                  · {call.direction.toLowerCase()}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                {call.vehicleLabel ?? 'no vehicle on file'}
                {call.jobCardCode === null ? '' : ` · ${call.jobCardCode}`} · {call.language}
              </p>
            </div>

            <div className="flex flex-wrap gap-2 text-xs">
              <Badge tone={live ? 'success' : 'neutral'}>{call.status}</Badge>
              {call.recording.startedAt === null ? (
                <Badge tone="neutral">not recording</Badge>
              ) : (
                <Badge tone="warn">recording since the notice</Badge>
              )}
              {call.outcome === null ? null : <Badge tone="neutral">{call.outcome}</Badge>}
            </div>

            {!answered && live ? (
              <Button
                data-testid="softphone-answer"
                className="w-full"
                onClick={() =>
                  void post(`/${call.callId}/answer`).then(() => {
                    setAnswered(true);
                  })
                }
              >
                Answer — the phone is ringing
              </Button>
            ) : null}

            {answered && live ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {DTMF_DIGITS.map((digit) => (
                    <Button
                      key={digit}
                      data-testid={`softphone-key-${digit}`}
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void post(`/${call.callId}/speak`, { dtmf: digit })}
                    >
                      {digit}
                    </Button>
                  ))}
                </div>

                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (utterance.trim().length === 0) return;
                    void post(`/${call.callId}/speak`, { utterance: utterance.trim() }).then(() => {
                      setUtterance('');
                    });
                  }}
                >
                  <Input
                    value={utterance}
                    placeholder="Say something…"
                    onChange={(event) => setUtterance(event.target.value)}
                  />
                  <Button type="submit" disabled={busy}>
                    Say
                  </Button>
                </form>

                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    className="flex-1"
                    onClick={() => setMuted((value) => !value)}
                  >
                    {muted ? 'Unmute' : 'Mute'}
                  </Button>
                  <Button
                    variant="destructive"
                    className="flex-1"
                    disabled={busy}
                    onClick={() =>
                      void post(`/${call.callId}/hangup`).then(() => {
                        void refresh();
                      })
                    }
                  >
                    Hang up
                  </Button>
                </div>
              </>
            ) : null}

            {!live && call.endedAt !== null ? (
              <p className="text-xs text-muted-foreground">
                The call ended: {call.endReason ?? call.outcome ?? 'no reason recorded'}.
              </p>
            ) : null}
          </Card>
        )}
      </div>

      <div className="space-y-4">
        {screenPop === null ? null : (
          <Card className="border-primary/40 bg-primary/5 p-4" data-testid="softphone-screen-pop">
            <p className="text-sm font-semibold">
              Bridged to {screenPop.advisorName ?? 'an advisor'}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Whispered before the legs joined: “{screenPop.whisper}”
            </p>
            {screenPop.jobCardId === null ? null : (
              <a
                className="mt-2 inline-block text-sm font-medium text-primary underline"
                href={`/board/${screenPop.jobCardId}`}
              >
                Open the job card
              </a>
            )}
          </Card>
        )}

        <Card className="p-4" data-testid="softphone-transcript">
          <h2 className="text-sm font-semibold">Transcript</h2>
          <p className="text-xs text-muted-foreground">
            The persisted one, not what the browser happened to hear.
          </p>

          <ol className="mt-3 space-y-2">
            {turns.length === 0 ? (
              <li className="text-sm text-muted-foreground">Nothing has been said yet.</li>
            ) : null}

            {turns.map((turn) => (
              <li
                key={turn.index}
                className={cn(
                  'rounded-md border px-3 py-2 text-sm',
                  turn.role === 'CALLER'
                    ? 'ml-8 border-border bg-muted/40'
                    : 'mr-8 border-border bg-background',
                )}
              >
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{turn.role.toLowerCase()}</span>
                  {turn.mandatory ? <Badge tone="warn">⚿ required</Badge> : null}
                  {turn.bargedIn ? <Badge tone="neutral">cut short</Badge> : null}
                  {turn.latencyMs === null ? null : <span>{turn.latencyMs}ms</span>}
                  {turn.inputMode === 'DTMF' ? <Badge tone="neutral">keypad</Badge> : null}
                </div>
                <p className="mt-1">{turn.text}</p>
              </li>
            ))}
          </ol>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-semibold">Recent calls</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {state.calls.length === 0 ? (
              <li className="text-muted-foreground">No calls yet.</li>
            ) : null}
            {state.calls.map((entry) => (
              <li key={entry.callId} className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">{entry.toMasked}</span>
                <span>{entry.direction.toLowerCase()}</span>
                <Badge tone={entry.status === 'BLOCKED' ? 'danger' : 'neutral'}>
                  {entry.outcome ?? entry.status}
                </Badge>
              </li>
            ))}
          </ul>
          <Button variant="ghost" className="mt-2" onClick={() => void refresh()}>
            Refresh
          </Button>
        </Card>
      </div>
    </div>
  );
}
