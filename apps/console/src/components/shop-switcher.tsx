'use client';

import type { SessionShop } from '@serviceloop/shared';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Select } from '@/components/ui/primitives';

/**
 * Shop switcher for multi-shop owners. Switching re-issues the access token
 * server-side; the console never picks its own tenant.
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
      <span className="rounded-md bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
        {only?.name ?? 'No shop'}
      </span>
    );
  }

  return (
    <Select
      aria-label="Active shop"
      className="h-9 w-auto text-sm"
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
