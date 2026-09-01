# Breach notification — draft text

Written in advance so the first draft is not written at 2am. Fill in the
bracketed fields; change the wording where it is wrong for the actual incident,
but do not soften it.

**Before using any of this, go to
[runbooks/playbooks.md](../runbooks/playbooks.md#data-breach) and do hour one.**
Containment first. These drafts are for hours two to twenty-four, once the scope
is established.

## Who notifies whom

| | Notified by | Notified when |
| --- | --- | --- |
| **Data Protection Board of India** | The shop (the data fiduciary) | As soon as scope is established. Not when the investigation concludes. |
| **Affected customers** | The shop | Same, in a language they read |
| **The shop** | Us | **Immediately** — before either of the above, because they cannot do their part until we have done ours |

The shop is the data fiduciary. We process on their behalf. They notify; we
help them do it, and we give them everything they need to. Say that plainly and
early — a shop owner discovering three days later that they were legally on the
hook is a worse outcome than the breach.

## The three facts every notification needs

Establish these before drafting anything. All three are required, and
reconstructing them later from logs that have rotated is not possible.

1. **Which data principals** — by count and, where possible, by list.
2. **Which categories of data** — names? phone numbers? message contents?
   photographs? call recordings? invoices?
3. **Over what period** — from when to when.

The audit chain is the instrument. The queries are in the playbook.

---

## 1 · To the shop (immediately, by phone then in writing)

> **Subject: Security incident affecting your customers' data — action needed
> today**
>
> [Owner name],
>
> We have found a security incident affecting data held by ServiceLoop for
> [shop name]. I am telling you now, before we have finished investigating,
> because there are things the law requires you to do and the clock has started.
>
> **What we know so far.** At approximately [time] on [date], [plain description
> — "an access credential belonging to a member of our team was used from an
> unrecognised location" / "a database was reachable from the internet without
> authentication"]. We closed it at [time] on [date].
>
> **What was affected.** [Number] of your customers. The data involved was
> [categories]. The period affected is [from] to [to].
>
> **What we have already done.** [Revoked all sessions / rotated every
> credential / …]. The system is secure now.
>
> **What you need to do, and what we will do for you.** You are the data
> fiduciary under the DPDP Act, which means the notifications are legally yours
> to make. We have drafted both of them for you — to the Data Protection Board
> and to your affected customers — and we will send them on your instruction, or
> support you to send them, whichever you prefer. They should go today.
>
> I will call you at [time]. If you would rather talk sooner, ring me on
> [number].
>
> [Name]

Do not send this as the first contact. Ring them, then send it.

---

## 2 · To the Data Protection Board

Via the prescribed form. This is the content, not the format — the form's fields
change and the current one governs.

> **Nature of the personal data breach**
> [Plain description of what happened, mechanically. Not "an incident occurred".]
>
> **Categories and approximate number of data principals affected**
> [N] data principals. Categories of personal data: [names, telephone numbers,
> vehicle registrations, message contents, photographs, call recordings, invoice
> records — list only what applies].
>
> **When it occurred, and when it was discovered**
> Occurred: [from] to [to]. Discovered: [date, time]. Contained: [date, time].
>
> **Likely consequences**
> [Honest assessment. If contact details were exposed, say that the realistic
> harm is unsolicited contact and phishing. If message contents were exposed,
> say that those contain details of the customers' vehicles and service history.
> Do not minimise, and do not speculate upward either.]
>
> **Measures taken or proposed**
> [What was done to contain it; what has been changed so it cannot recur; when
> affected data principals were or will be notified.]
>
> **Contact for further information**
> [Grievance officer name, email, phone — as published on the privacy notice.]

---

## 3 · To affected customers

Sent on the shop's behalf, from the shop, over the channel they normally hear
from the shop on. In their own language — the same three the product supports.

Short. A customer reading this on a phone will read three sentences.

### English

> **[Shop name] — an important message about your information**
>
> We are sorry to tell you that some of the information we hold about you may
> have been seen by someone who should not have seen it. This happened on
> [date].
>
> **What was involved:** [your name and phone number / messages about your
> vehicle / …].
> **What was not involved:** [your payment card details were not involved — say
> this only if it is true].
>
> We closed the problem on [date] and have changed how we protect this
> information.
>
> **What you should do:** [Be careful of calls or messages claiming to be from
> us and asking for money or personal details. We will never ask you for a
> payment code or a password.]
>
> If you have questions, contact [grievance officer name] at [email] or
> [phone]. You may also complain to the Data Protection Board of India.

### தமிழ் (Tamil)

> **[பணிமனையின் பெயர்] — உங்கள் தகவல் குறித்த ஒரு முக்கியச் செய்தி**
>
> உங்களைப் பற்றி நாங்கள் வைத்திருந்த சில தகவல்களை, பார்க்கக் கூடாத ஒருவர்
> பார்த்திருக்கக்கூடும் என்பதை வருத்தத்துடன் தெரிவிக்கிறோம். இது [தேதி] அன்று
> நடந்தது.
>
> **சம்பந்தப்பட்டவை:** [உங்கள் பெயர் மற்றும் தொலைபேசி எண் / உங்கள் வாகனம்
> குறித்த செய்திகள்].
> **சம்பந்தப்படாதவை:** [உங்கள் கார்டு விவரங்கள் சம்பந்தப்படவில்லை].
>
> [தேதி] அன்று இந்தச் சிக்கலை நாங்கள் சரிசெய்துவிட்டோம்; இந்தத் தகவலைப்
> பாதுகாக்கும் முறையை மாற்றியுள்ளோம்.
>
> **நீங்கள் செய்ய வேண்டியது:** எங்கள் பெயரைச் சொல்லி பணம் அல்லது தனிப்பட்ட
> விவரங்கள் கேட்கும் அழைப்புகள் அல்லது செய்திகள் குறித்து எச்சரிக்கையாக
> இருங்கள். பணம் செலுத்தும் குறியீட்டையோ கடவுச்சொல்லையோ நாங்கள் ஒருபோதும்
> கேட்க மாட்டோம்.
>
> கேள்விகள் இருந்தால் [பெயர்] அவர்களை [EMAIL] அல்லது [PHONE] இல் தொடர்பு
> கொள்ளவும். இந்திய தரவுப் பாதுகாப்பு வாரியத்திடமும் புகார் அளிக்கலாம்.

### हिन्दी (Hindi)

> **[वर्कशॉप का नाम] — आपकी जानकारी के बारे में एक ज़रूरी संदेश**
>
> हमें यह बताते हुए खेद है कि आपके बारे में हमारे पास मौजूद कुछ जानकारी
> ऐसे व्यक्ति ने देखी हो सकती है जिसे नहीं देखनी चाहिए थी। यह [तारीख़] को
> हुआ।
>
> **क्या शामिल था:** [आपका नाम और फ़ोन नंबर / आपके वाहन से जुड़े संदेश]।
> **क्या शामिल नहीं था:** [आपके कार्ड की जानकारी शामिल नहीं थी]।
>
> हमने [तारीख़] को यह समस्या बंद कर दी है और इस जानकारी की सुरक्षा का तरीक़ा
> बदला है।
>
> **आपको क्या करना चाहिए:** हमारा नाम लेकर पैसे या निजी जानकारी माँगने वाले
> कॉल या संदेशों से सावधान रहें। हम आपसे कभी भी भुगतान कोड या पासवर्ड नहीं
> माँगेंगे।
>
> प्रश्नों के लिए [नाम] से [EMAIL] या [PHONE] पर संपर्क करें। आप भारतीय
> डेटा संरक्षण बोर्ड से भी शिकायत कर सकते हैं।

---

## What not to write

- **"We take security seriously."** It says nothing and it reads as a shield.
- **"No evidence that data was misused."** True and irrelevant. It is heard as
  "nothing happened", and it will be quoted back if something surfaces later.
- **"A sophisticated attack."** Almost never true, and it reads as an excuse.
  Describe what happened.
- **Anything conditional about whether notification was required.** The decision
  was made; the notification is being sent. Arguing the point inside the
  notification undermines it.
- **A number you have not verified.** "Approximately 200" that turns out to be
  2,000 is a second incident.
