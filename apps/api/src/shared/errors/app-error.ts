/**
 * Domain error type. Every error thrown inside the application extends this.
 * The global error handler converts it to a stable JSON envelope. Anything
 * that isn't an AppError is treated as an internal 500 (no stack leakage).
 */
export type ErrorDetails = Record<string, unknown> | undefined;

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly details: ErrorDetails;
  public override readonly cause?: unknown;

  constructor(params: {
    statusCode: number;
    errorCode: string;
    message: string;
    details?: ErrorDetails;
    cause?: unknown;
  }) {
    super(params.message);
    this.name = 'AppError';
    this.statusCode = params.statusCode;
    this.errorCode = params.errorCode;
    this.details = params.details;
    this.cause = params.cause;
    Error.captureStackTrace?.(this, AppError);
  }
}

// ─── Common factories ──────────────────────────────────────────────────────

export const errors = {
  badRequest: (message: string, details?: ErrorDetails) =>
    new AppError({ statusCode: 400, errorCode: 'BAD_REQUEST', message, details }),

  unauthorized: (message = 'Authentication required') =>
    new AppError({ statusCode: 401, errorCode: 'UNAUTHORIZED', message }),

  forbidden: (message = 'Insufficient permissions') =>
    new AppError({ statusCode: 403, errorCode: 'FORBIDDEN', message }),

  notFound: (resource: string, id?: string) =>
    new AppError({
      statusCode: 404,
      errorCode: 'NOT_FOUND',
      message: id ? `${resource} ${id} not found` : `${resource} not found`,
      details: id ? { resource, id } : { resource },
    }),

  conflict: (message: string, details?: ErrorDetails) =>
    new AppError({ statusCode: 409, errorCode: 'CONFLICT', message, details }),

  unprocessable: (message: string, details?: ErrorDetails) =>
    new AppError({ statusCode: 422, errorCode: 'UNPROCESSABLE_ENTITY', message, details }),

  rateLimited: (retryAfterSeconds: number) =>
    new AppError({
      statusCode: 429,
      errorCode: 'RATE_LIMITED',
      message: 'Too many requests',
      details: { retryAfterSeconds },
    }),

  invalidSignature: () =>
    new AppError({ statusCode: 401, errorCode: 'INVALID_SIGNATURE', message: 'Webhook signature invalid' }),

  internal: (message = 'Internal server error', cause?: unknown) =>
    new AppError({ statusCode: 500, errorCode: 'INTERNAL', message, cause }),

  serviceUnavailable: (message = 'Dependency unavailable') =>
    new AppError({ statusCode: 503, errorCode: 'SERVICE_UNAVAILABLE', message }),
} as const;

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
