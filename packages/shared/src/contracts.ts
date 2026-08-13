import { z } from 'zod';
import {
  AuditActorTypeSchema,
  JobCardEventSchema,
  JobCardSourceSchema,
  JobCardStateSchema,
  LanguageSchema,
  StaffRoleSchema,
  WorkItemStateSchema,
} from './enums';
import { PhoneSchema } from './phone';

/**
 * Wire contracts shared by `apps/api` (DTO validation) and `apps/console`
 * (typed client). One schema, both ends — the console client cannot drift from
 * the API it calls.
 */

/* ---------------------------------- auth --------------------------------- */

export const OtpRequestSchema = z.object({ phone: PhoneSchema });
export type OtpRequest = z.infer<typeof OtpRequestSchema>;

export const OtpRequestResponseSchema = z.object({
  sent: z.literal(true),
  expiresInSeconds: z.number().int().positive(),
  /** Present only in DEMO_MODE, so the console can show the code (phase 1.8). */
  demoCode: z.string().optional(),
});
export type OtpRequestResponse = z.infer<typeof OtpRequestResponseSchema>;

export const OtpVerifySchema = z.object({
  phone: PhoneSchema,
  code: z.string().regex(/^\d{6}$/),
});
export type OtpVerify = z.infer<typeof OtpVerifySchema>;

export const SessionShopSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  city: z.string(),
  role: StaffRoleSchema,
});
export type SessionShop = z.infer<typeof SessionShopSchema>;

export const SessionSchema = z.object({
  accessToken: z.string(),
  expiresInSeconds: z.number().int().positive(),
  staff: z.object({
    id: z.string().uuid(),
    fullName: z.string(),
    role: StaffRoleSchema,
    shopId: z.string().uuid(),
  }),
  shops: z.array(SessionShopSchema),
});
export type Session = z.infer<typeof SessionSchema>;

export const SwitchShopSchema = z.object({ shopId: z.string().uuid() });
export type SwitchShop = z.infer<typeof SwitchShopSchema>;

/* -------------------------------- job cards ------------------------------- */

export const JobCardSummarySchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  state: JobCardStateSchema,
  stateChangedAt: z.string().datetime({ offset: true }),
  openedAt: z.string().datetime({ offset: true }).nullable(),
  promisedAt: z.string().datetime({ offset: true }).nullable(),
  source: JobCardSourceSchema,
  complaintText: z.string().nullable(),
  customer: z.object({
    id: z.string().uuid(),
    fullName: z.string(),
    phoneMasked: z.string(),
    preferredLanguage: LanguageSchema,
  }),
  vehicle: z.object({
    id: z.string().uuid(),
    registration: z.string(),
    registrationDisplay: z.string(),
    make: z.string().nullable(),
    model: z.string().nullable(),
  }),
  advisor: z.object({ id: z.string().uuid(), fullName: z.string() }).nullable(),
  workItemCounts: z.object({
    total: z.number().int().nonnegative(),
    pendingApproval: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
  }),
  estimateTotalPaise: z.number().int().nonnegative().nullable(),
});
export type JobCardSummary = z.infer<typeof JobCardSummarySchema>;

export const WorkItemDtoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullable(),
  state: WorkItemStateSchema,
  requiresApproval: z.boolean(),
  technicianNote: z.string().nullable(),
  sequence: z.number().int(),
  estimatedMinutes: z.number().int().nullable(),
});
export type WorkItemDto = z.infer<typeof WorkItemDtoSchema>;

export const EstimateLineDtoSchema = z.object({
  id: z.string().uuid(),
  description: z.string(),
  kind: z.enum(['LABOUR', 'PART', 'CONSUMABLE', 'FEE']),
  quantityMilli: z.number().int(),
  unitPricePaise: z.number().int(),
  lineTotalPaise: z.number().int(),
  workItemId: z.string().uuid().nullable(),
});
export type EstimateLineDto = z.infer<typeof EstimateLineDtoSchema>;

export const EstimateDtoSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int(),
  status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'SUPERSEDED']),
  subtotalPaise: z.number().int(),
  taxPaise: z.number().int(),
  totalPaise: z.number().int(),
  acceptedAt: z.string().datetime({ offset: true }).nullable(),
  lines: z.array(EstimateLineDtoSchema),
});
export type EstimateDto = z.infer<typeof EstimateDtoSchema>;

export const AuditEntryDtoSchema = z.object({
  id: z.string().uuid(),
  seq: z.number().int(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  actorType: AuditActorTypeSchema,
  actorId: z.string().nullable(),
  payload: z.record(z.unknown()),
  hash: z.string(),
  prevHash: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type AuditEntryDto = z.infer<typeof AuditEntryDtoSchema>;

export const JobCardDetailSchema = JobCardSummarySchema.extend({
  workItems: z.array(WorkItemDtoSchema),
  estimates: z.array(EstimateDtoSchema),
  auditTrail: z.array(AuditEntryDtoSchema),
  allowedEvents: z.array(JobCardEventSchema),
});
export type JobCardDetail = z.infer<typeof JobCardDetailSchema>;

export const BoardColumnSchema = z.object({
  state: JobCardStateSchema,
  cards: z.array(JobCardSummarySchema),
});
export const BoardResponseSchema = z.object({
  columns: z.array(BoardColumnSchema),
  totalCards: z.number().int().nonnegative(),
});
export type BoardResponse = z.infer<typeof BoardResponseSchema>;

export const TransitionRequestSchema = z.object({
  event: JobCardEventSchema,
  meta: z.record(z.unknown()).optional(),
});
export type TransitionRequest = z.infer<typeof TransitionRequestSchema>;

export const TransitionResponseSchema = z.object({
  jobCardId: z.string().uuid(),
  from: JobCardStateSchema,
  to: JobCardStateSchema,
  auditEventId: z.string().uuid(),
});
export type TransitionResponse = z.infer<typeof TransitionResponseSchema>;

/* ---------------------------------- audit --------------------------------- */

export const ChainVerificationSchema = z.object({
  shopId: z.string().uuid(),
  entriesChecked: z.number().int().nonnegative(),
  valid: z.boolean(),
  brokenAtIndex: z.number().int().nullable(),
  brokenEventId: z.string().uuid().nullable(),
  reason: z.string().nullable(),
});
export type ChainVerification = z.infer<typeof ChainVerificationSchema>;

/* --------------------------------- health --------------------------------- */

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  demoMode: z.boolean(),
  version: z.string(),
  checks: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['ok', 'down']),
      latencyMs: z.number().nonnegative().nullable(),
      detail: z.string().nullable(),
    }),
  ),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/* ------------------------------- problem json ----------------------------- */

export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string(),
  instance: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;
