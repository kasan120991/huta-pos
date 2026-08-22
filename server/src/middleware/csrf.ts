import type { NextFunction, Request, Response } from 'express'

import { ForbiddenError } from '../errors/index.js'
import { COOKIE, setCsrfCookie } from '../lib/cookies.js'
import { randomToken, timingSafeEqual } from '../lib/crypto.js'

/**
 * Double-submit CSRF protection.
 *
 * Hand-rolled because `csurf` is deprecated and unmaintained, and this is ~30 lines that
 * ought to be readable by whoever has to trust it.
 *
 * The mechanism: a random token is stored in a NON-httpOnly cookie and must be echoed in
 * the `X-CSRF-Token` header. A cross-site attacker can make the browser SEND our cookies,
 * but the same-origin policy stops them READING one, so they cannot populate the header.
 *
 * Only session cookies need this. Requests authenticated purely by a device token in an
 * explicit header are not vulnerable, because a browser will not attach that header on
 * a forged cross-site request.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const HEADER = 'x-csrf-token'

/** Issue a CSRF token. Called on login and on refresh. */
export function issueCsrfToken(res: Response): string {
  const token = randomToken(24)
  setCsrfCookie(res, token)
  return token
}

export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next()
    return
  }

  const cookies = req.cookies as Record<string, string | undefined>

  // No session cookie means nothing for a forged request to ride on — a device-token or
  // unauthenticated request has no ambient credential to abuse.
  if (!cookies[COOKIE.ACCESS] && !cookies[COOKIE.REFRESH]) {
    next()
    return
  }

  const cookieToken = cookies[COOKIE.CSRF]
  const headerValue = req.headers[HEADER]
  const headerToken = typeof headerValue === 'string' ? headerValue : undefined

  if (!cookieToken || !headerToken || !timingSafeEqual(cookieToken, headerToken)) {
    throw new ForbiddenError('Missing or invalid CSRF token.')
  }

  next()
}
