import { getEnv } from '@serviceloop/config';
import { SessionSchema } from '@serviceloop/shared';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import type { z } from 'zod';
import { AppShell } from '@/components/app-shell';
import { ShopSwitcher } from '@/components/shop-switcher';
import { ApiError, isSignedIn, serverApiFetch } from '@/lib/api';

const MeSchema = SessionSchema.shape.staff.extend({ shops: SessionSchema.shape.shops });

/**
 * The signed-in frame.
 *
 * Everything visual lives in `<AppShell>`, which is a client component because
 * a navigation that knows where it is has to read the pathname. The session
 * lookup stays here, on the server, so the token never crosses that boundary —
 * the shell is handed a name and a role, not a session.
 */
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
  // The simulator can only ever reach a fake WhatsApp; a build wired to the
  // live adapter should not advertise a link that 404s.
  const demoMode = getEnv().DEMO_MODE;

  return (
    <AppShell
      staffName={me.fullName}
      role={me.role}
      shopName={activeShop?.name ?? 'your workshop'}
      demoMode={demoMode}
      shopSwitcher={<ShopSwitcher shops={me.shops} activeShopId={me.shopId} />}
    >
      <p className="sr-only">
        Signed in to {activeShop?.name ?? 'your workshop'} as {me.role}
      </p>
      {children}
    </AppShell>
  );
}
