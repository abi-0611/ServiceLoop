import Link from 'next/link';
import { NewJobCardForm } from '@/components/new-job-card-form';

export const dynamic = 'force-dynamic';

/**
 * The minimal digital job card (phase 2.8).
 *
 * Never the pitch — the pitch is that ServiceLoop works on the paper the shop
 * already uses — but always available, because a greenfield shop still needs a
 * way in. It produces the same `JobCardDraft` the photo path does and confirms
 * it through the same service, so entity resolution, the audit chain and the
 * outbox behave identically.
 */
export default function NewJobCardPage(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div>
        <Link href="/intake" className="text-sm text-muted-foreground hover:underline">
          ← Intake
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">New job card</h1>
        <p className="text-sm text-muted-foreground">
          For shops with no paper card to photograph. The vehicle is matched on its normalised
          registration and the customer on their phone number, so re-entering an existing customer
          will not create a duplicate.
        </p>
      </div>

      <NewJobCardForm />
    </div>
  );
}
