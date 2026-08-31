'use client';

import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/primitives';

/**
 * The WhatsApp 24-hour customer-service window, as a live countdown.
 *
 * It ticks client-side because the number an advisor is reading has to be the
 * number that is true *now* — a server-rendered "4h left" that is really 40
 * minutes is worse than no number, since the whole point is deciding whether
 * there is time to write freely or whether this needs a template.
 */
export function WindowCountdown({
  expiresAt,
  open,
}: {
  expiresAt: string | null;
  open: boolean;
}): React.JSX.Element {
  const [remaining, setRemaining] = useState<number | null>(() => remainingMs(expiresAt));

  useEffect(() => {
    if (expiresAt === null) return;
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
      <Badge tone="neutral" title={`Window closed at ${new Date(expiresAt).toLocaleString()}`}>
        Window closed
      </Badge>
    );
  }

  // Under an hour is when it starts to matter, so that is when it turns amber.
  return (
    <Badge
      tone={left < 60 * 60 * 1000 ? 'warn' : 'success'}
      title={`Free-form replies allowed until ${new Date(expiresAt).toLocaleString()}`}
      data-testid="window-countdown"
    >
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
