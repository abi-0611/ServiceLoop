# Retention and the erasure carve-outs

What survives a deletion request, why, and for how long. The authority for this
document is `packages/domain/src/privacy/cascade-plan.ts` — every row below has
a `rationale` there, and if the two ever disagree, **the code is right and this
page is stale**.

## The three outcomes

Every table the cascade touches gets exactly one of these, and the distinction
between them is the whole of DPDP compliance in this system.

| | What happens | Used for |
| --- | --- | --- |
| **PURGED** | Rows destroyed | Personal data with no other basis to exist |
| **PSEUDONYMISED** | The row survives; every identifier is replaced by a one-way pseudonym | Where a *number* or a *link* must survive |
| **RETAINED** | The row is kept intact under a statutory carve-out, with its retention clock recorded | Tax records |

The pseudonym is `HMAC(blindIndexKey, shopId ‖ customerId)`, hex, prefixed
`sub_`. Reproducible for a second request about the same person, useless to
anybody without the key, and scoped per shop — one shop's pseudonym must not
identify the same person in another's records.

## What is retained, and until when

| Table | Basis | Clock starts | Default |
| --- | --- | --- | --- |
| `invoices` | CGST Act 2017 s.36 — books and accounts | `issued_at` | 8 years |
| `invoice_lines` | A tax invoice without its lines is not a tax invoice | invoice's `created_at` | 8 years |
| `payments` | A retained invoice with its receipts removed would not reconcile | `created_at` | 8 years |

Configurable per shop as `privacy.invoiceRetentionYears`, deployment default
`DPDP_INVOICE_RETENTION_YEARS`. Eight years is the conservative reading: GST law
says six years from the annual return due date, and the Income Tax Act's
reassessment window reaches further. A shop with advice to the contrary can
shorten it; nobody should lengthen it without a reason written down.

**§8(7)(a) of the DPDP Act is what permits this.** A retention obligation
imposed by another law survives an erasure request. What is erased from a
retained invoice is the *identity*: the pseudonym and the retention clock are
written on, the rendered PDF is purged (it has the customer's name printed on
it), and the evidence photographs it reproduced go with the rest of the media.

**A tax record is the ledger row, not a picture of it.**

## What is pseudonymised, and why each one has to be

These are the entries people query, so each has its own reason.

| Table | Why the row cannot simply go |
| --- | --- |
| `customers` | Retained invoices carry a `NOT NULL RESTRICT` link to it. Deleting the row would either destroy the tax record or leave a dangling key. Name and phone are overwritten, the blind index is destroyed, `erased_at` is set. |
| `vehicles` | `job_cards.vehicle_id` is `NOT NULL RESTRICT`. The registration is destroyed — it identifies a person as reliably as a phone number and more permanently — leaving a row whose registration is a per-row token with make, model, colour and odometer cleared. |
| `job_cards` | The unit every retained invoice and every metric hangs from. |
| `audit_events` | The chain is hash-linked. Deleting rows breaks every hash after them and destroys the shop's ability to prove anything about anybody. Payloads are rewritten in place with the trigger briefly disabled inside one transaction; the row's own hash is **left alone**, and `payload_redacted` marks it so the verifier reports redaction rather than corruption. |
| `metric_rollups` | A deletion that moved last quarter's revenue would make the figures unauditable. The counts stay; anything naming a person goes. |
| `owner_digests` | A stored digest may quote a registration in its body. The registration is redacted; the figures stay, for the same reason the rollups do. |
| `calls`, `call_usage` | The minute counts feed cost reconciliation. The turns and the recordings are purged. |
| `llm_usage` | Token counts and spend. No content. |
| `payment_events` | The gateway's own record of a retained payment. |

## What is purged

Everything else that reaches the customer: messages, conversations, consents,
media assets, call turns and consent events, every retention artefact
(touches, holds, feedback, forecasts, documents, odometer readings, the declined
work ledger), delivery bookings, gate passes, status signals, ETA entries,
evidence bundles, approvals, estimates and their lines, work items, agent runs
and steps, advisor tasks, escalations, intake drafts, merge suggestions, and
outbox events.

## The clocks that run without a request

Erasure is not the only thing that removes data. Two retention clocks run on
their own:

- **Call recordings** — `voice.recordingRetentionDays`. A recording is the most
  sensitive artefact this system holds and the least often needed after the fact.
- **Media assets** — retained while the job card is open and for a period after
  delivery, so a customer coming back about the same job still has the evidence.

Neither is a DPDP obligation; both are the principle that data you no longer
need is data you should not hold.

## Keeping this page honest

The cascade plan is code and this is prose, so they can drift. Two things stop
that mattering:

1. **`cascade-plan.test.ts` asserts the plan covers every table in the schema.**
   A table added without a decision about what an erasure does to it fails the
   build. That is the check that matters — a missing table would otherwise be
   silently retained for ever.
2. **The completion report is generated from the plan**, not from this document.
   What a customer is told happened is what actually happened.

If you change the plan, change this page in the same commit. If you find them
disagreeing, the code is right.
