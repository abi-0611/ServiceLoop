import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { uuidv7 } from '@serviceloop/shared';
import type { NextFunction, Request, Response } from 'express';

/**
 * Request-scoped context.
 *
 * A request id is minted (or taken from `x-request-id`) and carried through
 * logs, audit rows and outbox envelopes as `traceId`, so one customer
 * interaction can be followed across the API, the queue and the audit chain.
 */

export interface RequestContext {
  readonly requestId: string;
  readonly startedAt: number;
  staffId?: string;
  shopId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentTraceId(): string {
  return storage.getStore()?.requestId ?? `detached-${uuidv7()}`;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const inbound = request.header('x-request-id');
    const requestId =
      inbound !== undefined && inbound.length > 0 && inbound.length <= 128 ? inbound : uuidv7();

    response.setHeader('x-request-id', requestId);
    storage.run({ requestId, startedAt: Date.now() }, () => {
      next();
    });
  }
}
