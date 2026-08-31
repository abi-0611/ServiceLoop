import { getEnv } from '@serviceloop/config';
import { notFound } from 'next/navigation';
import { SandboxPersonaListSchema } from '@serviceloop/shared';
import { Simulator } from '@/components/simulator';
import { serverApiFetch } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * The Sandbox Simulator (phase 2.2).
 *
 * This is the most-used development surface for the rest of the build, so it is
 * built as a product screen rather than a debug page: act as any seeded
 * customer or as a technician in the workshop group, send text, photos, voice
 * notes and button taps, and watch the pipeline trace beside the thread.
 *
 * Everything travels the real path — a signed webhook envelope through the same
 * `receive` → router → handler chain Meta's delivery takes. There is no private
 * back door, which is what makes a flow that works here a flow that works in
 * production.
 */
export default async function SandboxPage(): Promise<React.JSX.Element> {
  // Refused on the server as well as in the API: a build with the live adapter
  // wired must not render a UI whose buttons would message real customers.
  if (!getEnv().DEMO_MODE) notFound();

  const personas = await serverApiFetch('/sandbox/personas', SandboxPersonaListSchema);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Sandbox simulator</h1>
        <p className="text-sm text-muted-foreground">
          Act as any customer or technician. Messages are rendered as signed Cloud API webhooks and
          pushed through the real inbound pipeline.
        </p>
      </div>

      <Simulator personas={personas.personas} staffGroupId={personas.staffGroupId} />
    </div>
  );
}
