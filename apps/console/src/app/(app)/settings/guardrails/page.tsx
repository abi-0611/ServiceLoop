import { ShopConfigV1Schema } from '@serviceloop/config';
import { z } from 'zod';
import { GuardrailForm } from '@/components/guardrail-form';
import { serverApiFetch } from '@/lib/api';

/**
 * Settings → Guardrails. The form is bound to the same `ShopConfigV1Schema`
 * the API validates against, and validation errors come back field-scoped.
 */

export const dynamic = 'force-dynamic';

const ReadSchema = z.object({
  config: ShopConfigV1Schema,
  migratedFrom: z.number().nullable(),
  editable: z.boolean(),
});

export default async function GuardrailsPage(): Promise<React.JSX.Element> {
  const { config, editable } = await serverApiFetch('/config/guardrails', ReadSchema);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Guardrails</h1>
        <p className="text-sm text-muted-foreground">
          Autonomy, pricing limits and quiet hours. Every change is validated as a whole document
          and recorded in the audit log with who made it.
        </p>
      </div>

      <GuardrailForm config={config} editable={editable} />
    </div>
  );
}
