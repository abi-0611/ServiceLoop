import { z } from 'zod';
import { LanguageSchema } from './enums';

/**
 * `JobCardDraft` — the single shape every intake on-ramp produces.
 *
 * A photographed paper card (2.5), a forwarded WhatsApp message (2.7) and a
 * voice note (2.7) all extract into this, and the staff confirmation flow (2.6)
 * knows only this. That is what makes the paper path first-class rather than
 * special-cased: it produces the same artefact as everything else.
 *
 * Every field carries its own `confidence` and, where the extractor can say, a
 * `region` pointing at the part of the image it came from. Confidence is not
 * decoration — the confirmation flow uses it to decide which fields to put in
 * front of a human with a ⚠, and the OCR eval asserts that wrong fields
 * actually carry low confidence. A model that is confidently wrong is far worse
 * than one that admits doubt.
 */

/** Normalised 0–1 box on the source image, so the console can highlight it. */
export const SourceRegionSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
  page: z.number().int().min(1).default(1),
});
export type SourceRegion = z.infer<typeof SourceRegionSchema>;

export const ConfidenceSchema = z.number().min(0).max(1);

function confident<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value,
    confidence: ConfidenceSchema,
    region: SourceRegionSchema.nullish().transform((region) => region ?? null),
  });
}

export type ConfidentField<T> = {
  readonly value: T;
  readonly confidence: number;
  readonly region: SourceRegion | null;
};

export const DraftCustomerSchema = z.object({
  name: confident(z.string().max(120)),
  /** Raw as written; normalisation to E.164 happens in entity resolution. */
  phone: confident(z.string().max(32).nullable()),
});

export const DraftVehicleSchema = z.object({
  registration: confident(z.string().max(24)),
  make: confident(z.string().max(60).nullable()),
  model: confident(z.string().max(60).nullable()),
  odometerKm: confident(z.number().int().min(0).max(2_000_000).nullable()),
});

export const DraftComplaintSchema = confident(z.string().min(1).max(400));

export const DraftEstimateLineSchema = z.object({
  description: confident(z.string().min(1).max(200)),
  /** Milli-units, matching `estimate_lines.quantity_milli` (1.5 → 1500). */
  quantityMilli: confident(z.number().int().min(1).max(1_000_000)),
  /** Paise. Null when the card lists work with no price against it. */
  unitPricePaise: confident(z.number().int().min(0).max(100_000_000).nullable()),
});

export const JobCardDraftSchema = z.object({
  customer: DraftCustomerSchema,
  vehicle: DraftVehicleSchema,
  complaints: z.array(DraftComplaintSchema).max(20),
  estimateLines: z.array(DraftEstimateLineSchema).max(40),
  advisorName: confident(z.string().max(120).nullable()),
  /** ISO-8601 when the extractor could resolve it; the raw phrase otherwise. */
  promisedAt: confident(z.string().max(64).nullable()),
  /** Language the source was written or spoken in — drives the reply language. */
  language: LanguageSchema.default('en'),
  /** Anything the extractor read but could not place, kept for the advisor. */
  notes: z.string().max(2000).default(''),
});

export type JobCardDraft = z.infer<typeof JobCardDraftSchema>;
export type DraftEstimateLine = z.infer<typeof DraftEstimateLineSchema>;

/* -------------------------------------------------------------------------- *
 * Field addressing
 *
 * The confirmation flow talks to staff in line numbers ("2 = TN 09 BX 4432"),
 * and stores corrections by path. Both need one canonical ordering of the
 * fields a human can be asked about.
 * -------------------------------------------------------------------------- */

export interface DraftField {
  /** Dotted path, e.g. `vehicle.registration` or `estimateLines.0.unitPricePaise`. */
  readonly path: string;
  /** Short human label used in the WhatsApp summary. */
  readonly label: string;
  readonly value: string;
  readonly confidence: number;
  readonly region: SourceRegion | null;
}

function render(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return String(value);
  return String(value);
}

/**
 * Every confirmable field, in the order a human reads a job card: who, what
 * vehicle, what is wrong, what it costs.
 */
export function draftFields(draft: JobCardDraft): DraftField[] {
  const fields: DraftField[] = [
    field('customer.name', 'Customer', draft.customer.name),
    field('customer.phone', 'Phone', draft.customer.phone),
    field('vehicle.registration', 'Registration', draft.vehicle.registration),
    field('vehicle.make', 'Make', draft.vehicle.make),
    field('vehicle.model', 'Model', draft.vehicle.model),
    field('vehicle.odometerKm', 'Odometer', draft.vehicle.odometerKm),
  ];

  for (const [index, complaint] of draft.complaints.entries()) {
    fields.push(field(`complaints.${index}`, `Complaint ${index + 1}`, complaint));
  }

  for (const [index, line] of draft.estimateLines.entries()) {
    fields.push(field(`estimateLines.${index}.description`, `Item ${index + 1}`, line.description));
    fields.push(
      field(`estimateLines.${index}.unitPricePaise`, `Item ${index + 1} price`, line.unitPricePaise),
    );
  }

  fields.push(field('advisorName', 'Advisor', draft.advisorName));
  fields.push(field('promisedAt', 'Promised', draft.promisedAt));

  return fields;
}

function field(path: string, label: string, source: ConfidentField<unknown>): DraftField {
  return {
    path,
    label,
    value: render(source.value),
    confidence: source.confidence,
    region: source.region,
  };
}

/** Mean confidence across every confirmable field. */
export function overallConfidence(draft: JobCardDraft): number {
  const fields = draftFields(draft);
  if (fields.length === 0) return 0;
  const total = fields.reduce((sum, entry) => sum + entry.confidence, 0);
  return total / fields.length;
}

/** The ⚠ list: fields the extractor is not sure enough about to accept silently. */
export function lowConfidenceFields(draft: JobCardDraft, threshold: number): DraftField[] {
  return draftFields(draft).filter((entry) => entry.confidence < threshold);
}

/* -------------------------------------------------------------------------- *
 * Corrections
 * -------------------------------------------------------------------------- */

export interface DraftCorrection {
  readonly path: string;
  readonly previousValue: string;
  readonly value: string;
  readonly correctedBy: string | null;
  readonly correctedAt: string;
}

export class UnknownDraftFieldError extends Error {
  constructor(readonly path: string) {
    super(`"${path}" is not a correctable field on this draft`);
    this.name = 'UnknownDraftFieldError';
  }
}

/**
 * Applies a human's correction, returning a new draft.
 *
 * A corrected field is set to confidence 1: a person has looked at the card and
 * said what it says, which is the highest-quality signal available anywhere in
 * this system. The `region` is kept so the console can still show where the
 * value came from.
 */
export function applyCorrection(
  draft: JobCardDraft,
  path: string,
  rawValue: string,
): { draft: JobCardDraft; previousValue: string } {
  const clone = structuredClone(draft) as JobCardDraft;
  const segments = path.split('.');

  const target = resolveTarget(clone, segments);
  if (target === null) throw new UnknownDraftFieldError(path);

  const previousValue = render(target.container[target.key]?.value ?? null);
  const existing = target.container[target.key];
  if (existing === undefined) throw new UnknownDraftFieldError(path);

  target.container[target.key] = {
    value: coerce(path, rawValue, existing.value),
    confidence: 1,
    region: existing.region,
  };

  // Re-validate, so a correction can never produce a draft the schema would
  // have rejected coming out of the extractor.
  return { draft: JobCardDraftSchema.parse(clone), previousValue };
}

interface Target {
  readonly container: Record<string, ConfidentField<unknown> | undefined>;
  readonly key: string;
}

function resolveTarget(draft: JobCardDraft, segments: string[]): Target | null {
  const [head, ...rest] = segments;
  if (head === undefined) return null;

  if (head === 'complaints') {
    const index = Number(rest[0]);
    if (!Number.isInteger(index) || rest.length !== 1) return null;
    if (index < 0 || index >= draft.complaints.length) return null;
    return {
      container: draft.complaints as unknown as Record<string, ConfidentField<unknown>>,
      key: String(index),
    };
  }

  if (head === 'estimateLines') {
    const index = Number(rest[0]);
    const leaf = rest[1];
    if (!Number.isInteger(index) || leaf === undefined || rest.length !== 2) return null;
    const line = draft.estimateLines[index];
    if (line === undefined) return null;
    if (!['description', 'quantityMilli', 'unitPricePaise'].includes(leaf)) return null;
    return { container: line as unknown as Record<string, ConfidentField<unknown>>, key: leaf };
  }

  if (head === 'customer' || head === 'vehicle') {
    const leaf = rest[0];
    if (leaf === undefined || rest.length !== 1) return null;
    const section = draft[head] as unknown as Record<string, ConfidentField<unknown> | undefined>;
    if (section[leaf] === undefined) return null;
    return { container: section, key: leaf };
  }

  if ((head === 'advisorName' || head === 'promisedAt') && rest.length === 0) {
    return { container: draft as unknown as Record<string, ConfidentField<unknown>>, key: head };
  }

  return null;
}

/**
 * Staff type "45000" for a price and "TN 09 BX 4432" for a registration. The
 * corrected value must match the field's type, inferred from what was there.
 */
function coerce(path: string, rawValue: string, previous: unknown): unknown {
  const trimmed = rawValue.trim();

  if (path.endsWith('unitPricePaise')) {
    // Staff think in rupees; the schema stores paise.
    const rupees = Number(trimmed.replace(/[₹,\s]/g, ''));
    if (!Number.isFinite(rupees)) throw new UnknownDraftFieldError(path);
    return Math.round(rupees * 100);
  }

  if (path.endsWith('quantityMilli')) {
    const quantity = Number(trimmed.replace(/[,\s]/g, ''));
    if (!Number.isFinite(quantity) || quantity <= 0) throw new UnknownDraftFieldError(path);
    return Math.round(quantity * 1000);
  }

  if (path === 'vehicle.odometerKm') {
    if (trimmed.length === 0) return null;
    const km = Number(trimmed.replace(/[,\s]|km$/gi, ''));
    if (!Number.isFinite(km)) throw new UnknownDraftFieldError(path);
    return Math.round(km);
  }

  // A nullable text field cleared to nothing becomes null, not "".
  if (trimmed.length === 0 && previous === null) return null;
  return trimmed;
}

/** An empty draft, used as the base a console form or a parser fills in. */
export function emptyJobCardDraft(): JobCardDraft {
  const blank = <T>(value: T): ConfidentField<T> => ({ value, confidence: 0, region: null });
  return JobCardDraftSchema.parse({
    customer: { name: blank(''), phone: blank(null) },
    vehicle: {
      registration: blank(''),
      make: blank(null),
      model: blank(null),
      odometerKm: blank(null),
    },
    complaints: [],
    estimateLines: [],
    advisorName: blank(null),
    promisedAt: blank(null),
    language: 'en',
    notes: '',
  });
}
