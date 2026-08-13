import { EmptyState } from '@/components/ui/primitives';

/**
 * Conversations inbox. Phase 2 fills this with the WhatsApp channel, the media
 * pipeline and the sandbox simulator; the shell and its route exist now so the
 * navigation and auth boundary are already proven.
 */
export default function ConversationsPage(): React.JSX.Element {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Conversations</h1>
        <p className="text-sm text-muted-foreground">
          Every customer thread, across WhatsApp, SMS and voice.
        </p>
      </div>

      <EmptyState
        title="No conversations yet"
        description="Channels arrive in phase 2: WhatsApp intake, the media pipeline, paper job-card OCR and the sandbox simulator that lets you act as any customer without a Meta account."
      />
    </div>
  );
}
