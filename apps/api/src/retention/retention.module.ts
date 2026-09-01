import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { AnalyticsController } from './analytics.controller';
import { RetentionController } from './retention.controller';

/**
 * Phase 6's read surface.
 *
 * Controllers only. The runtime itself is provided by `MessagingModule`,
 * because `InboundHandler` needs it — the ledger's one-tap answers, the
 * feedback faces and the MARKETING ask all arrive as inbound taps — and a
 * module that provided it here would need a `forwardRef` in both directions to
 * say something that is not true: nothing in messaging depends on these
 * controllers.
 */
@Module({
  imports: [MessagingModule],
  controllers: [AnalyticsController, RetentionController],
})
export class RetentionModule {}
