import { GateVerify } from '@/components/gate-verify';

/**
 * The gate (phase 4.10).
 *
 * A page of its own rather than a panel on the board, because the person who
 * opens it is not the person the rest of this console is for. They are standing
 * at a barrier with a car idling in front of them, and everything on the screen
 * that is not "may this car leave" is in the way.
 *
 * Deliberately reachable by a technician as well as an advisor and an owner:
 * whoever is nearest the gate at six o'clock is who checks the pass.
 */
export const dynamic = 'force-dynamic';

export default async function GatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const params = await searchParams;
  const raw = params['t'];
  const token = typeof raw === 'string' && raw.length > 0 ? raw : null;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Gate</h1>
        <p className="text-sm text-muted-foreground">
          Scan the customer&rsquo;s QR, or type the six characters from their message.
        </p>
      </div>

      <GateVerify initialToken={token} />

      <p className="text-xs text-muted-foreground">
        Every check is recorded — the pass, the result, and who was signed in.
        A pass works once.
      </p>
    </div>
  );
}
