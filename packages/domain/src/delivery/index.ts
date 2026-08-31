/**
 * The end of the loop (phase 4.7–4.10): pickup slots, invoices, payments, and
 * the gate pass that lets a vehicle leave.
 *
 * Model-free like the rest of the domain. The two things that reach outside the
 * process — rendering a PDF and creating a payment link — do so through ports
 * (`InvoiceRenderer`, `PaymentLinkGateway`) that `packages/adapters` implements,
 * so the tax arithmetic, the slot cap and the reconcile ledger can all be tested
 * without a credential or a headless browser.
 */

export {
  overlapsRush,
  slotStillAvailable,
  suggestSlots,
  type Slot,
  type SuggestSlotsInput,
} from './slots';

export {
  DeliveryService,
  type AnnounceReadyInput,
  type AnnounceReadyResult,
  type ChooseSlotResult,
  type DeliveryServiceDeps,
} from './delivery-service';

export {
  buildInvoice,
  invoiceNumber,
  splitTax,
  type BillableLine,
  type BuildInvoiceInput,
  type BuildInvoiceResult,
  type InvoiceDraft,
  type InvoiceLineDraft,
} from './invoice-builder';

export {
  InvoiceService,
  buildEvidenceBlocks,
  financialYearOf,
  toBillableLines,
  type InvoiceServiceDeps,
  type IssueInvoiceResult,
} from './invoice-service';

export {
  PaymentService,
  nextStatus,
  type CreateLinkResult,
  type PaymentServiceDeps,
  type ProviderPaymentEvent,
  type ReconcileResult,
} from './payment-service';

export {
  generateGatePassCode,
  hashToken,
  signGatePass,
  verifyGatePassToken,
  type GatePassClaims,
  type SignedGatePass,
  type TokenVerdict,
} from './gate-pass-token';

export {
  GatePassService,
  type GatePassServiceDeps,
  type IssueGatePassResult,
  type VerifyResult,
} from './gate-pass-service';

export type {
  AdvisorTaskCreator,
  DeliveryBooking,
  DeliveryBookingStore,
  GatePassRecord,
  GatePassSecretProvider,
  GatePassStore,
  GeneratedMediaWriter,
  InvoiceEvidenceBlock,
  InvoiceRecord,
  InvoiceRenderInput,
  InvoiceRenderer,
  InvoiceStore,
  PaymentEventRecord,
  PaymentLinkGateway,
  PaymentRecord,
  PaymentStore,
  QrRenderer,
} from './ports';
