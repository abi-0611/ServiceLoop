'use client';

import { useEffect, useState } from 'react';
import { Badge, LiveDot } from '@/components/ui/primitives';

/**
 * The WhatsApp 24-hour customer-service window, as a live countdown.
 *
 * It ticks client-side because the number an advisor is reading has to be the
 * number that is true *now* — a server-rendered "4h left" that is really 40
 * minutes is worse than no number, since the whole point is deciding whether
 * there is time to write freely or whether this needs a template.
 *
 * The exact expiry, in the tooltip, is rendered **only after mount**. The
 * server formats dates in the container's locale and timezone and the browser
 * formats them in the reader's, so a server-rendered `toLocaleString()` and its
 * hydrated replacement disagree — React calls that a hydration mismatch and
 * refuses to patch the attribute, leaving whichever string the server happened
 * to produce. Deferring it means the advisor gets their own clock, which is the
 * only clock that answers "have I still got time to type a reply?".
 */
export function WindowCountdown({
  expiresAt,
  open,
}: {
  expiresAt: string | null;
  open: boolean;
}): React.JSX.Element {
  const [remaining, setRemaining] = useState<number | null>(() => remainingMs(expiresAt));
  const [exact, setExact] = useState<string | null>(null);

  useEffect(() => {
    if (expiresAt === null) return;
    setExact(new Date(expiresAt).toLocaleString());
    const timer = setInterval(() => setRemaining(remainingMs(expiresAt)), 30_000);
    setRemaining(remainingMs(expiresAt));
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (expiresAt === null) {
    return (
      <Badge tone="neutral" title="This thread has never received an inbound message">
        Template only
      </Badge>
    );
  }

  const left = remaining ?? 0;
  if (!open || left <= 0) {
    return (
      <Badge
        tone="neutral"
        {...(exact === null ? {} : { title: `Window closed at ${exact}` })}
      >
        Window closed
      </Badge>
    );
  }

  // Under an hour is when it starts to matter, so that is when it turns amber —
  // and picks up a pulsing dot, because at that point the number is a deadline.
  const urgent = left < 60 * 60 * 1000;

  return (
    <Badge
      tone={urgent ? 'warn' : 'success'}
      {...(exact === null ? {} : { title: `Free-form replies allowed until ${exact}` })}
      data-testid="window-countdown"
    >
      {urgent && <LiveDot />}
      {formatRemaining(left)} left
    </Badge>
  );
}

function remainingMs(expiresAt: string | null): number | null {
  if (expiresAt === null) return null;
  return Math.max(0, new Date(expiresAt).getTime() - Date.now());
}

function formatRemaining(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
