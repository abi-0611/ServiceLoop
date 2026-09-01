# Deploy, promote, roll back

Two environments, three services, one command each way. Everything below assumes
the repository root as the working directory and `gcloud` authenticated against
the project you are targeting.

If you are doing this for the first time on a fresh machine, start at
[First time on this machine](#first-time-on-this-machine) — the deploy itself is
one line, but it needs four things to exist first.

## The one-liner

```bash
infra/deploy/deploy.sh staging
```

That builds three images, runs the migration job, deploys `api`, `workers` and
`console`, and then runs the smoke suite against what it just deployed. It is
idempotent: running it twice is how a failed deploy is retried, and the second
run is how you confirm the first one finished.

Production is the same command with a different word, and one extra gate:

```bash
infra/deploy/deploy.sh prod
```

It **refuses to run against prod from a dirty working tree**. Staging is allowed
it, because staging is where you try things.

## What gets deployed where

| Service | min-instances | Why |
| --- | --- | --- |
| `api` | **1** | A cold start behind a WhatsApp webhook means Meta times out and retries. A retried webhook is a duplicated inbound message that only the idempotency key saves us from. |
| `workers` | **1** | The workers *are* the timers. An escalation rung, a quiet-hours release and the DPDP grace window all fire from polling loops. A worker scaled to zero is a ladder that never climbs. |
| `console` | 0 | Nobody is looking at a board at 3am. A two-second cold start on the first page view of the morning is fine. |

The `workers` line is the single most expensive one in the deployment and the
one most likely to be "optimised" by somebody who has not read why it is there.
It is commented in `infra/deploy/deploy.sh` as well, at the line itself.

## Migrations run as a job

Not from a laptop, and not as a container entrypoint. Three reasons, and the
third is the one that bites:

1. A laptop needs a database password and a route into the VPC. Neither should
   exist on a laptop.
2. A migration in the service's entrypoint runs once per instance, so an
   autoscale event during a deploy runs it concurrently with itself.
3. **A job's exit code is the deploy's gate.** An entrypoint that fails a
   migration and then starts anyway is a service running against a schema it
   does not understand, which is how a column read as null gets written as a
   default.

The deploy script runs the job and waits. If it exits non-zero, nothing is
deployed, and the currently-serving revision is untouched.

## The environment matrix

`DEMO_MODE` and the adapter allow-list are the two switches that decide whether
this deployment can reach a real customer. They are the first thing to check
when something "isn't sending anything", and the answer about four times out of
five.

| | Local | Staging | Prod |
| --- | --- | --- | --- |
| `DEMO_MODE` | `true` | `false` | **must be `false`** — prod refuses to boot otherwise |
| `ADAPTER_ALLOWLIST` | ignored | ignored | **required** — every live adapter named explicitly, loudly logged at boot |
| WhatsApp | sandbox | **live**, test WABA + test number | live |
| LLM | mock/deterministic | **live** (Anthropic) | live |
| Speech / telephony | mock, loopback | mock, loopback | live |
| Payments | mock | **mock** | live |
| SMS | sandbox | sandbox | DLT provider |

**Why staging runs mixed.** Template approval and the 24-hour window cannot be
simulated, and they are where the surprises are — so staging talks to a real
test WABA. Payments and telephony stay on the mock and the loopback, because a
staging bug that charges a card or rings a stranger is a real-world consequence
for a rehearsal.

**Why production names every adapter.** `DEPLOY_ENV=prod` turns on the
allow-list check at boot: a live adapter that is not in `ADAPTER_ALLOWLIST`
refuses to start the process. This exists so that turning on a live payment
adapter is a deliberate edit to a deployment variable that a second person sees,
rather than a consequence of an environment variable being absent.

## Promoting staging to prod

There is no image promotion step, and that is deliberate: `deploy.sh prod`
builds from the same commit rather than moving a tag. Copying an artefact
between projects would make "what is running in production" a question about
registry state rather than about git, and the answer to that question needs to
be a commit hash.

The sequence:

1. Merge to `main`. CI deploys staging and runs the smoke suite automatically.
2. Let it sit. Look at the dashboards ([observability](#observability-after-a-deploy)).
3. `git tag -a v1.x.y -m '...' && git push --tags`
4. `infra/deploy/deploy.sh prod` from a clean checkout of that tag.
5. Watch the smoke suite output. It exits non-zero on the first failure.

The migration gate is inside step 4 and cannot be skipped.

## Rollback

```bash
infra/deploy/rollback.sh prod
```

Shifts 100% of traffic on all three services back to the previous revision. With
a revision name as a second argument it targets that one instead.

**This rolls back code, not data.** Say that out loud before running it. What
makes it safe is the migration policy — expand-migrate-contract, enforced by
`scripts/lint-migrations.mjs` — under which a release only ever adds columns, so
the previous revision can read the new schema. A release that dropped a column
could not be rolled back this way at all, which is exactly why the linter
refuses one without a two-release window.

The drill, and what to check after it, is in
[runbooks/playbooks.md](runbooks/playbooks.md).

### When rollback is the wrong tool

- **A bad migration.** Rolling back the code leaves the migration applied. Write
  a forward fix.
- **Corrupted data.** Rolling back changes nothing about the rows. See
  [runbooks/backup-restore.md](runbooks/backup-restore.md).
- **A leaked secret.** Rolling back does not un-leak it. Rotate first; see
  [runbooks/key-rotation.md](runbooks/key-rotation.md) and the breach playbook.

## Observability after a deploy

The five minutes after a deploy is when the dashboards earn their keep. In
order:

1. **Outbox age** (`serviceloop_outbox_age_seconds`). If this climbs, the
   workers did not start or cannot reach the database. It is the first symptom
   of almost every deploy failure and the alert that inhibits the others.
2. **Webhook 5xx rate.** A schema mismatch shows up here within a minute, as
   Meta retries.
3. **LLM error rate.** A missing or wrong `ANTHROPIC_API_KEY` mounts fine and
   fails on first use.
4. **Queue depth.** A brief spike is a cold start draining. A sustained climb is
   a consumer that did not register.

## First time on this machine

Four things must exist before `deploy.sh` will work.

```bash
gcloud auth login && gcloud auth application-default login
```

```bash
gcloud config set project serviceloop-staging
```

**1. An Artifact Registry repository** named as `ARTIFACT_REPO` in
`infra/deploy/env.staging.sh`:

```bash
gcloud artifacts repositories create serviceloop --repository-format=docker --location=asia-south1
```

**2. Cloud SQL, Memorystore and a VPC connector**, matching
`CLOUD_SQL_INSTANCE` and `VPC_CONNECTOR` in the same file. Postgres on a
**private IP** — the database must not have a public address at all, and the
connector is how Cloud Run reaches it.

**3. Every secret in Secret Manager**, under the names listed in
`SHARED_SECRETS`. Nothing in this repository holds a secret, and the gitleaks CI
step exists to keep that true. Create them with:

```bash
printf '%s' "$VALUE" | gcloud secrets create serviceloop-jwt-secret-staging --data-file=-
```

**4. A runtime service account** with `roles/cloudsql.client`,
`roles/secretmanager.secretAccessor` and object access to the media bucket. It
should have nothing else — in particular not `roles/editor`, which is what
`gcloud` will suggest.

### Verifying a fresh setup

From a clean checkout, with nothing else done:

```bash
infra/deploy/deploy.sh staging
```

If the smoke suite is green, the environment is complete. If it fails at
readiness, the VPC connector or the Cloud SQL instance name is wrong — those two
account for most first-run failures, and both fail the same way.

## When to port this to Terraform

When the resource count doubles. Today it is three Cloud Run services, one Cloud
SQL instance, one Memorystore instance, one bucket and a handful of secrets —
nine things, managed by two people. Terraform's value is drift management across
dozens of resources and several people; at this size its state file is the most
fragile thing in the system.

Port the **networking and IAM first** when you do: those are the resources where
drift is silent and dangerous. Cloud Run services can stay in scripts longest,
because a wrong one is visible immediately.
