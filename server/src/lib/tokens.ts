import { SignJWT, jwtVerify } from 'jose'

import { env } from '../config/env.js'

/**
 * Access-token signing.
 *
 * `jose` rather than `jsonwebtoken`: it is ESM-native, which matters under
 * `verbatimModuleSyntax` and `module: NodeNext`, and it will not silently accept
 * `alg: none`.
 *
 * Only the SHORT-LIVED access token is a JWT. Refresh tokens and device tokens are
 * opaque random strings stored hashed in the database, because those must be revocable
 * — and a self-contained token cannot be revoked before it expires.
 */

const secret = new TextEncoder().encode(env.JWT_SECRET)
const ISSUER = 'huta-pos'
const ALG = 'HS256'

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60
export const DEVICE_SESSION_TTL_SECONDS = 12 * 60 * 60
export const STEP_UP_TTL_SECONDS = 2 * 60

export interface AccessTokenClaims {
  /** User id, or terminal id for a device-only session. */
  readonly sub: string
  readonly kind: 'admin' | 'staff' | 'terminal'
  readonly storeId: string | null
  readonly terminalId: string | null
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  ttlSeconds = ACCESS_TOKEN_TTL_SECONDS,
): Promise<string> {
  return new SignJWT({
    kind: claims.kind,
    storeId: claims.storeId,
    terminalId: claims.terminalId,
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secret)
}

/** Returns null on any failure — expired, tampered, wrong issuer. Never throws to a caller. */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      algorithms: [ALG],
    })

    const sub = payload.sub
    const kind = payload['kind']
    if (typeof sub !== 'string') return null
    if (kind !== 'admin' && kind !== 'staff' && kind !== 'terminal') return null

    const storeId = payload['storeId']
    const terminalId = payload['terminalId']

    return {
      sub,
      kind,
      storeId: typeof storeId === 'string' ? storeId : null,
      terminalId: typeof terminalId === 'string' ? terminalId : null,
    }
  } catch {
    return null
  }
}
