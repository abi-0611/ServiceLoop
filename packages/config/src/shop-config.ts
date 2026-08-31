import {
  AutonomyLevelSchema,
  EscalationRungTypeSchema,
  HhMmSchema,
  LanguageSchema,
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
 * `invoice`, and widens `payments` past the single ordering flag.
 * Stored documents are migrated forward on read by `migrateShopConfig`, merging
 * the conservative defaults below — an absent field can only ever become more
 * restrictive, never less.
 */
export const SHOP_CONFIG_VERSION = 4 as const;

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
  });
}

export const OBJECTIVE_KEYS: readonly Objective[] = OBJECTIVES;
