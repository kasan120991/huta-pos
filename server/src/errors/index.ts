/**
 * Domain errors.
 *
 * Services throw these; the single error middleware maps them to status codes. Route
 * handlers never build an error response by hand, and a Prisma error or a stack trace
 * never reaches a client.
 */

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION_FAILED'
  | 'RATE_LIMITED'
  | 'ACCOUNT_LOCKED'
  | 'STEP_UP_REQUIRED'
  | 'INSUFFICIENT_STOCK'
  | 'AGE_VERIFICATION_REQUIRED'
  | 'PAYMENT_FAILED'
  | 'INTERNAL'

export class AppError extends Error {
  readonly status: number
  readonly code: ErrorCode
  /** Safe to send to the client. Never contains identifiers of other users or SQL. */
  readonly details: Record<string, unknown> | undefined

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = new.target.name
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * 401. Deliberately vague by default — never reveal whether an email exists, whether a
 * PIN matched a real person, or whether a token was expired versus forged.
 */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required.') {
    super(401, 'UNAUTHORIZED', message)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to do that.') {
    super(403, 'FORBIDDEN', message)
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found.') {
    super(404, 'NOT_FOUND', message)
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(409, 'CONFLICT', message)
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, 'VALIDATION_FAILED', message, details)
  }
}

/** Account-level lockout, distinct from endpoint rate limiting. */
export class AccountLockedError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again shortly.', {
      retryAfterSeconds,
    })
  }
}

/**
 * 403 carrying the capability that needs admin approval, so the terminal knows which
 * step-up prompt to show.
 */
export class StepUpRequiredError extends AppError {
  constructor(action: string) {
    super(403, 'STEP_UP_REQUIRED', 'An admin must authorise this action.', { action })
  }
}

/**
 * A stock change would drive on-hand below zero.
 *
 * 409 rather than 400: the request was well-formed, the world just moved. Carries the
 * available quantity so the caller can say "only 3 left" rather than "that failed".
 */
export class InsufficientStockError extends AppError {
  constructor(availableBase: number, requestedBase: number) {
    super(409, 'INSUFFICIENT_STOCK', 'There is not enough stock for that.', {
      availableBase,
      requestedBase,
    })
  }
}

/**
 * The cart contains a cannabinoid-bearing product and the cashier has not attested the
 * customer is 21+. A dedicated code so the register can focus the checkbox rather than
 * showing a generic conflict.
 */
export class AgeVerificationRequiredError extends AppError {
  constructor() {
    super(409, 'AGE_VERIFICATION_REQUIRED', 'Age verification (21+) is required for this sale.')
  }
}

/**
 * A card interaction did not do what the sale needed. 409 like the other "the world
 * moved" errors, carrying a machine-readable reason the register branches on:
 * `amount_mismatch` re-quotes and stages a fresh intent, `refund_failed` tells staff the
 * record exists but the money did not move.
 */
export class PaymentFailedError extends AppError {
  constructor(
    reason: 'not_succeeded' | 'amount_mismatch' | 'intent_already_used' | 'refund_failed',
    message: string,
  ) {
    super(409, 'PAYMENT_FAILED', message, { reason })
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
