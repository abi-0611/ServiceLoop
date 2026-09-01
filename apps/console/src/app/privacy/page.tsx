import { apiFetch } from '@/lib/api';
import { z } from 'zod';

/**
 * The published privacy notice (phase 7.2).
 *
 * Outside the `(app)` group, so it has no session check and no navigation
 * chrome. That is not a styling decision: the Act requires this to be
 * *published*, and a notice a person can only read after signing in to a
 * workshop's console has not been published to the people it is about.
 *
 * **The contact details are fetched, not written here.** `GET /privacy/notice`
 * serves them from the same environment the running system uses, so the
 * grievance officer named on this page is the one the API would name, and a
 * shop that changes theirs does not have to remember there is a second copy in
 * a React file. The narrative text around them is ours; every fact is theirs.
 *
 * The three-language versions live in `docs/privacy/` as the documents a shop
 * prints for its counter. This page is the canonical online copy the WhatsApp
 * consent request links to.
 */

export const dynamic = 'force-dynamic';

const NoticeSchema = z.object({
  grievanceOfficer: z.object({
    name: z.string(),
    email: z.string(),
    phone: z.string(),
  }),
  noticeUrl: z.string(),
  rights: z.array(z.object({ right: z.string(), how: z.string() })),
  retention: z.object({
    invoicesYears: z.number(),
    basis: z.string(),
    note: z.string(),
  }),
});

export const metadata = {
  title: 'Privacy notice · ServiceLoop',
  description: 'How this workshop handles your personal data, and how to ask us to stop.',
};

export default async function PrivacyPage(): Promise<React.JSX.Element> {
  // Unauthenticated: the endpoint is `@Public()` and carries no personal data.
  // A signed-in fetch here would make the page fail for the only people it is
  // written for.
  let notice: z.infer<typeof NoticeSchema> | null = null;
  try {
    notice = await apiFetch('/privacy/notice', NoticeSchema);
  } catch {
    // A notice that 500s because the API is down is worse than a notice with
    // the standing text and no contact block: the first tells a customer
    // nothing, the second still tells them what we collect and what their
    // rights are. The contact block degrades to the shop's counter.
    notice = null;
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Privacy notice</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Digital Personal Data Protection Act, 2023 · this workshop is the data fiduciary
      </p>

      <div className="mt-8 space-y-8 text-sm leading-relaxed">
        <Section title="What we collect">
          <p>
            Your name and phone number, the vehicle you bring us, and the messages and photographs
            exchanged about the work — including photographs our technicians take of your vehicle,
            and recordings of calls where you were told at the start that the call was recorded.
          </p>
          <p>
            We do not collect anything else, and we do not buy information about you from anyone.
          </p>
        </Section>

        <Section title="Why we hold it">
          <p>
            To do the work you asked for, to tell you what is happening to your vehicle, to take
            your approval before spending your money, and to invoice you. Where you have separately
            agreed to it, to remind you about work you deferred or a service that is due.
          </p>
          <p>
            Service updates and marketing are <strong>separate permissions</strong>. Agreeing to be
            told your car is ready is not agreeing to be sold anything, and saying no to one does
            not affect the other.
          </p>
        </Section>

        <Section title="How long we keep it">
          <p>
            Conversations and photographs for as long as we are working with you, and for a
            reasonable period afterwards in case you come back about the same job.
          </p>
          {notice !== null && (
            <p>
              <strong>Invoices and tax records for {notice.retention.invoicesYears} years.</strong>{' '}
              This is not our choice — {notice.retention.basis} requires it. {notice.retention.note}
            </p>
          )}
        </Section>

        <Section title="Your rights">
          <p>You can, at any time and without giving a reason:</p>
          <ul className="ml-5 list-disc space-y-1">
            {(
              notice?.rights ?? [
                { right: 'access', how: 'Ask the workshop for a copy of your data.' },
                { right: 'correction', how: 'Ask the workshop to correct anything that is wrong.' },
                { right: 'erasure', how: 'Ask the workshop to delete your data.' },
                { right: 'grievance', how: 'Complain to the grievance officer.' },
              ]
            ).map((entry) => (
              <li key={entry.right}>
                <span className="font-medium capitalize">{entry.right}</span> — {entry.how}
              </li>
            ))}
          </ul>
          <p>
            You can also stop messages instantly by replying <strong>STOP</strong> on WhatsApp. That
            takes effect immediately and permanently, and does not need anyone to approve it.
          </p>
          <p className="text-muted-foreground">
            An erasure request is verified before it runs, and there is a short window in which it
            can be cancelled — because a deletion has no undo. Once it runs you are sent a report of
            exactly what was deleted and what had to be kept.
          </p>
        </Section>

        <Section title="Who to complain to">
          {notice === null ? (
            <p>
              Ask at the workshop counter for the grievance officer&rsquo;s name and contact
              details. They are also displayed at the counter.
            </p>
          ) : (
            <div className="rounded-md border border-border p-4">
              <p className="font-medium">{notice.grievanceOfficer.name}</p>
              <p>
                <a className="underline" href={`mailto:${notice.grievanceOfficer.email}`}>
                  {notice.grievanceOfficer.email}
                </a>
              </p>
              <p>
                <a className="underline" href={`tel:${notice.grievanceOfficer.phone}`}>
                  {notice.grievanceOfficer.phone}
                </a>
              </p>
            </div>
          )}
          <p className="text-muted-foreground">
            If you are not satisfied with the response, you may complain to the Data Protection
            Board of India.
          </p>
        </Section>
      </div>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}
