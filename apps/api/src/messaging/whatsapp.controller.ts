import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import {
  MESSAGE_STATUS_BY_DELIVERY_STATE,
  toInboundMessage,
  WhatsAppError,
  type WhatsAppPort,
} from '@serviceloop/adapters';
import { PgMessageStore, type PgUnitOfWork, type Tx } from '@serviceloop/db';
import type { InboundHandler } from '@serviceloop/domain';
import { UnauthorizedError, ValidationError } from '@serviceloop/shared';
import type { Request } from 'express';
import { currentTraceId } from '../common/request-context';
import { rootLogger } from '../common/logger';
import { Public } from '../auth/auth.types';
import { INBOUND_HANDLER, UNIT_OF_WORK, WHATSAPP_PORT } from '../infra/tokens';
import { ShopResolver } from './shop-resolver';

/**
 * The WhatsApp webhook (phase 2.1).
 *
 * Two things about this endpoint are load-bearing:
 *
 * 1. **The signature is checked over the raw bytes**, before the body is
 *    parsed. `rawBody` is captured by the Nest factory for exactly this route;
 *    a re-serialised object would produce a different digest and either fail
 *    every legitimate delivery or — worse, if someone "fixed" it by relaxing
 *    the check — accept a forged one.
 *
 * 2. **It always answers 200 once the signature holds.** Meta retries any
 *    non-2xx, and a handler error that surfaced as a 500 would make it redeliver
 *    the same photograph until it gave up. Idempotency is what makes that safe
 *    (the router recognises a provider message id it has already stored), but
 *    the honest contract is: we have taken custody of this delivery. Failures
 *    are logged and audited, never bounced back to the provider.
 */
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly messages = new PgMessageStore();

  constructor(
    @Inject(WHATSAPP_PORT) private readonly whatsapp: WhatsAppPort,
    @Inject(INBOUND_HANDLER) private readonly handler: InboundHandler<Tx>,
    @Inject(UNIT_OF_WORK) private readonly uow: PgUnitOfWork,
    @Inject(ShopResolver) private readonly shops: ShopResolver,
  ) {}

  /**
   * Meta's subscription handshake. Echoes the challenge when the verify token
   * matches, and 401s otherwise — the adapter owns that comparison so both the
   * sandbox and the live adapter answer it identically.
   */
  @Public()
  @Get()
  verify(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') verifyToken?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    try {
      return this.whatsapp.verifySubscription({
        mode: mode ?? null,
        verifyToken: verifyToken ?? null,
        challenge: challenge ?? null,
      });
    } catch (error) {
      throw new UnauthorizedError(
        error instanceof Error ? error.message : 'Webhook verification failed',
      );
    }
  }

  @Public()
  @Post()
  @HttpCode(200)
  async receive(@Req() request: RawBodyRequest<Request>): Promise<{ received: number }> {
    const rawBody = request.rawBody?.toString('utf8') ?? '';
    const signature = request.header('x-hub-signature-256') ?? null;
    const traceId = currentTraceId();

    // `receive` throws `WhatsAppError('SIGNATURE_INVALID')` before parsing
    // anything, so a tampered payload never reaches the router.
    //
    // The translation below matters as much as the check: an adapter error is
    // not an `AppError`, so without this it would surface as a 500 — and Meta
    // retries 5xx. A permanently invalid signature would be redelivered
    // forever. A 4xx tells the provider to stop, which is the truth.
    let batch;
    try {
      batch = await this.whatsapp.receive({
        rawBody,
        signatureHeader: signature,
        receivedAt: new Date(),
      });
    } catch (error) {
      if (error instanceof WhatsAppError && error.kind === 'SIGNATURE_INVALID') {
        throw new UnauthorizedError(error.message);
      }
      if (error instanceof WhatsAppError) {
        throw new ValidationError(`This webhook delivery could not be read: ${error.message}`, {
          kind: error.kind,
        });
      }
      throw error;
    }

    const shopId = await this.shops.resolve(batch.phoneNumberId);
    let handled = 0;

    for (const event of batch.events) {
      try {
        await this.handler.handle({
          shopId,
          channel: 'WHATSAPP',
          message: toInboundMessage(event),
          traceId: `${traceId}:${event.waMessageId}`,
        });
        handled += 1;

        // Blue ticks are best-effort: a customer whose message was answered but
        // not ticked is a cosmetic problem, and failing the delivery over it
        // would cost us a redelivery of work already done.
        await this.whatsapp
          .markRead({ shopId, waMessageId: event.waMessageId })
          .catch(() => undefined);
      } catch (error) {
        rootLogger.error(
          { err: error, shopId, waMessageId: event.waMessageId },
          'inbound message handling failed',
        );
      }
    }

    for (const status of batch.statuses) {
      try {
        await this.uow.transaction(async (tx: Tx) => {
          await this.messages.updateDeliveryState(tx, {
            shopId,
            providerMessageId: status.waMessageId,
            status: MESSAGE_STATUS_BY_DELIVERY_STATE[status.state],
            at: status.timestamp,
            errorCode: status.errorCode === null ? null : String(status.errorCode),
            failureReason: status.errorTitle,
          });
        });
        handled += 1;
      } catch (error) {
        rootLogger.error(
          { err: error, shopId, waMessageId: status.waMessageId },
          'delivery receipt handling failed',
        );
      }
    }

    return { received: handled };
  }
}
