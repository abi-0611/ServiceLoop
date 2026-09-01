# Rotating the PII encryption key

Customer names and phone numbers are encrypted at the column level, so a
database dump, a replica or a backup contains no readable personal data. Those
keys have to be rotatable — on a schedule, and urgently if one leaks.

⚠ **The one mistake that loses data permanently is dropping the retired key too
early.** The ciphertext stays in the column and nothing can read it, for ever.
Everything below is arranged so that mistake requires ignoring a command that
tells you not to.

## How the keys work

Two environment variables, and the relationship between them is the whole
mechanism:

| | |
| --- | --- |
| `PII_ENCRYPTION_KEY` | The key **new writes** use. One key. |
| `PII_KEY_RING` | JSON: every key that can still **decrypt**, by id. Includes the active one. |

The key id lives inside the ciphertext itself (`v1:<keyId>:…`), not in a column
of its own — a column would be a second place the truth lives, and the two would
eventually disagree, at which point a row is reported as rotated and is not.

This gives a **dual-key decrypt window**: during a rotation, rows written last
year and rows written this morning are both readable, and neither the
application nor an operator has to know which is which.

## The procedure

### 1 · Generate the new key

```bash
openssl rand -base64 32
```

Give it an id that sorts and dates: `k3`, `k4`, … or `2026-09`. Never reuse an
id — the id is what the ciphertext points at.

### 2 · Add it to the ring, and make it active

Both, in the same deploy. Adding it to the ring alone rotates nothing; making it
active without adding it to the ring makes every *previous* row unreadable
immediately.

```bash
printf '%s' '{"k2":"<old base64>","k3":"<new base64>"}' | gcloud secrets versions add serviceloop-pii-key-ring-prod --data-file=-
```

```bash
printf '%s' '<new base64>' | gcloud secrets versions add serviceloop-pii-key-prod --data-file=-
```

Then deploy so the services pick up the new secret versions:

```bash
infra/deploy/deploy.sh prod
```

**Confirm before continuing.** The rotation command prints both:

```bash
pnpm pii:rotate --status
```

`Active key` must be the new id and `Readable keys` must list both. If it does
not, the deploy did not pick up the secret and nothing below will work.

### 3 · Rewrite the existing rows

```bash
pnpm pii:rotate
```

Batched and resumable — a shop with a hundred thousand customers is a
multi-minute rewrite, and a single transaction over that holds row locks on the
customers table for its whole duration, which stops every inbound webhook that
needs to resolve a phone number.

Run it until `--status` reports **zero** rows on old keys. It is safe to run
repeatedly and safe to interrupt.

The columns it rewrites are hard-coded rather than discovered, and
`rotate-pii.test.ts` compares that list against the schema on every build. That
test exists because a rotation that silently skipped a column would report
success and leave behind data that step 4 then destroys — it caught three
missing columns the first time it ran.

### 4 · Drop the retired key ⚠

**Only when `--status` reports zero.** This is irreversible.

```bash
pnpm pii:rotate --status
```

```bash
printf '%s' '{"k3":"<new base64>"}' | gcloud secrets versions add serviceloop-pii-key-ring-prod --data-file=-
```

Deploy again. Keep the old key value somewhere offline for a fortnight — not in
the ring, not in the repository. If something surfaces that was missed, it is
recoverable; after a fortnight, destroy it properly.

### 5 · Record it

Date, key id, who did it, and the `--status` output showing zero. In the shop's
operational log, not in a chat thread.

## Rotating urgently, because a key leaked

Same steps, different order of worry. The leaked key can decrypt every row
written under it, and those rows are in every backup taken while it was active.

1. **Do steps 1–3 immediately.** New writes stop using the leaked key within one
   deploy, which bounds the exposure going forward.
2. **The backups are the real problem.** A backup taken yesterday is readable
   with the leaked key and re-encrypting the live database does not change that.
   Decide, deliberately, whether to re-take and destroy — and note that
   destroying backups has its own consequences.
3. **This is a personal-data breach** if the key left your control. Go to the
   breach section of [playbooks.md](playbooks.md); the DPDP notification duties
   and the clock are there.
4. Do **not** skip step 3 to get to step 4 faster. A rushed rotation that drops
   the old key with rows still on it turns a breach into a breach plus permanent
   data loss.

## The other keys

Rotated the same way where they have a ring, and simply replaced where they do
not.

| Secret | Notes |
| --- | --- |
| `BLIND_INDEX_KEY` | ⚠ **Not rotatable in place.** It derives the phone-lookup index *and* the DPDP pseudonyms. Changing it makes every existing customer unfindable by phone and mints new pseudonyms that no longer match retained invoices. Rotating it means rebuilding every index and is a project, not a runbook. |
| `JWT_SECRET` | Rotating signs out every member of staff. Do it at night. |
| `GATE_PASS_SECRET` | Invalidates outstanding gate passes. Do it when no vehicle is waiting at the gate. |
| `WHATSAPP_APP_SECRET` | Must be changed in Meta and here **in the same minute**; webhook signature verification fails closed in between. |
| `RAZORPAY_WEBHOOK_SECRET` | Same simultaneity problem. Payment webhooks fail closed. |

## If you dropped the key too early

Stop writing to the database. The ciphertext is intact — what is missing is the
key.

1. **Find the old key.** Previous Secret Manager *versions* are retained unless
   explicitly destroyed: `gcloud secrets versions list serviceloop-pii-key-ring-prod`.
   This works far more often than people expect, and it is the first thing to
   try.
2. If the version was destroyed, look for the offline copy from step 4.
3. If neither exists, the affected columns are gone. Restore from a backup taken
   before the drop ([backup-restore.md](backup-restore.md)) and accept the data
   loss between then and now — which is why step 4 says to keep the old value
   for a fortnight.
