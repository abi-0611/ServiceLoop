import type { Language } from '../enums';

/**
 * Centralised customer- and staff-facing copy (master §8: never inline
 * customer-facing strings).
 *
 * English is the reference catalogue — every other language must supply the
 * same keys, which the `satisfies` constraint below enforces at compile time.
 * Placeholders use `{name}` syntax and are substituted by `t()`.
 */

const en = {
  'auth.otp.body': 'Your ServiceLoop verification code is {code}. It expires in {minutes} minutes.',
  'auth.otp.sent': 'We sent a code to {phone}.',

  // Mandatory AI disclosure — master §6. Non-removable from first contact.
  'disclosure.first_contact':
    'Hi {customerName}, this is the ServiceLoop assistant messaging on behalf of {shopName}. I am an AI assistant. Reply HUMAN any time to talk to an advisor.',
  'disclosure.voice_intro':
    'Hello, this is an AI assistant calling on behalf of {shopName}. This call may be recorded. Say "agent" at any time to reach a person.',

  'handoff.offer': 'Would you like me to connect you to {advisorName} at {shopName}?',
  'handoff.confirmed': '{advisorName} from {shopName} will call you shortly.',

  'consent.request':
    'May we send you service updates about your {vehicle} on WhatsApp? Reply YES to allow, STOP to opt out at any time.',
  'consent.opt_out_ack':
    'You will not receive further messages from {shopName}. Reply START to resume service updates.',

  'jobcard.opened': 'We have opened job card {code} for your {vehicle} at {shopName}.',
  'jobcard.ready': 'Your {vehicle} is ready for pickup at {shopName}.',

  'approval.request_intro':
    'While inspecting your {vehicle} we found work that needs your approval. Total: {amount}.',
  'approval.granted_ack': 'Thank you. We have started the approved work on your {vehicle}.',
  'approval.declined_ack':
    'Understood — we will skip that work. We have noted it for your next visit.',

  'status.in_progress': 'Work on your {vehicle} is in progress. Expected ready by {eta}.',
  'status.awaiting_parts': 'We are waiting on a part for your {vehicle}. Updated estimate: {eta}.',

  'quiet_hours.deferred': 'Message held until {time} because of the shop’s quiet hours.',

  // Phase 2 — channels, consent and zero-migration intake.
  'identify.unknown_number':
    'Hello! You have reached {shopName}. I am the ServiceLoop assistant, an AI. So I can pull up the right record, could you reply with your vehicle number (for example TN 09 BX 1234)? Reply HUMAN any time to reach an advisor.',
  'consent.granted_ack':
    'Thank you. We will send service updates about your {vehicle} here. Reply STOP any time to opt out.',
  'consent.opt_in_ack': 'Welcome back — service updates from {shopName} are switched on again.',
  'consent.implied_notice':
    'We will use this number for service updates about your {vehicle} at {shopName}. Reply STOP any time to opt out.',

  'intake.draft_summary_header': 'Job card read from your photo — please check {count} fields:',
  'intake.low_confidence_marker': 'not sure',
  'intake.confirm_prompt':
    'Reply with the line number and the correction (for example: 2 = TN 09 BX 4432), or tap Confirm.',
  'intake.confirmed': 'Job card {code} created for {vehicle}.',
  'intake.discarded': 'Discarded — nothing was saved.',
  'intake.correction_ack': 'Updated {field} to {value}.',
  'intake.extraction_failed':
    'I could not read that job card. Please send a clearer photo, or create the card in the console.',
  'intake.edit_in_console': 'Open the draft in the console to edit it: {url}',
  'intake.confirm_failed':
    'That draft could not be turned into a job card: {reason}. Open it in the console to finish it.',

  'media.too_large':
    'That file is {size} — larger than the {limit} we can accept. Could you send a smaller one?',
  'media.unsupported_type':
    'I cannot read {type} files yet. A photo, a voice note or a PDF works well.',
  /* Phase 7.1 - the upload scanner.
   *
   * Neither string names the signature or the scanner. A customer whose phone
   * has picked something up needs to be told plainly and pointed at a person;
   * a diagnosis they cannot act on, or the name of the detection they tripped,
   * helps nobody and helps a deliberate sender quite a lot. */
  'media.infected':
    'That file did not pass our security check, so we have not opened or kept it. Could you try a different photo, or call {shopName}?',
  'media.scan_unavailable':
    'We could not check that file just now, so we have not kept it. Please try again in a few minutes.',

  'error.generic': 'Something went wrong. An advisor at {shopName} will follow up.',

  /* Phase 3 — approval autopilot, objection handling, handoff.
   *
   * Button titles are capped at 20 characters by WhatsApp, in every language.
   * `i18n.test.ts` asserts it, because a title that overflows fails at send
   * time — after the evidence bundle has been built and the customer is
   * waiting. */
  'approval.line_item': '{index}. {description} — {amount}',
  'approval.new_total': 'New total: {amount}',
  'approval.button.approve': 'Approve ✅',
  'approval.button.partial': 'Ask a question 💬',
  'approval.button.call': 'Call me 📞',
  'approval.footer': 'Reply HUMAN any time to reach an advisor.',
  'approval.reminder':
    'Just checking on the estimate for your {vehicle} — we are holding the bay until you decide. Total: {amount}.',
  'approval.partial_ack':
    'Thank you. We are starting the work you approved and have noted the rest for your next visit.',
  'approval.deferred_ack': 'Understood — we have noted it and will raise it again around {when}.',
  'approval.callback_ack': 'An advisor from {shopName} will call you shortly.',
  /* A standing allowed claim: it is true of every job, so it needs no evidence
   * id and the checker exempts it by exact match. */
  'approval.old_parts_offer':
    'You are welcome to inspect the old parts when you collect the vehicle.',
  'approval.owner_check_offer':
    'That is below what I am able to offer. I can check with the owner and come back to you.',
  'approval.call_offer':
    'Would it help if an advisor called you to talk this through? Tap “Call me”.',

  'agent.handoff_ack':
    'I have passed this to an advisor at {shopName}. They will get back to you shortly.',
  'agent.blocked_fallback':
    'Let me get an advisor at {shopName} to answer that properly. They will be in touch shortly.',

  /* --- phase 4: status, ETA, delivery, payment, gate pass ---------------- */

  'status.eta_line': 'Expected ready by {eta}.',
  'status.delay_apology': 'Sorry — there is a delay on your {vehicle}.',
  'status.earlier_intro': 'Good news about your {vehicle}.',
  'status.work_started': 'Work has started on your {vehicle}.',
  'status.awaiting_parts_notice': 'Your {vehicle} is waiting on a part.',

  'eta.reason.intake': 'This is the time we estimated when the vehicle came in.',
  'eta.reason.work_approved': 'This is because of the extra work you approved.',
  'eta.reason.work_declined': 'This is after leaving out the work you decided against.',
  'eta.reason.blocked_parts': 'The part we need has not arrived yet.',
  'eta.reason.parts_received': 'The part has arrived and fitting has resumed.',
  'eta.reason.technician_hint': 'The technician has given us a firmer time.',
  'eta.reason.work_done': 'The work is finished and only the final check is left.',
  'eta.reason.quality_passed': 'The final check is done.',
  'eta.reason.advisor_override': 'An advisor at {shopName} has updated the time.',

  'delivery.ready_intro': 'Your {vehicle} is ready to collect from {shopName}.',
  'delivery.work_summary': 'Work done: {summary}',
  'delivery.amount_due': 'Amount due: {amount}',
  'delivery.slot_prompt': 'When would you like to collect it?',
  'delivery.slot_option': '{when}',
  'delivery.slot_confirmed': 'Booked — we will have your {vehicle} ready for {when}.',
  'delivery.slot_reminder': 'Reminder: your {vehicle} is booked for collection at {when}.',
  'delivery.no_slots':
    'Tell us when suits you and we will keep your {vehicle} ready at {shopName}.',

  'payment.link_message': 'You can pay {amount} for your {vehicle} here: {url}',
  'payment.received_full': 'Payment of {amount} received — thank you.',
  'payment.received_partial': 'Received {amount}. Balance outstanding: {balance}.',
  'payment.balance_reminder':
    'A gentle reminder about the {balance} outstanding on your {vehicle}. You can pay here: {url}',
  'payment.failed': 'That payment did not go through. You can try again here: {url}',

  'gatepass.issued':
    'Your gate pass for {vehicle}: code {code}. Show this at the gate — it is valid until {expires}.',
  'gatepass.override':
    'An owner at {shopName} has released your {vehicle}. Gate pass code: {code}.',

  'staff.status_confirm': 'Did you mean: {what} {signal} on {registration}?',
  'staff.status_yes': 'Yes ✅',
  'staff.status_edit': 'No, fix it ✏️',
  'staff.status_ambiguous':
    '{signal} — but {count} open cards match. Which vehicle did you mean?',
  'staff.status_applied': 'Noted: {what} on {registration}.',
  'staff.silent_bay_header': '{count} vehicle(s) with no update for over {hours}h:',
  'staff.silent_bay_line': '• {code} {registration} — {state}, quiet {hours}h ({technician})',

  /* --- phase 5: voice layer -------------------------------------------- *
   *
   * The two segments marked ⚿ in the phase file are non-removable: the AI
   * disclosure and the recording notice. `buildCallScript` refuses to produce a
   * script without them, and `assertMandatorySegments` re-checks the composed
   * turn list before a single frame is synthesised — so removing a key here
   * fails a test rather than silencing a legal obligation.
   *
   * Voice copy is written to be *heard*: short sentences, no brackets, no
   * currency symbols a synthesiser reads aloud as "rupee symbol", and every
   * decision point restated as a keypad option for the caller who cannot be
   * understood. */

  /** ⚿ Non-removable. Master §6: AI self-identification at the top of every call. */
  'voice.disclosure':
    'Hello {customerName}. This is the ServiceLoop assistant calling for {shopName}. I am an AI assistant, not a person.',
  /** ⚿ Non-removable. The inbound half of the same obligation. */
  'voice.inbound.greeting':
    'Thank you for calling {shopName}. This is the ServiceLoop AI assistant — I am not a person.',
  /** ⚿ Non-removable. Recording starts only after this has been played. */
  'voice.recording_notice':
    'This call is recorded. Press 0 at any time to speak to {advisorName}.',

  'voice.context': 'I am calling about your {vehicle}, job card {code}.',
  'voice.evidence_recap': 'Our technician found {summary}. That work comes to {amount}.',
  'voice.ask': 'Shall I go ahead with it?',
  'voice.readback': 'So I will go ahead with {summary} at {amount}. Shall I confirm?',
  'voice.readback.decline':
    'So I will leave that work for now and note it for your next visit. Shall I confirm?',
  'voice.readback.defer': 'So I will hold that work and ask you again later. Shall I confirm?',
  'voice.keypad_hint':
    'Say yes, or press 1 to approve, 2 to speak to {advisorName}, 9 to hear it again.',
  'voice.repeat_intro': 'Of course — once more.',
  /** Comfort filler. Played when a turn is going to take longer than the budget. */
  'voice.filler': 'One moment…',
  'voice.no_input': 'Sorry, I did not catch that.',
  'voice.not_understood':
    'I did not quite follow. Press 1 to approve, 2 for {advisorName}, or 9 to hear it again.',
  'voice.ivr_mode':
    'The line is not clear, so let us use the keypad. Press 1 to approve, 2 for {advisorName}.',
  'voice.approved': 'Thank you — I have recorded your approval and the work will start now.',
  'voice.declined': 'Understood. We will leave that work and note it for your next visit.',
  'voice.deferred': 'Understood — we will raise it again around {when}.',
  'voice.objection.price':
    'That is below what I am able to offer. I can check with the owner and call you back.',
  'voice.objection.evidence':
    'The technician photographed it. I will send you the photos on WhatsApp right after this call.',
  'voice.objection.defer': 'That is no problem at all. Nothing has to be decided today.',
  'voice.handoff_offer': 'Would you like me to put you through to {advisorName}?',
  'voice.handoff_bridging': 'Connecting you to {advisorName} now. Please hold.',
  /** Whispered to the advisor leg before the two legs are joined. */
  'voice.whisper': '{customerName}, {vehicle}, job card {code}. {reason}. Amount {amount}.',
  'voice.graceful_exit': 'I will have {advisorName} call you back about this shortly.',
  'voice.pipeline_failure':
    'Sorry — I am having trouble hearing you. I will send the details to your WhatsApp and {advisorName} will follow up.',
  'voice.goodbye': 'Thank you. Goodbye.',
  'voice.inbound.intent_prompt':
    'You can ask about your vehicle, answer an estimate, or book a pickup. What would you like?',
  'voice.inbound.status_answer': 'Your {vehicle} is {state}. {eta}',
  'voice.inbound.booking_prompt': 'When would suit you for collection?',
  'voice.inbound.booking_drafted':
    'I have noted {when}. {advisorName} will confirm it on WhatsApp.',
  'voice.summary_sent': 'I have sent the details to your WhatsApp as well.',
  'voice.missed_call_followup':
    'We tried to call you about your {vehicle}. The estimate is {amount} — reply here and we will take it from there.',
  /* --- Phase 6 — retention, feedback, reminders, digest, alerts ---------- */

  /**
   * The re-pitch (6.3). Continuity of care, not a fresh sales pitch: it names
   * the visit, restates the technician's own finding, and quotes the price the
   * customer was already given.
   */
  'retention.repitch_body':
    'Hello {customerName} — when we serviced your {vehicle} in {when}, our technician flagged {item}: {finding}. {rationale} The price is unchanged from that estimate: {amount}.',
  'retention.repitch_price_changed':
    'Hello {customerName} — when we serviced your {vehicle} in {when}, our technician flagged {item}: {finding}. {rationale} Our price for this has changed since then: it is now {amount} (it was {previousAmount}).',
  'retention.reason.season':
    'With the monsoon starting, this is a good time to have it done.',
  'retention.reason.time_elapsed': 'That was about {months} months ago.',
  'retention.reason.next_visit':
    'Your {vehicle} is with us today, so it can be done in the same visit.',
  'retention.reason.odometer':
    'You mentioned you have driven around {km} km since then.',
  'retention.reason.manual': 'We wanted to check whether you would like it done now.',
  'retention.action.book': 'Book a slot',
  'retention.action.remind': 'Remind me later',
  'retention.action.not_interested': 'Not interested',
  'retention.booked_ack':
    'Thank you — {advisorName} will message you shortly to fix a time for your {vehicle}.',
  'retention.remind_later_ack': 'No problem. We will raise it again in about a month.',
  'retention.not_interested_ack':
    'Understood — we will not bring this one up again. Reply here any time if you change your mind.',
  /** Shown to the advisor in the card drawer, not to the customer (6.2). */
  'retention.next_visit_prompt':
    'While it is here: {item} was deferred on {when} ({amount}). Technician then: {finding}',
  'retention.odometer_ask':
    'While I have you — roughly how many kilometres is your {vehicle} showing now?',
  'retention.odometer_ack': 'Noted, thank you.',

  /* --- 6.4 feedback ------------------------------------------------------ */
  'feedback.ask':
    'How was your visit to {shopName} for your {vehicle}? Tap a face below — and add a note or a voice message if you would like to tell us more.',
  'feedback.option.positive': 'Good 😊',
  'feedback.option.neutral': 'Okay 😐',
  'feedback.option.negative': 'Not good 😞',
  'feedback.thanks_positive': 'Thank you — we are glad it went well.',
  'feedback.review_ask':
    'If you have a minute, a Google review helps a small workshop more than you would think: {link}',
  'feedback.thanks_neutral': 'Thank you for telling us — we have noted it.',
  'feedback.thanks_negative':
    'I am sorry it was not right. I have flagged this to {advisorName} and they will call you about it.',
  'feedback.reminder':
    'A quick one about your {vehicle} at {shopName} — how did the visit go?',

  /* --- 6.5 reminders ----------------------------------------------------- */
  'reminder.service_due':
    'Your {vehicle} is due for its next service around {when}. Would you like me to hold a slot?',
  'reminder.service_due_soon':
    'Your {vehicle}’s next service is due {when}. Shall I book you in?',
  'reminder.document':
    'Your {vehicle}’s {document} expires on {date}. Would you like {shopName} to help with the renewal?',
  'reminder.document.insurance': 'insurance',
  'reminder.document.puc': 'PUC certificate',
  'reminder.enrol_ask':
    'Would you like me to keep track of your {vehicle}’s insurance and PUC renewal dates and remind you before they run out?',
  'reminder.enrol_ack': 'Done — I will remind you before each one is due.',

  /* --- 6.6 marketing consent -------------------------------------------- */
  'consent.marketing_ask':
    'Separately from your service updates: may {shopName} send you reminders and offers for your {vehicle} — service reminders, renewal dates and occasional offers? Reply YES to allow, or STOP at any time.',
  'consent.marketing_granted_ack':
    'Thank you — we will send reminders and offers for your {vehicle}. Reply STOP any time to switch them off.',
  'consent.marketing_revoked_ack':
    'Done — no more reminders or offers. You will still get updates about work in progress.',

  /* --- 6.10 win-back ----------------------------------------------------- */
  'winback.body':
    'Hello {customerName} — it has been about {months} months since we last saw your {vehicle} at {shopName}. {hook} Would you like to book a check-up?',
  'winback.hook.age':
    'At around {age} years, brakes, coolant and belts are usually the things worth a look.',
  'winback.hook.general':
    'A quick health check is usually enough to catch anything before it becomes a bill.',
  'winback.action.book': 'Book a check-up',

  /* --- 6.7 owner digest -------------------------------------------------- */
  'digest.header': '{shopName} — {date}',
  'digest.line.vehicles': 'Vehicles: {in} in, {out} delivered',
  'digest.line.approved': 'Approved today: {amount}',
  'digest.line.recovered': 'Recovered from previously declined work: {amount}',
  'digest.line.approvals_pending': 'Waiting on approval over {hours}h: {count}',
  'digest.line.approval_item': '• {vehicle} — {amount}, waiting {waited}',
  'digest.line.feedback': 'Feedback needing you: {count}',
  'digest.line.silent_bays': 'Bays with no update today: {count}',
  'digest.line.none': 'Nothing outstanding.',
  'digest.action.call': 'I’ll call {vehicle}',
  'digest.action.open_console': 'Open the console',
  'digest.weekly_header': '{shopName} — week to {date}',
  'digest.trend.up': '{label}: {value} ({change} vs last week)',
  'digest.trend.flat': '{label}: {value} (unchanged)',
  'digest.multi_shop_header': 'All shops — {date}',
  'digest.claimed_ack':
    'Noted — {vehicle} is yours. I have stopped nudging about it. It stays on the list until the customer decides.',

  /* --- 6.8 realtime exception alerts ------------------------------------- */
  'alert.approval_stuck':
    '{vehicle}: approval for {amount} has been waiting {waited} with no answer.',
  'alert.negative_feedback':
    '{customerName} rated their visit for {vehicle} poorly. “{comment}” — a recovery task is on {advisorName}’s queue.',
  'alert.payment_failed':
    '{vehicle}: the payment link has failed twice ({amount}). The customer may need another way to pay.',
  'alert.voice_kill_switch': 'Voice calling has been switched off for {shopName}.',
  'alert.silent_bay_repeat':
    '{vehicle} has had no update for {windows} windows running. It may be sitting in a bay nobody is on.',
} as const;

export type StringKey = keyof typeof en;
export type Catalogue = Readonly<Record<StringKey, string>>;

const ta = {
  'auth.otp.body':
    'உங்கள் ServiceLoop சரிபார்ப்பு குறியீடு {code}. இது {minutes} நிமிடங்களில் காலாவதியாகும்.',
  'auth.otp.sent': '{phone} எண்ணுக்கு குறியீடு அனுப்பப்பட்டது.',

  'disclosure.first_contact':
    'வணக்கம் {customerName}, நான் {shopName} சார்பாக செய்தி அனுப்பும் ServiceLoop உதவியாளர். நான் ஒரு AI உதவியாளர். ஆலோசகருடன் பேச HUMAN என்று பதிலளிக்கவும்.',
  'disclosure.voice_intro':
    'வணக்கம், நான் {shopName} சார்பாக அழைக்கும் AI உதவியாளர். இந்த அழைப்பு பதிவு செய்யப்படலாம். நபருடன் பேச "agent" என்று சொல்லுங்கள்.',

  'handoff.offer': '{shopName} இன் {advisorName} உடன் உங்களை இணைக்கவா?',
  'handoff.confirmed': '{shopName} இன் {advisorName} விரைவில் உங்களை அழைப்பார்.',

  'consent.request':
    'உங்கள் {vehicle} பற்றிய சேவை புதுப்பிப்புகளை WhatsApp இல் அனுப்பலாமா? சம்மதிக்க YES, நிறுத்த STOP என்று பதிலளிக்கவும்.',
  'consent.opt_out_ack':
    '{shopName} இடமிருந்து இனி செய்திகள் வராது. மீண்டும் தொடங்க START என்று பதிலளிக்கவும்.',

  'jobcard.opened': 'உங்கள் {vehicle} வாகனத்திற்கு {shopName} இல் job card {code} தொடங்கப்பட்டது.',
  'jobcard.ready': 'உங்கள் {vehicle} {shopName} இல் எடுத்துச் செல்ல தயாராக உள்ளது.',

  'approval.request_intro':
    'உங்கள் {vehicle} வாகனத்தை பரிசோதித்தபோது உங்கள் ஒப்புதல் தேவைப்படும் வேலை கண்டறியப்பட்டது. மொத்தம்: {amount}.',
  'approval.granted_ack':
    'நன்றி. ஒப்புதல் பெற்ற வேலையை உங்கள் {vehicle} வாகனத்தில் தொடங்கிவிட்டோம்.',
  'approval.declined_ack':
    'சரி — அந்த வேலையை தவிர்க்கிறோம். அடுத்த வருகைக்காக குறித்து வைத்துள்ளோம்.',

  'status.in_progress':
    'உங்கள் {vehicle} வாகனத்தின் வேலை நடந்து கொண்டிருக்கிறது. {eta} க்குள் தயாராகும்.',
  'status.awaiting_parts':
    'உங்கள் {vehicle} வாகனத்திற்கான உதிரி பாகத்திற்காக காத்திருக்கிறோம். புதிய மதிப்பீடு: {eta}.',

  'quiet_hours.deferred': 'கடையின் அமைதி நேரம் காரணமாக செய்தி {time} வரை நிறுத்தி வைக்கப்பட்டது.',

  'identify.unknown_number':
    'வணக்கம்! நீங்கள் {shopName} ஐ தொடர்பு கொண்டுள்ளீர்கள். நான் ServiceLoop உதவியாளர், ஒரு AI. சரியான பதிவை எடுக்க, உங்கள் வாகன எண்ணை (எடுத்துக்காட்டு: TN 09 BX 1234) பதிலளிக்க முடியுமா? ஆலோசகருடன் பேச எப்போது வேண்டுமானாலும் HUMAN என்று பதிலளிக்கவும்.',
  'consent.granted_ack':
    'நன்றி. உங்கள் {vehicle} பற்றிய சேவை புதுப்பிப்புகளை இங்கே அனுப்புவோம். நிறுத்த எப்போது வேண்டுமானாலும் STOP என்று பதிலளிக்கவும்.',
  'consent.opt_in_ack': 'மீண்டும் வரவேற்கிறோம் — {shopName} இன் சேவை புதுப்பிப்புகள் மீண்டும் இயக்கப்பட்டன.',
  'consent.implied_notice':
    '{shopName} இல் உங்கள் {vehicle} பற்றிய சேவை புதுப்பிப்புகளுக்கு இந்த எண்ணை பயன்படுத்துவோம். நிறுத்த எப்போது வேண்டுமானாலும் STOP என்று பதிலளிக்கவும்.',

  'intake.draft_summary_header': 'உங்கள் புகைப்படத்திலிருந்து job card படிக்கப்பட்டது — {count} புலங்களை சரிபார்க்கவும்:',
  'intake.low_confidence_marker': 'உறுதியில்லை',
  'intake.confirm_prompt':
    'வரிசை எண்ணும் திருத்தமும் பதிலளிக்கவும் (எடுத்துக்காட்டு: 2 = TN 09 BX 4432), அல்லது Confirm ஐ அழுத்தவும்.',
  'intake.confirmed': '{vehicle} வாகனத்திற்கு job card {code} உருவாக்கப்பட்டது.',
  'intake.discarded': 'நிராகரிக்கப்பட்டது — எதுவும் சேமிக்கப்படவில்லை.',
  'intake.correction_ack': '{field} ஐ {value} ஆக புதுப்பித்தோம்.',
  'intake.extraction_failed':
    'அந்த job card ஐ என்னால் படிக்க முடியவில்லை. தெளிவான புகைப்படத்தை அனுப்பவும், அல்லது console இல் card ஐ உருவாக்கவும்.',
  'intake.edit_in_console': 'திருத்த draft ஐ console இல் திறக்கவும்: {url}',
  'intake.confirm_failed':
    'அந்த draft ஐ job card ஆக மாற்ற முடியவில்லை: {reason}. முடிக்க console இல் திறக்கவும்.',

  'media.too_large':
    'அந்த கோப்பு {size} — நாங்கள் ஏற்கக்கூடிய {limit} ஐ விட பெரியது. சிறியதாக அனுப்ப முடியுமா?',
  'media.unsupported_type':
    '{type} கோப்புகளை என்னால் இன்னும் படிக்க முடியாது. புகைப்படம், குரல் குறிப்பு அல்லது PDF நன்றாக வேலை செய்யும்.',
  'media.infected':
    'அந்த கோப்பு எங்கள் பாதுகாப்பு சோதனையில் தேறவில்லை. அதனை நாங்கள் திறக்கவும் இல்லை, வைக்கவும் இல்லை. வேறு புகைப்படம் அனுப்புங்கள், அல்லது {shopName} ஐ அழைக்கவும்.',
  'media.scan_unavailable':
    'அந்த கோப்பை இப்போது சரிபார்க்க முடியவில்லை, அதனால் வைக்கவில்லை. சில நிமிடங்களில் மீண்டும் முயற்சிக்கவும்.',

  'error.generic': 'ஏதோ தவறு நடந்தது. {shopName} இன் ஆலோசகர் உங்களை தொடர்பு கொள்வார்.',

  'approval.line_item': '{index}. {description} — {amount}',
  'approval.new_total': 'புதிய மொத்தம்: {amount}',
  'approval.button.approve': 'ஒப்புதல் ✅',
  'approval.button.partial': 'கேள்வி கேட்க 💬',
  'approval.button.call': 'அழையுங்கள் 📞',
  'approval.footer': 'ஆலோசகருடன் பேச HUMAN என்று பதிலளிக்கவும்.',
  'approval.reminder':
    'உங்கள் {vehicle} மதிப்பீடு பற்றி நினைவூட்டல் — நீங்கள் முடிவு சொல்லும் வரை வாகனத்தை வைத்திருக்கிறோம். மொத்தம்: {amount}.',
  'approval.partial_ack':
    'நன்றி. நீங்கள் ஒப்புதல் அளித்த வேலையை தொடங்குகிறோம், மீதியை அடுத்த வருகைக்கு குறித்து வைத்துள்ளோம்.',
  'approval.deferred_ack': 'சரி — குறித்து வைத்துள்ளோம், {when} அளவில் மீண்டும் நினைவூட்டுவோம்.',
  'approval.callback_ack': '{shopName} இன் ஆலோசகர் விரைவில் உங்களை அழைப்பார்.',
  'approval.old_parts_offer':
    'வாகனத்தை எடுக்கும்போது பழைய பாகங்களை நீங்கள் பார்வையிடலாம்.',
  'approval.owner_check_offer':
    'அது நான் தர முடிந்த விலையை விட குறைவு. உரிமையாளரிடம் கேட்டு உங்களிடம் திரும்ப சொல்கிறேன்.',
  'approval.call_offer':
    'ஒரு ஆலோசகர் அழைத்து விளக்கினால் எளிதாக இருக்குமா? “அழையுங்கள்” ஐ அழுத்தவும்.',

  'agent.handoff_ack':
    'இதை {shopName} இன் ஆலோசகரிடம் அனுப்பிவிட்டேன். அவர் விரைவில் உங்களை தொடர்பு கொள்வார்.',
  'agent.blocked_fallback':
    'அதற்கு சரியான பதில் தர {shopName} இன் ஆலோசகரை கேட்கிறேன். அவர் விரைவில் தொடர்பு கொள்வார்.',

  'status.eta_line': '{eta} மணிக்கு தயாராகும் என எதிர்பார்க்கிறோம்.',
  'status.delay_apology': 'மன்னிக்கவும் — உங்கள் {vehicle} வாகனத்தில் சிறிது தாமதம்.',
  'status.earlier_intro': 'உங்கள் {vehicle} பற்றி நல்ல செய்தி.',
  'status.work_started': 'உங்கள் {vehicle} வாகனத்தின் வேலை தொடங்கிவிட்டது.',
  'status.awaiting_parts_notice': 'உங்கள் {vehicle} ஒரு பாகத்திற்காக காத்திருக்கிறது.',

  'eta.reason.intake': 'வாகனம் வந்தபோது நாங்கள் மதிப்பிட்ட நேரம் இது.',
  'eta.reason.work_approved': 'நீங்கள் ஒப்புதல் அளித்த கூடுதல் வேலையால் இந்த மாற்றம்.',
  'eta.reason.work_declined': 'நீங்கள் வேண்டாம் என்ற வேலையை விட்டுவிட்ட பிறகான நேரம் இது.',
  'eta.reason.blocked_parts': 'தேவையான பாகம் இன்னும் வந்து சேரவில்லை.',
  'eta.reason.parts_received': 'பாகம் வந்துவிட்டது, பொருத்தும் வேலை மீண்டும் தொடங்கியுள்ளது.',
  'eta.reason.technician_hint': 'தொழிலாளர் இன்னும் உறுதியான நேரம் தந்துள்ளார்.',
  'eta.reason.work_done': 'வேலை முடிந்துவிட்டது, இறுதிச் சோதனை மட்டும் மீதம்.',
  'eta.reason.quality_passed': 'இறுதிச் சோதனை முடிந்துவிட்டது.',
  'eta.reason.advisor_override': '{shopName} இன் ஆலோசகர் நேரத்தை புதுப்பித்துள்ளார்.',

  'delivery.ready_intro': 'உங்கள் {vehicle} {shopName} இல் எடுத்துச் செல்ல தயாராக உள்ளது.',
  'delivery.work_summary': 'செய்த வேலை: {summary}',
  'delivery.amount_due': 'செலுத்த வேண்டிய தொகை: {amount}',
  'delivery.slot_prompt': 'எப்போது வந்து எடுத்துச் செல்ல விரும்புகிறீர்கள்?',
  'delivery.slot_option': '{when}',
  'delivery.slot_confirmed': 'பதிவு செய்தோம் — {when} க்கு உங்கள் {vehicle} தயாராக இருக்கும்.',
  'delivery.slot_reminder': 'நினைவூட்டல்: {when} க்கு உங்கள் {vehicle} எடுக்க பதிவு செய்யப்பட்டுள்ளது.',
  'delivery.no_slots':
    'உங்களுக்கு வசதியான நேரத்தை சொல்லுங்கள், {shopName} இல் உங்கள் {vehicle} தயாராக வைத்திருப்போம்.',

  'payment.link_message': 'உங்கள் {vehicle} க்கான {amount} ஐ இங்கே செலுத்தலாம்: {url}',
  'payment.received_full': '{amount} பெறப்பட்டது — நன்றி.',
  'payment.received_partial': '{amount} பெறப்பட்டது. மீதம்: {balance}.',
  'payment.balance_reminder':
    'உங்கள் {vehicle} க்கான {balance} நிலுவை பற்றிய மென்மையான நினைவூட்டல். இங்கே செலுத்தலாம்: {url}',
  'payment.failed': 'அந்த பணப்பரிமாற்றம் நிறைவேறவில்லை. இங்கே மீண்டும் முயற்சிக்கலாம்: {url}',

  'gatepass.issued':
    '{vehicle} க்கான உங்கள் gate pass: குறியீடு {code}. வாயிலில் காட்டுங்கள் — {expires} வரை செல்லும்.',
  'gatepass.override':
    '{shopName} இன் உரிமையாளர் உங்கள் {vehicle} ஐ விடுவித்துள்ளார். Gate pass குறியீடு: {code}.',

  'staff.status_confirm': 'நீங்கள் சொன்னது: {registration} இல் {what} {signal} — சரியா?',
  'staff.status_yes': 'ஆம் ✅',
  'staff.status_edit': 'இல்லை, திருத்துங்கள் ✏️',
  'staff.status_ambiguous':
    '{signal} — ஆனால் {count} கார்டுகள் பொருந்துகின்றன. எந்த வாகனம்?',
  'staff.status_applied': 'குறித்துக்கொண்டோம்: {registration} இல் {what}.',
  'staff.silent_bay_header': '{hours} மணி நேரத்திற்கு மேல் புதுப்பிப்பு இல்லாத {count} வாகனம்:',
  'staff.silent_bay_line': '• {code} {registration} — {state}, {hours} மணி அமைதி ({technician})',

  /* --- phase 5: voice layer --------------------------------------------- */
  'voice.disclosure':
    'வணக்கம் {customerName}. நான் {shopName} சார்பாக அழைக்கும் ServiceLoop உதவியாளர். நான் ஒரு AI உதவியாளர், நபர் அல்ல.',
  'voice.inbound.greeting':
    '{shopName} ஐ அழைத்ததற்கு நன்றி. நான் ServiceLoop AI உதவியாளர் — நான் நபர் அல்ல.',
  'voice.recording_notice':
    'இந்த அழைப்பு பதிவு செய்யப்படுகிறது. {advisorName} உடன் பேச எப்போது வேண்டுமானாலும் 0 ஐ அழுத்தவும்.',

  'voice.context': 'உங்கள் {vehicle} வாகனம், job card {code} பற்றி அழைக்கிறேன்.',
  'voice.evidence_recap':
    'எங்கள் மெக்கானிக் {summary} கண்டறிந்தார். அந்த வேலைக்கு {amount} ஆகும்.',
  'voice.ask': 'நான் அதை செய்யத் தொடங்கலாமா?',
  'voice.readback': 'அப்படியானால் {summary}, {amount} க்கு செய்கிறேன். உறுதி செய்யவா?',
  'voice.readback.decline':
    'அந்த வேலையை இப்போது விட்டுவிடுகிறேன், அடுத்த வருகைக்கு குறித்து வைக்கிறேன். உறுதி செய்யவா?',
  'voice.readback.defer':
    'அந்த வேலையை நிறுத்தி, பிறகு மீண்டும் கேட்கிறேன். உறுதி செய்யவா?',
  'voice.keypad_hint':
    'ஆம் என்று சொல்லுங்கள், அல்லது ஒப்புதலுக்கு 1, {advisorName} உடன் பேச 2, மீண்டும் கேட்க 9 ஐ அழுத்தவும்.',
  'voice.repeat_intro': 'கண்டிப்பாக — இன்னொரு முறை.',
  'voice.filler': 'ஒரு நிமிஷம்…',
  'voice.no_input': 'மன்னிக்கவும், எனக்கு கேட்கவில்லை.',
  'voice.not_understood':
    'சரியாக புரியவில்லை. ஒப்புதலுக்கு 1, {advisorName} க்கு 2, மீண்டும் கேட்க 9 ஐ அழுத்தவும்.',
  'voice.ivr_mode':
    'லைன் சரியாக இல்லை, கீபேட் பயன்படுத்துவோம். ஒப்புதலுக்கு 1, {advisorName} க்கு 2 ஐ அழுத்தவும்.',
  'voice.approved': 'நன்றி — உங்கள் ஒப்புதலை பதிவு செய்துவிட்டேன், வேலை இப்போது தொடங்கும்.',
  'voice.declined': 'சரி. அந்த வேலையை விட்டுவிடுகிறோம், அடுத்த வருகைக்கு குறித்து வைக்கிறோம்.',
  'voice.deferred': 'சரி — {when} அளவில் மீண்டும் கேட்கிறோம்.',
  'voice.objection.price':
    'அது நான் தர முடிந்ததை விட குறைவு. உரிமையாளரிடம் கேட்டு மீண்டும் அழைக்கிறேன்.',
  'voice.objection.evidence':
    'மெக்கானிக் புகைப்படம் எடுத்துள்ளார். இந்த அழைப்புக்கு பிறகு WhatsApp இல் அனுப்புகிறேன்.',
  'voice.objection.defer': 'பரவாயில்லை. இன்றே முடிவு எடுக்க வேண்டியதில்லை.',
  'voice.handoff_offer': '{advisorName} உடன் இணைக்கவா?',
  'voice.handoff_bridging': '{advisorName} உடன் இணைக்கிறேன். தயவுசெய்து காத்திருங்கள்.',
  'voice.whisper': '{customerName}, {vehicle}, job card {code}. {reason}. தொகை {amount}.',
  'voice.graceful_exit': '{advisorName} விரைவில் உங்களை திரும்ப அழைப்பார்.',
  'voice.pipeline_failure':
    'மன்னிக்கவும் — உங்கள் குரல் சரியாக கேட்கவில்லை. விவரங்களை WhatsApp இல் அனுப்புகிறேன், {advisorName} தொடர்பு கொள்வார்.',
  'voice.goodbye': 'நன்றி. வணக்கம்.',
  'voice.inbound.intent_prompt':
    'வாகனத்தின் நிலை, மதிப்பீட்டுக்கு பதில், அல்லது வாகனம் எடுக்கும் நேரம் — எதைப் பற்றி பேசலாம்?',
  'voice.inbound.status_answer': 'உங்கள் {vehicle} {state}. {eta}',
  'voice.inbound.booking_prompt': 'வாகனத்தை எப்போது எடுக்க வருவீர்கள்?',
  'voice.inbound.booking_drafted':
    '{when} குறித்து வைத்துள்ளேன். {advisorName} WhatsApp இல் உறுதி செய்வார்.',
  'voice.summary_sent': 'விவரங்களை WhatsApp இலும் அனுப்பிவிட்டேன்.',
  'voice.missed_call_followup':
    'உங்கள் {vehicle} பற்றி அழைக்க முயற்சித்தோம். மதிப்பீடு {amount} — இங்கே பதிலளியுங்கள், தொடர்ந்து பேசலாம்.',
  /* --- Phase 6 --- */
  'retention.repitch_body':
    'வணக்கம் {customerName} — {when} இல் உங்கள் {vehicle} வாகனத்தை சர்வீஸ் செய்தபோது, எங்கள் டெக்னீஷியன் {item} பற்றி குறிப்பிட்டார்: {finding}. {rationale} அப்போது கொடுத்த விலையே இப்போதும்: {amount}.',
  'retention.repitch_price_changed':
    'வணக்கம் {customerName} — {when} இல் உங்கள் {vehicle} வாகனத்தை சர்வீஸ் செய்தபோது, எங்கள் டெக்னீஷியன் {item} பற்றி குறிப்பிட்டார்: {finding}. {rationale} அதன் பிறகு விலை மாறிவிட்டது: இப்போது {amount} (அப்போது {previousAmount}).',
  'retention.reason.season': 'மழைக்காலம் தொடங்குவதால், இதை இப்போது செய்வது நல்லது.',
  'retention.reason.time_elapsed': 'அது சுமார் {months} மாதங்களுக்கு முன்பு.',
  'retention.reason.next_visit':
    'உங்கள் {vehicle} இன்று எங்களிடம் இருப்பதால், இதே வருகையில் செய்துவிடலாம்.',
  'retention.reason.odometer': 'அதற்குப் பிறகு சுமார் {km} கி.மீ ஓட்டியதாக சொன்னீர்கள்.',
  'retention.reason.manual': 'இப்போது செய்ய விரும்புகிறீர்களா என்று கேட்க நினைத்தோம்.',
  'retention.action.book': 'நேரம் பதிவு செய்ய',
  'retention.action.remind': 'பிறகு நினைவூட்டவும்',
  'retention.action.not_interested': 'வேண்டாம்',
  'retention.booked_ack':
    'நன்றி — உங்கள் {vehicle} வாகனத்திற்கு நேரம் நிர்ணயிக்க {advisorName} விரைவில் தொடர்பு கொள்வார்.',
  'retention.remind_later_ack': 'பரவாயில்லை. சுமார் ஒரு மாதத்தில் மீண்டும் கேட்கிறோம்.',
  'retention.not_interested_ack':
    'சரி — இதைப் பற்றி இனி கேட்க மாட்டோம். மனம் மாறினால் எப்போது வேண்டுமானாலும் இங்கே சொல்லுங்கள்.',
  'retention.next_visit_prompt':
    'வாகனம் இங்கே இருக்கும்போது: {when} அன்று {item} ஒத்திவைக்கப்பட்டது ({amount}). அப்போதைய டெக்னீஷியன் குறிப்பு: {finding}',
  'retention.odometer_ask':
    'ஒரு சிறு கேள்வி — உங்கள் {vehicle} இப்போது சுமார் எத்தனை கிலோமீட்டர் காட்டுகிறது?',
  'retention.odometer_ack': 'குறித்துக் கொண்டேன், நன்றி.',

  'feedback.ask':
    '{shopName} இல் உங்கள் {vehicle} வாகனத்திற்கான வருகை எப்படி இருந்தது? கீழே ஒரு முகத்தை தேர்ந்தெடுங்கள் — மேலும் சொல்ல விரும்பினால் குறிப்போ குரல் செய்தியோ அனுப்பலாம்.',
  'feedback.option.positive': 'நன்றாக இருந்தது 😊',
  'feedback.option.neutral': 'பரவாயில்லை 😐',
  'feedback.option.negative': 'நன்றாக இல்லை 😞',
  'feedback.thanks_positive': 'நன்றி — நன்றாக நடந்ததில் மகிழ்ச்சி.',
  'feedback.review_ask':
    'ஒரு நிமிடம் இருந்தால், Google விமர்சனம் ஒரு சிறிய பட்டறைக்கு நினைப்பதை விட அதிகம் உதவும்: {link}',
  'feedback.thanks_neutral': 'சொன்னதற்கு நன்றி — குறித்து வைத்துள்ளோம்.',
  'feedback.thanks_negative':
    'சரியாக இல்லாததற்கு வருந்துகிறேன். இதை {advisorName} இடம் தெரிவித்துவிட்டேன், அவர் உங்களை அழைப்பார்.',
  'feedback.reminder':
    '{shopName} இல் உங்கள் {vehicle} வருகை பற்றி ஒரு சிறு கேள்வி — எப்படி இருந்தது?',

  'reminder.service_due':
    'உங்கள் {vehicle} அடுத்த சர்வீஸ் {when} அளவில் வர உள்ளது. நேரம் ஒதுக்கட்டுமா?',
  'reminder.service_due_soon':
    'உங்கள் {vehicle} அடுத்த சர்வீஸ் {when} வர உள்ளது. பதிவு செய்யட்டுமா?',
  'reminder.document':
    'உங்கள் {vehicle} வாகனத்தின் {document} {date} அன்று காலாவதியாகிறது. புதுப்பிக்க {shopName} உதவட்டுமா?',
  'reminder.document.insurance': 'இன்சூரன்ஸ்',
  'reminder.document.puc': 'PUC சான்றிதழ்',
  'reminder.enrol_ask':
    'உங்கள் {vehicle} வாகனத்தின் இன்சூரன்ஸ் மற்றும் PUC புதுப்பிப்பு தேதிகளை நான் கவனித்து, முன்கூட்டியே நினைவூட்டவா?',
  'reminder.enrol_ack': 'சரி — ஒவ்வொன்றும் முடிவதற்கு முன் நினைவூட்டுகிறேன்.',

  'consent.marketing_ask':
    'சேவை புதுப்பிப்புகளுக்கு தனியாக: உங்கள் {vehicle} வாகனத்திற்கான நினைவூட்டல்களும் சலுகைகளும் {shopName} அனுப்பலாமா? சம்மதிக்க YES, நிறுத்த எப்போது வேண்டுமானாலும் STOP.',
  'consent.marketing_granted_ack':
    'நன்றி — உங்கள் {vehicle} வாகனத்திற்கான நினைவூட்டல்களும் சலுகைகளும் அனுப்புவோம். நிறுத்த STOP.',
  'consent.marketing_revoked_ack':
    'சரி — இனி நினைவூட்டல்களோ சலுகைகளோ இல்லை. நடந்துகொண்டிருக்கும் வேலை பற்றிய தகவல்கள் தொடரும்.',

  'winback.body':
    'வணக்கம் {customerName} — {shopName} இல் உங்கள் {vehicle} வாகனத்தை கடைசியாக பார்த்து சுமார் {months} மாதங்கள் ஆகிவிட்டன. {hook} ஒரு பரிசோதனைக்கு நேரம் பதிவு செய்யவா?',
  'winback.hook.age':
    'சுமார் {age} வயதில், பிரேக், கூலன்ட், பெல்ட் — இவற்றைப் பார்ப்பது வழக்கம்.',
  'winback.hook.general':
    'ஒரு விரைவான ஹெல்த் செக் பெரும்பாலும் பெரிய செலவாகும் முன்பே பிரச்சினையை பிடித்துவிடும்.',
  'winback.action.book': 'பரிசோதனை பதிவு',

  'digest.header': '{shopName} — {date}',
  'digest.line.vehicles': 'வாகனங்கள்: {in} வந்தது, {out} டெலிவரி',
  'digest.line.approved': 'இன்று ஒப்புதல் பெற்றது: {amount}',
  'digest.line.recovered': 'முன்பு வேண்டாம் என்ற வேலையிலிருந்து மீட்டது: {amount}',
  'digest.line.approvals_pending': '{hours} மணிக்கு மேல் ஒப்புதலுக்கு காத்திருப்பவை: {count}',
  'digest.line.approval_item': '• {vehicle} — {amount}, {waited} ஆக காத்திருக்கிறது',
  'digest.line.feedback': 'உங்கள் கவனம் தேவைப்படும் கருத்துகள்: {count}',
  'digest.line.silent_bays': 'இன்று எந்த புதுப்பிப்பும் இல்லாத பே: {count}',
  'digest.line.none': 'நிலுவையில் எதுவும் இல்லை.',
  'digest.action.call': '{vehicle} — நான் அழைக்கிறேன்',
  'digest.action.open_console': 'கன்சோலைத் திற',
  'digest.weekly_header': '{shopName} — {date} வரையிலான வாரம்',
  'digest.trend.up': '{label}: {value} (கடந்த வாரத்தை விட {change})',
  'digest.trend.flat': '{label}: {value} (மாற்றமில்லை)',
  'digest.multi_shop_header': 'அனைத்து கடைகளும் — {date}',
  'digest.claimed_ack':
    'சரி — {vehicle} உங்களுடையது. இனி நினைவூட்டல் அனுப்ப மாட்டேன். வாடிக்கையாளர் முடிவு சொல்லும் வரை பட்டியலில் இருக்கும்.',

  'alert.approval_stuck':
    '{vehicle}: {amount} ஒப்புதலுக்கு {waited} ஆக பதில் இல்லை.',
  'alert.negative_feedback':
    '{customerName} அவர்களின் {vehicle} வருகைக்கு குறைவான மதிப்பீடு கொடுத்துள்ளார். “{comment}” — {advisorName} வரிசையில் recovery பணி உள்ளது.',
  'alert.payment_failed':
    '{vehicle}: பணம் செலுத்தும் இணைப்பு இரண்டு முறை தோல்வி ({amount}). வேறு வழி தேவைப்படலாம்.',
  'alert.voice_kill_switch': '{shopName} க்கான குரல் அழைப்பு நிறுத்தப்பட்டுள்ளது.',
  'alert.silent_bay_repeat':
    '{vehicle} — தொடர்ந்து {windows} சுற்றுகளாக எந்த புதுப்பிப்பும் இல்லை. யாரும் வேலை செய்யாத பே ஆக இருக்கலாம்.',
} as const satisfies Catalogue;

const hi = {
  'auth.otp.body': 'आपका ServiceLoop सत्यापन कोड {code} है। यह {minutes} मिनट में समाप्त हो जाएगा।',
  'auth.otp.sent': '{phone} पर कोड भेजा गया है।',

  'disclosure.first_contact':
    'नमस्ते {customerName}, मैं {shopName} की ओर से संदेश भेजने वाला ServiceLoop सहायक हूँ। मैं एक AI सहायक हूँ। सलाहकार से बात करने के लिए HUMAN लिखकर भेजें।',
  'disclosure.voice_intro':
    'नमस्ते, मैं {shopName} की ओर से कॉल करने वाला AI सहायक हूँ। यह कॉल रिकॉर्ड की जा सकती है। किसी व्यक्ति से बात करने के लिए "agent" कहें।',

  'handoff.offer': 'क्या मैं आपको {shopName} के {advisorName} से जोड़ूँ?',
  'handoff.confirmed': '{shopName} के {advisorName} आपको जल्द ही कॉल करेंगे।',

  'consent.request':
    'क्या हम आपके {vehicle} की सर्विस अपडेट WhatsApp पर भेज सकते हैं? अनुमति के लिए YES, बंद करने के लिए STOP भेजें।',
  'consent.opt_out_ack':
    'अब आपको {shopName} से संदेश नहीं मिलेंगे। दोबारा शुरू करने के लिए START भेजें।',

  'jobcard.opened': 'आपके {vehicle} के लिए {shopName} में जॉब कार्ड {code} खोला गया है।',
  'jobcard.ready': 'आपका {vehicle} {shopName} पर लेने के लिए तैयार है।',

  'approval.request_intro':
    'आपके {vehicle} की जाँच में ऐसा काम मिला है जिसके लिए आपकी मंज़ूरी चाहिए। कुल: {amount}.',
  'approval.granted_ack': 'धन्यवाद। हमने आपके {vehicle} पर स्वीकृत काम शुरू कर दिया है।',
  'approval.declined_ack': 'ठीक है — वह काम छोड़ रहे हैं। अगली विज़िट के लिए नोट कर लिया है।',

  'status.in_progress': 'आपके {vehicle} का काम चल रहा है। {eta} तक तैयार होने की उम्मीद है।',
  'status.awaiting_parts': 'आपके {vehicle} के लिए पुर्ज़े का इंतज़ार है। नया अनुमान: {eta}.',

  'quiet_hours.deferred': 'दुकान के शांत घंटों के कारण संदेश {time} तक रोका गया।',

  'identify.unknown_number':
    'नमस्ते! आपने {shopName} से संपर्क किया है। मैं ServiceLoop सहायक हूँ, एक AI। सही रिकॉर्ड निकालने के लिए, क्या आप अपना वाहन नंबर भेज सकते हैं (जैसे TN 09 BX 1234)? सलाहकार से बात करने के लिए कभी भी HUMAN लिखें।',
  'consent.granted_ack':
    'धन्यवाद। हम आपके {vehicle} की सर्विस अपडेट यहीं भेजेंगे। बंद करने के लिए कभी भी STOP भेजें।',
  'consent.opt_in_ack': 'वापस स्वागत है — {shopName} की सर्विस अपडेट फिर से चालू हैं।',
  'consent.implied_notice':
    'हम इस नंबर का उपयोग {shopName} में आपके {vehicle} की सर्विस अपडेट के लिए करेंगे। बंद करने के लिए कभी भी STOP भेजें।',

  'intake.draft_summary_header': 'आपकी फ़ोटो से जॉब कार्ड पढ़ा गया — {count} फ़ील्ड जाँच लें:',
  'intake.low_confidence_marker': 'पक्का नहीं',
  'intake.confirm_prompt':
    'लाइन नंबर और सुधार भेजें (जैसे: 2 = TN 09 BX 4432), या Confirm दबाएँ।',
  'intake.confirmed': '{vehicle} के लिए जॉब कार्ड {code} बन गया।',
  'intake.discarded': 'रद्द कर दिया — कुछ भी सेव नहीं हुआ।',
  'intake.correction_ack': '{field} को {value} कर दिया।',
  'intake.extraction_failed':
    'मैं वह जॉब कार्ड नहीं पढ़ पाया। कृपया साफ़ फ़ोटो भेजें, या कंसोल में कार्ड बनाएँ।',
  'intake.edit_in_console': 'ड्राफ़्ट को संपादित करने के लिए कंसोल में खोलें: {url}',
  'intake.confirm_failed':
    'वह ड्राफ़्ट जॉब कार्ड नहीं बन सका: {reason}। पूरा करने के लिए इसे कंसोल में खोलें।',

  'media.too_large': 'वह फ़ाइल {size} है — हमारी {limit} सीमा से बड़ी। छोटी भेज सकते हैं?',
  'media.unsupported_type':
    'मैं {type} फ़ाइलें अभी नहीं पढ़ सकता। फ़ोटो, वॉइस नोट या PDF ठीक रहेगा।',
  'media.infected':
    'वह फ़ाइल हमारी सुरक्षा जाँच में पास नहीं हुई, इसलिए हमने न उसे खोला न रखा। कोई दूसरी फ़ोटो भेजिए, या {shopName} को फ़ोन कीजिए।',
  'media.scan_unavailable':
    'अभी उस फ़ाइल की जाँच नहीं हो पाई, इसलिए हमने उसे रखा नहीं। कुछ मिनट बाद दोबारा कोशिश कीजिए।',

  'error.generic': 'कुछ गड़बड़ हो गई। {shopName} का सलाहकार आपसे संपर्क करेगा।',

  'approval.line_item': '{index}. {description} — {amount}',
  'approval.new_total': 'नया कुल: {amount}',
  'approval.button.approve': 'मंज़ूरी ✅',
  'approval.button.partial': 'सवाल पूछें 💬',
  'approval.button.call': 'कॉल करें 📞',
  'approval.footer': 'सलाहकार से बात करने के लिए कभी भी HUMAN लिखें।',
  'approval.reminder':
    'आपके {vehicle} के अनुमान पर याद दिला रहे हैं — आपके फ़ैसले तक गाड़ी रोकी हुई है। कुल: {amount}.',
  'approval.partial_ack':
    'धन्यवाद। जिस काम की मंज़ूरी मिली वह शुरू कर रहे हैं, बाकी अगली विज़िट के लिए नोट कर लिया है।',
  'approval.deferred_ack': 'ठीक है — नोट कर लिया, {when} के आसपास फिर याद दिलाएँगे।',
  'approval.callback_ack': '{shopName} का सलाहकार आपको जल्द ही कॉल करेगा।',
  'approval.old_parts_offer': 'गाड़ी लेते समय आप पुराने पुर्ज़े देख सकते हैं।',
  'approval.owner_check_offer':
    'यह उससे कम है जितना मैं दे सकता हूँ। मैं मालिक से पूछकर आपको बताता हूँ।',
  'approval.call_offer':
    'क्या सलाहकार कॉल करके समझाए तो आसान रहेगा? “कॉल करें” दबाएँ।',

  'agent.handoff_ack':
    'मैंने यह {shopName} के सलाहकार को भेज दिया है। वे जल्द ही आपसे संपर्क करेंगे।',
  'agent.blocked_fallback':
    'इसका सही जवाब {shopName} का सलाहकार देगा। वे जल्द ही संपर्क करेंगे।',

  'status.eta_line': '{eta} तक तैयार होने की उम्मीद है।',
  'status.delay_apology': 'माफ़ कीजिए — आपकी {vehicle} में थोड़ी देरी हो रही है।',
  'status.earlier_intro': 'आपकी {vehicle} के बारे में अच्छी ख़बर।',
  'status.work_started': 'आपकी {vehicle} पर काम शुरू हो गया है।',
  'status.awaiting_parts_notice': 'आपकी {vehicle} एक पुर्ज़े का इंतज़ार कर रही है।',

  'eta.reason.intake': 'गाड़ी आने पर हमने यही समय अनुमान लगाया था।',
  'eta.reason.work_approved': 'यह उस अतिरिक्त काम की वजह से है जिसकी आपने मंज़ूरी दी।',
  'eta.reason.work_declined': 'जिस काम के लिए आपने मना किया, उसे हटाने के बाद का समय यह है।',
  'eta.reason.blocked_parts': 'ज़रूरी पुर्ज़ा अभी तक नहीं पहुँचा है।',
  'eta.reason.parts_received': 'पुर्ज़ा आ गया है और फिटिंग दोबारा शुरू हो गई है।',
  'eta.reason.technician_hint': 'मैकेनिक ने अब पक्का समय बताया है।',
  'eta.reason.work_done': 'काम पूरा हो गया है, बस आख़िरी जाँच बाक़ी है।',
  'eta.reason.quality_passed': 'आख़िरी जाँच हो चुकी है।',
  'eta.reason.advisor_override': '{shopName} के सलाहकार ने समय अपडेट किया है।',

  'delivery.ready_intro': 'आपकी {vehicle} {shopName} से ले जाने के लिए तैयार है।',
  'delivery.work_summary': 'किया गया काम: {summary}',
  'delivery.amount_due': 'देय राशि: {amount}',
  'delivery.slot_prompt': 'आप गाड़ी कब लेने आना चाहेंगे?',
  'delivery.slot_option': '{when}',
  'delivery.slot_confirmed': 'बुक कर लिया — {when} के लिए आपकी {vehicle} तैयार रहेगी।',
  'delivery.slot_reminder': 'याद दिला रहे हैं: {when} पर आपकी {vehicle} लेने का समय तय है।',
  'delivery.no_slots':
    'आपको जो समय ठीक लगे बता दीजिए, {shopName} में आपकी {vehicle} तैयार रखेंगे।',

  'payment.link_message': 'अपनी {vehicle} के लिए {amount} यहाँ भर सकते हैं: {url}',
  'payment.received_full': '{amount} का भुगतान मिल गया — धन्यवाद।',
  'payment.received_partial': '{amount} मिल गया। बाक़ी राशि: {balance}.',
  'payment.balance_reminder':
    'आपकी {vehicle} पर बाक़ी {balance} के बारे में एक विनम्र याद। यहाँ भर सकते हैं: {url}',
  'payment.failed': 'वह भुगतान नहीं हो पाया। यहाँ दोबारा कोशिश कर सकते हैं: {url}',

  'gatepass.issued':
    '{vehicle} के लिए आपका gate pass: कोड {code}. गेट पर दिखाएँ — यह {expires} तक मान्य है।',
  'gatepass.override':
    '{shopName} के मालिक ने आपकी {vehicle} छोड़ दी है। Gate pass कोड: {code}.',

  'staff.status_confirm': 'क्या आपका मतलब था: {registration} पर {what} {signal}?',
  'staff.status_yes': 'हाँ ✅',
  'staff.status_edit': 'नहीं, ठीक करें ✏️',
  'staff.status_ambiguous': '{signal} — पर {count} कार्ड मिलते हैं। कौन सी गाड़ी?',
  'staff.status_applied': 'दर्ज कर लिया: {registration} पर {what}.',
  'staff.silent_bay_header': '{hours} घंटे से कोई अपडेट नहीं — {count} गाड़ी:',
  'staff.silent_bay_line': '• {code} {registration} — {state}, {hours} घंटे शांत ({technician})',

  /* --- phase 5: voice layer --------------------------------------------- */
  'voice.disclosure':
    'नमस्ते {customerName}. मैं {shopName} की ओर से कॉल कर रहा ServiceLoop असिस्टेंट हूँ। मैं एक AI असिस्टेंट हूँ, कोई व्यक्ति नहीं।',
  'voice.inbound.greeting':
    '{shopName} को कॉल करने के लिए धन्यवाद। मैं ServiceLoop का AI असिस्टेंट हूँ — कोई व्यक्ति नहीं।',
  'voice.recording_notice':
    'यह कॉल रिकॉर्ड की जा रही है। {advisorName} से बात करने के लिए कभी भी 0 दबाएँ।',

  'voice.context': 'मैं आपकी {vehicle} के बारे में कॉल कर रहा हूँ, job card {code}.',
  'voice.evidence_recap': 'हमारे मैकेनिक ने {summary} पाया। उस काम का ख़र्च {amount} है।',
  'voice.ask': 'क्या मैं यह काम शुरू करवा दूँ?',
  'voice.readback': 'तो मैं {summary} {amount} में करवा देता हूँ। पक्का कर दूँ?',
  'voice.readback.decline':
    'तो मैं वो काम अभी छोड़ देता हूँ और अगली बार के लिए लिख देता हूँ। पक्का कर दूँ?',
  'voice.readback.defer':
    'तो मैं वो काम रोक देता हूँ और बाद में फिर पूछूँगा। पक्का कर दूँ?',
  'voice.keypad_hint':
    'हाँ कहिए, या मंज़ूरी के लिए 1, {advisorName} से बात के लिए 2, दोबारा सुनने के लिए 9 दबाएँ।',
  'voice.repeat_intro': 'ज़रूर — एक बार और।',
  'voice.filler': 'एक मिनट…',
  'voice.no_input': 'माफ़ कीजिए, मुझे सुनाई नहीं दिया।',
  'voice.not_understood':
    'ठीक से समझ नहीं आया। मंज़ूरी के लिए 1, {advisorName} के लिए 2, दोबारा सुनने के लिए 9 दबाएँ।',
  'voice.ivr_mode':
    'लाइन साफ़ नहीं है, कीपैड से करते हैं। मंज़ूरी के लिए 1, {advisorName} के लिए 2 दबाएँ।',
  'voice.approved': 'धन्यवाद — आपकी मंज़ूरी दर्ज कर ली है, काम अभी शुरू होगा।',
  'voice.declined': 'समझ गया। वह काम छोड़ देते हैं और अगली बार के लिए नोट कर लेते हैं।',
  'voice.deferred': 'समझ गया — {when} के आसपास दोबारा पूछेंगे।',
  'voice.objection.price':
    'यह उससे कम है जितना मैं दे सकता हूँ। मैं मालिक से पूछकर आपको कॉल करता हूँ।',
  'voice.objection.evidence':
    'मैकेनिक ने फ़ोटो ली है। कॉल के तुरंत बाद WhatsApp पर भेज देता हूँ।',
  'voice.objection.defer': 'कोई बात नहीं। आज ही तय करना ज़रूरी नहीं है।',
  'voice.handoff_offer': 'क्या मैं आपकी बात {advisorName} से करा दूँ?',
  'voice.handoff_bridging': '{advisorName} से जोड़ रहा हूँ। कृपया होल्ड कीजिए।',
  'voice.whisper': '{customerName}, {vehicle}, job card {code}. {reason}. राशि {amount}.',
  'voice.graceful_exit': '{advisorName} आपको जल्द ही वापस कॉल करेंगे।',
  'voice.pipeline_failure':
    'माफ़ कीजिए — आपकी आवाज़ ठीक से नहीं आ रही। विवरण WhatsApp पर भेज देता हूँ और {advisorName} संपर्क करेंगे।',
  'voice.goodbye': 'धन्यवाद। नमस्ते।',
  'voice.inbound.intent_prompt':
    'आप गाड़ी की स्थिति पूछ सकते हैं, अनुमान का जवाब दे सकते हैं, या लेने का समय तय कर सकते हैं। क्या करना है?',
  'voice.inbound.status_answer': 'आपकी {vehicle} {state}. {eta}',
  'voice.inbound.booking_prompt': 'गाड़ी लेने आप कब आना चाहेंगे?',
  'voice.inbound.booking_drafted':
    '{when} नोट कर लिया। {advisorName} WhatsApp पर पक्का कर देंगे।',
  'voice.summary_sent': 'विवरण WhatsApp पर भी भेज दिए हैं।',
  'voice.missed_call_followup':
    'हमने आपकी {vehicle} के बारे में कॉल करने की कोशिश की। अनुमान {amount} है — यहाँ जवाब दीजिए, आगे बात करते हैं।',
  /* --- Phase 6 --- */
  'retention.repitch_body':
    'नमस्ते {customerName} — {when} में जब हमने आपकी {vehicle} की सर्विस की थी, तब हमारे टेक्नीशियन ने {item} पर ध्यान दिलाया था: {finding}. {rationale} कीमत उसी अनुमान जितनी है: {amount}.',
  'retention.repitch_price_changed':
    'नमस्ते {customerName} — {when} में जब हमने आपकी {vehicle} की सर्विस की थी, तब हमारे टेक्नीशियन ने {item} पर ध्यान दिलाया था: {finding}. {rationale} तब से इसकी कीमत बदल गई है: अब {amount} है (पहले {previousAmount} थी).',
  'retention.reason.season': 'बारिश शुरू हो रही है, इसलिए यह कराने का अच्छा समय है।',
  'retention.reason.time_elapsed': 'उसे लगभग {months} महीने हो गए हैं।',
  'retention.reason.next_visit':
    'आपकी {vehicle} आज हमारे पास है, तो इसी विज़िट में हो जाएगा।',
  'retention.reason.odometer': 'आपने बताया था कि तब से लगभग {km} किमी चल चुकी है।',
  'retention.reason.manual': 'हम पूछना चाहते थे कि क्या अब यह करा लें।',
  'retention.action.book': 'स्लॉट बुक करें',
  'retention.action.remind': 'बाद में याद दिलाएँ',
  'retention.action.not_interested': 'नहीं चाहिए',
  'retention.booked_ack':
    'धन्यवाद — आपकी {vehicle} के लिए समय तय करने {advisorName} जल्द ही संदेश करेंगे।',
  'retention.remind_later_ack': 'कोई बात नहीं। लगभग एक महीने बाद फिर पूछेंगे।',
  'retention.not_interested_ack':
    'ठीक है — यह दोबारा नहीं उठाएँगे। मन बदले तो यहीं बता दीजिएगा।',
  'retention.next_visit_prompt':
    'गाड़ी यहीं है: {when} को {item} टाला गया था ({amount}). तब टेक्नीशियन ने लिखा: {finding}',
  'retention.odometer_ask':
    'एक छोटा सवाल — आपकी {vehicle} अभी लगभग कितने किलोमीटर दिखा रही है?',
  'retention.odometer_ack': 'नोट कर लिया, धन्यवाद।',

  'feedback.ask':
    '{shopName} में आपकी {vehicle} की विज़िट कैसी रही? नीचे एक चेहरा चुनिए — और कुछ कहना हो तो संदेश या वॉइस नोट भेज दीजिए।',
  'feedback.option.positive': 'अच्छी रही 😊',
  'feedback.option.neutral': 'ठीक-ठाक 😐',
  'feedback.option.negative': 'अच्छी नहीं रही 😞',
  'feedback.thanks_positive': 'धन्यवाद — अच्छा लगा कि सब ठीक रहा।',
  'feedback.review_ask':
    'एक मिनट हो तो, Google रिव्यू एक छोटी वर्कशॉप के लिए सोच से ज़्यादा मायने रखता है: {link}',
  'feedback.thanks_neutral': 'बताने के लिए धन्यवाद — हमने नोट कर लिया है।',
  'feedback.thanks_negative':
    'खेद है कि ठीक नहीं रहा। मैंने {advisorName} को बता दिया है, वे आपको इस बारे में कॉल करेंगे।',
  'feedback.reminder':
    '{shopName} में आपकी {vehicle} की विज़िट के बारे में एक छोटा सवाल — कैसी रही?',

  'reminder.service_due':
    'आपकी {vehicle} की अगली सर्विस {when} के आसपास है। स्लॉट रोक दूँ?',
  'reminder.service_due_soon':
    'आपकी {vehicle} की अगली सर्विस {when} है। बुक कर दूँ?',
  'reminder.document':
    'आपकी {vehicle} का {document} {date} को खत्म हो रहा है। रिन्यू में {shopName} मदद करे?',
  'reminder.document.insurance': 'बीमा',
  'reminder.document.puc': 'PUC प्रमाणपत्र',
  'reminder.enrol_ask':
    'क्या मैं आपकी {vehicle} के बीमा और PUC की तारीखें याद रखूँ और खत्म होने से पहले याद दिला दूँ?',
  'reminder.enrol_ack': 'हो गया — हर एक से पहले याद दिला दूँगा।',

  'consent.marketing_ask':
    'सर्विस अपडेट से अलग: क्या {shopName} आपकी {vehicle} के लिए रिमाइंडर और ऑफ़र भेज सकता है? हाँ के लिए YES लिखिए, और कभी भी STOP.',
  'consent.marketing_granted_ack':
    'धन्यवाद — आपकी {vehicle} के लिए रिमाइंडर और ऑफ़र भेजेंगे। बंद करने के लिए कभी भी STOP.',
  'consent.marketing_revoked_ack':
    'हो गया — अब कोई रिमाइंडर या ऑफ़र नहीं। चल रहे काम की जानकारी मिलती रहेगी।',

  'winback.body':
    'नमस्ते {customerName} — {shopName} में आपकी {vehicle} को देखे लगभग {months} महीने हो गए। {hook} एक चेक-अप बुक करें?',
  'winback.hook.age':
    'लगभग {age} साल पर आमतौर पर ब्रेक, कूलेंट और बेल्ट देखने लायक होते हैं।',
  'winback.hook.general':
    'एक छोटा हेल्थ चेक अक्सर बड़ी खर्च बनने से पहले ही दिक्कत पकड़ लेता है।',
  'winback.action.book': 'चेक-अप बुक करें',

  'digest.header': '{shopName} — {date}',
  'digest.line.vehicles': 'गाड़ियाँ: {in} आईं, {out} डिलीवर',
  'digest.line.approved': 'आज मंज़ूर: {amount}',
  'digest.line.recovered': 'पहले मना किए गए काम से वसूला: {amount}',
  'digest.line.approvals_pending': '{hours} घंटे से मंज़ूरी का इंतज़ार: {count}',
  'digest.line.approval_item': '• {vehicle} — {amount}, {waited} से इंतज़ार',
  'digest.line.feedback': 'आपके ध्यान की ज़रूरत वाले फ़ीडबैक: {count}',
  'digest.line.silent_bays': 'आज बिना अपडेट वाले बे: {count}',
  'digest.line.none': 'कुछ बकाया नहीं है।',
  'digest.action.call': '{vehicle} — मैं कॉल करूँगा',
  'digest.action.open_console': 'कंसोल खोलें',
  'digest.weekly_header': '{shopName} — {date} तक का हफ़्ता',
  'digest.trend.up': '{label}: {value} (पिछले हफ़्ते से {change})',
  'digest.trend.flat': '{label}: {value} (कोई बदलाव नहीं)',
  'digest.multi_shop_header': 'सभी शॉप — {date}',
  'digest.claimed_ack':
    'ठीक है — {vehicle} आपके पास। अब याद नहीं दिलाऊँगा। ग्राहक के जवाब तक सूची में रहेगा।',

  'alert.approval_stuck':
    '{vehicle}: {amount} की मंज़ूरी {waited} से बिना जवाब के अटकी है।',
  'alert.negative_feedback':
    '{customerName} ने अपनी {vehicle} की विज़िट को खराब बताया। “{comment}” — {advisorName} की कतार में recovery टास्क है।',
  'alert.payment_failed':
    '{vehicle}: पेमेंट लिंक दो बार फेल हुआ ({amount}). ग्राहक को कोई और तरीका चाहिए हो सकता है।',
  'alert.voice_kill_switch': '{shopName} के लिए वॉइस कॉलिंग बंद कर दी गई है।',
  'alert.silent_bay_repeat':
    '{vehicle} — लगातार {windows} विंडो से कोई अपडेट नहीं। शायद किसी बे में यूँ ही खड़ी है।',
} as const satisfies Catalogue;

export const CATALOGUES: Readonly<Record<Language, Catalogue>> = { en, ta, hi };
