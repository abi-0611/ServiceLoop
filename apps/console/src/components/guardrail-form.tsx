'use client';

import { AUTONOMY_FLOWS, AUTONOMY_LEVELS, LANGUAGES } from '@serviceloop/shared';
import type { ShopConfig } from '@serviceloop/config';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
} from '@/components/ui/primitives';

interface FieldError {
  readonly path: string;
  readonly message: string;
}

const AUTONOMY_HELP: Readonly<Record<string, string>> = {
  L0_SHADOW: 'Agent drafts; every send needs approval',
  L1_TEMPLATED: 'Auto-send templated updates only',
  L2_CONVERSATIONAL: 'Auto conversational replies within guardrails',
  L3_VOICE: 'Voice autonomy (phase 5)',
};

export function GuardrailForm({
  config,
  editable,
}: {
  config: ShopConfig;
  editable: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldError[]>([]);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    setErrors([]);

    const form = new FormData(event.currentTarget);
    const patch = {
      autonomy: Object.fromEntries(
        AUTONOMY_FLOWS.map((flow) => [flow, form.get(`autonomy.${flow}`)]),
      ),
      pricing: {
        priceFloorPercent: Number(form.get('pricing.priceFloorPercent')),
        discountCeilingPercent: Number(form.get('pricing.discountCeilingPercent')),
      },
      quietHours: {
        start: form.get('quietHours.start'),
        end: form.get('quietHours.end'),
        timezone: form.get('quietHours.timezone'),
      },
      languages: {
        enabled: LANGUAGES.filter((language) => form.get(`languages.${language}`) === 'on'),
        default: form.get('languages.default'),
      },
      payments: { paymentBeforeDelivery: form.get('payments.paymentBeforeDelivery') === 'on' },
      frequencyCaps: {
        maxOutboundPerCustomerPerDay: Number(form.get('frequencyCaps.perDay')),
        maxOutboundPerCustomerPerWeek: Number(form.get('frequencyCaps.perWeek')),
        minMinutesBetweenMessages: Number(form.get('frequencyCaps.minMinutes')),
      },
      voice: {
        enabled: form.get('voice.enabled') === 'on',
        // Sent whole rather than as three independent switches: the schema
        // refuses outbound or inbound without `enabled`, and a patch that set
        // one without the other would be rejected as a validation error the
        // owner did not cause.
        outboundEnabled: form.get('voice.enabled') === 'on' && form.get('voice.outbound') === 'on',
        inboundEnabled: form.get('voice.enabled') === 'on' && form.get('voice.inbound') === 'on',
        dailyCostCapPaise: Number(form.get('voice.dailyCostCapPaise')),
        maxOutboundCallsPerDay: Number(form.get('voice.maxOutboundCallsPerDay')),
      },
    };

    try {
      const response = await fetch('/api/config/guardrails', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });

      const payload = (await response.json()) as {
        detail?: string;
        details?: { fieldErrors?: FieldError[] };
        changed?: Array<{ path: string }>;
      };

      if (!response.ok) {
        setErrors(payload.details?.fieldErrors ?? []);
        setMessage(payload.detail ?? 'The change was rejected.');
        return;
      }

      const changed = payload.changed ?? [];
      setMessage(
        changed.length === 0
          ? 'No changes to save.'
          : `Saved and audited: ${changed.map((entry) => entry.path).join(', ')}`,
      );
      router.refresh();
    } catch {
      setMessage('Could not reach the API.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      {!editable && (
        <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          Only an owner can change guardrails. You are seeing the current values read-only.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Autonomy per flow</CardTitle>
          <CardDescription>
            New shops start every flow in shadow mode. Raising a level means the agent may send
            without a human first.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {AUTONOMY_FLOWS.map((flow) => (
            <div key={flow} className="space-y-2">
              <Label htmlFor={`autonomy.${flow}`} className="capitalize">
                {flow}
              </Label>
              <Select
                id={`autonomy.${flow}`}
                name={`autonomy.${flow}`}
                defaultValue={config.autonomy[flow]}
                disabled={!editable}
              >
                {AUTONOMY_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                {AUTONOMY_HELP[config.autonomy[flow]] ?? ''}
              </p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pricing limits</CardTitle>
          <CardDescription>
            Enforced in the tool layer: an offer below the floor is rejected before it can reach a
            customer.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Price floor (% of list)"
            name="pricing.priceFloorPercent"
            defaultValue={config.pricing.priceFloorPercent}
            type="number"
            editable={editable}
            errors={errors}
          />
          <Field
            label="Discount ceiling (% of list)"
            name="pricing.discountCeilingPercent"
            defaultValue={config.pricing.discountCeilingPercent}
            type="number"
            editable={editable}
            errors={errors}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Quiet hours</CardTitle>
          <CardDescription>No outbound messages inside this window, shop-local.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Start"
            name="quietHours.start"
            defaultValue={config.quietHours.start}
            editable={editable}
            errors={errors}
          />
          <Field
            label="End"
            name="quietHours.end"
            defaultValue={config.quietHours.end}
            editable={editable}
            errors={errors}
          />
          <Field
            label="Timezone"
            name="quietHours.timezone"
            defaultValue={config.quietHours.timezone}
            editable={editable}
            errors={errors}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Languages</CardTitle>
          <CardDescription>Launch languages are Tamil, Hindi and English.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-4">
            {LANGUAGES.map((language) => (
              <label key={language} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name={`languages.${language}`}
                  defaultChecked={config.languages.enabled.includes(language)}
                  disabled={!editable}
                  className="h-4 w-4"
                />
                {language}
              </label>
            ))}
          </div>
          <div className="max-w-xs space-y-2">
            <Label htmlFor="languages.default">Default language</Label>
            <Select
              id="languages.default"
              name="languages.default"
              defaultValue={config.languages.default}
              disabled={!editable}
            >
              {LANGUAGES.map((language) => (
                <option key={language} value={language}>
                  {language}
                </option>
              ))}
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Voice</CardTitle>
          <CardDescription>
            A shop starts with voice off. Switching it on lets the approval ladder ring a customer
            instead of raising a task for an advisor — every other guardrail still applies, and a
            call is refused in quiet hours where a message would only have been deferred.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="voice.enabled"
              data-testid="voice-enabled"
              defaultChecked={config.voice.enabled}
              disabled={!editable}
              className="h-4 w-4"
            />
            Let the agent use the telephone
          </label>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="voice.outbound"
                data-testid="voice-outbound"
                defaultChecked={config.voice.outboundEnabled}
                disabled={!editable}
                className="h-4 w-4"
              />
              Call customers about approvals
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="voice.inbound"
                data-testid="voice-inbound"
                defaultChecked={config.voice.inboundEnabled}
                disabled={!editable}
                className="h-4 w-4"
              />
              Answer the published line
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Daily voice budget (paise)"
              name="voice.dailyCostCapPaise"
              type="number"
              defaultValue={config.voice.dailyCostCapPaise}
              editable={editable}
              errors={errors}
            />
            <Field
              label="Max calls / day"
              name="voice.maxOutboundCallsPerDay"
              type="number"
              defaultValue={config.voice.maxOutboundCallsPerDay}
              editable={editable}
              errors={errors}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Delivery and frequency</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="payments.paymentBeforeDelivery"
              defaultChecked={config.payments.paymentBeforeDelivery}
              disabled={!editable}
              className="h-4 w-4"
            />
            Collect payment before handing the vehicle back
          </label>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field
              label="Max messages / day"
              name="frequencyCaps.perDay"
              type="number"
              defaultValue={config.frequencyCaps.maxOutboundPerCustomerPerDay}
              editable={editable}
              errors={errors}
            />
            <Field
              label="Max messages / week"
              name="frequencyCaps.perWeek"
              type="number"
              defaultValue={config.frequencyCaps.maxOutboundPerCustomerPerWeek}
              editable={editable}
              errors={errors}
            />
            <Field
              label="Min minutes between"
              name="frequencyCaps.minMinutes"
              type="number"
              defaultValue={config.frequencyCaps.minMinutesBetweenMessages}
              editable={editable}
              errors={errors}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Non-negotiable</CardTitle>
          <CardDescription>
            These are architectural, not configurable. They cannot be switched off from anywhere.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Badge tone="success">AI disclosure on first contact</Badge>
          <Badge tone="success">AI disclosure on every voice call</Badge>
          <Badge tone="success">Recording-consent line</Badge>
          <Badge tone="success">Evidence-anchored claims</Badge>
        </CardContent>
      </Card>

      {editable && (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save guardrails'}
          </Button>
          {message !== null && (
            <p data-testid="guardrail-message" className="text-sm text-muted-foreground">
              {message}
            </p>
          )}
        </div>
      )}

      {errors.length > 0 && (
        <ul
          data-testid="guardrail-errors"
          role="alert"
          className="space-y-1 text-sm text-destructive"
        >
          {errors.map((error) => (
            <li key={`${error.path}:${error.message}`}>
              <span className="font-mono text-xs">{error.path}</span> — {error.message}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

function Field({
  label,
  name,
  defaultValue,
  editable,
  errors,
  type = 'text',
}: {
  label: string;
  name: string;
  defaultValue: string | number;
  editable: boolean;
  errors: readonly FieldError[];
  type?: string;
}): React.JSX.Element {
  const fieldError = errors.find((error) => error.path === name || error.path.endsWith(name));

  return (
    <div className="space-y-2">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} defaultValue={defaultValue} disabled={!editable} />
      {fieldError !== undefined && <p className="text-xs text-destructive">{fieldError.message}</p>}
    </div>
  );
}
