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
          'max-w-[85%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed shadow-sm sm:max-w-[70%]',
          'transition-transform duration-200 ease-swift hover:-translate-y-px',
          outbound
            ? // Flat ink, not a gradient. The thread is a transcript of what a
              // shop said to a customer, and a decorated bubble makes an
              // advisor read the decoration before the sentence.
              'rounded-br-sm bg-primary text-primary-foreground'
            : 'rounded-bl-sm bg-muted text-foreground ring-1 ring-inset ring-border/60',
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
                className="rounded-full border border-current px-2 py-0.5 text-xs opacity-60"
              >
                {button.title}
              </span>
            ))}
          </div>
        )}

        {interactive?.replyId !== undefined && (
          <p className="mt-1 text-xs opacity-80">tapped “{interactive.title ?? ''}”</p>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] opacity-80">
          <time dateTime={message.createdAt} className="font-mono">
            {new Date(message.sentAt ?? message.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>

          {message.templateName !== null && (
            <span className="font-mono">template: {message.templateName}</span>
          )}
          {outbound && !blocked && (
            // READ is the only tick worth a colour — it is the one that answers
            // "did the customer actually see the estimate?".
            <span className={cn(message.status === 'READ' && 'opacity-100')}>
              {TICKS[message.status] ?? ''}
            </span>
          )}
          {message.isHumanReply && (
            <span className="rounded-full bg-black/10 px-1.5 py-px dark:bg-white/10">advisor</span>
          )}
          {message.createdByAgent && (
            <span className="rounded-full bg-black/10 px-1.5 py-px dark:bg-white/10">agent</span>
          )}
        </div>

        {blocked && (
          <p className="mt-2 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive">
            Blocked ({message.blockedCode}): {message.blockedReason}
          </p>
        )}

        {held && (
          <p className="mt-2 rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-900 dark:bg-amber-500/20 dark:text-amber-100">
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
      {/* Outline, not filled: this chip sits inside a message bubble whose
          ground is the primary ink on outbound, and a filled neutral badge
          there reads as a hole punched in the bubble. */}
      <Badge tone="outline" className="border-current text-current">
        {media.kind}
      </Badge>
      {media.contentType}
    </a>
  );
}
