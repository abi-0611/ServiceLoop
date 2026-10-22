'use client';

import type { SessionShop } from '@serviceloop/shared';
import { Building2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Select } from '@/components/ui/primitives';

/**
 * Shop switcher for multi-shop owners. Switching re-issues the access token
 * server-side; the console never picks its own tenant.
 *
 * A single-shop staff member gets a label rather than a disabled control: the
 * question "which shop am I in?" still deserves an answer on a screen full of
 * other shops' vocabulary, but offering a choice of one is a control that only
 * teaches people it does nothing.
 */
export function ShopSwitcher({
  shops,
  activeShopId,
}: {
  shops: readonly SessionShop[];
  activeShopId: string;
}): React.JSX.Element | null {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (shops.length <= 1) {
    const only = shops[0];
    return (
      <span className="inline-flex max-w-[9rem] items-center gap-1.5 rounded-md bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground sm:max-w-none">
        <Building2 className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{only?.name ?? 'No shop'}</span>
      </span>
    );
  }

  return (
    <Select
      aria-label="Active shop"
      className="h-9 w-auto max-w-[11rem] py-0 text-sm"
      value={activeShopId}
      disabled={busy}
      onChange={async (event) => {
        setBusy(true);
        await fetch('/api/session/switch-shop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shopId: event.target.value }),
        });
        router.refresh();
        setBusy(false);
      }}
    >
      {shops.map((shop) => (
        <option key={shop.id} value={shop.id}>
          {shop.name} · {shop.city}
        </option>
      ))}
    </Select>
  );
}
