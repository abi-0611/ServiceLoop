import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard, RolesGuard } from './auth/guards';
import { RequestContextMiddleware } from './common/request-context';
import { InfraModule } from './infra/infra.module';
import { LoopModule } from './loop/loop.module';
import { MessagingModule } from './messaging/messaging.module';
import { AuditController } from './modules/audit.controller';
import { ConfigController } from './modules/config.controller';
import { HealthController } from './modules/health.controller';
import { JobCardsController } from './modules/jobcards.controller';

/**
 * Authentication and RBAC are global guards, so a new controller is protected
 * by default and has to opt out explicitly with `@Public()`.
 */
@Module({
  imports: [InfraModule, AuthModule, MessagingModule, LoopModule],
  controllers: [HealthController, JobCardsController, ConfigController, AuditController],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*path');
  }
}
