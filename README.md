# ServiceLoop

An AI service advisor for independent automotive workshops in India. It owns the customer
follow-up loop — evidence-backed approval chasing, proactive status updates, delivery and
payment, and declined-work recovery — over WhatsApp and voice, in Tamil/Hindi/English, on top of
whatever the garage already uses **including paper job cards**.

> **Status: Phase 1 (Foundation & domain core) complete.** See [`PROGRESS.md`](./PROGRESS.md).

---

## Quickstart

Requires Node 22 (`.nvmrc`), pnpm 9, and Docker.

```bash
docker compose --project-directory . -f infra/compose.yaml up -d && pnpm i && pnpm db:migrate && pnpm db:seed && pnpm dev
```

Then open **http://localhost:3000** and sign in as the demo advisor with `9840012002`. The
sandbox has no SMS provider, so the OTP is shown on screen (DEMO_MODE only).

| Service | URL | Notes |
|---|---|---|
| Console | http://localhost:3000 | Job card board, conversations, guardrails |
| API | http://localhost:3001 | `/health`, `/health/ready`, `/metrics` |
| Workers | — | metrics on http://localhost:9101/metrics |
| MinIO console | http://localhost:9001 | `serviceloop` / `serviceloop` |

If port 5432 is already taken by a local Postgres, set `POSTGRES_PORT` and `DATABASE_URL`
in `.env` (see `.env.example`); the compose file reads them.

### Demo accounts (seeded)

| Phone | Name | Role |
|---|---|---|
| `9840012001` | Murugan Selvam | OWNER |
| `9840012002` | Priya Ramesh | ADVISOR |
| `9840012003` | Karthik Manoharan | TECHNICIAN |

---

## Commands

```bash
pnpm dev            # every app in watch mode
pnpm build          # turbo build across the workspace
pnpm typecheck      # tsc project references
pnpm lint           # eslint flat config
pnpm test:unit      # fast, no docker
pnpm test           # unit + integration (needs docker)
pnpm demo:phase1    # phase 1 acceptance scenario, exits non-zero on failure

pnpm db:migrate     # apply migrations
pnpm db:rollback    # revert the newest migration
pnpm db:seed        # seed the demo shop  (--reset rebuilds from scratch)

pnpm infra:up       # docker compose up
pnpm infra:down     # docker compose down
pnpm infra:reset    # down -v — drops the volumes
```

Console end-to-end tests:

```bash
pnpm --filter @serviceloop/console exec playwright install chromium && pnpm --filter @serviceloop/console run test:e2e
```

---

## Layout

```
apps/
  api/         NestJS — webhooks, REST, auth
  workers/     BullMQ — outbox dispatcher, consumers, escalations
  console/     Next.js — board, inbox, HITL queue, settings
packages/
  domain/      pure TS — entities, state machines, guardrail engine, policies
  db/          drizzle schema, migrations, repositories, seed
  agent-core/  agent runtime, tool registry, prompt assembly, post-checkers
  adapters/    storage/ notifier/ (whatsapp, telephony, speech, payments follow)
  simulator/   scenario runner + phase demos (used in CI)
  shared/      zod schemas, types, i18n strings, utils
  config/      env schema, shop-config schema, DEMO_MODE wiring
infra/         docker compose, deploy scripts
```

## Architecture in one screen

- **Ports & adapters.** Every external dependency is reached through a port with at least two
  adapters — one real, one sandbox. `DEMO_MODE=true` forces the sandbox set and every process
  prints which adapter is live at boot.
- **The state machine is the API.** A job card changes state only through
  `JobCardTransitionService`, which in one transaction validates the guard, writes the state,
  appends a hash-chained audit event, and inserts an outbox row. The console cannot drag a card
  into a new state; there is no endpoint that sets `state` directly.
- **Guardrails are architectural.** Autonomy level, price floor, discount ceiling, quiet hours,
  frequency caps and consent live in a validated `shop_config` document, and AI disclosure is a
  literal `true` in the schema — no patch, prompt or migration can switch it off.
- **Reliability spine.** Transactional outbox → `FOR UPDATE SKIP LOCKED` dispatcher → BullMQ →
  idempotent consumers. Delivery is at-least-once; effects are exactly-once.
- **PII at rest.** Customer name and phone are AES-256-GCM encrypted in Postgres; lookup goes
  through a per-shop HMAC blind index, so one shop's index cannot probe another's.

## Documentation

- [`00_MASTER_PROMPT.md`](./00_MASTER_PROMPT.md) — product laws, stack, domain model
- [`01_PHASE_FOUNDATION.md`](./01_PHASE_FOUNDATION.md) … `07_…` — the phase plan
- [`PROGRESS.md`](./PROGRESS.md) — task log and open questions
