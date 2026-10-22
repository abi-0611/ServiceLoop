import { ConversationThreadSchema } from '@serviceloop/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MessageBubble } from '@/components/message-bubble';
import { ReplyBox } from '@/components/reply-box';
import { WindowCountdown } from '@/components/window-countdown';
import { Badge, Card } from '@/components/ui/primitives';
import { ApiError, serverApiFetch } from '@/lib/api';
import { MarkThreadRead } from '@/components/mark-thread-read';

export const dynamic = 'force-dynamic';

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;

  let thread;
  try {
    thread = await serverApiFetch(`/conversations/${id}`, ConversationThreadSchema);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const { conversation, messages, openDraftIds } = thread;

  return (
    <div className="space-y-4">
      <MarkThreadRead conversationId={conversation.id} unread={conversation.unreadCount} />

      <div className="animate-enter">
        <Link
          href="/conversations"
          className="group inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft
            className="size-4 transition-transform duration-200 ease-swift group-hover:-translate-x-0.5"
            aria-hidden="true"
          />
          Conversations
        </Link>

        {/* Consent and the 24-hour window sit level with the name because they
            are preconditions on the reply box below, not metadata about it. */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-md border border-border bg-card p-4 shadow-sm">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold text-muted-foreground"
            >
              {conversation.title.trim().charAt(0).toUpperCase() || '—'}
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold tracking-tight">
                {conversation.title}
              </h1>
              <p className="truncate text-sm text-muted-foreground">
                <span className="font-mono">{conversation.addressMasked}</span> ·{' '}
                {conversation.kind.toLowerCase().replace('_', ' ')}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {conversation.serviceConsent === 'REVOKED' && <Badge tone="danger">Opted out</Badge>}
            {conversation.serviceConsent === 'GRANTED' && <Badge tone="success">Consented</Badge>}
            {conversation.serviceConsent === null && (
              <Badge tone="warn">No consent on record</Badge>
            )}
            <WindowCountdown
              expiresAt={conversation.windowExpiresAt}
              open={conversation.windowOpen}
            />
          </div>
        </div>
      </div>

      {openDraftIds.length > 0 && (
        <Card className="border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400/35 dark:bg-amber-500/10 dark:text-amber-200">
          {openDraftIds.length === 1 ? 'A job-card draft from this thread is' : `${openDraftIds.length} job-card drafts from this thread are`}{' '}
          waiting for confirmation.{' '}
          <Link href={`/intake/${openDraftIds[0] as string}`} className="font-semibold underline">
            Review it
          </Link>
        </Card>
      )}

      {/* The faint rule behind the thread does the job WhatsApp's wallpaper
          does: it separates "the conversation" from "the console around it"
          without adding another border. */}
      <Card
        className="animate-enter relative flex max-h-[60vh] flex-col gap-3 overflow-y-auto p-4"
        data-testid="thread"
      >
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:18px_18px]"
          aria-hidden="true"
        />
        {messages.length === 0 ? (
          <p className="relative text-sm text-muted-foreground">
            Nothing has been said on this thread yet.
          </p>
        ) : (
          messages.map((message, index) => (
            <div
              key={message.id}
              className="animate-enter-fast relative"
              style={{ '--i': Math.min(index, 12) } as React.CSSProperties}
            >
              <MessageBubble message={message} />
            </div>
          ))
        )}
      </Card>

      {conversation.kind === 'STAFF_GROUP' ? (
        <p className="text-sm text-muted-foreground">
          This is the technician evidence group. Messages here are internal and are not sent to
          customers.
        </p>
      ) : (
        <ReplyBox conversationId={conversation.id} windowOpen={conversation.windowOpen} />
      )}
    </div>
  );
}
