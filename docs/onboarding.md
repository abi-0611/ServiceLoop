# Operator manual — putting a shop live in 30 minutes

The half-hour starts when you sit down with the owner and ends when their first
real job card is open and the system is watching it in shadow mode. It does
**not** include the external registrations — Meta verification, DLT, a phone
number — which take days to weeks and must already be done. Those are
[go-live-checklist.md](go-live-checklist.md), and if they are not finished, stop
here and go there.

Print the [config worksheet](#the-config-worksheet) before you go.

---

## Before you arrive (15 minutes, at your desk)

- [ ] The shop's WABA is verified and the number is connected.
- [ ] Every customer-facing template is `APPROVED` in **all three languages**.
      Check `/settings/templates` — the screen says "Ready" only when all of
      them are, and "Blocked on ta, hi" when they are not.
- [ ] If the shop wants SMS fallback: DLT entity and templates registered, ids
      to hand.
- [ ] A shop row and an owner staff row exist. The owner can sign in with their
      own phone number.

If any template is not approved, you can still do everything below — the shop
runs in shadow mode and sends nothing. Say so plainly rather than delaying the
visit; the owner learning the console is worth more than waiting on Meta.

---

## At the shop

### 1. Sit on the same side of the counter (2 min)

Ask them to show you a job they did yesterday. Do not open the console yet. You
are looking for three things and you will need all of them in step 3:

- What they call a car — plate? customer name? "the white Swift"?
- Who actually rings customers about money.
- What time they stop wanting the phone to buzz.

### 2. Sign in and open the board (3 min)

Have **the owner** do this on their own phone, not you on a laptop. If it does
not work on their phone it does not work.

Sign in with the phone number on their staff record. The board is empty. That is
correct and worth saying out loud — it fills from real work, not from a demo.

### 3. The config worksheet (10 min)

This is the conversation, not the form. Fill it in as they talk.

**Languages.** Which do their customers actually write in? Not which they speak
— which they *type*. Set the default to the most common; the rest are detected
per conversation.

**Price floor and discount ceiling.** "If a customer says the brake job is too
expensive, how far down can the system go before it has to ask you?" Their first
answer is usually "it should always ask me". Accept that: floor 100%, ceiling
0%. It is the safe default and they will loosen it themselves in week three.

**Quiet hours.** "When should we never message a customer?" Almost everyone says
9pm to 7am and then remembers Sunday mornings. Ask.

**Working hours.** Different from quiet hours, and the difference confuses
everyone including us: quiet hours are when a *customer* must not be disturbed;
working hours are when a *vehicle* is being worked on. A shop that shuts at 7pm
may still send a ready alert at 8:30pm.

**Digest time.** When does the owner sit down with a cup of tea? That is the
time. Not "end of day" — the actual time.

**SMS fallback.** Only if DLT is registered. Explain the three facts before they
say yes: it costs money per message, it has no buttons so every one-tap action
becomes a phone number, and until their templates are registered it carries
nothing.

### 4. Explain shadow mode (5 min)

This is the most important five minutes of the visit and the one most often
rushed.

> "For the first two weeks the system writes every message but sends nothing.
> You will see each one in the review queue before it would have gone out. If it
> would have said something wrong, you press reject and tell us why. When you
> stop finding things to reject, we turn it on."

What to make sure they understand:

- **Nothing reaches a customer without them pressing send.** Not "usually" —
  never. The autonomy level is `L0` for every flow.
- **Rejecting is the point, not a failure.** A fortnight with no rejections
  means they are not reading them.
- **They can go back.** Graduation is reversible and reverting is not a defeat.

Show them the review queue with a real draft in it. Create one by opening a job
card and moving it to the state that triggers an approval ask.

### 5. Open a real job card (5 min)

A car that is actually in the bay right now. Not a test. The whole thing rests
on the first card being real, because a test card teaches them the system is a
toy.

Walk through: intake → work items → the approval draft appearing in the review
queue. Stop there. Do not send anything.

### 6. What happens next (5 min)

- The digest arrives at the time they chose, tonight.
- You will call in three days. Say the day.
- The number to reach you on, written on paper and left on the counter.

---

## The config worksheet

Print this. Fill it in with a pen. Enter it afterwards.

```
Shop ______________________________  Date ______________  Owner ______________

LANGUAGES        default: en / ta / hi        others in use: ______________

PRICING          price floor        _____ %   (100 = never discount unasked)
                 discount ceiling   _____ %   (0   = always ask the owner)

QUIET HOURS      from _____ to _____          timezone: Asia/Kolkata
WORKING HOURS    from _____ to _____          closed on: ______________

DIGEST           daily at _____                to: owner / owner+advisor

AUTONOMY         all flows start at L0. Graduation criteria on the reverse.

SMS FALLBACK     no  /  yes → sender id ________  DLT entity ________________

STAFF            name ______________ phone ____________ role: owner/advisor/tech
                 name ______________ phone ____________ role: owner/advisor/tech

GRIEVANCE        DPDP contact name ______________ email ____________________
CONTACT          (displayed on the privacy notice; required by law)

WHO RINGS CUSTOMERS ABOUT MONEY: ____________________________________________
WHAT THEY CALL A CAR:            ____________________________________________
```

---

## Graduation criteria

Do not graduate on a calendar. Graduate on evidence, per flow, and one flow at a
time.

| Flow | Move L0 → L1 when | Move L1 → L2 when |
| --- | --- | --- |
| `status` | 20 consecutive drafts approved unedited | 50 more, and no customer complaint about a status message |
| `approval` | 30 approved unedited, **and** the owner can state the price floor from memory | 50 more, and the objection path has been exercised at least twice |
| `delivery` | 20 approved unedited | after `status` has been at L2 for a fortnight |
| `retention` | 20 approved unedited, and the owner has read a re-pitch out loud and agreed with it | only after a full quarter, and never before `approval` |
| `voice` | never automatically. This one is a separate conversation | — |

**A rejection resets nothing formally, and everything informally.** The counter
is consecutive: one rejection puts it back to zero. That is deliberate — the
number is meant to measure trust, and trust does not average.

**Revert immediately, without discussion, if:** a customer complains about a
message they received; a claim goes out that the evidence did not support; or
the owner says they are not sure what the system sent yesterday. The third is
the important one and the easiest to talk somebody out of. Do not.

---

## Common first-week questions

**"It sent nothing all day."** Check `DEMO_MODE` first, then autonomy level,
then template approval, in that order. Four times out of five it is the first.

**"A customer got it in English and they speak Tamil."** The Tamil template
variant is not approved. `/settings/templates` will say so.

**"Can I just message them myself?"** Yes — an advisor reply from the
conversation screen goes out as a human reply. It still passes consent and quiet
hours, and it always will.

**"Why is it asking me about a ₹200 discount?"** Because the discount ceiling is
0%. That was their choice in step 3 and it is the right one for week one.

**"I want to delete a customer's data."** `/settings/privacy`. It is a workflow
with a verification step, an approval and a completion report — not a button.
See [privacy/dpdp.md](privacy/dpdp.md).

---

## Gaps found in practice

*Record here anything a teammate or a fresh session had to ask about. The
acceptance test for this document is that they do not have to.*

- **Nothing recorded yet.** This section is not decoration: the first time
  somebody runs this manual and gets stuck, the gap goes here and then gets
  fixed above.
