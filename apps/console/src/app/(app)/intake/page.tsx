import { IntakeDraftListSchema, type IntakeDraftSummary } from '@serviceloop/shared';
import { Camera, FileText, Inbox, Mic, Plus } from 'lucide-react';
import Link from 'next/link';
import { Badge, Button, Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { SpotlightArea } from '@/components/ui/spotlight';
import { spotlightProps } from '@/lib/spotlight';
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

/** Each on-ramp gets its own mark, so a queue of mixed sources is scannable. */
const SOURCE_ICON: Readonly<Record<string, React.ComponentType<{ className?: string }>>> = {
  PHOTO: Camera,
  FORWARDED_TEXT: FileText,
  VOICE_NOTE: Mic,
  CONSOLE_FORM: Plus,
};

export default async function IntakePage(): Promise<React.JSX.Element> {
  const list = await serverApiFetch(
    '/intake/drafts?status=AWAITING_CONFIRMATION',
    IntakeDraftListSchema,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Workshop"
        title="Intake"
        description="Drafts waiting for a human to confirm before they become job cards."
        actions={
          <Button asChild variant="outline">
            <Link href="/intake/new">
              <Plus aria-hidden="true" />
              New job card
            </Link>
          </Button>
        }
      />

      {list.drafts.length === 0 ? (
        <EmptyState
          icon={<Inbox />}
          title="Nothing waiting"
          description="Send a photo of a paper job card captioned #jobcard from the workshop group in the sandbox simulator, and it will appear here with every field the extractor was unsure about marked."
          action={
            <Button asChild variant="outline">
              <Link href="/sandbox">Open the simulator</Link>
            </Button>
          }
        />
      ) : (
        <SpotlightArea>
          <ul data-testid="draft-list" className="space-y-2.5">
            {list.drafts.map((draft, index) => (
              <li
                key={draft.id}
                className="animate-enter-fast"
                style={{ '--i': index } as React.CSSProperties}
              >
                <DraftRow draft={draft} />
              </li>
            ))}
          </ul>
        </SpotlightArea>
      )}
    </div>
  );
}

function DraftRow({ draft }: { draft: IntakeDraftSummary }): React.JSX.Element {
  const SourceIcon = SOURCE_ICON[draft.source] ?? FileText;
  const confidence = Math.round(draft.overallConfidence * 100);

  return (
    <Link
      href={`/intake/${draft.id}`}
      className="block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card
        {...spotlightProps}
        className="spotlight sheen lift overflow-hidden p-4 hover:border-foreground/25 hover:shadow-md"
      >
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-start gap-3">
            <span
              aria-hidden="true"
              className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
            >
              <SourceIcon className="size-4" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                {draft.customerName.length > 0 ? draft.customerName : 'Unnamed customer'}
                <span className="mx-1.5 text-muted-foreground/50">·</span>
                <span className="font-mono tracking-wide">
                  {draft.registration.length > 0 ? draft.registration : 'no registration'}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {SOURCE_LABEL[draft.source] ?? draft.source} ·{' '}
                {new Date(draft.createdAt).toLocaleString()}
                {draft.extractorModel !== null && ` · read by ${draft.extractorModel}`}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {draft.uncertainCount > 0 ? (
              <Badge tone="warn" data-testid="uncertain-count">
                ⚠ {draft.uncertainCount} to check
              </Badge>
            ) : (
              <Badge tone="success">All fields confident</Badge>
            )}
            {/* The mean confidence as a bar as well as a number: a queue of
                drafts is sorted by eye long before anyone reads a percentage. */}
            <Badge tone="neutral" className="gap-2 pr-2">
              <span
                aria-hidden="true"
                className="h-1 w-10 overflow-hidden rounded-full bg-muted-foreground/25"
              >
                <span
                  className="block h-full rounded-full bg-current"
                  style={{ width: `${confidence}%` }}
                />
              </span>
              {confidence}% mean
            </Badge>
          </div>
        </div>
      </Card>
    </Link>
  );
}
