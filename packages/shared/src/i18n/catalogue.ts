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
} as const satisfies Catalogue;

export const CATALOGUES: Readonly<Record<Language, Catalogue>> = { en, ta, hi };
