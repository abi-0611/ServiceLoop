import { ConversationThreadSchema } from '@serviceloop/shared';
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

      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <Link href="/conversations" className="text-sm text-muted-foreground hover:underline">
            ← Conversations
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">{conversation.title}</h1>
          <p className="text-sm text-muted-foreground">
            {conversation.addressMasked} · {conversation.kind.toLowerCase().replace('_', ' ')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {conversation.serviceConsent === 'REVOKED' && <Badge tone="danger">Opted out</Badge>}
          {conversation.serviceConsent === 'GRANTED' && <Badge tone="success">Consented</Badge>}
          {conversation.serviceConsent === null && <Badge tone="warn">No consent on record</Badge>}
          <WindowCountdown
            expiresAt={conversation.windowExpiresAt}
            open={conversation.windowOpen}
          />
        </div>
      </div>

      {openDraftIds.length > 0 && (
        <Card className="border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {openDraftIds.length === 1 ? 'A job-card draft from this thread is' : `${openDraftIds.length} job-card drafts from this thread are`}{' '}
          waiting for confirmation.{' '}
          <Link href={`/intake/${openDraftIds[0] as string}`} className="font-semibold underline">
            Review it
          </Link>
        </Card>
      )}

      <Card className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto p-4" data-testid="thread">
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has been said on this thread yet.</p>
        ) : (
          messages.map((message) => <MessageBubble key={message.id} message={message} />)
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
