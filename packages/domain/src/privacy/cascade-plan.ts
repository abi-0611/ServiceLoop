import type { CascadeAction } from '@serviceloop/shared';

/**
 * The deletion cascade plan (phase 7.2).
 *
 * Every table in the schema that can hold something about one customer, with
 * what an approved erasure does to it and why. It is a declared table rather
 * than a series of DELETE statements for three reasons, and each of them is a
 * failure this file exists to prevent:
 *
 *  1. **A table added next year is silently missed.** `cascade-plan.test.ts`
 *     compares this list against the live schema and fails on any table that is
 *     in one and not the other. A cascade derived by hand from a developer's
 *     memory of the FK map is a cascade that leaves a customer's phone number
 *     in `odometer_readings` for two years.
 *  2. **"We deleted everything" is not an answer to a regulator.** Section 8 of
 *     the DPDP Act makes the fiduciary accountable for erasure. The completion
 *     report is generated from this table, one row per entry, with counts.
 *  3. **The carve-outs need to be argued in one place.** An invoice survives a
 *     deletion request; an audit event survives with its payload rewritten; a
 *     metric rollup is untouched because it holds no identifier at all. Each of
 *     those is a legal judgement, and scattering them across a hundred lines of
 *     SQL means nobody ever reviews them together.
 *
 * The order is execution order, and it matters: children before parents, and
 * the customer row last, so a crash halfway never leaves a dangling reference.
 */

export interface CascadeStep {
  /** Physical table name. Checked against the live schema by a test. */
  readonly table: string;
  readonly action: CascadeAction;
  /**
   * How rows for this data principal are found.
   *
   * `direct` — the table has a `customer_id`.
   * `via` — reached through a named join (a job card, a conversation).
   * `none` — the table holds no per-customer row; it is listed so the plan is
   *          demonstrably total over the schema, and its step is a no-op.
   */
  readonly reach:
    | { readonly kind: 'direct'; readonly column: string }
    | { readonly kind: 'via'; readonly through: string; readonly detail: string }
    | { readonly kind: 'none' };
  /** One sentence, written for a reader who is not a programmer. */
  readonly rationale: string;
  /**
   * For `RETAINED` only: the statute that requires it, and how the clock is
   * computed. A carve-out with no named law and no clock is indefinite
   * retention wearing a justification.
   */
  readonly retention?: {
    readonly basis: string;
    readonly yearsFrom: 'issued_at' | 'created_at';
  };
}

export const CASCADE_PLAN: readonly CascadeStep[] = [
  /* ---------------------------------------------------------------------- *
   * 1. Conversation and message data. The largest volume of personal data in
   *    the system, and the least ambiguous: it exists to serve this customer
   *    and has no purpose once they are gone.
   * ---------------------------------------------------------------------- */
  {
    table: 'message_reviews',
    action: 'PURGED',
    reach: { kind: 'via', through: 'messages', detail: 'review rows for this thread’s messages' },
    rationale:
      'An advisor’s decision about a draft message to this customer. Meaningless once the message is gone.',
  },
  {
    table: 'messages',
    action: 'PURGED',
    reach: { kind: 'via', through: 'conversations', detail: 'every message on their threads' },
    rationale:
      'The message bodies are the customer’s own words and ours to them. Nothing outside the conversation depends on them.',
  },
  {
    table: 'conversations',
    action: 'PURGED',
    reach: { kind: 'direct', column: 'customer_id' },
    rationale: 'The thread itself, including the WhatsApp address it is keyed on.',
  },
  {
    table: 'consents',
    action: 'PURGED',
    reach: { kind: 'direct', column: 'customer_id' },
    rationale:
      'A consent record is personal data about a decision this person made. Keeping it "to prove they opted out" would be keeping their number to remember not to use their number.',
  },

  /* ---------------------------------------------------------------------- *
   * 2. Media. Photographs of a customer’s vehicle, voice notes in their voice.
   * ---------------------------------------------------------------------- */
  {
    table: 'media_assets',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'assets on their cards and threads' },
    rationale:
      'Photographs and voice notes. The object-storage objects are deleted in the same step; a row without its bytes, or bytes without their row, is the failure this step is written to avoid.',
  },

  /* ---------------------------------------------------------------------- *
   * 3. Voice.
   * ---------------------------------------------------------------------- */
  {
    table: 'call_turns',
    action: 'PURGED',
    reach: { kind: 'via', through: 'calls', detail: 'transcript turns' },
    rationale: 'Verbatim transcript of what the customer said on the telephone.',
  },
  {
    table: 'call_consent_events',
    action: 'PURGED',
    reach: { kind: 'via', through: 'calls', detail: 'recording-consent facts' },
    rationale: 'Whether and when they were told the call was recorded.',
  },
  {
    table: 'calls',
    action: 'PSEUDONYMISED',
    reach: { kind: 'direct', column: 'customer_id' },
    rationale:
      'Kept rather than purged, and the reason is a foreign key: `call_usage.call_id` is NOT NULL and cascades, so deleting the call would take the shop’s telephone bill with it. Everything identifying goes — the masked number, the whisper text, the recording reference, the customer and job-card links — and what is left is a row that says a call of some duration happened and cost some paise.',
  },
  {
    table: 'call_usage',
    action: 'PSEUDONYMISED',
    reach: { kind: 'via', through: 'calls', detail: 'per-call cost rows' },
    rationale:
      'What the calls cost the shop. No identifier of its own; it survives because its call does, and because a deletion that moved last month’s telephone bill would make the shop’s accounts wrong.',
  },

  /* ---------------------------------------------------------------------- *
   * 4. Retention and feedback.
   * ---------------------------------------------------------------------- */
  {
    table: 'retention_touches',
    action: 'PURGED',
    reach: { kind: 'direct', column: 'customer_id' },
    rationale: 'When we last wrote to them and about what.',
  },
  {
    table: 'retention_holds',
    action: 'PURGED',
    reach: { kind: 'direct', column: 'customer_id' },
    rationale: 'A freeze on marketing to this person. Nothing left to freeze.',
  },
  {
    table: 'feedback_requests',
    action: 'PURGED',
    reach: { kind: 'direct', column: 'customer_id' },
    rationale:
      'Their rating and their comment, which is free text they wrote and often the most personal thing in the database.',
  },
  {
    table: 'exception_alerts',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'alerts whose subject is this customer’s card or feedback' },
    rationale:
      'Owner alerts quote the customer’s complaint verbatim, so these carry the same free text as the feedback row. Reached through the polymorphic subject rather than a customer column, because the table has none.',
  },
  {
    table: 'service_due_forecasts',
    action: 'PURGED',
    reach: { kind: 'via', through: 'vehicles', detail: 'forecasts for their vehicles' },
    rationale: 'A prediction about when to write to them again.',
  },
  {
    table: 'vehicle_documents',
    action: 'PURGED',
    reach: { kind: 'via', through: 'vehicles', detail: 'insurance and PUC expiry dates' },
    rationale: 'Renewal dates the customer told us so we could remind them.',
  },
  {
    table: 'odometer_readings',
    action: 'PURGED',
    reach: { kind: 'via', through: 'vehicles', detail: 'readings for their vehicles' },
    rationale: 'Mileage history, which is a record of how much this person drives.',
  },
  {
    table: 'declined_work_ledger',
    action: 'PURGED',
    reach: { kind: 'direct', column: 'customer_id' },
    rationale:
      'Work they said no to, with the technician’s note and the horizon on which we intended to ask again.',
  },

  /* ---------------------------------------------------------------------- *
   * 5. The job itself. Here the answer stops being obvious, because a job card
   *    is simultaneously a record about a person and a record of work done on a
   *    machine that a shop must be able to account for.
   * ---------------------------------------------------------------------- */
  {
    table: 'delivery_bookings',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'pickup slots' },
    rationale: 'When they said they would come and collect.',
  },
  {
    table: 'gate_passes',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'release tokens' },
    rationale: 'A short-lived token. Nothing depends on it after the vehicle has left.',
  },
  {
    table: 'status_signals',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'technician utterances' },
    rationale:
      'Free text and voice notes from technicians. Not about the customer, but frequently naming them.',
  },
  {
    table: 'eta_entries',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'ETA history' },
    rationale: 'When we told them the car would be ready, and why that changed.',
  },
  {
    table: 'silent_bay_nudges',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'internal nudges' },
    rationale: 'Internal prompts about a stalled bay.',
  },
  {
    table: 'evidence_bundles',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'approval evidence' },
    rationale: 'The photographs and findings we put in front of them to justify a quote.',
  },
  {
    table: 'approval_requests',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'their approval decisions' },
    rationale: 'What they approved and what they refused.',
  },
  {
    table: 'estimate_lines',
    action: 'PURGED',
    reach: { kind: 'via', through: 'estimates', detail: 'quoted lines' },
    rationale: 'The quote. Superseded by the invoice, which is what is retained.',
  },
  {
    table: 'estimates',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'quotes' },
    rationale: 'The quote, as distinct from the invoice.',
  },
  {
    table: 'work_items',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'line items' },
    rationale:
      'What was done to the vehicle. Retained in summarised form on the invoice line; the working record goes.',
  },
  {
    table: 'agent_steps',
    action: 'PURGED',
    reach: { kind: 'via', through: 'agent_runs', detail: 'model prompts and outputs' },
    rationale:
      'Prompts and completions, which contain the customer’s messages verbatim. The most easily forgotten copy of a conversation in the whole system.',
  },
  {
    table: 'agent_runs',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'agent runs about their job' },
    rationale: 'Runs of the agent on this customer’s behalf.',
  },
  {
    table: 'llm_usage',
    action: 'PSEUDONYMISED',
    reach: { kind: 'via', through: 'agent_runs', detail: 'token counts and cost' },
    rationale:
      'Tokens and paise, no content. The run link is dropped and the cost stays, for the same reason `call_usage` does.',
  },
  {
    table: 'advisor_tasks',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'tasks raised about them' },
    rationale: 'A queue entry telling an advisor to ring this person.',
  },
  {
    table: 'escalations',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'ladder rungs' },
    rationale: 'Scheduled attempts to reach them.',
  },
  {
    table: 'job_card_drafts',
    action: 'PURGED',
    reach: { kind: 'via', through: 'job_cards', detail: 'drafts and their extractions' },
    rationale:
      'The photographed paper card and everything read off it, including a hand-written name and number.',
  },
  {
    table: 'merge_suggestions',
    action: 'PURGED',
    reach: { kind: 'direct', column: 'customer_id' },
    rationale: 'Suggested duplicates of this customer’s record.',
  },

  /* ---------------------------------------------------------------------- *
   * 6. Money. The statutory carve-out.
   * ---------------------------------------------------------------------- */
  {
    table: 'payment_events',
    action: 'PSEUDONYMISED',
    reach: { kind: 'via', through: 'payments', detail: 'provider callbacks' },
    rationale:
      'Provider callbacks carrying a payer name. The name is stripped; the reconciliation trail survives.',
  },
  {
    table: 'payments',
    action: 'RETAINED',
    reach: { kind: 'via', through: 'invoices', detail: 'receipts against their invoices' },
    rationale:
      'A receipt is part of the tax record the invoice belongs to, and a retained invoice with its payments removed would not reconcile.',
    retention: { basis: 'CGST Act 2017 s.36 — books and accounts', yearsFrom: 'created_at' },
  },
  {
    table: 'invoice_lines',
    action: 'RETAINED',
    reach: { kind: 'via', through: 'invoices', detail: 'the lines of a retained invoice' },
    rationale: 'A tax invoice without its lines is not a tax invoice.',
    retention: { basis: 'CGST Act 2017 s.36 — books and accounts', yearsFrom: 'created_at' },
  },
  {
    table: 'invoices',
    action: 'RETAINED',
    reach: { kind: 'direct', column: 'customer_id' },
    rationale:
      'Retained under the GST record-keeping obligation, which s.8(7)(a) of the DPDP Act preserves. The pseudonym and the retention clock are written onto the row; the customer link stays, because it is NOT NULL and RESTRICT and because the record it points at has itself been reduced to a tombstone. So the amount, the tax and the invoice number survive for an assessor, and following the link finds no name. The rendered PDF is a media asset and is purged with the rest — a tax record is the ledger row, not a picture of it, and the picture has the customer’s name printed on it.',
    retention: { basis: 'CGST Act 2017 s.36 — books and accounts', yearsFrom: 'issued_at' },
  },
  {
    table: 'job_cards',
    action: 'PSEUDONYMISED',
    reach: { kind: 'direct', column: 'customer_id' },
    rationale:
      'The card is the spine every retained invoice hangs from and the unit every metric counts, so it survives. Its links to the customer and vehicle rows stay — both are NOT NULL, and both now point at records that have themselves been reduced to tombstones, so following them reveals nothing. What is cleared here is the card’s own copy of the customer’s words: the complaint text and the odometer reading.',
  },

  /* ---------------------------------------------------------------------- *
   * 7. The chain, the numbers, and the person.
   * ---------------------------------------------------------------------- */
  {
    table: 'audit_events',
    action: 'PSEUDONYMISED',
    reach: { kind: 'direct', column: 'entity_id' },
    rationale:
      'The audit chain is append-only and hash-linked: deleting rows would break every hash after them and destroy the shop’s ability to prove anything about anybody. Payloads are rewritten in place to replace identifiers with the pseudonym, the rows and their hashes are left, and each rewritten row is flagged so the verifier reports it as redacted rather than as tampered.',
  },
  {
    table: 'events_outbox',
    action: 'PURGED',
    reach: { kind: 'direct', column: 'shop_id' },
    rationale:
      'Dispatched envelopes carrying message bodies and phone numbers. Only rows naming this customer are removed, and only once dispatched — an undispatched event is work in flight.',
  },
  {
    table: 'metric_rollups',
    action: 'PSEUDONYMISED',
    reach: { kind: 'none' },
    rationale:
      'A rollup is a count of things that happened on a day. It holds no identifier and is left exactly as it is — which is the point: a deletion that moved last quarter’s revenue would make every number the shop is judged on unauditable, and the acceptance gate asserts the totals are unchanged.',
  },
  {
    table: 'owner_digests',
    action: 'PSEUDONYMISED',
    reach: { kind: 'none' },
    rationale:
      'A stored digest may quote a vehicle registration in its body. The registration is redacted in place; the figures stay, for the same reason the rollups do.',
  },
  {
    table: 'vehicles',
    action: 'PSEUDONYMISED',
    reach: { kind: 'direct', column: 'customer_id' },
    rationale:
      'A registration number identifies a person as reliably as their telephone number does, and more permanently — so it is destroyed. The *row* survives because `job_cards.vehicle_id` is NOT NULL and RESTRICT, and a job card is the unit every retained invoice and every metric hangs from. What is left is a row whose registration is a per-row token, with the make, model, colour and odometer cleared: enough for a foreign key to resolve, not enough to identify a vehicle or its owner.',
  },
  {
    table: 'customers',
    action: 'PSEUDONYMISED',
    reach: { kind: 'direct', column: 'id' },
    rationale:
      'Last. The encrypted name and phone are overwritten, the blind index is cleared so the record can never be found by phone number again, and `erased_at` and the pseudonym are written. The row survives only so the retained invoices’ foreign keys resolve and the completion report has something to point at.',
  },

  /* ---------------------------------------------------------------------- *
   * 8. Tables with no per-customer row. Listed so the plan is demonstrably
   *    total over the schema — a table absent from this file fails the test,
   *    and "we thought about it and there is nothing to do" is a conclusion the
   *    plan should record rather than leave to inference.
   * ---------------------------------------------------------------------- */
  ...(
    [
      ['shops', 'The workshop itself, which is not a data principal under this workflow.'],
      ['staff', 'Employees of the workshop. Erasing a member of staff is an employment matter with different retention rules, not this workflow.'],
      ['shop_config', 'The shop’s own guardrail document, which names no customer.'],
      ['wa_templates', 'WhatsApp template registrations, which belong to the shop rather than to any customer.'],
      ['template_registrations', 'Per-shop template approval state from Meta — a template key, a language and an approval status. It is the shop’s compliance record with a third party and names no customer, so an erasure leaves it exactly as it is.'],
      ['idempotency_keys', 'Consumer-side bookkeeping keyed on event ids; it holds no personal data and expires on its own.'],
      ['conversation_costs', 'Daily per-category cost aggregates for the shop, holding no customer identifier of any kind.'],
      ['sms_costs', 'Daily SMS cost aggregates for the shop, holding no customer identifier of any kind.'],
      ['data_requests', 'This workflow’s own records, which survive keyed by the pseudonym — see PLAN_SELF_EXEMPT below.'],
      ['data_request_steps', 'This workflow’s own completion report, which is the evidence that the erasure happened.'],
    ] as const
  ).map(
    ([table, rationale]): CascadeStep => ({
      table,
      action: 'PSEUDONYMISED',
      reach: { kind: 'none' },
      rationale,
    }),
  ),
];

/**
 * The plan's own records are not erased by the plan.
 *
 * A deletion request that deleted the evidence of itself would leave the shop
 * unable to answer "did you honour that request?" — which is the one question
 * the Act guarantees somebody will eventually ask. The `data_requests` row
 * survives keyed by the pseudonym, with `customer_id` nulled: it names no
 * person and proves the erasure happened.
 */
export const PLAN_SELF_EXEMPT: readonly string[] = ['data_requests', 'data_request_steps'];

/** Steps that actually do something, in execution order. */
export function activeSteps(): readonly CascadeStep[] {
  return CASCADE_PLAN.filter((step) => step.reach.kind !== 'none');
}

export function stepFor(table: string): CascadeStep | undefined {
  return CASCADE_PLAN.find((step) => step.table === table);
}
