'use client';

import { useEffect, useRef } from 'react';

/**
 * Clears the unread badge once a thread is actually open.
 *
 * Deliberately an explicit call rather than a side effect of the read query:
 * an advisor glancing at a preview in the list has not read the thread, and a
 * badge that clears itself on any page load is a badge nobody trusts. It fires
 * once per mount — `sent` guards React's development double-render.
 */
export function MarkThreadRead({
  conversationId,
  unread,
}: {
  conversationId: string;
  unread: number;
}): null {
  const sent = useRef(false);

  useEffect(() => {
    if (unread === 0 || sent.current) return;
    sent.current = true;
    void fetch(`/api/conversations/${conversationId}/read`, { method: 'POST' }).catch(
      () => undefined,
    );
  }, [conversationId, unread]);

  return null;
}
