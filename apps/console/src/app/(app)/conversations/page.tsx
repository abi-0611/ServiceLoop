import { ConversationListSchema, type ConversationSummary } from '@serviceloop/shared';
import Link from 'next/link';
import { Badge, Card, EmptyState } from '@/components/ui/primitives';
import { serverApiFetch } from '@/lib/api';
import { WindowCountdown } from '@/components/window-countdown';

/**
 * Conversations inbox (phase 2.10).
 *
 * The three things an advisor needs at a glance are all here: who is waiting
 * (unread), how long the shop can still speak freely (the 24-hour window), and
 * whether the customer has agreed to be messaged at all. A thread whose window
 * has closed is not a broken thread — it is one where only an approved template
 * will go out — so it is labelled rather than hidden.
 */
export const dynamic = 'force-dynamic';

const LANGUAGE_LABEL: Readonly<Record<string, string>> = {
  en: 'English',
  ta: 'தமிழ்',
  hi: 'हिन्दी',
};

export default async function ConversationsPage(): Promise<React.JSX.Element> {
  const list = await serverApiFetch('/conversations', ConversationListSchema);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Conversations</h1>
          <p className="text-sm text-muted-foreground">
            Every customer thread, plus the workshop floor group.
          </p>
        </div>
        {list.unreadTotal > 0 && (
          <Badge tone="info" data-testid="unread-total">
            {list.unreadTotal} unread
          </Badge>
        )}
      </div>

      {list.threads.length === 0 ? (
        <EmptyState
          title="No conversations yet"
          description="Open the sandbox simulator and send yourself a message as any seeded customer — it travels the same webhook path a real WhatsApp message would."
        />
      ) : (
        <ul data-testid="thread-list" className="space-y-2">
          {list.threads.map((thread) => (
            <li key={thread.id}>
              <ThreadRow thread={thread} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ThreadRow({ thread }: { thread: ConversationSummary }): React.JSX.Element {
  return (
    <Link href={`/conversations/${thread.id}`} className="block">
      <Card className="p-4 transition-colors hover:bg-accent/40">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{thread.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              {thread.addressMasked} · {LANGUAGE_LABEL[thread.language] ?? thread.language}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {thread.unreadCount > 0 && <Badge tone="info">{thread.unreadCount} new</Badge>}
            {thread.humanOverrideAt !== null && <Badge tone="warn">Human replied</Badge>}
            {thread.serviceConsent === 'REVOKED' && <Badge tone="danger">Opted out</Badge>}
            {thread.serviceConsent === 'GRANTED' && <Badge tone="success">Consented</Badge>}
            {thread.kind === 'UNKNOWN' && <Badge tone="warn">Unidentified</Badge>}
            <WindowCountdown expiresAt={thread.windowExpiresAt} open={thread.windowOpen} />
          </div>
        </div>

        {thread.lastMessagePreview.length > 0 && (
          <p className="mt-2 truncate text-sm text-muted-foreground">
            {thread.lastMessageDirection === 'OUTBOUND' ? '→ ' : '← '}
            {thread.lastMessagePreview}
          </p>
        )}
      </Card>
    </Link>
  );
}
