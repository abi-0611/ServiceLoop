import {
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  type RawBodyRequest,
} from '@nestjs/common';
import type { LoopRuntime } from '@serviceloop/agent-core';
import type { Tx } from '@serviceloop/db';
import type { Request } from 'express';
import { Public } from '../auth/auth.types';
import { rootLogger } from '../common/logger';
import { currentTraceId } from '../common/request-context';
import { LOOP_RUNTIME } from '../infra/tokens';

/**
 * The payments webhook (phase 4.9).
 *
 * The same three properties as the WhatsApp webhook, for the same reasons —
 * and one more that is specific to money:
 *
 * 1. **The signature is verified over the raw bytes, before anything is
 *    parsed.** `rawBody` is captured by the Nest factory. Razorpay's own docs
 *    say not to re-serialise the body, and they are right: `JSON.parse`
 *    followed by `JSON.stringify` reorders keys and drops whitespace, so the
 *    HMAC will not match. That is the failure mode where verification appears
 *    to work in testing and silently rejects every real delivery — or, if
 *    somebody "fixes" it by relaxing the check, accepts a forged one that
 *    marks an unpaid car as paid.
 *
 * 2. **An invalid signature answers 401, not 500.** A permanently invalid
 *    signature must tell the provider to stop rather than retry.
 *
 * 3. **A verified delivery always answers 200.** Razorpay retries any non-2xx
 *    until it gives up; a handler error surfacing as a 500 would make it
 *    redeliver the same payment. Idempotency is what makes that safe — the
 *    ledger collides on `provider_event_id` — but the honest contract is that
 *    we have taken custody of this delivery.
 *
 * 4. **It is `@Public()`, and that is not a hole.** The signature *is* the
 *    authentication, and it is stronger than a session would be: it proves the
 *    body came from the provider, not merely that somebody is logged in. The
 *    shop is resolved from the payment row the link id matches, never from
 *    anything in the payload.
 */
@Controller('webhooks/payments')
export class PaymentsWebhookController {
  private readonly logger = rootLogger.child({ component: 'payments-webhook' });

  constructor(@Inject(LOOP_RUNTIME) private readonly loop: LoopRuntime<Tx>) {}

  @Public()
  @Post()
  @HttpCode(200)
  async receive(@Req() request: RawBodyRequest<Request>): Promise<{ handled: boolean }> {
    const rawBody = request.rawBody ?? Buffer.alloc(0);
    const traceId = currentTraceId();

    const verdict = this.loop.paymentsPort.parseWebhook({
      rawBody,
      headers: request.headers as Record<string, string | undefined>,
    });

    if (!verdict.ok) {
      if (verdict.code === 'BAD_SIGNATURE') {
        this.logger.warn({ traceId, reason: verdict.reason }, 'rejected an unsigned payment webhook');
        throw new UnauthorizedException({ code: verdict.code, detail: verdict.reason });
      }

      // `IGNORED` and `MALFORMED` are answered 200: the signature held, so the
      // delivery is genuinely ours, and there is nothing a retry would fix.
      this.logger.info({ traceId, code: verdict.code, reason: verdict.reason }, 'payment webhook not consumed');
      return { handled: false };
    }

    try {
      const result = await this.loop.payments.reconcile({
        event: verdict.event,
        actor: { type: 'SYSTEM', id: null },
        traceId,
      });

      this.logger.info(
        {
          traceId,
          paymentId: result.paymentId,
          kind: verdict.event.kind,
          status: result.status,
          duplicate: result.duplicate,
          cardMoved: result.cardMoved,
        },
        'reconciled a payment event',
      );

      return { handled: result.handled };
    } catch (error) {
      // Logged and audited, never bounced back to the provider — see (3).
      this.logger.error(
        { err: error, traceId, providerEventId: verdict.event.providerEventId },
        'payment reconcile failed after a verified delivery',
      );
      return { handled: false };
    }
  }
}
