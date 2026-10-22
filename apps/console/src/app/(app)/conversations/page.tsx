import { ConversationListSchema, type ConversationSummary } from '@serviceloop/shared';
import { MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { SpotlightArea } from '@/components/ui/spotlight';
import { spotlightProps } from '@/lib/spotlight';
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
 *
 * An unread thread carries a filled left edge rather than only a count badge.
 * The count answers "how many"; the edge answers "which ones", which is the
 * question somebody scanning forty rows is actually asking.
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
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workshop"
        title="Conversations"
        description="Every customer thread, plus the workshop floor group."
        actions={
          list.unreadTotal > 0 ? (
            <span
              data-testid="unread-total"
              className="inline-flex items-center gap-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm font-medium text-sky-900 shadow-xs dark:border-sky-400/30 dark:bg-sky-500/10 dark:text-sky-300"
            >
              <span className="relative flex size-2">
                <span className="ping-dot absolute inset-0 rounded-full opacity-70" />
                <span className="relative size-2 rounded-full bg-current" />
              </span>
              {list.unreadTotal} unread
            </span>
          ) : undefined
        }
      />

      {list.threads.length === 0 ? (
        <EmptyState
          icon={<MessageSquare />}
          title="No conversations yet"
          description="Open the sandbox simulator and send yourself a message as any seeded customer — it travels the same webhook path a real WhatsApp message would."
        />
      ) : (
        <SpotlightArea>
          <ul data-testid="thread-list" className="space-y-2.5">
            {list.threads.map((thread, index) => (
              <li
                key={thread.id}
                className="animate-enter-fast"
                style={{ '--i': index } as React.CSSProperties}
              >
                <ThreadRow thread={thread} />
              </li>
            ))}
          </ul>
        </SpotlightArea>
      )}
    </div>
  );
}

function ThreadRow({ thread }: { thread: ConversationSummary }): React.JSX.Element {
  const unread = thread.unreadCount > 0;

  return (
    <Link
      href={`/conversations/${thread.id}`}
      className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card
        {...spotlightProps}
        className="spotlight sheen lift overflow-hidden p-4 pl-5 hover:border-foreground/25 hover:shadow-md"
      >
        {/* The unread edge. Absolute so it never shifts the row's text. */}
        {unread && (
          <span
            aria-hidden="true"
            className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-primary"
          />
        )}

        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
            >
              {initials(thread.title)}
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{thread.title}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                <span className="font-mono">{thread.addressMasked}</span> ·{' '}
                {LANGUAGE_LABEL[thread.language] ?? thread.language}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {unread && <Badge tone="brand">{thread.unreadCount} new</Badge>}
            {thread.humanOverrideAt !== null && <Badge tone="warn">Human replied</Badge>}
            {thread.serviceConsent === 'REVOKED' && <Badge tone="danger">Opted out</Badge>}
            {thread.serviceConsent === 'GRANTED' && <Badge tone="success">Consented</Badge>}
            {thread.kind === 'UNKNOWN' && <Badge tone="warn">Unidentified</Badge>}
            <WindowCountdown expiresAt={thread.windowExpiresAt} open={thread.windowOpen} />
          </div>
        </div>

        {thread.lastMessagePreview.length > 0 && (
          <p className="mt-2.5 truncate pl-12 text-sm text-muted-foreground">
            <span
              aria-hidden="true"
              className="mr-1 font-mono text-xs text-muted-foreground/70"
            >
              {thread.lastMessageDirection === 'OUTBOUND' ? '→' : '←'}
            </span>
            {thread.lastMessagePreview}
          </p>
        )}
      </Card>
    </Link>
  );
}

function initials(title: string): string {
  const parts = title.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}
