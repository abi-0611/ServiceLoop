import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ValidationError } from '@serviceloop/shared';
import type { Request } from 'express';
import type { z } from 'zod';

/**
 * Zod DTO validation.
 *
 * Every request body, query and param is parsed by the same schemas the console
 * client uses (`@serviceloop/shared/contracts`), so a contract change breaks
 * both ends at compile time rather than at runtime in production.
 *
 * Failures become `ValidationError`, which the problem-details filter renders
 * with field-level errors.
 */

function parseOrThrow<T extends z.ZodTypeAny>(
  schema: T,
  value: unknown,
  source: string,
): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  throw new ValidationError(`Invalid ${source}`, {
    fieldErrors: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    })),
  });
}

export const ZodBody = <T extends z.ZodTypeAny>(schema: T) =>
  createParamDecorator((_data: unknown, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<Request>();
    return parseOrThrow(schema, request.body, 'request body');
  })();

export const ZodQuery = <T extends z.ZodTypeAny>(schema: T) =>
  createParamDecorator((_data: unknown, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<Request>();
    return parseOrThrow(schema, request.query, 'query string');
  })();

export const ZodParam = <T extends z.ZodTypeAny>(name: string, schema: T) =>
  createParamDecorator((_data: unknown, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<Request>();
    return parseOrThrow(
      schema,
      (request.params as Record<string, unknown>)[name],
      `path parameter "${name}"`,
    );
  })();
