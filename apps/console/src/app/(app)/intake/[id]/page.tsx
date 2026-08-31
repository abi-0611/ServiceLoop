import { IntakeDraftDetailSchema } from '@serviceloop/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DraftReview } from '@/components/draft-review';
import { Badge, Card } from '@/components/ui/primitives';
import { ApiError, serverApiFetch } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * One draft, side by side with what it was read from.
 *
 * Showing the source photograph next to the extracted fields is the whole
 * ergonomic point: an advisor checking a plate should be able to look at the
 * plate, not remember it from a WhatsApp thread two screens away.
 */
export default async function DraftPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;

  let draft;
  try {
    draft = await serverApiFetch(`/intake/drafts/${id}`, IntakeDraftDetailSchema);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  return (
    <div className="space-y-4">
      <div>
        <Link href="/intake" className="text-sm text-muted-foreground hover:underline">
          ← Intake
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">
            {draft.customerName.length > 0 ? draft.customerName : 'Unnamed customer'}
          </h1>
          <Badge tone={draft.status === 'AWAITING_CONFIRMATION' ? 'warn' : 'neutral'}>
            {draft.status.toLowerCase().replace(/_/g, ' ')}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {draft.source.toLowerCase().replace(/_/g, ' ')}
          {draft.extractorModel !== null && ` · read by ${draft.extractorModel}`} ·{' '}
          {new Date(draft.createdAt).toLocaleString()}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_minmax(0,22rem)]">
        <div className="order-2 lg:order-1">
          <DraftReview initial={draft} />
        </div>

        <div className="order-1 space-y-3 lg:order-2">
          {draft.mediaUrl !== null && (
            <Card className="overflow-hidden">
              {/* Our own authenticated proxy serves these bytes; next/image
                  cannot fetch them. */}
              <img
                src={`/api${draft.mediaUrl}`}
                alt="The job card as photographed"
                className="w-full object-contain"
                data-testid="draft-source-image"
              />
            </Card>
          )}

          {draft.rawInput !== null && draft.rawInput.length > 0 && (
            <Card className="p-3">
              <p className="mb-1 text-xs font-semibold">Read from</p>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{draft.rawInput}</p>
            </Card>
          )}

          {draft.notes.length > 0 && (
            <Card className="p-3">
              <p className="mb-1 text-xs font-semibold">Notes the extractor could not place</p>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{draft.notes}</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
