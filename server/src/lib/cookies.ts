import type { CookieOptions, Response } from 'express'

import { isProduction } from '../config/env.js'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  DEVICE_SESSION_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} from './tokens.js'

/**
 * Cookie names and attributes.
 *
 * Session material is httpOnly so that an XSS bug cannot read it. The CSRF token is the
 * one cookie JavaScript MUST be able to read — that is the whole double-submit
 * mechanism, and it is not a secret on its own.
 */

export const COOKIE = {
  /** Admin/staff access token (JWT, short-lived). */
  ACCESS: 'huta_at',
  /** Refresh token (opaque, revocable). Scoped to the auth path so it is not sent everywhere. */
  REFRESH: 'huta_rt',
  /** Device token identifying a terminal to its store. */
  DEVICE: 'huta_dt',
  /** Readable by JS, echoed back in a header. Not httpOnly by design. */
  CSRF: 'huta_csrf',
} as const

const REFRESH_PATH = '/api/auth'

function base(maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    // Lax rather than Strict: Strict would drop the cookie on a top-level navigation
    // back into the app, logging admins out whenever they follow a link in.
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: maxAgeSeconds * 1000,
  }
}

export function setAccessCookie(res: Response, token: string): void {
  res.cookie(COOKIE.ACCESS, token, base(ACCESS_TOKEN_TTL_SECONDS))
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(COOKIE.REFRESH, token, { ...base(REFRESH_TOKEN_TTL_SECONDS), path: REFRESH_PATH })
}

export function setDeviceCookie(res: Response, token: string): void {
  // Long-lived: a register is a fixed machine, and a device session expiring mid-shift
  // would stop trade. Revoked by deactivating the terminal, not by expiry.
  res.cookie(COOKIE.DEVICE, token, base(365 * 24 * 60 * 60))
}

/** Short-lived session identifying WHICH PERSON is attached at a terminal. */
export function setStaffSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE.ACCESS, token, base(DEVICE_SESSION_TTL_SECONDS))
}

export function setCsrfCookie(res: Response, token: string): void {
  res.cookie(COOKIE.CSRF, token, {
    httpOnly: false, // intentional — the client must read and echo it
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: REFRESH_TOKEN_TTL_SECONDS * 1000,
  })
}

export function clearSessionCookies(res: Response): void {
  res.clearCookie(COOKIE.ACCESS, { path: '/' })
  res.clearCookie(COOKIE.REFRESH, { path: REFRESH_PATH })
  res.clearCookie(COOKIE.CSRF, { path: '/' })
}
