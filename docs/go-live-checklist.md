# Go-live checklist

Every external dependency, in the order the lead times force. This is a
sequencing document, not a task list: several of these block each other, and the
common failure is discovering on day 20 that something on day 1 was the
prerequisite.

**Fill in the owner and the date for every row before starting.** A row with no
name against it is a row nobody is doing.

Lead times are what to plan for, not best cases. Where the range is wide, the
wide end is the one that happens when something is rejected once — which is
normal, not exceptional.

---

## The critical path

```
  Meta Business verification  ──┐
        (2–15 working days)     │
                                ▼
              WABA + phone number  ──▶  Template submission  ──▶  LIVE
                   (1–3 days)              (1 hour – 14 days)
```

Everything else can run in parallel with this. Nothing else can start it.

**Start Meta Business verification on day one, before anything else, including
before the GCP project.** It is the longest pole, it is the one that gets
rejected for reasons nobody can predict, and every other item can be done while
waiting.

---

## 1 · Meta / WhatsApp Business

| # | Item | Lead time | Owner | Target date | Done |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Meta Business Manager account created | same day | | | ☐ |
| 1.2 | **Business verification** — legal name, address and phone matching the registration documents exactly | **2–15 working days** | | | ☐ |
| 1.3 | WhatsApp Business Account (WABA) created | 1 day | | | ☐ |
| 1.4 | Phone number connected and verified | 1–3 days | | | ☐ |
| 1.5 | System user + permanent access token issued | same day | | | ☐ |
| 1.6 | Webhook subscribed, `WHATSAPP_VERIFY_TOKEN` set, callback verified | same day | | | ☐ |
| 1.7 | App secret stored in Secret Manager as `serviceloop-whatsapp-app-secret-prod` | same day | | | ☐ |
| 1.8 | **Every customer-facing template submitted in EN, TA and HI** | **1 hour – 14 days each** | | | ☐ |
| 1.9 | All templates `APPROVED` — `/settings/templates` reports "Ready" for every row | | | | ☐ |

**1.2 is the one that fails.** The name on the Meta account must match the GST
certificate character for character, including the suffix. "Sri Murugan Auto
Works" and "Sri Murugan Auto Works Pvt Ltd" are different businesses to Meta's
reviewer.

**1.8: submit all three languages at once.** A common and expensive mistake is
submitting English, waiting for approval, then submitting Tamil — which serialises
two multi-day reviews for no reason. The submission body for every language is
on `/settings/templates`, already rendered with the correct positional
placeholders.

A template rejected for `INVALID_FORMAT` is almost always a placeholder problem.
Do not retype the body — copy it from the screen.

---

## 2 · TRAI DLT (only if SMS fallback is wanted)

Skip this section entirely if the shop is not using SMS. It is genuinely
optional, and a shop without it degrades to raising an advisor task when
WhatsApp is unreachable — which is safe, and silent.

| # | Item | Lead time | Owner | Target date | Done |
| --- | --- | --- | --- | --- | --- |
| 2.1 | Entity registration on a DLT portal (Jio/Airtel/Vodafone/BSNL — any one) | **3–10 working days** | | | ☐ |
| 2.2 | Header (sender id) registered — 6 alphanumeric characters | 1–3 days | | | ☐ |
| 2.3 | Content templates registered, one per customer-facing manifest key | **2–7 days each** | | | ☐ |
| 2.4 | Template ids entered in shop config `smsFallback.dltTemplateIds` | same day | | | ☐ |
| 2.5 | `/settings/templates` reports zero missing DLT ids | | | | ☐ |

DLT content templates must match what is actually sent, variable for variable.
Register the *template*, not a sample message.

---

## 3 · Telephony (Exotel)

| # | Item | Lead time | Owner | Target date | Done |
| --- | --- | --- | --- | --- | --- |
| 3.1 | Exotel account + KYC | **3–7 working days** | | | ☐ |
| 3.2 | Number provisioned in the shop's own circle | 1–3 days | | | ☐ |
| 3.3 | Webhook / applet pointed at the API's voice endpoints | same day | | | ☐ |
| 3.4 | **Recording-consent script signed off by the owner, in all three languages** | 1 day | | | ☐ |
| 3.5 | Test call end to end on the loopback, then on the real number | same day | | | ☐ |

**3.4 is a legal item, not a copy item.** The caller must be told the call is
recorded *before* anything is recorded. The owner signs off the wording because
it is their business making the statement.

---

## 4 · Payments (Razorpay)

| # | Item | Lead time | Owner | Target date | Done |
| --- | --- | --- | --- | --- | --- |
| 4.1 | Razorpay account created | same day | | | ☐ |
| 4.2 | **Activation** — PAN, GST, bank proof, business category | **2–7 working days** | | | ☐ |
| 4.3 | Live API keys issued and stored in Secret Manager | same day | | | ☐ |
| 4.4 | Webhook endpoint registered; `RAZORPAY_WEBHOOK_SECRET` set | same day | | | ☐ |
| 4.5 | One real ₹1 payment made and refunded | same day | | | ☐ |

**4.5 is not optional.** A webhook secret that is subtly wrong produces a
signature failure that looks exactly like an attack in the logs, and the first
time you want to discover that is not when a customer is standing at the gate.

---

## 5 · Speech and model providers

| # | Item | Lead time | Owner | Target date | Done |
| --- | --- | --- | --- | --- | --- |
| 5.1 | Anthropic API key, billing enabled, spend limit set | same day | | | ☐ |
| 5.2 | Sarvam AI account and key | 1–2 days | | | ☐ |
| 5.3 | **Sarvam startup credits applied for** — they run a programme; ask | 3–10 days | | | ☐ |
| 5.4 | Google Cloud Speech key (fallback STT) | same day | | | ☐ |
| 5.5 | Per-provider spend alerts configured | same day | | | ☐ |

**5.5 before going live, not after.** The LLM cost per hour is on the cost
dashboard, and the alert rule exists, but a provider-side hard limit is the only
thing that stops a runaway loop at 3am.

---

## 6 · Infrastructure

| # | Item | Lead time | Owner | Target date | Done |
| --- | --- | --- | --- | --- | --- |
| 6.1 | GCP project + **billing account attached** | same day | | | ☐ |
| 6.2 | Artifact Registry repository | same day | | | ☐ |
| 6.3 | Cloud SQL Postgres, **private IP only** | 1 hour | | | ☐ |
| 6.4 | Memorystore Redis | 1 hour | | | ☐ |
| 6.5 | VPC connector | 1 hour | | | ☐ |
| 6.6 | GCS buckets (media, backups) with lifecycle rules | same day | | | ☐ |
| 6.7 | Every secret in Secret Manager | same day | | | ☐ |
| 6.8 | Runtime service account, least privilege | same day | | | ☐ |
| 6.9 | `infra/deploy/deploy.sh staging` green from a clean checkout | same day | | | ☐ |
| 6.10 | Nightly `pg_dump` scheduled **and a restore verified** | 1 day | | | ☐ |
| 6.11 | Alertmanager / Cloud Monitoring routed to a phone somebody answers | same day | | | ☐ |

**6.10: the backup is not done until the restore is done.** An untested backup
is a belief. `pnpm restore:verify` restores into a scratch database and runs the
demo suite against it; the documented target is under 30 minutes.

**6.11: to a phone, not to an email alias.** The outbox-age alert at 2am is
worth being woken for; nothing else in this list is.

---

## 7 · Legal and privacy (DPDP)

| # | Item | Lead time | Owner | Target date | Done |
| --- | --- | --- | --- | --- | --- |
| 7.1 | **Grievance officer named**, with a working email and phone | same day | | | ☐ |
| 7.2 | Privacy notice published at a public URL; `PRIVACY_NOTICE_URL` set | same day | | | ☐ |
| 7.3 | Notice available in EN, TA and HI (`docs/privacy/notice-*.md`) | same day | | | ☐ |
| 7.4 | Printed copy at the counter | same day | | | ☐ |
| 7.5 | Retention carve-outs reviewed with the owner (invoices, 8 years) | 1 day | | | ☐ |
| 7.6 | Consent capture wording reviewed in all three languages | 1 day | | | ☐ |
| 7.7 | Breach-response contacts recorded (who calls whom, and in what order) | same day | | | ☐ |

**7.1 is a statutory publication requirement.** It is not optional and it is not
"the platform's". The data fiduciary is the workshop.

---

## 8 · Cutover

| # | Item | Owner | Target date | Done |
| --- | --- | --- | --- | --- |
| 8.1 | `ADAPTER_ALLOWLIST` set for prod, every live adapter named | | | ☐ |
| 8.2 | `DEMO_MODE=false` confirmed; boot log shows the adapter matrix | | | ☐ |
| 8.3 | `infra/deploy/deploy.sh prod` from a clean tagged checkout | | | ☐ |
| 8.4 | Smoke suite green | | | ☐ |
| 8.5 | **Rollback drill executed once, deliberately, on prod** | | | ☐ |
| 8.6 | **Every flow at L0.** Verified on the guardrails screen, not assumed | | | ☐ |
| 8.7 | Onboarding visit booked ([onboarding.md](onboarding.md)) | | | ☐ |
| 8.8 | First real job card open, in shadow | | | ☐ |
| 8.9 | Day-3 call booked, with a date | | | ☐ |

**8.5 before the first customer, not after the first incident.** The one thing
worse than needing to roll back is discovering during the incident that nobody
has ever done it.

**8.6 is the last gate and the one to be pedantic about.** The product plan's
validation section says the first real shop runs at L0 shadow for every flow.
Open `/settings/guardrails` and read the levels off the screen.

---

## Signed off

| Role | Name | Date |
| --- | --- | --- |
| Shop owner | | |
| Operator | | |
| Grievance officer (DPDP) | | |
