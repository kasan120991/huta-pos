import type { NextFunction, Request, Response } from 'express'
import { ZodError } from 'zod'

import { isProduction } from '../config/env.js'
import { AppError, isAppError } from '../errors/index.js'

/**
 * The single error handler.
 *
 * Everything a client sees about a failure is decided here. Services throw typed domain
 * errors; nothing else is trusted to be safe to show.
 */

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found.' } })
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const requestId = res.getHeader('x-request-id')

  if (isAppError(error)) {
    logSafely(req, requestId, error.code, error.status)
    res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    })
    return
  }

  if (error instanceof ZodError) {
    logSafely(req, requestId, 'VALIDATION_FAILED', 400)
    res.status(400).json({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'The request was not valid.',
        // Field paths and messages only. Never the submitted values — a validation error
        // on a login form would otherwise echo the password back in the response.
        details: {
          issues: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      },
    })
    return
  }

  // Anything else is a bug or a Prisma error. Neither is safe to show: Prisma messages
  // carry table names, column names and sometimes row values.
  console.error(`[${String(requestId)}] Unhandled error on ${req.method} ${req.path}`, error)

  res.status(500).json({
    error: {
      code: 'INTERNAL',
      message: 'Something went wrong.',
      ...(isProduction ? {} : { details: { hint: 'See server logs for the stack trace.' } }),
    },
  })
}

/**
 * Log the shape of a failure, never its content.
 *
 * No request body, no headers, no cookies — those carry PINs, passwords and tokens, and
 * The house rules forbid logging any of them.
 */
function logSafely(
  req: Request,
  requestId: string | number | string[] | undefined,
  code: string,
  status: number,
): void {
  if (status >= 500) {
    console.error(`[${String(requestId)}] ${status} ${code} ${req.method} ${req.path}`)
  }
}

export { AppError }
