import {
  AutonomyLevelSchema,
  EscalationChannelSchema,
  HhMmSchema,
  LanguageSchema,
  OBJECTIVES,
  TimeZoneSchema,
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

export const SHOP_CONFIG_VERSION = 1 as const;

export const EscalationRungSchema = z.object({
  /** Minutes after the objective opened (not after the previous rung). */
  afterMinutes: z
    .number()
    .int()
    .min(0)
    .max(60 * 24 * 90),
  channel: EscalationChannelSchema,
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
});
export type PaymentsConfig = z.infer<typeof PaymentsConfigSchema>;

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

export const ShopConfigV1Schema = z.object({
  configVersion: z.literal(SHOP_CONFIG_VERSION),
  autonomy: AutonomyConfigSchema,
  pricing: PricingConfigSchema,
  quietHours: QuietHoursSchema,
  languages: LanguagesConfigSchema,
  ladders: LaddersSchema,
  payments: PaymentsConfigSchema,
  frequencyCaps: FrequencyCapsSchema,
  disclosure: DisclosureConfigSchema,
});

export type ShopConfig = z.infer<typeof ShopConfigV1Schema>;

const HUMAN_HANDOFF_LABEL = 'Hand off to a human advisor';

function ladder(
  rungs: ReadonlyArray<Omit<EscalationRung, 'label'> & { label: string }>,
  giveUpAfterMinutes: number,
): EscalationLadder {
  return { enabled: true, rungs: [...rungs], giveUpAfterMinutes };
}

/** L3: every objective ships with a cadence that ends in a human. */
export const DEFAULT_LADDERS: LaddersConfig = {
  APPROVAL: ladder(
    [
      { afterMinutes: 0, channel: 'WHATSAPP', label: 'Send evidence-backed approval request' },
      { afterMinutes: 120, channel: 'WHATSAPP', label: 'Gentle reminder with the same evidence' },
      { afterMinutes: 360, channel: 'VOICE', label: 'Outbound call to walk through the estimate' },
      { afterMinutes: 1440, channel: 'HUMAN', label: HUMAN_HANDOFF_LABEL },
    ],
    2880,
  ),
  STATUS: ladder(
    [
      { afterMinutes: 0, channel: 'WHATSAPP', label: 'Proactive status update' },
      { afterMinutes: 720, channel: 'WHATSAPP', label: 'Follow-up status update' },
      { afterMinutes: 2880, channel: 'HUMAN', label: HUMAN_HANDOFF_LABEL },
    ],
    4320,
  ),
  DELIVERY: ladder(
    [
      { afterMinutes: 0, channel: 'WHATSAPP', label: 'Ready-for-delivery alert' },
      { afterMinutes: 180, channel: 'WHATSAPP', label: 'Pickup reminder' },
      { afterMinutes: 720, channel: 'VOICE', label: 'Call to arrange pickup' },
      { afterMinutes: 1440, channel: 'HUMAN', label: HUMAN_HANDOFF_LABEL },
    ],
    4320,
  ),
  PAYMENT: ladder(
    [
      { afterMinutes: 0, channel: 'WHATSAPP', label: 'Invoice and payment link' },
      { afterMinutes: 240, channel: 'WHATSAPP', label: 'Payment reminder' },
      { afterMinutes: 1440, channel: 'VOICE', label: 'Call about the outstanding amount' },
      { afterMinutes: 2880, channel: 'HUMAN', label: HUMAN_HANDOFF_LABEL },
    ],
    10080,
  ),
  RETENTION: ladder(
    [
      { afterMinutes: 0, channel: 'WHATSAPP', label: 'Re-pitch deferred work at its horizon' },
      { afterMinutes: 10080, channel: 'WHATSAPP', label: 'Second re-pitch' },
      { afterMinutes: 43200, channel: 'HUMAN', label: HUMAN_HANDOFF_LABEL },
    ],
    86400,
  ),
  FEEDBACK: ladder(
    [
      { afterMinutes: 0, channel: 'WHATSAPP', label: 'Ask for feedback after delivery' },
      { afterMinutes: 1440, channel: 'WHATSAPP', label: 'Single feedback reminder' },
    ],
    4320,
  ),
};

export function defaultShopConfig(timezone = 'Asia/Kolkata'): ShopConfig {
  return ShopConfigV1Schema.parse({
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
    languages: { enabled: ['en'], default: 'en' },
    ladders: DEFAULT_LADDERS,
    payments: { paymentBeforeDelivery: true },
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
  });
}

export const OBJECTIVE_KEYS: readonly Objective[] = OBJECTIVES;
