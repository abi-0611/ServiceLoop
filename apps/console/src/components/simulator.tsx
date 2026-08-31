'use client';

import {
  ConversationThreadSchema,
  SandboxInjectResponseSchema,
  type ConversationThread,
  type SandboxInjectResponse,
  type SandboxPersona,
} from '@serviceloop/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageBubble } from '@/components/message-bubble';
import { Badge, Button, Card, Input, Select } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * The simulator's client half.
 *
 * Three panes, because three questions get asked constantly during development:
 * *who am I* (persona), *what does the customer see* (thread), and *why did that
 * happen* (trace). The trace is the one that earns its place — "the reply never
 * arrived" and "the reply was blocked at the consent gate because SERVICE is
 * REVOKED" are indistinguishable in a chat window.
 */
export function Simulator({
  personas,
  staffGroupId,
}: {
  personas: readonly SandboxPersona[];
  staffGroupId: string | null;
}): React.JSX.Element {
  const [personaId, setPersonaId] = useState(personas[0]?.id ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thread, setThread] = useState<ConversationThread | null>(null);
  const [trace, setTrace] = useState<SandboxInjectResponse['trace']>([]);
  const [lastResult, setLastResult] = useState<SandboxInjectResponse | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const persona = personas.find((candidate) => candidate.id === personaId);

  const loadThread = useCallback(async (conversationId: string): Promise<void> => {
    const response = await fetch(`/api/conversations/${conversationId}`);
    if (!response.ok) return;
    setThread(ConversationThreadSchema.parse(await response.json()));
  }, []);

  // Switching persona switches thread: the staff group and a customer line are
  // different conversations, and showing the wrong one is how you spend twenty
  // minutes wondering why a message "vanished".
  useEffect(() => {
    setThread(null);
    setTrace([]);
    setLastResult(null);
  }, [personaId]);

  async function inject(body: Record<string, unknown>): Promise<void> {
    if (persona === undefined) return;
    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/sandbox/inject', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ personaId: persona.id, ...body }),
      });

      if (!response.ok) {
        const problem = (await response.json()) as { detail?: string };
        setError(problem.detail ?? 'The injection was refused.');
        return;
      }

      const result = SandboxInjectResponseSchema.parse(await response.json());
      setLastResult(result);
      setTrace(result.trace);
      if (result.conversationId !== null) await loadThread(result.conversationId);
    } catch {
      setError('Could not reach the API.');
    } finally {
      setBusy(false);
    }
  }

  async function sendFile(file: File): Promise<void> {
    const base64 = await toBase64(file);
    const isAudio = file.type.startsWith('audio/');

    await inject({
      kind: isAudio ? 'audio' : 'image',
      mediaBase64: base64,
      contentType: file.type.length > 0 ? file.type : 'application/octet-stream',
      filename: file.name,
      // The trigger caption is what turns a photo into an intake on a customer
      // line; from the staff group it is optional but harmless.
      ...(isAudio ? {} : { caption: text.trim().length > 0 ? text.trim() : '#jobcard' }),
    });
    setText('');
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-3">
        <Card className="p-3">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="persona">
            Acting as
          </label>
          <Select
            id="persona"
            value={personaId}
            data-testid="persona-picker"
            onChange={(event) => setPersonaId(event.target.value)}
          >
            {personas.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.kind === 'STAFF' ? '🔧 ' : '👤 '}
                {candidate.label}
                {candidate.vehicle !== null ? ` · ${candidate.vehicle}` : ''}
              </option>
            ))}
          </Select>
          {persona?.kind === 'STAFF' && (
            <p className="mt-2 text-xs text-muted-foreground">
              {staffGroupId === null
                ? 'No staff group is configured, so this technician writes on their own line.'
                : 'Writing in the workshop evidence group — a photo here is a job-card intake with or without a caption.'}
            </p>
          )}
        </Card>

        <Card
          className="flex h-[52vh] flex-col gap-3 overflow-y-auto p-4"
          data-testid="simulator-thread"
        >
          {thread === null ? (
            <p className="text-sm text-muted-foreground">
              Send something to open this persona&apos;s thread.
            </p>
          ) : (
            thread.messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))
          )}
        </Card>

        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = text.trim();
            if (trimmed.length === 0) return;
            void inject({ kind: 'text', text: trimmed }).then(() => setText(''));
          }}
        >
          <Input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Type as this persona…"
            aria-label="Message to send as this persona"
            data-testid="simulator-input"
            disabled={busy}
            className="min-w-[12rem] flex-1"
          />
          <Button type="submit" disabled={busy} data-testid="simulator-send">
            Send
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            data-testid="simulator-attach"
            onClick={() => fileInput.current?.click()}
          >
            Photo / voice
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*,audio/*"
            className="hidden"
            data-testid="simulator-file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void sendFile(file);
              event.target.value = '';
            }}
          />
        </form>

        {lastResult !== null && lastResult.replies.length > 0 && (
          <div className="flex flex-wrap gap-2" data-testid="simulator-buttons">
            {interactiveButtons(thread).map((button) => (
              <Button
                key={button.id}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void inject({
                    kind: 'button_reply',
                    replyId: button.id,
                    replyTitle: button.title,
                  })
                }
              >
                Tap “{button.title}”
              </Button>
            ))}
          </div>
        )}

        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>

      <TracePanel trace={trace} result={lastResult} />
    </div>
  );
}

/**
 * The buttons on the most recent outbound interactive message.
 *
 * Tapping them is how a technician confirms a draft, so the simulator has to
 * offer them — typing the reply id by hand would be testing a different thing
 * from what a phone does.
 */
function interactiveButtons(
  thread: ConversationThread | null,
): readonly { id: string; title: string }[] {
  if (thread === null) return [];

  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message === undefined || message.direction !== 'OUTBOUND') continue;

    const interactive = message.interactive as { buttons?: { id: string; title: string }[] } | null;
    const buttons = interactive?.buttons ?? [];
    if (buttons.length > 0) return buttons;
  }
  return [];
}

function TracePanel({
  trace,
  result,
}: {
  trace: SandboxInjectResponse['trace'];
  result: SandboxInjectResponse | null;
}): React.JSX.Element {
  return (
    <Card className="h-fit p-3" data-testid="trace-panel">
      <p className="mb-2 text-sm font-semibold">Pipeline trace</p>

      {trace.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Send a message to see how it travelled: webhook → media → router → session → intake →
          gate.
        </p>
      ) : (
        <ol className="space-y-2">
          {trace.map((step, index) => (
            <li key={`${step.stage}-${index}`} className="text-xs">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'inline-block h-2 w-2 shrink-0 rounded-full',
                    step.ok ? 'bg-emerald-500' : 'bg-rose-500',
                  )}
                />
                <span className="font-semibold uppercase tracking-wide">{step.stage}</span>
              </div>
              <p className="ml-4 text-muted-foreground">{step.detail}</p>
            </li>
          ))}
        </ol>
      )}

      {result !== null && (
        <div className="mt-3 space-y-1 border-t border-border pt-3 text-xs">
          {result.duplicate && <Badge tone="warn">Duplicate — already processed</Badge>}
          {result.conversationId !== null && (
            <p>
              Thread{' '}
              <a
                className="underline"
                data-testid="trace-conversation"
                data-conversation-id={result.conversationId}
                href={`/conversations/${result.conversationId}`}
              >
                {result.conversationId.slice(0, 8)}…
              </a>
            </p>
          )}
          {result.draftId !== null && (
            <p>
              Draft{' '}
              <a className="underline" href={`/intake/${result.draftId}`}>
                {result.draftId.slice(0, 8)}…
              </a>
            </p>
          )}
          {result.jobCardId !== null && (
            <p>
              Job card{' '}
              <a className="underline" href={`/board/${result.jobCardId}`}>
                {result.jobCardId.slice(0, 8)}…
              </a>
            </p>
          )}
          {result.replies.map((reply) => (
            <p key={reply.messageId} data-testid="trace-reply">
              Reply: <span className="font-semibold">{reply.status}</span>
              {reply.reason !== null && ` — ${reply.reason}`}
            </p>
          ))}
        </div>
      )}
    </Card>
  );
}

async function toBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  // Chunked rather than spread: a 5 MB photo would blow the argument limit.
  for (let index = 0; index < bytes.length; index += 8192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  }
  return btoa(binary);
}
