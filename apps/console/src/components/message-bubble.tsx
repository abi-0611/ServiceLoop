import type { MessageDto } from '@serviceloop/shared';
import { Badge } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * One message, rendered the way it actually went out.
 *
 * Templates show their rendered copy and their template name; interactive
 * messages show their buttons; and a message the `OutboundGate` refused is
 * shown *in the thread*, struck through, with the reason. Hiding a blocked
 * message would leave an advisor believing the customer was told something they
 * never were — which is exactly the failure mode the gate exists to make
 * visible.
 */

interface InteractivePayload {
  readonly buttons?: readonly { readonly id: string; readonly title: string }[];
  readonly sections?: readonly {
    readonly title: string;
    readonly rows: readonly { readonly id: string; readonly title: string }[];
  }[];
  readonly replyId?: string;
  readonly title?: string;
}

const TICKS: Readonly<Record<string, string>> = {
  QUEUED: '🕗',
  SENT: '✓',
  DELIVERED: '✓✓',
  READ: '✓✓',
};

export function MessageBubble({ message }: { message: MessageDto }): React.JSX.Element {
  const outbound = message.direction === 'OUTBOUND';
  const blocked = message.status === 'BLOCKED';
  const held = message.status === 'QUEUED' && message.scheduledFor !== null;
  const interactive = message.interactive as InteractivePayload | null;

  return (
    <div
      data-testid="message"
      data-direction={message.direction}
      data-status={message.status}
      className={cn('flex w-full', outbound ? 'justify-end' : 'justify-start')}
    >
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3 py-2 text-sm shadow-sm sm:max-w-[70%]',
          outbound
            ? 'rounded-br-sm bg-primary text-primary-foreground'
            : 'rounded-bl-sm bg-muted text-foreground',
          blocked && 'opacity-70 ring-1 ring-destructive',
        )}
      >
        {message.senderName !== null && (
          <p className="mb-1 text-xs font-semibold opacity-80">{message.senderName}</p>
        )}

        {message.media !== null && (
          <MediaPreview media={message.media} caption={message.body} />
        )}

        {message.body.length > 0 && (
          <p className={cn('whitespace-pre-wrap break-words', blocked && 'line-through')}>
            {message.body}
          </p>
        )}

        {interactive?.buttons !== undefined && interactive.buttons.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {interactive.buttons.map((button) => (
              <span
                key={button.id}
                className="rounded-full border border-current/30 px-2 py-0.5 text-xs opacity-90"
              >
                {button.title}
              </span>
            ))}
          </div>
        )}

        {interactive?.replyId !== undefined && (
          <p className="mt-1 text-xs opacity-80">tapped “{interactive.title ?? ''}”</p>
        )}

        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] opacity-80">
          <time dateTime={message.createdAt}>
            {new Date(message.sentAt ?? message.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>

          {message.templateName !== null && <span>template: {message.templateName}</span>}
          {outbound && !blocked && <span>{TICKS[message.status] ?? ''}</span>}
          {message.isHumanReply && <span>advisor</span>}
          {message.createdByAgent && <span>agent</span>}
        </div>

        {blocked && (
          <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
            Blocked ({message.blockedCode}): {message.blockedReason}
          </p>
        )}

        {held && (
          <p className="mt-2 rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-900">
            Held for quiet hours until{' '}
            {new Date(message.scheduledFor as string).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}

function MediaPreview({
  media,
  caption,
}: {
  media: NonNullable<MessageDto['media']>;
  caption: string;
}): React.JSX.Element {
  if (media.kind === 'PHOTO') {
    return (
      // Deliberately a plain <img>: the bytes come from our own authenticated
      // proxy, and next/image would try to optimise a URL it cannot fetch.
      <img
        src={`/api${media.thumbnailUrl ?? media.url}`}
        alt={caption.length > 0 ? caption : 'Photo from the customer'}
        className="mb-2 max-h-64 rounded-lg border border-border object-cover"
        loading="lazy"
      />
    );
  }

  if (media.kind === 'AUDIO') {
    return (
      <audio controls src={`/api${media.url}`} className="mb-2 w-full">
        <track kind="captions" />
      </audio>
    );
  }

  return (
    <a
      href={`/api${media.url}`}
      className="mb-2 inline-flex items-center gap-2 underline"
      target="_blank"
      rel="noreferrer"
    >
      <Badge tone="neutral">{media.kind}</Badge>
      {media.contentType}
    </a>
  );
}
