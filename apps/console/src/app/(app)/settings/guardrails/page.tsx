import { PageHeader } from '@/components/ui/primitives';
import { ShopConfigSchema } from '@serviceloop/config';
import { z } from 'zod';
import { GuardrailForm } from '@/components/guardrail-form';
import { serverApiFetch } from '@/lib/api';

/**
 * Settings → Guardrails. The form is bound to the same `ShopConfigSchema`
 * the API validates against, and validation errors come back field-scoped.
 */

export const dynamic = 'force-dynamic';

const ReadSchema = z.object({
  config: ShopConfigSchema,
  migratedFrom: z.number().nullable(),
  editable: z.boolean(),
});

export default async function GuardrailsPage(): Promise<React.JSX.Element> {
  const { config, editable } = await serverApiFetch('/config/guardrails', ReadSchema);

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Settings"
        title="Guardrails"
        description={
          <>
            Autonomy, pricing limits and quiet hours. Every change is validated as a whole document
            and recorded in the audit log with who made it.
          </>
        }
      />

      <GuardrailForm config={config} editable={editable} />
    </div>
  );
}
