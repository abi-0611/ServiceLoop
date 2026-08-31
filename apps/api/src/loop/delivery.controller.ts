import { BadRequestException, Controller, Get, Inject, Post } from '@nestjs/common';
import type { LoopRuntime } from '@serviceloop/agent-core';
import type { Tx } from '@serviceloop/db';
import { z } from 'zod';
import { CurrentStaff, Roles, type AuthenticatedStaff } from '../auth/auth.types';
import { currentTraceId } from '../common/request-context';
import { ZodBody, ZodQuery } from '../common/zod';
import { LOOP_RUNTIME } from '../infra/tokens';

/**
 * Ready-for-delivery, invoicing and payment links (phase 4.7–4.9).
 *
 * The console's end-of-loop surface. Every write here is idempotent by
 * construction rather than by the caller being careful — `announceReady`
 * refuses a second offer, `issue` returns the existing invoice, and
 * `createLink` re-uses a live link — because these are the buttons an advisor
 * double-taps when the counter is busy, and each of them costs a customer a
 * duplicate message or a duplicate payment.
 */

const CardBody = z.object({ jobCardId: z.string().uuid() });

const CardQuery = z.object({ jobCardId: z.string().uuid() });

const IssueInvoiceBody = z.object({
  jobCardId: z.string().uuid(),
  /** GST state code where the service was supplied. Defaults to the shop's. */
  placeOfSupplyStateCode: z
    .string()
    .regex(/^\d{2}$/)
    .optional(),
});

const PaymentLinkBody = z.object({
  jobCardId: z.string().uuid(),
  /** Overrides the invoice total, e.g. for a part payment agreed at the counter. */
  amountPaise: z.number().int().positive().optional(),
});

const ManualPaymentBody = z.object({
  paymentId: z.string().uuid(),
  amountPaise: z.number().int().positive(),
  method: z.enum(['UPI', 'CARD', 'NETBANKING', 'WALLET', 'CASH', 'BANK_TRANSFER', 'OTHER']),
  note: z.string().max(200).default(''),
});

@Controller('delivery')
export class DeliveryController {
  constructor(@Inject(LOOP_RUNTIME) private readonly loop: LoopRuntime<Tx>) {}

  /**
   * Sends the ready message with pickup slots.
   *
   * Normally fired by the worker on `QUALITY_CHECK → READY_FOR_DELIVERY`; this
   * endpoint exists because an advisor sometimes needs to re-open the
   * conversation by hand, and because the demo drives it explicitly.
   */
  @Post('ready')
  @Roles('OWNER', 'ADVISOR')
  async announceReady(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(CardBody) body: z.infer<typeof CardBody>,
  ) {
    const result = await this.loop.delivery.announceReady({
      shopId: staff.shopId,
      jobCardId: body.jobCardId,
      actor: { type: 'STAFF', id: staff.staffId },
      traceId: currentTraceId(),
    });

    if (!result.ok) throw new BadRequestException({ code: result.code, detail: result.reason });

    return {
      bookingId: result.bookingId,
      messageId: result.messageId,
      gateStatus: result.gateStatus,
      amountDuePaise: result.amountDuePaise,
      offeredSlots: result.offeredSlots.map((slot) => ({
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
      })),
    };
  }

  @Post('invoice')
  @Roles('OWNER', 'ADVISOR')
  async issueInvoice(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(IssueInvoiceBody) body: z.infer<typeof IssueInvoiceBody>,
  ) {
    const result = await this.loop.invoices.issue({
      shopId: staff.shopId,
      jobCardId: body.jobCardId,
      placeOfSupplyStateCode: body.placeOfSupplyStateCode ?? null,
      actor: { type: 'STAFF', id: staff.staffId },
      traceId: currentTraceId(),
    });

    // A missing legal name is an owner's five-second fix in Settings, so it is
    // a 400 with the field named — not a 500 an advisor can do nothing about.
    if (!result.ok) throw new BadRequestException({ code: result.code, detail: result.reason });

    return {
      invoiceId: result.invoiceId,
      number: result.number,
      totalPaise: result.totalPaise,
      mediaId: result.mediaId,
      renderHash: result.renderHash,
      evidenceBlocks: result.evidenceBlocks,
      alreadyIssued: result.alreadyIssued,
    };
  }

  @Post('payment-link')
  @Roles('OWNER', 'ADVISOR')
  async createPaymentLink(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(PaymentLinkBody) body: z.infer<typeof PaymentLinkBody>,
  ) {
    const result = await this.loop.payments.createLink({
      shopId: staff.shopId,
      jobCardId: body.jobCardId,
      ...(body.amountPaise === undefined ? {} : { amountPaise: body.amountPaise }),
      actor: { type: 'STAFF', id: staff.staffId },
      traceId: currentTraceId(),
    });

    if (!result.ok) throw new BadRequestException({ code: result.code, detail: result.reason });

    return {
      paymentId: result.paymentId,
      shortUrl: result.shortUrl,
      amountPaise: result.amountPaise,
      reused: result.reused,
    };
  }

  /**
   * Records money taken at the counter.
   *
   * Cash is how most of these shops are still paid. A system that could only
   * see UPI would show every one of those cards as unpaid for ever, and would
   * then chase the customer for money they have already handed over.
   */
  @Post('payment/manual')
  @Roles('OWNER', 'ADVISOR')
  async recordManualPayment(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodBody(ManualPaymentBody) body: z.infer<typeof ManualPaymentBody>,
  ) {
    const result = await this.loop.payments.recordManualPayment({
      shopId: staff.shopId,
      paymentId: body.paymentId,
      amountPaise: body.amountPaise,
      method: body.method,
      staffId: staff.staffId,
      note: body.note,
      actor: { type: 'STAFF', id: staff.staffId },
      traceId: currentTraceId(),
    });

    if (!result.handled) {
      throw new BadRequestException({ code: 'PAYMENT_NOT_RECONCILABLE', detail: result.detail });
    }

    return {
      paymentId: result.paymentId,
      status: result.status,
      amountPaidPaise: result.amountPaidPaise,
      balancePaise: result.balancePaise,
      cardMoved: result.cardMoved,
      alreadyRecorded: result.duplicate,
    };
  }

  /**
   * The card's ETA, booking, invoice, payment and gate pass in one read.
   *
   * One request rather than five, because this is a drawer an advisor opens
   * with a customer standing in front of them, and five round trips on a
   * workshop's connection is a visible stagger.
   */
  @Get('summary')
  @Roles('OWNER', 'ADVISOR')
  async summary(
    @CurrentStaff() staff: AuthenticatedStaff,
    @ZodQuery(CardQuery) query: z.infer<typeof CardQuery>,
  ) {
    const shopId = staff.shopId;
    const [eta, booking, invoice, payment, gatePass, amountDuePaise] = await Promise.all([
      this.loop.eta.latest(shopId, query.jobCardId),
      this.loop.delivery.openBooking(shopId, query.jobCardId),
      this.loop.invoices.forCard(shopId, query.jobCardId),
      this.loop.payments.openForCard(shopId, query.jobCardId),
      this.loop.gatePasses.activeForCard(shopId, query.jobCardId),
      this.loop.delivery.amountDue(shopId, query.jobCardId),
    ]);

    return {
      jobCardId: query.jobCardId,
      amountDuePaise,
      eta:
        eta === null
          ? null
          : {
              eta: eta.eta.toISOString(),
              version: eta.version,
              reason: eta.reason,
              materiality: eta.materiality,
              detail: eta.detail,
              customerWasTold: eta.notifiedAt !== null,
            },
      booking:
        booking === null
          ? null
          : {
              bookingId: booking.id,
              status: booking.status,
              offeredSlots: booking.offeredSlots.map((slot) => slot.toISOString()),
              slotStart: booking.slotStart?.toISOString() ?? null,
              slotEnd: booking.slotEnd?.toISOString() ?? null,
              chosenVia: booking.chosenVia,
              reminderSentAt: booking.reminderSentAt?.toISOString() ?? null,
            },
      invoice:
        invoice === null
          ? null
          : {
              invoiceId: invoice.id,
              number: invoice.number,
              status: invoice.status,
              totalPaise: invoice.totalPaise,
              amountPaidPaise: invoice.amountPaidPaise,
              mediaId: invoice.mediaId,
              issuedAt: invoice.issuedAt?.toISOString() ?? null,
            },
      payment:
        payment === null
          ? null
          : {
              paymentId: payment.id,
              status: payment.status,
              provider: payment.provider,
              amountPaise: payment.amountPaise,
              amountPaidPaise: payment.amountPaidPaise,
              shortUrl: payment.shortUrl,
              remindersSent: payment.remindersSent,
            },
      // The token is deliberately absent: it was returned once, at issue, and
      // only its hash was stored. A summary that could hand it back would make
      // every read of this endpoint a way to open a barrier.
      gatePass:
        gatePass === null
          ? null
          : {
              gatePassId: gatePass.id,
              code: gatePass.code,
              status: gatePass.status,
              expiresAt: gatePass.expiresAt.toISOString(),
              usedAt: gatePass.usedAt?.toISOString() ?? null,
            },
    };
  }
}
