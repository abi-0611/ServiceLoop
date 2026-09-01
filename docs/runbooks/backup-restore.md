# Backup and restore

**An untested backup is a belief, not a backup.** The verify half of this page
is the half that matters; the dump half is fifteen lines of `pg_dump`.

## What exists

| | What | Where | Retention |
| --- | --- | --- | --- |
| Cloud SQL automated backups | Instance-level snapshots + PITR | Same project | 7 days |
| **`scripts/backup.sh`** | Nightly logical `pg_dump`, custom format | GCS bucket, **different project** | 30 days |
| Object storage | Media and rendered invoices | GCS, versioned | per lifecycle rule |

Both database backups exist, and the duplication is deliberate. Cloud SQL's
backups are excellent at restoring an instance and useless for the two things
that actually happen:

- *"Restore one shop's data into a scratch database to answer a question."*
- *"The project was deleted."*

A logical dump in a bucket in a **different project** answers both. That the
bucket is in another project is the entire point of it; a backup that a
compromised or deleted project takes with it is not a backup.

## Nightly

Runs as a Cloud Scheduler job at 02:00 IST against a read replica.

```bash
BACKUP_BUCKET=gs://serviceloop-backups-prod scripts/backup.sh
```

It **refuses to upload a dump under 100 KB**. That is the classic silent backup
failure — the connection succeeded, the schema dumped, and no data came with it
— and a job that fails loudly is worth more than an object that looks fine.

Each dump uploads a `.sha256` beside it. The restore checks it, because a
truncated upload restores partially and looks like data corruption three steps
later.

## Restore and verify — the drill

Run this **monthly**, and after any change to the schema or the backup job.

```bash
BACKUP_BUCKET=gs://serviceloop-backups-prod ADMIN_DATABASE_URL=postgres://... pnpm restore:verify
```

To check a specific dump rather than the newest:

```bash
BACKUP_OBJECT=gs://serviceloop-backups-prod/serviceloop/pg/2026-09-01T02-00-00Z.dump pnpm restore:verify
```

It restores into a scratch database and then runs **the product's own checks**
against it. A restore that completes is not a restore that worked — the schema
can come back without the data, the data without the constraints, or the whole
thing with an audit chain that no longer verifies. So:

1. **Every migration in the journal is recorded as applied.** A dump taken
   mid-deploy restores a schema the code cannot read.
2. **There is actually data.** A schema-only restore passes every structural
   check and is worthless.
3. **The audit chain verifies.** This is what distinguishes a good restore from
   a plausible one: the chain is hash-linked, so any row lost, reordered or
   truncated in transit breaks it.
4. **The metrics fold reproduces the stored rollups exactly.** The strongest
   check available — it re-derives the numbers from the event log and compares
   them to what was stored. A partial restore of `events_outbox` fails here and
   nowhere else.

The script prints its own elapsed time, so the number below is measured rather
than remembered.

### Measured restore-and-verify time

| Date | Dump size | Elapsed | By |
| --- | --- | --- | --- |
| *(record each drill here)* | | | |

**Target: under 30 minutes.** If a drill exceeds it, the reason is nearly always
`--jobs` being too low for the instance, not the dump being large.

The scratch database is left in place for inspection. Drop it when done:

```bash
psql "$ADMIN_DATABASE_URL" -c "DROP DATABASE serviceloop_restore_check WITH (FORCE)"
```

## Restoring for real

⚠ Everything here is destructive to the target. Read the whole section first.

### Point in time (Cloud SQL PITR)

For "a bad migration ran twenty minutes ago" or "a script deleted rows". Fastest
path, within the 7-day window.

**Restore to a new instance, never over the live one.** Then compare, then
switch. Restoring in place destroys the evidence of what went wrong, and you
will want it.

```bash
gcloud sql instances clone serviceloop-pg serviceloop-pg-recover --point-in-time '2026-09-01T08:15:00Z'
```

Then: point a scratch environment at the clone, verify, and only then repoint
production.

### From the logical dump

For "the project is gone" or "we need last Tuesday". Slower, and independent of
Cloud SQL entirely.

```bash
gsutil cp gs://serviceloop-backups-prod/serviceloop/pg/<stamp>.dump .
```

```bash
pg_restore --dbname "$TARGET_URL" --no-owner --no-privileges --jobs 4 <stamp>.dump
```

Then run the four verification steps above by hand, or point `restore:verify` at
the object.

### One table, one shop, one question

This is the common case, and the reason the dump is custom-format.

```bash
pg_restore --dbname "$SCRATCH_URL" --table invoices <stamp>.dump
```

No instance to stand up, no production to touch.

## What the backup does not cover

- **Redis.** Deliberately. It holds queues, rate-limit counters and escalation
  timers — all reconstructible. Escalation *rows* live in Postgres; only the
  timers are lost, and they are rescheduled. See the Redis-loss playbook.
- **Secrets.** They are in Secret Manager with its own versioning. A database
  restore into an environment with the wrong `PII_ENCRYPTION_KEY` restores
  unreadable columns — which is why [key-rotation.md](key-rotation.md) says to
  keep a retired key offline for a fortnight.
- **Media objects**, separately. The bucket is versioned; a database restore
  paired with a much later bucket state gives you rows pointing at objects that
  do not exist yet. Media rows tolerate a missing object; the console shows a
  placeholder.

## After any restore

In this order:

1. **Verify the audit chain** — `pnpm audit:verify`.
2. **Recompute the metrics** — `pnpm metrics:recompute --from … --to …`. It must
   report zero changed days. A changed day means the restore is inconsistent
   with the event log, and the number an owner sees would be wrong.
3. **Check the outbox** for events restored as `PENDING` that were already
   dispatched before the dump. The idempotency keys in Redis are gone, so a
   redelivery is possible — this is the one place a restore can send a customer
   a message they already received.
4. **Tell the shop what window was lost**, in plain words, before they find a
   gap themselves.
