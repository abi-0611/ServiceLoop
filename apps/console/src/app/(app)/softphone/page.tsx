import { getEnv } from '@serviceloop/config';
import { SoftphoneStateSchema } from '@serviceloop/shared';
import { notFound } from 'next/navigation';
import { Softphone } from '@/components/softphone';
import { serverApiFetch } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The browser softphone (phase 5.1).
 *
 * The development surface the whole voice phase is built on: the page is the
 * far end of a telephone call, and everything on it travels the same
 * `TelephonyPort` an Exotel call would. A flow that works here is a flow that
 * works on a telephone, which is what makes it possible to build — and to
 * demonstrate — the entire phase with no telco account in existence.
 */
export default async function SoftphonePage(): Promise<React.JSX.Element> {
  // Refused on the server as well as in the API: a build wired to a live
  // telephony adapter must not render a page whose buttons could pick up a real
  // customer's call.
  if (!getEnv().DEMO_MODE) notFound();

  const state = await serverApiFetch('/voice/softphone', SoftphoneStateSchema);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Softphone</h1>
        <p className="text-sm text-muted-foreground">
          Answer as a customer. Audio is real PCM through the real telephony port — the words you
          type are encoded into it and recognised back out, so nothing here takes a shortcut the
          telephone would not allow.
        </p>
      </div>

      <Softphone initial={state} />
    </div>
  );
}
