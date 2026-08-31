import { IntakeDraftListSchema, type IntakeDraftSummary } from '@serviceloop/shared';
import Link from 'next/link';
import { Badge, Button, Card, EmptyState } from '@/components/ui/primitives';
import { serverApiFetch } from '@/lib/api';

/**
 * The intake queue (phase 2.6).
 *
 * Every on-ramp lands here — a photographed paper card, a forwarded WhatsApp
 * message, a voice note, the console form — because they all produce the same
 * `JobCardDraft`. Nothing on this page is a job card yet: a draft is inert
 * until a human confirms it, which is what stops an OCR mistake from quietly
 * becoming a record.
 */
export const dynamic = 'force-dynamic';

const SOURCE_LABEL: Readonly<Record<string, string>> = {
  PHOTO: 'Paper card photo',
  FORWARDED_TEXT: 'Forwarded message',
  VOICE_NOTE: 'Voice note',
  CONSOLE_FORM: 'Console form',
};

export default async function IntakePage(): Promise<React.JSX.Element> {
  const list = await serverApiFetch(
    '/intake/drafts?status=AWAITING_CONFIRMATION',
    IntakeDraftListSchema,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Intake</h1>
          <p className="text-sm text-muted-foreground">
            Drafts waiting for a human to confirm before they become job cards.
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href="/intake/new">New job card</Link>
        </Button>
      </div>

      {list.drafts.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          description="Send a photo of a paper job card captioned #jobcard from the workshop group in the sandbox simulator, and it will appear here with every field the extractor was unsure about marked."
          action={
            <Button asChild variant="outline">
              <Link href="/sandbox">Open the simulator</Link>
            </Button>
          }
        />
      ) : (
        <ul data-testid="draft-list" className="space-y-2">
          {list.drafts.map((draft) => (
            <li key={draft.id}>
              <DraftRow draft={draft} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DraftRow({ draft }: { draft: IntakeDraftSummary }): React.JSX.Element {
  return (
    <Link href={`/intake/${draft.id}`} className="block">
      <Card className="p-4 transition-colors hover:bg-accent/40">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {draft.customerName.length > 0 ? draft.customerName : 'Unnamed customer'} ·{' '}
              {draft.registration.length > 0 ? draft.registration : 'no registration'}
            </p>
            <p className="text-xs text-muted-foreground">
              {SOURCE_LABEL[draft.source] ?? draft.source} ·{' '}
              {new Date(draft.createdAt).toLocaleString()}
              {draft.extractorModel !== null && ` · read by ${draft.extractorModel}`}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {draft.uncertainCount > 0 ? (
              <Badge tone="warn" data-testid="uncertain-count">
                ⚠ {draft.uncertainCount} to check
              </Badge>
            ) : (
              <Badge tone="success">All fields confident</Badge>
            )}
            <Badge tone="neutral">{Math.round(draft.overallConfidence * 100)}% mean</Badge>
          </div>
        </div>
      </Card>
    </Link>
  );
}
