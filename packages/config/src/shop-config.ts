import {
  ALERT_KINDS,
  AlertKindSchema,
  AutonomyLevelSchema,
  EscalationRungTypeSchema,
  HhMmSchema,
  LanguageSchema,
  MmDdSchema,
  OBJECTIVES,
  TimeZoneSchema,
  WorkingWindowSchema,
  parseHhMm,
  type Objective,
} from '@serviceloop/shared';
import { z } from 'zod';

/**
 * The shop configuration document — the guardrail surface (master §6).
 *
 * Stored as validated JSON in `shop_config.config` alongside `config_version`.
 * Every default here is the most conservative value: a brand-new shop runs
 * fully in shadow mode, offers no discount, and cannot message outside quiet
 * hours. Loosening any of these is an explicit, audited act.
 */

/**
 * v2 (phase 2) adds the `messaging`, `intake` and `consent` blocks. v3 (phase 3)
 * adds `agent` and re-expresses ladder rungs as a *type* rather than a channel.
 * v4 (phase 4) adds `workingHours`, `eta`, `statusComms`, `delivery` and
 * `invoice`, and widens `payments` past the single ordering flag. v5 (phase 5)
 * adds `voice`, with every switch in it off. v6 (phase 6) adds `retention`,
 * `feedback`, `digest`, `alerts` and `analytics` — the retention engine off,
 * the digest on, because a brief nobody asked for goes to the owner's own
 * number and a re-pitch goes to a customer's.
 * Stored documents are migrated forward on read by `migrateShopConfig`, merging
 * the conservative defaults below — an absent field can only ever become more
 * restrictive, never less.
 */
export const SHOP_CONFIG_VERSION = 6 as const;

export const EscalationRungSchema = z.object({
  /** Minutes after the objective opened (not after the previous rung). */
  afterMinutes: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 90),
  /**
   * What the rung *is*, not the transport it happens to use today.
   *
   * `VOICE_OR_ADVISOR` is the reason this is a type: until phase 5 lands the
   * telephony adapter that rung raises a prioritised advisor task carrying the
   * agent's brief, and afterwards it places the call itself. A shop that has
   * configured "call them at two hours" should not have to re-configure
   * anything when the call becomes automatic.
   */
  type: EscalationRungTypeSchema,
  label: z.string().min(1).max(80),
});
export type EscalationRung = z.infer<typeof EscalationRungSchema>;

export const EscalationLadderSchema = z.object({
  enabled: z.boolean(),
  /** L3: a ladder must terminate — the last rung is the human handoff. */
  rungs: z.array(EscalationRungSchema).min(1).max(8),
  /** Hard stop: the objective is abandoned to a human after this long. */
  giveUpAfterMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 180),
});
export type EscalationLadder = z.infer<typeof EscalationLadderSchema>;

export const AutonomyConfigSchema = z.object({
  approval: AutonomyLevelSchema,
  status: AutonomyLevelSchema,
  delivery: AutonomyLevelSchema,
  retention: AutonomyLevelSchema,
  voice: AutonomyLevelSchema,
});
export type AutonomyConfig = z.infer<typeof AutonomyConfigSchema>;

export const PricingConfigSchema = z
  .object({
    /**
     * Floor as a percentage of the list price. 100 = never quote below list.
     * The `send_customer_message`/offer tools reject anything under this.
     */
    priceFloorPercent: z.number().min(0).max(100),
    discountCeilingPercent: z.number().min(0).max(100),
  })
  .refine((value) => value.priceFloorPercent + value.discountCeilingPercent <= 100, {
    message: 'priceFloorPercent + discountCeilingPercent cannot exceed 100',
    path: ['discountCeilingPercent'],
  });
export type PricingConfig = z.infer<typeof PricingConfigSchema>;

export const QuietHoursSchema = z.object({
  timezone: TimeZoneSchema,
  start: HhMmSchema,
  end: HhMmSchema,
});
export type QuietHoursConfig = z.infer<typeof QuietHoursSchema>;

export const LanguagesConfigSchema = z
  .object({
    enabled: z.array(LanguageSchema).min(1),
    default: LanguageSchema,
  })
  .refine((value) => value.enabled.includes(value.default), {
    message: 'The default language must also be enabled',
    path: ['default'],
  });
export type LanguagesConfig = z.infer<typeof LanguagesConfigSchema>;

export const FrequencyCapsSchema = z.object({
  maxOutboundPerCustomerPerDay: z.number().int().min(1).max(50),
  maxOutboundPerCustomerPerWeek: z.number().int().min(1).max(200),
  minMinutesBetweenMessages: z
    .number()
    .int()
    .min(0)
    .max(60 * 24),
});
export type FrequencyCaps = z.infer<typeof FrequencyCapsSchema>;

export const PaymentsConfigSchema = z.object({
  /** Controls whether AWAITING_PAYMENT precedes or follows DELIVERED. */
  paymentBeforeDelivery: z.boolean(),
  /* --- phase 4.9 ------------------------------------------------------- */
  /**
   * Whether the payment link accepts less than the full amount.
   *
   * Off by default, because a partial payment is a balance somebody has to
   * chase, and a shop should opt into that rather than discover it.
   */
  acceptPartialPayment: z.boolean(),
  /** Smallest first instalment, as a percentage of the invoice total. */
  minimumFirstPaymentPercent: z.number().min(0).max(100),
  paymentLinkExpiryMinutes: z
    .number()
    .int()
    .min(15)
    .max(60 * 24 * 30),
  /**
   * The balance-chasing ladder — **two rungs, hard maximum** (phase 4.9).
   *
   * After the second the shop raises an advisor task and stops writing. This is
   * a person who has already paid something and already has their vehicle; a
   * third automated reminder is a debt-collection cadence, and a workshop that
   * behaves like a debt collector loses the customer and the balance.
   */
  balanceReminderAfterMinutes: z
    .array(
      z
        .number()
        .int()
        .min(30)
        .max(60 * 24 * 14),
    )
    .max(2),
  /** A gate pass may not be verified for ever; a stolen code has to go stale. */
  gatePassTtlMinutes: z
    .number()
    .int()
    .min(15)
    .max(60 * 24 * 7),
  /** Whether a vehicle may leave without a verified pass. */
  requireGatePass: z.boolean(),
});
export type PaymentsConfig = z.infer<typeof PaymentsConfigSchema>;

/* -------------------------------------------------------------------------- *
 * Phase 4 — status sentinel, delivery & payments
 * -------------------------------------------------------------------------- */

/**
 * The ETA engine's rules table (phase 4.3).
 *
 * Deterministic and explainable by design — a rules table, not a model. Every
 * number here is one an owner can point at when a customer asks why they were
 * told four o'clock, which is the whole reason the engine is not a prediction.
 */
export const EtaConfigSchema = z.object({
  /**
   * Fallback labour minutes when a work item carries no estimate of its own.
   *
   * Keyed by estimate-line kind because that is what the estimate actually
   * says: a PART line's time is fitting time, a FEE line takes none.
   */
  defaultMinutesByLineKind: z.object({
    LABOUR: z.number().int().min(0).max(2880),
    PART: z.number().int().min(0).max(2880),
    CONSUMABLE: z.number().int().min(0).max(2880),
    FEE: z.number().int().min(0).max(2880),
  }),
  /** Added when a technician reports `blocked_parts` and offers no hint. */
  partsLeadTimeMinutes: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 30),
  /** Quality check and the walk back to the counter, once per card. */
  qualityCheckMinutes: z.number().int().min(0).max(480),
  /**
   * Slack added to the summed labour, as a percentage.
   *
   * A workshop is not a production line: parts get fetched, bays get shuffled,
   * and an ETA computed from labour alone is one the shop misses every time.
   * Padding it is more honest than being late.
   */
  bufferPercent: z.number().min(0).max(100),
  /**
   * The materiality threshold (phase 4.3). A slip beyond this — or one that
   * crosses onto a later local day — interrupts the customer immediately.
   */
  materialSlipMinutes: z
    .number()
    .int()
    .min(5)
    .max(60 * 24),
});
export type EtaConfig = z.infer<typeof EtaConfigSchema>;

/** Proactive status comms and the silent-bay sentinel (phase 4.4 / 4.6). */
export const StatusCommsConfigSchema = z.object({
  /**
   * Working hours of silence on an active card before the staff group is
   * nudged. Working hours, not wall-clock: see `workingMinutesBetween`.
   */
  silentBayAfterWorkingHours: z.number().min(0.25).max(72),
  /**
   * Minimum gap between coalesced status updates to one customer about one
   * card. Approvals, ready alerts and delay notices are exempt — those are the
   * three messages a customer is *waiting* for.
   */
  coalesceWindowHours: z.number().min(0).max(24),
  /**
   * Silent windows in a row before the card becomes an owner-digest exception.
   * Phase 6 consumes the event; phase 4 emits it.
   */
  silentWindowsBeforeEscalation: z.number().int().min(1).max(10),
});
export type StatusCommsConfig = z.infer<typeof StatusCommsConfigSchema>;

export const RushWindowSchema = z
  .object({ start: HhMmSchema, end: HhMmSchema })
  .refine((value) => parseHhMm(value.start) < parseHhMm(value.end), {
    message: 'A rush window must end later in the day than it starts',
    path: ['end'],
  });

/** Pickup slotting (phase 4.7). */
export const DeliveryConfigSchema = z.object({
  slotMinutes: z.number().int().min(15).max(120),
  /** Cap per bin, so ten cars are not all promised for 18:00. */
  maxPickupsPerSlot: z.number().int().min(1).max(20),
  /** Counter-rush windows the shop will not book pickups into. */
  rushWindows: z.array(RushWindowSchema).max(4),
  /** How many slots the ready message offers. Three fits a WhatsApp list. */
  suggestionCount: z.number().int().min(1).max(3),
  /** Never offer a slot sooner than this; the customer has to travel. */
  earliestOffsetMinutes: z.number().int().min(0).max(480),
  /** How far ahead of the chosen slot the reminder goes out. */
  reminderLeadMinutes: z.number().int().min(0).max(1440),
});
export type DeliveryConfig = z.infer<typeof DeliveryConfigSchema>;

/**
 * GSTIN: two state-code digits, a PAN, an entity digit, a literal Z, a checksum.
 *
 * Validated rather than accepted as free text because it is printed on a tax
 * document a customer may hand to their accountant.
 */
export const GstinSchema = z
  .string()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[\dA-Z]$/, 'Expected a 15-character GSTIN');

/** Invoice letterhead and tax treatment (phase 4.8). */
export const InvoiceConfigSchema = z
  .object({
    legalName: z.string().min(1).max(160).nullable(),
    gstin: GstinSchema.nullable(),
    addressLines: z.array(z.string().min(1).max(120)).max(5),
    /** GST state code of the shop — the left half of the intra-state test. */
    stateCode: z
      .string()
      .regex(/^\d{2}$/, 'Expected a two-digit GST state code')
      .nullable(),
    /** Default HSN/SAC when a line carries none. Optional by design (§10). */
    defaultHsnSac: z.string().min(4).max(8).nullable(),
    numberPrefix: z.string().min(1).max(12),
    footerNote: z.string().max(300),
    /** The phase-4.8 flagship: media backing each additional-work line. */
    includeEvidenceAppendix: z.boolean(),
  })
  .refine((value) => value.gstin === null || value.stateCode !== null, {
    // Without a state code the CGST/SGST-versus-IGST split cannot be decided,
    // and a tax invoice that guesses is worse than one that is not issued.
    message: 'stateCode is required once a GSTIN is configured',
    path: ['stateCode'],
  });
export type InvoiceConfig = z.infer<typeof InvoiceConfigSchema>;

/**
 * Voice behaviour and its brakes (phase 5).
 *
 * Two things live here that look like duplicates of the environment and are
 * not. `enabled` is the shop's own switch — an owner who does not want the
 * agent phoning their customers turns it off without anybody deploying
 * anything — while `VOICE_KILL_SWITCH` is the platform's. Either alone stops a
 * call, which is the correct shape for a brake: you never want the two parties
 * who can stop something to have to agree.
 *
 * `dailyCostCapPaise` is the same story at the level of money. A shop that has
 * spent its day's budget stops originating and starts raising advisor tasks —
 * the loop degrades to what it did in phase 3 rather than to silence.
 */
export const VoiceConfigSchema = z
  .object({
    /** The shop's own switch. New shops start with voice off (§6: L0 first). */
    enabled: z.boolean(),
    /**
     * Outbound rungs may place calls. Off means `VOICE_OR_ADVISOR` keeps
     * raising advisor tasks — the phase-3 behaviour, deliberately reachable.
     */
    outboundEnabled: z.boolean(),
    /** The published line answers. Independent of outbound, because the risk is. */
    inboundEnabled: z.boolean(),
    /** One retry on no-answer, then the ladder falls to a person (phase 5.4a). */
    retryOnNoAnswer: z.boolean(),
    retryAfterMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24),
    /** Per-customer ceiling. A shop cannot ring the same person all afternoon. */
    maxCallsPerCustomerPerDay: z.number().int().min(1).max(10),
    /** Per-shop ceiling on originations, regardless of cost. */
    maxOutboundCallsPerDay: z.number().int().min(1).max(500),
    /** Money brake. Breaching alerts, then halts new originations. */
    dailyCostCapPaise: z
      .number()
      .int()
      .min(0)
      .max(100_000_000),
    /** Recording + transcript retention. Phase 7 wires the deletion cascade. */
    recordingRetentionDays: z.number().int().min(1).max(3650),
    /**
     * Two consecutive low-confidence turns drop the call into pure IVR
     * (phase 5.5). Below this, the recogniser is guessing.
     */
    minTranscriptConfidence: z.number().min(0).max(1),
    poorTurnsBeforeIvr: z.number().int().min(1).max(5),
    /** Agent turns before the graceful "I'll have Kumar sir call you" exit. */
    maxTurnsPerCall: z.number().int().min(2).max(40),
    maxCallSeconds: z
      .number()
      .int()
      .min(30)
      .max(30 * 60),
    /** Speech-end to speech-start. Breaching it does not end the call; it fills. */
    latencyBudgetMs: z.number().int().min(200).max(10_000),
    /** A turn may be at most this many sentences. Voice composition policy (5.3). */
    maxSentencesPerTurn: z.number().int().min(1).max(4),
    /**
     * A decision may not be recorded from a call until the agent has read the
     * work and the amount back and the caller has agreed to *that*.
     *
     * A literal, not a boolean: this is the guardrail that stops a mis-heard
     * "sari" from spending somebody's money, and no shop configuration may
     * switch it off (§6, §10).
     */
    requireReadbackBeforeDecision: z.literal(true),
  })
  .refine((value) => !value.outboundEnabled || value.enabled, {
    message: 'outboundEnabled requires enabled',
    path: ['outboundEnabled'],
  })
  .refine((value) => !value.inboundEnabled || value.enabled, {
    message: 'inboundEnabled requires enabled',
    path: ['inboundEnabled'],
  });
export type VoiceConfig = z.infer<typeof VoiceConfigSchema>;

/* -------------------------------------------------------------------------- *
 * Phase 6 — retention, feedback, digest & analytics
 * -------------------------------------------------------------------------- */

/**
 * A seasonal window that wakes ledger items tagged for it (phase 6.2).
 *
 * `MM-DD` with no year, and a window that wraps the year end is expected rather
 * than an edge case — a shop in the north tags underbody work for a winter that
 * starts in November and ends in February.
 */
export const SeasonWindowSchema = z.object({
  key: z.string().min(1).max(24),
  start: MmDdSchema,
  end: MmDdSchema,
  /** Ledger trigger tags this window fires, e.g. `["season:monsoon"]`. */
  tags: z.array(z.string().min(1).max(48)).min(1).max(8),
});
export type SeasonWindow = z.infer<typeof SeasonWindowSchema>;

/** The lapsed-customer win-back (phase 6.10). */
export const WinBackConfigSchema = z.object({
  enabled: z.boolean(),
  /** No visit in this many months makes a customer lapsed. */
  afterMonths: z.number().int().min(1).max(60),
  /** A lapsed customer hears from us at most once in this many months. */
  cooldownMonths: z.number().int().min(1).max(60),
});
export type WinBackConfig = z.infer<typeof WinBackConfigSchema>;

/** The service-due engine (phase 6.5). */
export const ServiceDueConfigSchema = z.object({
  enabled: z.boolean(),
  /** Shop default between services when the vehicle's own history says nothing. */
  intervalDays: z.number().int().min(30).max(1095),
  /** Used instead of the calendar when the customer has volunteered readings. */
  intervalKm: z.number().int().min(1000).max(50_000),
  /**
   * Days before the due window a reminder goes out. The phase asks for T-7 and
   * T-1; a shop may shorten the list but not lengthen it past three, because
   * four reminders about one service is the shape of a nuisance.
   */
  leadDays: z.array(z.number().int().min(0).max(90)).min(1).max(3),
});
export type ServiceDueConfig = z.infer<typeof ServiceDueConfigSchema>;

/**
 * Document-expiry tracking (phase 6.5).
 *
 * Enrolment is per customer and explicit; this block only says *when* an
 * enrolled customer hears, never *whether*. A shop that has a customer's
 * insurance date because it saw the papers has not thereby been asked to remind
 * them about it, and no configuration here can make it so.
 */
export const DocumentReminderConfigSchema = z.object({
  enabled: z.boolean(),
  leadDays: z.number().int().min(1).max(90),
});
export type DocumentReminderConfig = z.infer<typeof DocumentReminderConfigSchema>;

/**
 * The retention engine (phase 6.1–6.3, 6.10).
 *
 * `enabled` is off for a new shop, like every other switch that can put a
 * message in front of a customer. The two numbers below it are the ones that
 * make retention care rather than spam, and both are enforced *below* the
 * composer: `maxRepitchesPerItem` by the ledger service and a database CHECK,
 * `minDaysBetweenTouches` by the OutboundGate's frequency layer — so a new
 * retention flow written next year inherits them without knowing they exist.
 */
export const RetentionConfigSchema = z
  .object({
    enabled: z.boolean(),
    /** The floor between *any* two retention touches to one customer. */
    minDaysBetweenTouches: z.number().int().min(1).max(365),
    /** Hard cap per ledger item. Two, and the phase says two. */
    maxRepitchesPerItem: z.number().int().min(0).max(3),
    /** "Remind me later" pushes the horizon out by this much and counts as one. */
    remindLaterDays: z.number().int().min(1).max(365),
    /**
     * Follow-up horizon in days by shop-KB category — the phase's own numbers:
     * brake wear 60–90 days, tyres 90, cosmetic never.
     *
     * `null` means "never re-pitch on the clock". Such an item still exists in
     * the ledger and still surfaces on the customer's next visit, which is the
     * cheapest conversion moment and the one that costs the customer nothing.
     */
    horizonDaysByCategory: z.record(
      z.string().min(1).max(48),
      z.number().int().min(1).max(1095).nullable(),
    ),
    /** Applied to an item whose category the shop has no rule for. */
    defaultHorizonDays: z.number().int().min(1).max(1095).nullable(),
    seasons: z.array(SeasonWindowSchema).max(4),
    /** The "while it's here" prompt in the advisor's card drawer (6.2). */
    nextVisitPromptEnabled: z.boolean(),
    /**
     * Whether a light "how many km now?" may ride along on another touchpoint.
     *
     * Never a standalone message — the phase is explicit, and the composer has
     * no path that sends one. This switch only governs the piggyback.
     */
    odometerAskEnabled: z.boolean(),
    /** Kilometres since the visit that wake an `odometer:+N` tagged item. */
    odometerTriggerKm: z.number().int().min(500).max(50_000),
    winBack: WinBackConfigSchema,
    serviceDue: ServiceDueConfigSchema,
    documents: DocumentReminderConfigSchema,
  })
  .refine((value) => value.winBack.cooldownMonths >= 1, {
    message: 'A win-back cooldown of zero would let a lapsed customer be pitched repeatedly',
    path: ['winBack', 'cooldownMonths'],
  });
export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;

/**
 * Post-service feedback, review routing and service recovery (phase 6.4).
 *
 * Two literals here rather than booleans, for the same reason
 * `requireReadbackBeforeDecision` is one: an owner who could switch off the
 * realtime alert on a bad review, or switch off the retention freeze that
 * follows it, would be configuring the system to keep selling to somebody it
 * has just upset. Neither is a preference.
 */
export const FeedbackConfigSchema = z
  .object({
    enabled: z.boolean(),
    /** Hours after DELIVERED before the ask. The phase's window is 24–48. */
    askAfterHours: z.number().int().min(1).max(168),
    /** One reminder, or none. Null means the ask is asked once. */
    reminderAfterHours: z.number().int().min(1).max(336).nullable(),
    /** The ask stops waiting for an answer after this long. */
    expireAfterHours: z.number().int().min(2).max(720),
    /** The shop's Google Place review link. Null until an owner pastes one in. */
    reviewLink: z.string().url().max(500).nullable(),
    askForReviewOnPositive: z.boolean(),
    /** Negative feedback interrupts the owner immediately, never in the digest. */
    alertOwnerOnNegative: z.literal(true),
    /** And freezes every retention touch until the recovery task is closed. */
    freezeRetentionOnNegative: z.literal(true),
  })
  .refine((value) => !value.askForReviewOnPositive || value.reviewLink !== null, {
    // A review ask with no link is a message that asks somebody for a favour
    // and then does not say how to do it.
    message: 'askForReviewOnPositive requires a reviewLink',
    path: ['reviewLink'],
  });
export type FeedbackConfig = z.infer<typeof FeedbackConfigSchema>;

/** The evening owner brief (phase 6.7). */
export const DigestConfigSchema = z.object({
  enabled: z.boolean(),
  /** Shop-local wall clock. 20:30 IST is the default the phase names. */
  dailyAt: HhMmSchema,
  includeWeekly: z.boolean(),
  /** 0 = Sunday. The weekly edition rides the daily slot on that day. */
  weeklyOn: z.number().int().min(0).max(6),
  /** Longest list of stuck approvals the brief will print before it summarises. */
  maxApprovalLines: z.number().int().min(1).max(10),
});
export type DigestConfig = z.infer<typeof DigestConfigSchema>;

/**
 * Realtime exception alerts (phase 6.8).
 *
 * `approvalStuckHours` lives here rather than in `digest` even though both use
 * it, because it is one threshold and having two would let a shop configure a
 * digest that lists approvals its alert stream has not mentioned.
 */
export const AlertsConfigSchema = z.object({
  enabled: z.boolean(),
  approvalStuckHours: z.number().min(0.25).max(72),
  /** Consecutive failed payment attempts before the owner hears. */
  paymentFailuresBeforeAlert: z.number().int().min(1).max(5),
  /**
   * Which alerts may wake an owner during quiet hours.
   *
   * An override of the customer-protection rule, and therefore per-kind and
   * explicit: an owner is not a customer, but they are still a person asleep at
   * 23:00, and "everything is critical" is how an alert stream gets muted.
   */
  quietHoursOverride: z.array(AlertKindSchema).max(ALERT_KINDS.length),
});
export type AlertsConfig = z.infer<typeof AlertsConfigSchema>;

/**
 * Windows the KPI rollups are computed over (phase 6.9).
 *
 * Configuration rather than constants because they are *claims*: "recovery rate
 * over a 90-day cohort" is a number a shop quotes, and a shop whose brake work
 * is pitched on a 120-day horizon needs the cohort to be longer than its own
 * horizon or the rate is structurally understated.
 */
export const AnalyticsConfigSchema = z
  .object({
    recoveryCohortDays: z.number().int().min(7).max(730),
    repeatVisitWindowDays: z.number().int().min(30).max(1095),
    /** How far back a `recompute --from` will go without being asked twice. */
    maxBackfillDays: z.number().int().min(1).max(1095),
  })
  .refine((value) => value.maxBackfillDays >= value.recoveryCohortDays, {
    message: 'A backfill shorter than the recovery cohort cannot reproduce the recovery rate',
    path: ['maxBackfillDays'],
  });
export type AnalyticsConfig = z.infer<typeof AnalyticsConfigSchema>;

export const DisclosureConfigSchema = z.object({
  /**
   * Non-negotiable (master §6). Modelled as a literal so no patch, prompt, or
   * migration can switch it off.
   */
  requireFirstContactDisclosure: z.literal(true),
  requireVoiceCallDisclosure: z.literal(true),
  requireRecordingConsentLine: z.literal(true),
});
export type DisclosureConfig = z.infer<typeof DisclosureConfigSchema>;

export const LaddersSchema = z.object({
  APPROVAL: EscalationLadderSchema,
  STATUS: EscalationLadderSchema,
  DELIVERY: EscalationLadderSchema,
  PAYMENT: EscalationLadderSchema,
  RETENTION: EscalationLadderSchema,
  FEEDBACK: EscalationLadderSchema,
});
export type LaddersConfig = z.infer<typeof LaddersSchema>;

/** Channel wiring for the shop (phase 2.1/2.3). */
export const MessagingConfigSchema = z.object({
  /**
   * WhatsApp group id of the technician evidence channel. Messages arriving
   * from it are routed as staff traffic, never as a customer thread.
   */
  staffGroupId: z.string().min(1).nullable(),
  /**
   * The Meta phone-number id this shop's WhatsApp traffic arrives on.
   *
   * One webhook URL serves every shop, so the delivery has to say which shop it
   * belongs to, and its `metadata.phone_number_id` is the only stable thing in
   * the payload that does. Null in the sandbox, where there is one shop and no
   * Meta.
   */
  whatsappPhoneNumberId: z.string().min(1).nullable(),
  /** Template names by purpose. Ids are configuration, never hardcoded (§10). */
  templates: z.object({
    reengagement: z.string().min(1).nullable(),
    jobCardOpened: z.string().min(1).nullable(),
    readyForDelivery: z.string().min(1).nullable(),
  }),
  /** Language a thread starts in before the customer reveals a preference. */
  defaultOutboundLanguage: LanguageSchema,
});
export type MessagingConfig = z.infer<typeof MessagingConfigSchema>;

/** Zero-migration intake behaviour (phase 2.5/2.6). */
export const IntakeConfigSchema = z.object({
  /**
   * Fields extracted below this confidence are marked ⚠ and must be confirmed
   * by a human before the card is created. Raising it is an audited act.
   */
  confirmationThreshold: z.number().min(0.5).max(1),
  /** Caption keyword that turns a photographed card into an intake draft. */
  photoTrigger: z.string().min(1).max(32),
  /** Whether a technician in the staff group may confirm a draft, or only an advisor. */
  technicianMayConfirm: z.boolean(),
});
export type IntakeConfig = z.infer<typeof IntakeConfigSchema>;

/** Consent capture policy (phase 2.9, DPDP purpose limitation). */
export const ConsentConfigSchema = z.object({
  /**
   * A job card handed over at the counter counts as implied SERVICE consent.
   * Even when true the first message still carries the opt-out line, so the
   * customer is never worse off than an explicit opt-in would leave them.
   */
  impliedServiceConsentFromCounter: z.boolean(),
  /** MARKETING is never implied by a SERVICE grant, in any configuration. */
  requireExplicitMarketingConsent: z.literal(true),
});
export type ConsentConfig = z.infer<typeof ConsentConfigSchema>;

/**
 * Agent runtime budgets and the graduation thresholds (phase 3.2 / 3.9).
 *
 * The caps are configuration rather than constants because they are a cost and
 * a safety control at once: a shop that has never let the agent speak wants a
 * short leash, and the owner is the one who decides when to lengthen it.
 */
export const AgentConfigSchema = z.object({
  /** Hard step cap on the outer loop. Reached ⇒ `budget_exhausted`. */
  maxSteps: z.number().int().min(1).max(12),
  /** Wall-clock budget for a whole run, including tool time. */
  wallClockBudgetMs: z
    .number()
    .int()
    .min(1_000)
    .max(10 * 60_000),
  /** Total LLM tokens a run may spend across every step. */
  maxTokensPerRun: z.number().int().min(1_000).max(1_000_000),
  /**
   * Graduation thresholds. The system *recommends*; the owner decides — so
   * these are the bar a recommendation must clear, never an auto-promotion.
   */
  graduation: z.object({
    minRuns: z.number().int().min(5).max(500),
    minApprovedWithoutEditRate: z.number().min(0).max(1),
    maxCheckerBlockRate: z.number().min(0).max(1),
  }),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const ShopConfigSchema = z.object({
  configVersion: z.literal(SHOP_CONFIG_VERSION),
  autonomy: AutonomyConfigSchema,
  pricing: PricingConfigSchema,
  quietHours: QuietHoursSchema,
  /**
   * When the shop is actually open (phase 4).
   *
   * Separate from `quietHours`, which is about when a *customer* may be
   * disturbed. These are about when a *vehicle* is being worked on, and the two
   * genuinely differ: a shop that shuts at 19:00 may still send a ready alert
   * at 20:30, and a shop open on Sunday still owes its customers quiet at 22:00.
   */
  workingHours: WorkingWindowSchema,
  languages: LanguagesConfigSchema,
  ladders: LaddersSchema,
  payments: PaymentsConfigSchema,
  frequencyCaps: FrequencyCapsSchema,
  disclosure: DisclosureConfigSchema,
  messaging: MessagingConfigSchema,
  intake: IntakeConfigSchema,
  consent: ConsentConfigSchema,
  agent: AgentConfigSchema,
  eta: EtaConfigSchema,
  statusComms: StatusCommsConfigSchema,
  delivery: DeliveryConfigSchema,
  invoice: InvoiceConfigSchema,
  voice: VoiceConfigSchema,
  retention: RetentionConfigSchema,
  feedback: FeedbackConfigSchema,
  digest: DigestConfigSchema,
  alerts: AlertsConfigSchema,
  analytics: AnalyticsConfigSchema,
});

export type ShopConfig = z.infer<typeof ShopConfigSchema>;

const HUMAN_HANDOFF_LABEL = 'Hand off to a human advisor';

function ladder(
  rungs: ReadonlyArray<Omit<EscalationRung, 'label'> & { label: string }>,
  giveUpAfterMinutes: number,
): EscalationLadder {
  return { enabled: true, rungs: [...rungs], giveUpAfterMinutes };
}

/** L3: every objective ships with a cadence that ends in a human. */
export const DEFAULT_LADDERS: LaddersConfig = {
  /**
   * The phase-3 flagship cadence: bundle at T0, a gentle nudge at 45 minutes,
   * the voice rung at two hours, and an owner-digest exception at a day. It is
   * deliberately quicker than the phase-1 placeholder it replaces — a vehicle
   * on a lift is idle capacity, and "time to decision" is the metric (L3).
   */
  APPROVAL: ladder(
    [
      { afterMinutes: 0, type: 'WHATSAPP', label: 'Send evidence-backed approval request' },
      { afterMinutes: 45, type: 'WHATSAPP', label: 'Gentle reminder with the same evidence' },
      {
        afterMinutes: 120,
        type: 'VOICE_OR_ADVISOR',
        label: 'Call the customer to walk through the estimate',
      },
      { afterMinutes: 1440, type: 'OWNER_DIGEST', label: 'Raise as an owner-digest exception' },
    ],
    2880,
  ),
  STATUS: ladder(
    [
      { afterMinutes: 0, type: 'WHATSAPP', label: 'Proactive status update' },
      { afterMinutes: 720, type: 'WHATSAPP', label: 'Follow-up status update' },
      { afterMinutes: 2880, type: 'HUMAN', label: HUMAN_HANDOFF_LABEL },
    ],
    4320,
  ),
  DELIVERY: ladder(
    [
      { afterMinutes: 0, type: 'WHATSAPP', label: 'Ready-for-delivery alert' },
      { afterMinutes: 180, type: 'WHATSAPP', label: 'Pickup reminder' },
      { afterMinutes: 720, type: 'VOICE_OR_ADVISOR', label: 'Call to arrange pickup' },
      { afterMinutes: 1440, type: 'HUMAN', label: HUMAN_HANDOFF_LABEL },
    ],
    4320,
  ),
  PAYMENT: ladder(
    [
      { afterMinutes: 0, type: 'WHATSAPP', label: 'Invoice and payment link' },
      { afterMinutes: 240, type: 'WHATSAPP', label: 'Payment reminder' },
      { afterMinutes: 1440, type: 'VOICE_OR_ADVISOR', label: 'Call about the outstanding amount' },
      { afterMinutes: 2880, type: 'HUMAN', label: HUMAN_HANDOFF_LABEL },
    ],
    10080,
  ),
  RETENTION: ladder(
    [
      { afterMinutes: 0, type: 'WHATSAPP', label: 'Re-pitch deferred work at its horizon' },
      { afterMinutes: 10080, type: 'WHATSAPP', label: 'Second re-pitch' },
      { afterMinutes: 43200, type: 'HUMAN', label: HUMAN_HANDOFF_LABEL },
    ],
    86400,
  ),
  FEEDBACK: ladder(
    [
      { afterMinutes: 0, type: 'WHATSAPP', label: 'Ask for feedback after delivery' },
      { afterMinutes: 1440, type: 'WHATSAPP', label: 'Single feedback reminder' },
    ],
    4320,
  ),
};

export function defaultShopConfig(timezone = 'Asia/Kolkata'): ShopConfig {
  return ShopConfigSchema.parse({
    configVersion: SHOP_CONFIG_VERSION,
    autonomy: {
      approval: 'L0_SHADOW',
      status: 'L0_SHADOW',
      delivery: 'L0_SHADOW',
      retention: 'L0_SHADOW',
      voice: 'L0_SHADOW',
    },
    pricing: { priceFloorPercent: 100, discountCeilingPercent: 0 },
    quietHours: { timezone, start: '21:00', end: '08:00' },
    // Monday–Saturday, 09:00–19:00. The Indian independent-workshop norm, and
    // the one number a new shop is most likely to correct first.
    workingHours: { days: [1, 2, 3, 4, 5, 6], open: '09:00', close: '19:00' },
    languages: { enabled: ['en'], default: 'en' },
    ladders: DEFAULT_LADDERS,
    payments: {
      paymentBeforeDelivery: true,
      acceptPartialPayment: false,
      minimumFirstPaymentPercent: 50,
      paymentLinkExpiryMinutes: 60 * 24 * 3,
      // Two rungs and then a person, which is the maximum the phase allows.
      balanceReminderAfterMinutes: [60 * 24, 60 * 24 * 3],
      gatePassTtlMinutes: 60 * 12,
      requireGatePass: true,
    },
    frequencyCaps: {
      maxOutboundPerCustomerPerDay: 3,
      maxOutboundPerCustomerPerWeek: 8,
      minMinutesBetweenMessages: 60,
    },
    disclosure: {
      requireFirstContactDisclosure: true,
      requireVoiceCallDisclosure: true,
      requireRecordingConsentLine: true,
    },
    messaging: {
      staffGroupId: null,
      whatsappPhoneNumberId: null,
      templates: { reengagement: null, jobCardOpened: null, readyForDelivery: null },
      defaultOutboundLanguage: 'en',
    },
    intake: {
      // The phase-2 flagship: anything the extractor is less than 80% sure of
      // is shown to a human with a tap-to-correct prompt before it becomes a
      // record.
      confirmationThreshold: 0.8,
      photoTrigger: '#jobcard',
      technicianMayConfirm: false,
    },
    consent: {
      impliedServiceConsentFromCounter: false,
      requireExplicitMarketingConsent: true,
    },
    agent: {
      // Six steps is the phase-3 cap: enough for read context → compose →
      // send → record, with headroom for one retry after a tool refusal, and
      // short enough that a looping model costs seconds rather than rupees.
      maxSteps: 6,
      wallClockBudgetMs: 60_000,
      maxTokensPerRun: 120_000,
      graduation: {
        minRuns: 30,
        minApprovedWithoutEditRate: 0.9,
        maxCheckerBlockRate: 0.05,
      },
    },
    eta: {
      // A general-service line is about an hour; fitting a part is half of
      // that; a consumable top-up is minutes; a fee is paperwork.
      defaultMinutesByLineKind: { LABOUR: 60, PART: 30, CONSUMABLE: 10, FEE: 0 },
      // A day and a half is what a Chennai parts run actually takes when the
      // item is not on the shelf. Shops with a counter next door lower it.
      partsLeadTimeMinutes: 60 * 36,
      qualityCheckMinutes: 30,
      bufferPercent: 20,
      // The phase's own threshold: 45 minutes, or crossing the promised day.
      materialSlipMinutes: 45,
    },
    statusComms: {
      silentBayAfterWorkingHours: 3,
      coalesceWindowHours: 2,
      silentWindowsBeforeEscalation: 2,
    },
    delivery: {
      slotMinutes: 30,
      maxPickupsPerSlot: 2,
      // The two windows an Indian workshop counter is genuinely unusable in.
      rushWindows: [
        { start: '13:00', end: '14:00' },
        { start: '18:00', end: '19:00' },
      ],
      suggestionCount: 3,
      earliestOffsetMinutes: 60,
      reminderLeadMinutes: 90,
    },
    invoice: {
      // Null rather than a placeholder: an invoice printed with somebody
      // else's GSTIN is a tax document with a false statement on it, so the
      // renderer refuses until an owner has filled these in.
      legalName: null,
      gstin: null,
      addressLines: [],
      stateCode: null,
      defaultHsnSac: null,
      numberPrefix: 'INV',
      footerNote: '',
      includeEvidenceAppendix: true,
    },
    voice: {
      // Every switch off. A shop that has never heard the agent speak on
      // WhatsApp has no business letting it speak on the phone, and the owner
      // is the one who decides otherwise — the same reasoning as L0 autonomy.
      enabled: false,
      outboundEnabled: false,
      inboundEnabled: false,
      retryOnNoAnswer: true,
      retryAfterMinutes: 20,
      maxCallsPerCustomerPerDay: 2,
      maxOutboundCallsPerDay: 50,
      // ₹500 a day. Roughly eighty three-minute calls at the default estimates,
      // which is a busy shop's whole approval board and then some.
      dailyCostCapPaise: 50_000,
      recordingRetentionDays: 180,
      minTranscriptConfidence: 0.6,
      poorTurnsBeforeIvr: 2,
      maxTurnsPerCall: 12,
      maxCallSeconds: 240,
      latencyBudgetMs: 1_200,
      maxSentencesPerTurn: 2,
      requireReadbackBeforeDecision: true,
    },
    retention: {
      // Off, like every other switch that can put a message in front of a
      // customer who did not just write to us. The ledger still fills up from
      // the moment a shop declines its first work item — turning this on later
      // finds a year of deferred work waiting, which is the point.
      enabled: false,
      // The phase's own floor. Three weeks between any two retention touches is
      // the difference between a workshop that remembers you and one that
      // markets at you.
      minDaysBetweenTouches: 21,
      maxRepitchesPerItem: 2,
      remindLaterDays: 30,
      // The phase's numbers: brake wear 60–90 days (75 is the middle), tyres
      // 90, cosmetic never. Keys are shop-KB categories, so a shop that names
      // its categories differently edits this map rather than the code.
      horizonDaysByCategory: {
        brakes: 75,
        tyres: 90,
        suspension: 120,
        battery: 180,
        wipers: 120,
        underbody: 180,
        ac: 150,
        cosmetic: null,
      },
      // Null: an uncategorised item is not re-pitched on a timer at all. It
      // still surfaces on the next visit, which costs the customer nothing.
      defaultHorizonDays: null,
      seasons: [
        // The south-west and north-east monsoons, which between them cover the
        // two windows an Indian workshop's wiper and brake work actually sells.
        { key: 'monsoon', start: '05-25', end: '07-15', tags: ['season:monsoon'] },
        { key: 'monsoon_ne', start: '10-01', end: '12-15', tags: ['season:monsoon'] },
      ],
      nextVisitPromptEnabled: true,
      odometerAskEnabled: true,
      odometerTriggerKm: 3_000,
      winBack: { enabled: false, afterMonths: 8, cooldownMonths: 6 },
      serviceDue: {
        enabled: false,
        intervalDays: 180,
        intervalKm: 10_000,
        leadDays: [7, 1],
      },
      documents: { enabled: false, leadDays: 15 },
    },
    feedback: {
      enabled: false,
      askAfterHours: 24,
      reminderAfterHours: 24,
      expireAfterHours: 72,
      // Null rather than a placeholder, for the reason `invoice.gstin` is: a
      // review link pointing at the wrong shop sends a customer's goodwill to
      // somebody else.
      reviewLink: null,
      askForReviewOnPositive: false,
      alertOwnerOnNegative: true,
      freezeRetentionOnNegative: true,
    },
    digest: {
      // On by default — the one phase-6 switch that is. A digest goes to the
      // owner's own number about their own shop; there is no customer to
      // protect and nothing for an owner to opt into before being told how
      // their day went.
      enabled: true,
      dailyAt: '20:30',
      includeWeekly: true,
      weeklyOn: 0,
      maxApprovalLines: 5,
    },
    alerts: {
      enabled: true,
      approvalStuckHours: 2,
      paymentFailuresBeforeAlert: 2,
      // Two of the five. A negative review at 22:00 is worth an owner's evening
      // because the recovery window is hours long; a voice kill switch is worth
      // it because the shop's telephone has stopped working. The other three
      // keep until morning.
      quietHoursOverride: ['NEGATIVE_FEEDBACK', 'VOICE_KILL_SWITCH'],
    },
    analytics: {
      recoveryCohortDays: 90,
      repeatVisitWindowDays: 180,
      maxBackfillDays: 400,
    },
  });
}

export const OBJECTIVE_KEYS: readonly Objective[] = OBJECTIVES;
