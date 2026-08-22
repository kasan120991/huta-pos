import type { NextFunction, Request, Response } from 'express'

import { principalFromUser } from '../auth/auth.service.js'
import type { Principal } from '../auth/principal.js'
import { principalFromDeviceToken, touchTerminal } from '../auth/terminal.service.js'
import { UnauthorizedError } from '../errors/index.js'
import { COOKIE } from '../lib/cookies.js'
import { verifyAccessToken } from '../lib/tokens.js'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Explicitly `| undefined` rather than optional: under
       * `exactOptionalPropertyTypes` an optional property cannot be assigned `undefined`,
       * and middleware needs to be able to leave it unset.
       */
      principal?: Principal | undefined
    }
  }
}

/**
 * Resolve a Principal from cookies. Never rejects — it only populates.
 *
 * Rejection is `requireAuth`'s job, so that public routes and optional-auth routes share
 * one resolution path and cannot drift apart.
 */
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const cookies = req.cookies as Record<string, string | undefined>

  // The device token comes first: it establishes WHICH STORE, independent of who is
  // attached, and a register with nobody signed in is still a valid identity.
  const deviceToken = cookies[COOKIE.DEVICE] ?? headerToken(req, 'x-device-token')
  const terminal = deviceToken ? await principalFromDeviceToken(deviceToken) : null

  const accessToken = cookies[COOKIE.ACCESS]
  const claims = accessToken ? await verifyAccessToken(accessToken) : null

  if (claims) {
    const principal = await principalFromUser(
      claims.sub,
      terminal?.terminalId ?? claims.terminalId,
      terminal?.storeId ?? null,
    )
    if (principal) {
      req.principal = principal
      if (terminal) touchTerminal(terminal.terminalId)
      next()
      return
    }
  }

  if (terminal) {
    req.principal = terminal
    touchTerminal(terminal.terminalId)
  }

  next()
}

function headerToken(req: Request, header: string): string | undefined {
  const value = req.headers[header]
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

/**
 * Read the principal, or fail.
 *
 * Handlers call this instead of testing `req.principal` for null, so a forgotten check
 * cannot silently produce an unauthenticated code path.
 */
export function requirePrincipal(req: Request): Principal {
  if (!req.principal) throw new UnauthorizedError()
  return req.principal
}

/** Gate a route on any authenticated principal. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  requirePrincipal(req)
  next()
}

/** Gate a route on a person being attached — a bare terminal is not enough. */
export function requirePerson(req: Request, _res: Response, next: NextFunction): void {
  const principal = requirePrincipal(req)
  if (principal.kind === 'terminal') {
    throw new UnauthorizedError('Sign in with your PIN to continue.')
  }
  next()
}

/** Gate a route on an admin. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  const principal = requirePrincipal(req)
  if (principal.kind !== 'admin') {
    throw new UnauthorizedError('Administrator access is required.')
  }
  next()
}
