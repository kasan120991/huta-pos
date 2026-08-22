import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { ZodType } from 'zod'

import { randomToken } from '../lib/crypto.js'

/**
 * Zod validation and request identity.
 *
 * House rule: every body, query and param is parsed with a schema before it reaches a
 * service. Unvalidated input never gets past this layer.
 */

/**
 * Validate and REPLACE `req.body` with the parsed value, so handlers consume the typed,
 * coerced output rather than the raw input. Zod failures propagate to the error handler,
 * which renders field paths without echoing submitted values.
 */
export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    req.body = schema.parse(req.body)
    next()
  }
}

/**
 * Symbol the parsed query is stashed under.
 *
 * Express 5 makes `req.query` a getter with NO setter, so unlike `req.body` it cannot be
 * replaced in place. Parsing and discarding the result — which is what this middleware
 * used to do — silently threw away every `z.coerce.number()`, `.default()` and
 * `.transform()`, leaving handlers with raw strings while appearing to validate. Worse,
 * `validateBody` DOES reassign, so the asymmetry was invisible at the call site.
 */
const PARSED_QUERY = Symbol('parsedQuery')

export function validateQuery<T>(schema: ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    const parsed = schema.parse(req.query)
    Reflect.set(req, PARSED_QUERY, parsed)
    next()
  }
}

/**
 * Read what `validateQuery` parsed — coerced, defaulted and transformed.
 *
 * Throws rather than returning undefined: reaching this without the middleware in front
 * of it is a wiring mistake, and silently handing back raw strings is exactly the bug
 * this replaced.
 */
export function validatedQuery<T>(req: Request): T {
  const parsed = Reflect.get(req, PARSED_QUERY) as T | undefined
  if (parsed === undefined) {
    throw new Error('validatedQuery() called without validateQuery() on the route.')
  }
  return parsed
}

export function validateParams<T>(schema: ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    schema.parse(req.params)
    next()
  }
}

/** Correlates a client-visible error with a server log line, without logging any content. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id']
  const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomToken(8)
  res.setHeader('x-request-id', id)
  next()
}
