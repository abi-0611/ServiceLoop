# Incident playbooks

Four failures with enough shape to plan for. Each has a decision to make in the
first five minutes, and each says what that decision is rather than making you
derive it while a shop's phone is ringing.

A note that applies to all four: **the degraded mode is usually to involve a
person, not to try harder.** Every ladder in this system ends in an advisor
task, and an incident is the moment that design pays for itself. If in doubt,
turn the automation down and let the humans work.

---

## WhatsApp outage {#whatsapp-outage}

*Meta is down, our number is restricted, or the token is dead.*

### First five minutes

1. **Which is it?** They have different responses and look identical from here.
   ```bash
   gcloud logging read 'jsonPayload.component="whatsapp" AND severity>=WARNING' --limit 30
   ```
   | Error kind | Means | Response |
   | --- | --- | --- |
   | `PROVIDER_UNAVAILABLE` | Meta is down | Wait; the circuit breaker is already routing round it |
   | `AUTH_FAILED` | Token expired or permission revoked | Rotate the token, below |
   | `RATE_LIMITED` | We are sending too fast | Lower `WHATSAPP_SEND_PER_SECOND` |
   | `INVALID_RECIPIENT` on everything | The number is restricted | Meta Business Manager; this is a quality problem, not an outage |

2. **Check <https://metastatus.com>** before anything else if it is
   `PROVIDER_UNAVAILABLE`. Half of these incidents are twenty minutes long and
   need nothing from us.

### What the system is already doing

The circuit breaker opens after three consecutive transport failures and stays
open for a minute at a time. While it is open:

- Shops with `smsFallback.enabled` and a registered DLT template for the message
  get **SMS**. The message row still records `WHATSAPP` as the channel it was
  written for and `SMS` as the channel that carried it, so the reconciliation
  afterwards is possible.
- Shops without it get a **failed send**, and the escalation ladder raises the
  advisor task it raises for any unsendable rung. A person rings the customer.
  That is worse than WhatsApp and much better than silence.

Neither happens for a *business rejection* — a template Meta refused, an invalid
number — because falling back on those would send over SMS a message WhatsApp
refused for a reason.

### If it is the token

```bash
echo -n "$NEW_TOKEN" | gcloud secrets versions add serviceloop-whatsapp-token-prod --data-file=-
gcloud run services update serviceloop-api-prod --region asia-south1 --update-secrets WHATSAPP_ACCESS_TOKEN=serviceloop-whatsapp-token-prod:latest
gcloud run services update serviceloop-workers-prod --region asia-south1 --update-secrets WHATSAPP_ACCESS_TOKEN=serviceloop-whatsapp-token-prod:latest
```

Both services. Forgetting the workers leaves an API that can send and a ladder
that cannot, which looks like an intermittent fault for a day.

### If you want to stop the SMS spend

```bash
gcloud run services update serviceloop-workers-prod --region asia-south1 --update-env-vars SMS_FALLBACK_ENABLED=false
```

SMS costs per message where WhatsApp costs per conversation, and a long outage
on a busy shop is a real bill. Turning it off converts the outage into advisor
tasks.

### Afterwards

Messages that failed entirely are in `messages` with `status = 'FAILED'`. They
are not retried automatically — a stale ready-alert is worse than none:

```sql
select id, conversation_id, purpose, error_code, created_at
from messages where status = 'FAILED' and created_at > now() - interval '4 hours';
```

Decide per message whether it is still worth sending. Most status updates are
not; approval requests are.

---

## Telco failure {#telco-failure}

*Exotel is down, calls are failing, or — worse — calls are connecting and going
silent.*

### The kill switch first

```bash
gcloud run services update serviceloop-workers-prod --region asia-south1 --update-env-vars VOICE_KILL_SWITCH=true
```

Read per call rather than captured at boot, so it takes effect on the next one
without a restart. **Use it early.** A voice pipeline that is half-working is
worse than one that is off: a customer who answers and hears nothing forms an
opinion about the shop that a failed call does not.

With voice off, every `VOICE_OR_ADVISOR` rung falls back to the advisor task it
raised in phase 3. The ladder keeps climbing; a person makes the call.

### Then diagnose

| Symptom | Likely cause |
| --- | --- |
| Originations rejected outright | Credentials, or the caller ID is not verified |
| Calls connect, then silence | The media leg. Check `serviceloop_speech_latency_seconds` by stage |
| Calls connect, agent talks over the caller | Endpointing. `VOICE_ENDPOINT_SILENCE_MS` too low |
| Everything slow | `serviceloop_voice_turn_latency_seconds` p95 above ~1.2s means callers start talking over the agent |

The speech stack has its own failover (Sarvam → Google) with its own threshold,
so a speech-provider outage should not need this playbook at all. If it did, the
Google fallback is not configured — check the boot log, which says so explicitly.

### Recovery

Turn the switch back off, then place one test call through the console's
softphone before letting the ladder resume. The loopback adapter is a complete
adapter, so a call that works against it works against Exotel.

---

## LLM provider down {#llm-provider-down}

*Anthropic is erroring, rate-limiting, or timing out.*

### What the system does on its own

This is the failure the autonomy design exists for, and mostly it needs nothing:

- The agent runner's budget is bounded (`agent.maxSteps`, `wallClockBudgetMs`),
  so a failing model exhausts a run rather than hanging.
- An exhausted run raises an **advisor task**, and the objective stays open.
- Nothing free-form is sent. Every message that goes out during an outage comes
  from the reviewed i18n catalogue, because the composer paths that need a model
  simply fail and the templated ones do not.

So the customer experience degrades from "an assistant answered in 30 seconds"
to "an advisor called back in an hour". That is the intended shape.

### What to do

1. **Confirm it is them.** `serviceloop_llm_calls_total{outcome="error"}` by
   model. A single task class failing is a prompt or a model-id problem, not an
   outage.

2. **Decide whether to shed load.** If the provider is rate-limiting, the
   retries are making it worse. Lower `LLM_MAX_RETRIES` to 1 to stop the
   amplification.

3. **Consider dropping shops to L0** if the outage will be long. At `L0` the
   agent does not draft at all, so the advisor queue fills with tasks rather
   than with drafts to review — which is less work per task for the same
   outcome. This is per shop and audited.

4. **Do not** point `LLM_DRIVER` at the sandbox adapter to "keep things
   moving". It composes plausible-looking text from fixtures, and production
   refuses it for exactly this reason: a message that reads correctly and was
   never grounded in a real job card is the worst thing this system could send.

### Afterwards

Advisor tasks raised during the outage are in the queue with their objectives
still open. They do not expire. The shop works through them; nothing needs
replaying.

---

## Data breach {#data-breach}

*Unauthorised access to customer data — a leaked credential, an exposed
database, a compromised laptop with console access.*

This section is a legal procedure as much as a technical one. **The DPDP Act
2023 requires notification to the Data Protection Board and to affected data
principals, without the delay the Act calls "undue".** Treat the clock as
starting when you become aware, not when you finish investigating.

### Hour one — contain

1. **Revoke, do not investigate first.** Investigation can happen after the
   door is shut.
   ```bash
   # Every console session, everywhere. Refresh families are keyed in Redis.
   gcloud redis instances describe serviceloop-prod --region asia-south1
   redis-cli -h <host> --scan --pattern 'auth:refresh:*' | xargs redis-cli -h <host> del
   redis-cli -h <host> --scan --pattern 'auth:family:*' | xargs redis-cli -h <host> del
   ```
   Everybody signs in again with an OTP to their own phone. That is the
   inconvenience it is meant to be.

2. **Rotate every credential the compromised principal could reach.** The list
   is `SHARED_SECRETS` in `infra/deploy/env.prod.sh`. Rotate them all rather
   than reasoning about which were exposed; reasoning about that under pressure
   is how one gets missed.

3. **Do not rotate `PII_ENCRYPTION_KEY` yet.** It is a multi-step procedure
   ([key-rotation.md](key-rotation.md)) and doing it wrong makes the data
   unreadable to *us* as well. It is also rarely the right response: the key
   protects data at rest, and a breach through the application had the
   plaintext anyway.

### Hours two to twenty-four — establish scope

The audit chain is the instrument here, and it is why it exists.

```bash
pnpm audit:verify
```

```sql
-- What did this principal do?
select seq, action, entity_type, entity_id, created_at, trace_id
from audit_events where actor_id = '<staffId>' and created_at > '<since>'
order by seq;
```

```sql
-- Which customers were read? Every console read of a conversation is audited.
select distinct payload->>'customerId'
from audit_events
where actor_id = '<staffId>' and action like '%.read' and created_at > '<since>';
```

Write down, specifically: **which data principals**, **which categories of
data**, and **over what period**. The notification requires all three, and
reconstructing them later from logs that have rotated is not possible.

### The notification

- **The Board.** Via the prescribed form, as soon as the scope above is
  established. Do not wait for the investigation to conclude.
- **Affected data principals.** Directly, in a language they read — the same
  three the product supports. What was accessed, what you are doing, what they
  should do.
- **The shop.** They are the data fiduciary; we are processing on their behalf.
  They are notifying, and we are helping them do it. Say so plainly and early.

Draft text for both notifications is in
[../privacy/breach-notification.md](../privacy/breach-notification.md), so that
the first draft is not written at 2am.

### Afterwards

A written post-incident note, in the repository, in `docs/incidents/`. Not for
process reasons: the third time something like this happens, the note from the
first time is the only thing that makes the response fast.
