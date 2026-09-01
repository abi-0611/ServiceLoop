/**
 * Error taxonomy. Every error carries a stable machine-readable `code` so the
 * API can render RFC 9457 problem-details without string matching.
 */

export type ErrorDetails = Readonly<Record<string, unknown>>;

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details: ErrorDetails;

  constructor(code: string, message: string, httpStatus = 500, details: ErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }

  toProblem(instance?: string): {
    type: string;
    title: string;
    status: number;
    code: string;
    detail: string;
    instance?: string;
    details: ErrorDetails;
  } {
    return {
      type: `https://serviceloop.dev/errors/${this.code.toLowerCase().replace(/_/g, '-')}`,
      title: this.name,
      status: this.httpStatus,
      code: this.code,
      detail: this.message,
      ...(instance === undefined ? {} : { instance }),
      details: this.details,
    };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details: ErrorDetails = {}) {
    super('VALIDATION_FAILED', message, 400, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', details: ErrorDetails = {}) {
    super('UNAUTHORIZED', message, 401, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Insufficient permissions', details: ErrorDetails = {}) {
    super('FORBIDDEN', message, 403, details);
  }
}

/**
 * Cross-tenant reads must not leak existence, so "not found" is what a caller
 * sees for another shop's rows too (master §7 / phase 1.8).
 */
export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super('NOT_FOUND', `${entity} not found`, 404, id === undefined ? { entity } : { entity, id });
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details: ErrorDetails = {}) {
    super('CONFLICT', message, 409, details);
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string, details: ErrorDetails = {}) {
    super('CONFIGURATION_ERROR', message, 500, details);
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}
