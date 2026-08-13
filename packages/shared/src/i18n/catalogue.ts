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

  'error.generic': 'Something went wrong. An advisor at {shopName} will follow up.',
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

  'error.generic': 'ஏதோ தவறு நடந்தது. {shopName} இன் ஆலோசகர் உங்களை தொடர்பு கொள்வார்.',
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

  'error.generic': 'कुछ गड़बड़ हो गई। {shopName} का सलाहकार आपसे संपर्क करेगा।',
} as const satisfies Catalogue;

export const CATALOGUES: Readonly<Record<Language, Catalogue>> = { en, ta, hi };
