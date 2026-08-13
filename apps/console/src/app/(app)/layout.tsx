import { SessionSchema } from '@serviceloop/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import type { z } from 'zod';
import { ShopSwitcher } from '@/components/shop-switcher';
import { ApiError, isSignedIn, serverApiFetch } from '@/lib/api';

const MeSchema = SessionSchema.shape.staff.extend({ shops: SessionSchema.shape.shops });

const NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: '/board', label: 'Job cards' },
  { href: '/conversations', label: 'Conversations' },
  { href: '/settings/guardrails', label: 'Guardrails' },
];

export default async function AppLayout({
  children,
}: {
  children: ReactNode;
}): Promise<React.JSX.Element> {
  if (!(await isSignedIn())) redirect('/login');

  let me: z.infer<typeof MeSchema>;
  try {
    me = await serverApiFetch('/auth/me', MeSchema);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect('/login');
    throw error;
  }

  const activeShop = me.shops.find((shop) => shop.id === me.shopId);

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <Link href="/board" className="text-sm font-semibold tracking-tight">
            ServiceLoop
          </Link>

          <ShopSwitcher shops={me.shops} activeShopId={me.shopId} />

          <nav className="order-last flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-muted-foreground sm:inline">
              {me.fullName} · {me.role}
            </span>
            <form action="/api/session/logout" method="post">
              <button
                type="submit"
                className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <p className="sr-only">
          Signed in to {activeShop?.name ?? 'your workshop'} as {me.role}
        </p>
        {children}
      </main>
    </div>
  );
}
