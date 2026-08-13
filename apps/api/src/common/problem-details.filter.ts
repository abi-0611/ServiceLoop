import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AppError, type Problem } from '@serviceloop/shared';
import type { Response } from 'express';
import { rootLogger } from './logger';
import { currentTraceId } from './request-context';

/**
 * RFC 9457 problem-details responses.
 *
 * Domain errors carry their own machine-readable `code` and status; anything
 * else is reported as a generic 500 with the trace id, and the real cause goes
 * to the log rather than to the client.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const traceId = currentTraceId();

    const problem = toProblem(exception, traceId);

    if (problem.status >= 500) {
      rootLogger.error(
        { err: exception, traceId, code: problem.code },
        'unhandled request failure',
      );
    } else {
      rootLogger.warn({ traceId, code: problem.code, status: problem.status }, problem.detail);
    }

    response.status(problem.status).type('application/problem+json').send(problem);
  }
}

function toProblem(exception: unknown, traceId: string): Problem {
  if (exception instanceof AppError) {
    return { ...exception.toProblem(traceId), instance: traceId };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const payload = exception.getResponse();
    const detail =
      typeof payload === 'string'
        ? payload
        : ((payload as { message?: string | string[] }).message ?? exception.message);

    return {
      type: `https://serviceloop.dev/errors/http-${status}`,
      title: exception.name,
      status,
      code: httpCode(status),
      detail: Array.isArray(detail) ? detail.join('; ') : detail,
      instance: traceId,
    };
  }

  return {
    type: 'https://serviceloop.dev/errors/internal',
    title: 'InternalServerError',
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    code: 'INTERNAL_ERROR',
    detail: 'An unexpected error occurred. The trace id identifies this request in the logs.',
    instance: traceId,
  };
}

function httpCode(status: number): string {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'UNPROCESSABLE';
    case 429:
      return 'RATE_LIMITED';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
  }
}
