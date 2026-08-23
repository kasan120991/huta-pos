import { Role } from '@huta/shared'

import { prisma } from '../db/client.js'
import { AccountLockedError, PinChangeRequiredError, UnauthorizedError } from '../errors/index.js'
import { pinLookup, randomToken, sha256 } from '../lib/crypto.js'
import { hashSecret, verifySecret } from '../lib/password.js'
import { REFRESH_TOKEN_TTL_SECONDS } from '../lib/tokens.js'
import type { AdminPrincipal, Principal, StaffPrincipal } from './principal.js'

/**
 * Authentication logic. No HTTP concerns here — routes translate to and from the wire.
 */

/** 5 attempts then a 15-minute lockout, locking the PERSON rather than the terminal. */
export const MAX_PIN_ATTEMPTS = 5
export const LOCKOUT_MINUTES = 15

/**
 * Verify admin email + password.
 *
 * Always runs a hash comparison, even when no user matched, so the response time does
 * not reveal whether an email exists. Returns one generic error either way.
 */
export async function authenticateAdmin(
  email: string,
  password: string,
): Promise<AdminPrincipal> {
  const user = await prisma.user.findUnique({ where: { email } })

  // A fixed dummy hash so the failure path costs the same as the success path. Without
  // it, "no such user" returns in ~1ms and "wrong password" in ~100ms, which is a
  // perfectly usable account-enumeration oracle.
  const hash = user?.passwordHash ?? DUMMY_HASH
  const ok = await verifySecret(hash, password)

  if (!user || !ok || !user.active || user.role !== Role.ADMIN) {
    throw new UnauthorizedError('Invalid email or password.')
  }

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

  return { kind: 'admin', userId: user.id, role: Role.ADMIN, storeId: null, terminalId: null }
}

/**
 * A real argon2id hash of a value nobody knows, generated once at module load.
 * Used only to burn equivalent time on the "user not found" path.
 */
const DUMMY_HASH = await hashSecret(randomToken())

export interface RosterEntry {
  readonly userId: string
  readonly firstName: string
  readonly lastInitial: string
}

/**
 * Who can attach at this terminal.
 *
 * Anyone may work at any store since 2026-08-22, so the honest answer is "every active
 * person" — but this endpoint is reachable by an UNATTENDED register, and printing every
 * employee's name on a screen in every shop is a wider disclosure than the one it replaced.
 * So it stays LOCAL by default (this store's staff, plus admins, who could always attach
 * anywhere) and `scope: 'all'` is what the sign-in screen's "Someone else" asks for.
 *
 * Deliberately minimal either way — first name and last initial only. No emails, no lock
 * state, nothing else about the people who work here.
 */
export async function roster(
  storeId: string,
  scope: 'store' | 'all' = 'store',
): Promise<RosterEntry[]> {
  const users = await prisma.user.findMany({
    where: {
      active: true,
      pinHash: { not: null },
      ...(scope === 'all' ? {} : { OR: [{ storeId }, { role: Role.ADMIN }] }),
    },
    select: { id: true, firstName: true, lastName: true },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  })

  return users.map((u) => ({
    userId: u.id,
    firstName: u.firstName,
    lastInitial: u.lastName.charAt(0).toUpperCase(),
  }))
}

export interface PinAttachResult {
  readonly principal: AdminPrincipal | StaffPrincipal
  readonly firstName: string
  readonly lastName: string
}

/**
 * Attach a person to a terminal: they pick themselves off the roster, then enter a PIN.
 *
 * The identity has to arrive SEPARATELY from the PIN, and that is not a UX preference —
 * it is what makes per-user lockout possible at all. If the register accepted a bare PIN,
 * the lookup would be `HMAC(pin) -> user`: a wrong PIN matches no row, so there is no
 * account whose failure counter could be incremented, and a right PIN matches exactly one
 * row after which the hash check always passes. `failedPinAttempts` and `lockedUntil`
 * would be dead columns and a 4-digit PIN would be defended only by a rate limiter.
 *
 * With the user id known up front, a wrong PIN is attributable and the lockout is real.
 */
export async function attachByPin(
  userId: string,
  pin: string,
  terminalId: string,
  terminalStoreId: string,
): Promise<PinAttachResult> {
  const user = await prisma.user.findUnique({ where: { id: userId } })

  if (!user || !user.pinHash || !user.active) {
    throw new UnauthorizedError('That PIN was not recognised.')
  }

  // Anyone may attach ANYWHERE (Kasan, 2026-08-22). People cover both shops, so the terminal
  // establishes WHICH STORE and the PIN establishes WHO — which is what the three-layer model
  // always said; a home-store guard here was the one thing contradicting it.
  //
  // `User.storeId` survives as a home store: it records who is based where and orders the
  // roster, and it no longer governs anything. Nothing is lost by dropping the check, because
  // PINs are globally unique already (see Auth) — a cashier from another store could never
  // have collided with a local one.

  // Burn an attempt BEFORE verifying. Doing it after would let five simultaneous wrong
  // PINs all read the same counter and all write the same value, consuming five attempts
  // as one — which is precisely what a parallel brute-force script does.
  const reservation = await reservePinAttempt(user.id)
  if (!reservation) {
    throw new AccountLockedError(await lockRemainingSeconds(user.id))
  }

  const ok = await verifySecret(user.pinHash, pin)
  if (!ok) throw new UnauthorizedError('That PIN was not recognised.')

  // The PIN was right, so clear the lockout counters either way — a person who has just
  // proved who they are should not stay locked because of earlier fumbles.
  await prisma.user.update({
    where: { id: user.id },
    data: { failedPinAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  })

  // AFTER verification, deliberately: refusing earlier would tell an unauthenticated
  // caller which accounts are mid-reset without them having proved anything. No session is
  // created — see PinChangeRequiredError for why attaching first would be a hole.
  if (user.mustChangePin) throw new PinChangeRequiredError()

  const principal: AdminPrincipal | StaffPrincipal =
    user.role === Role.ADMIN
      ? { kind: 'admin', userId: user.id, role: Role.ADMIN, storeId: null, terminalId }
      : {
          kind: 'staff',
          userId: user.id,
          role: Role.STAFF,
          storeId: terminalStoreId,
          terminalId,
        }

  return { principal, firstName: user.firstName, lastName: user.lastName }
}

/**
 * Reserve one PIN attempt, atomically.
 *
 * The `WHERE` clause is the lock check and the `SET` is the reservation, both evaluated
 * under the row lock the UPDATE itself takes. Postgres re-evaluates the `WHERE` after
 * acquiring a lock held by a concurrent update, so simultaneous attempts each see the
 * other's increment and none is lost.
 *
 * Returns null when the account is locked right now — no row matches, so no attempt is
 * consumed and the caller must not proceed to verification.
 *
 * A previously-expired lock resets the count to 1 rather than continuing from 5, so a
 * staff member who was locked out yesterday gets a full five attempts today.
 */
async function reservePinAttempt(userId: string): Promise<{ locked: boolean } | null> {
  const rows = await prisma.$queryRaw<Array<{ failedPinAttempts: number; lockedUntil: Date | null }>>`
    UPDATE "User" u
       SET "failedPinAttempts" =
             CASE WHEN u."lockedUntil" IS NOT NULL THEN 1
                  ELSE u."failedPinAttempts" + 1 END,
           "lockedUntil" =
             CASE WHEN (CASE WHEN u."lockedUntil" IS NOT NULL THEN 1
                             ELSE u."failedPinAttempts" + 1 END) >= ${MAX_PIN_ATTEMPTS}
                  THEN now() + make_interval(mins => ${LOCKOUT_MINUTES})
                  ELSE NULL END
     WHERE u."id" = ${userId}
       AND u."active"
       AND (u."lockedUntil" IS NULL OR u."lockedUntil" <= now())
    RETURNING u."failedPinAttempts", u."lockedUntil"
  `

  const row = rows[0]
  if (!row) return null
  return { locked: row.lockedUntil !== null }
}

async function lockRemainingSeconds(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lockedUntil: true },
  })
  if (!user?.lockedUntil) return LOCKOUT_MINUTES * 60
  return Math.max(1, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000))
}

// --- refresh tokens --------------------------------------------------------------------

export interface IssuedRefreshToken {
  readonly token: string
  readonly expiresAt: Date
}

/**
 * Refresh tokens are opaque random strings stored HASHED. Opaque rather than a JWT
 * because they must be revocable before expiry; hashed because a database dump should
 * not hand over live sessions.
 */
export async function issueRefreshToken(userId: string): Promise<IssuedRefreshToken> {
  const token = randomToken()
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000)
  await prisma.refreshToken.create({
    data: { userId, tokenHash: sha256(token), expiresAt },
  })
  return { token, expiresAt }
}

/**
 * Rotate a refresh token.
 *
 * Presenting an ALREADY-REVOKED token means either a replay or a stolen token being used
 * alongside the legitimate one. We cannot tell which, so we revoke every token for that
 * user and force a fresh login. Losing a session is a far better outcome than leaving a
 * thief with one.
 */
export async function rotateRefreshToken(token: string): Promise<{
  userId: string
  next: IssuedRefreshToken
}> {
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(token) },
  })

  if (!existing) throw new UnauthorizedError('Session expired. Please sign in again.')

  if (existing.revokedAt !== null) {
    await prisma.refreshToken.updateMany({
      where: { userId: existing.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    })
    throw new UnauthorizedError('Session expired. Please sign in again.')
  }

  if (existing.expiresAt <= new Date()) {
    throw new UnauthorizedError('Session expired. Please sign in again.')
  }

  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  })

  const next = await issueRefreshToken(existing.userId)
  return { userId: existing.userId, next }
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: sha256(token), revokedAt: null },
    data: { revokedAt: new Date() },
  })
}

/** Rebuild a principal from a verified access token, re-checking the user still exists. */
export async function principalFromUser(
  userId: string,
  terminalId: string | null,
  terminalStoreId: string | null,
): Promise<Principal | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user || !user.active) return null

  if (user.role === Role.ADMIN) {
    return { kind: 'admin', userId: user.id, role: Role.ADMIN, storeId: null, terminalId }
  }
  /**
   * ⚠️ The store comes from the TERMINAL, never from `user.storeId`.
   *
   * This function and `attachByPin` are two independent derivations of the same fact, and
   * until 2026-08-22 they disagreed: attach used the terminal, this used the home store. They
   * could not be caught disagreeing only because the attach guard forced them equal. Removing
   * that guard without fixing this would mint a session for the store someone is standing in
   * and then, on the very next request, either refuse it or silently move them home.
   *
   * A staff session cannot exist away from a terminal — staff hold no password — so no
   * terminal means we cannot know where they are, and refusing sends a register to
   * `/register/pair`, which is the documented remedy for a device that has lost its token.
   */
  if (!terminalId || terminalStoreId === null) return null

  return {
    kind: 'staff',
    userId: user.id,
    role: Role.STAFF,
    storeId: terminalStoreId,
    terminalId,
  }
}
