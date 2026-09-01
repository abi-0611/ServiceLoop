# Answering a data-protection request

What to do when a customer asks for their data, or asks to be forgotten. This is
the operator's procedure; the retention carve-outs are in
[retention.md](retention.md) and the notices customers read are the
`notice-*.md` files beside this one.

## The two requests

The Act gives a data principal several rights. Two of them are workflows in this
system:

- **Access** — a copy of everything held about them, as a ZIP.
- **Erasure** — destruction of their personal data, with documented carve-outs.

**Correction is deliberately not a workflow.** A customer correcting their name
or phone number is an ordinary edit an advisor makes at the counter, already
audited. Modelling it as an asynchronous request with a queue would turn a
five-second fix into a ticket.

## Taking the request

Anyone may take it — an advisor at the counter, or the customer on their own
WhatsApp thread. Go to **`/settings/privacy`** and lodge it against the
customer's record.

Enter what they actually said in the detail field, in their words. It goes into
the audit trail and the completion report unaltered, because "delete everything
except my invoices" and "delete everything" are different requests and a
paraphrase loses the difference.

Nothing happens yet. The request is `RECEIVED` and unverified.

## Verifying who is asking

**This is the step that protects the customer, and it is the one under time
pressure to skip.** Somebody who can name a customer and their car can ask for
that customer's data, and an unverified export is a data breach performed by the
shop on request.

Three ways, all offered on the screen:

| Method | Use when |
| --- | --- |
| `OTP_TO_NUMBER_ON_FILE` | The default. A code to the number already on the record — not a number they give you now. |
| `STAFF_ATTESTED_IN_PERSON` | They are standing there with an ID. The advisor is attesting; their name is on it. |
| `AUTHENTICATED_THREAD` | The request arrived on the customer's own WhatsApp thread, which is already bound to their number. |

If you cannot verify, **reject with a reason**. The customer is entitled to be
told, so the reason must be one you can give them. The API refuses a rejection
shorter than ten characters, which is a crude proxy for "an actual sentence".

## Approving

**Owner only.** Not because an advisor is untrusted, but because this is the
point of no return and a shop should have exactly one person who can reach it.
The RBAC matrix asserts it, so loosening it is a diff a reviewer sees.

Verifying identity and deciding to destroy the shop's records are different
judgements. In a two-person workshop they are often the same person a minute
apart — the columns are separate so the audit answers both questions.

### The grace window

An approved **deletion** is `SCHEDULED`, not run. The window is
`privacy.deletionGraceDays` in shop config, default one day.

It exists because a deletion aimed at the wrong customer has no undo, and this
interval is the only place that mistake can be caught. During it the request can
be cancelled from the same screen.

The window can be waived by the owner with a written reason, which is audited.
It is deliberately awkward rather than absent: a customer standing at the counter
who wants it done before they leave is a real case, and refusing outright would
get the shop's grace window set to zero for every request instead of for the one
that needed it.

An **export** has no grace window. Nothing is destroyed by it.

## What runs, and when

The `DataRequestSentinel` in the workers process polls every
`DPDP_SCAN_MS` (default two minutes) for approved requests past their scheduled
time, and executes them. Nobody has to press anything.

"Run now" on the console exists for the case where somebody is waiting at the
counter. It refuses a request still inside its window — it is not a way round
the grace period.

**If a request fails**, it goes to `FAILED` with the reason on it, and the
sentinel does not retry it. That is deliberate: a request that cannot complete
should stop asking rather than loop on the same exception until somebody reads
the logs. Restarting it is a person's decision, because the failure usually
means something about the cascade plan is wrong. Escalate rather than retrying
blindly.

## Delivering an export

The archive is written to object storage and a **single-use, expiring link** is
sent to the customer's own WhatsApp thread. The token is 256 bits, stored only
as a SHA-256 hash, and expires after `DPDP_EXPORT_TTL_HOURS` (default 72).

The filename carries the pseudonym, not the customer's name — a file called
`serviceloop-export-ramesh-kumar.zip` in a phone's Downloads folder is a small
privacy leak to everyone who borrows that phone.

**The archive contains a media *index*, not the photographs.** A customer's
photos can be tens of megabytes and this is delivered to a phone. Each entry
carries the date, kind, size and its own expiring link. This is a deliberate
deviation from "everything in one file" and it is stated in the archive's own
README.

## What a completed deletion looks like

The console row names **nobody**. `customer_id` is gone from the request, and
the row identifies itself by its pseudonym.

That is correct, and worth saying to anyone who reports it as a bug: the erasure
is meant to have happened. A console that still displayed the name would mean it
had not.

Attached to the request is a **completion report**: one line per table, what was
done to it, and how many rows. Section 8 of the Act makes the fiduciary
accountable for erasure, and "we ran a delete" is not an answer to "show me". A
per-table record written inside the same transaction as the deletion is.

Send the customer the summary. They asked to be forgotten; telling them it is
done is the last thing you owe them.

## Proving it worked

The four probes, in `pnpm demo:phase7`. Run them if anyone ever asks — including
the shop's own owner, who is entitled to.

1. **The PII is unrecoverable in raw SQL.** The customer row survives as a
   tombstone (retained invoices carry a `NOT NULL RESTRICT` link to it), with
   name and phone overwritten and the phone blind index destroyed so they can
   never be found by number again. No name or number in any message, thread or
   audit payload.
2. **Invoices are retained**, intact, with the identity replaced by the
   pseudonym and a retention clock written on.
3. **The audit chain still verifies.** Payloads are rewritten in place; the
   row's own hash is left alone and the row is marked `payload_redacted`, so the
   verifier reports redaction rather than corruption.
4. **The metric rollups are unmoved.** A deletion that shifted last quarter's
   revenue would make every figure the shop is judged on unauditable.

## Escalating a grievance

If a customer is not satisfied, the grievance officer named on the privacy
notice handles it. That contact is per-shop configuration
(`privacy.grievanceContact*`), falling back to the deployment-wide
`DPDP_GRIEVANCE_*` — which is the platform accepting the duty on the shop's
behalf until the shop supplies its own. It is stated plainly on the notice which
of the two is in force.

Beyond that, the customer may complain to the Data Protection Board of India.
Do not attempt to talk them out of it.

## If a breach has happened

Stop reading this and go to
[runbooks/playbooks.md](../runbooks/playbooks.md) — the breach-response section.
It has the notification duties and the clock.
