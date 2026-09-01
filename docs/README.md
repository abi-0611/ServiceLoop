# ServiceLoop operations

Everything a two-person team needs to run this, written to be executed rather
than read. The acceptance test for this directory is specific: *a teammate, or a
fresh Claude Code session given only `docs/`, can deploy to staging and onboard a
shop without asking a question.* Where that has failed in practice, the gap is
recorded at the foot of the page it failed on.

## Start here

| I need to… | Read |
| --- | --- |
| Understand what runs where | [architecture.md](architecture.md) |
| Deploy, promote or roll back | [deploy.md](deploy.md) |
| Respond to an alert | [runbooks/alerts.md](runbooks/alerts.md) |
| Handle an outage | [runbooks/playbooks.md](runbooks/playbooks.md) |
| Start or stop something | [runbooks/operations.md](runbooks/operations.md) |
| Put a new shop live | [onboarding.md](onboarding.md) |
| Take the product live at all | [go-live-checklist.md](go-live-checklist.md) |
| Answer a data-protection request | [privacy/dpdp.md](privacy/dpdp.md) |
| Rotate the PII encryption key | [runbooks/key-rotation.md](runbooks/key-rotation.md) |
| Restore from backup | [runbooks/backup-restore.md](runbooks/backup-restore.md) |
| Read the load-test results | [perf/README.md](perf/README.md) |
| Find the retention carve-outs | [privacy/retention.md](privacy/retention.md) |
| Notify about a breach | [privacy/breach-notification.md](privacy/breach-notification.md) |
| Print the privacy notice for a counter | [privacy/notice-en.md](privacy/notice-en.md) · [ta](privacy/notice-ta.md) · [hi](privacy/notice-hi.md) |

## The three things that are always true

Read these before anything else. Most incidents are one of them being violated.

**1. Every customer-facing message passes `OutboundGate`.** Consent, the
24-hour window, quiet hours, frequency caps, autonomy level, claim anchoring and
the retention floor are all enforced in one place. There is no second send path,
and `no-bypass.test.ts` walks the repository on every build to prove it. If you
are ever tempted to add one — for a "quick" notification, a test, a migration —
the answer is no, and the reason is that every rule above would silently stop
applying to it.

**2. Nothing is deleted; things are transitioned.** The audit chain is
append-only and hash-linked, the outbox is the only way an event leaves a
transaction, and a customer erasure pseudonymises rather than truncates. If a
procedure in here tells you to `DELETE` from a table, it is wrong — with the
single exception of the DPDP cascade, which is a declared plan with a completion
report and its own approval step.

**3. `DEMO_MODE` forces every sandbox adapter, regardless of credentials.** A
developer with a live WhatsApp token in their shell cannot message a real
customer. Production refuses to boot with `DEMO_MODE=true`, and also refuses to
boot unless every live adapter is named in `ADAPTER_ALLOWLIST`. If staging
"isn't sending anything", check this first: it is the answer about four times
out of five.

## Conventions in these documents

- **Commands are copy-pasteable** and assume the repository root as the working
  directory.
- **Anything destructive is marked** ⚠ and says what cannot be undone.
- **Every alert names its runbook section**, and every runbook section names the
  alert that brings you to it. If you arrive at an alert with no runbook, that
  is a bug — file it.
- Times are IST (`Asia/Kolkata`) unless stated, because the shops are.
