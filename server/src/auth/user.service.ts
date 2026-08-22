import type { Prisma } from '../generated/prisma/client.js'
import { prisma } from '../db/client.js'
import { ConflictError, NotFoundError, ValidationError } from '../errors/index.js'
import { pinLookup, tempPin } from '../lib/crypto.js'
import { hashSecret } from '../lib/password.js'

/**
 * Staff administration — the `/admin/staff` back-office screen.
 *
 * Until this file existed there was NO way to create a user outside `scripts/seed.ts`, no way
 * to reset a PIN, and no way to clear a lockout other than a correct PIN or waiting fifteen
 * minutes. `user.manage` had been declared in `permissions.ts` since the auth phase with zero
 * call sites; the routes over this service are its first.
 *
 * Shaped after `terminal.service.ts` deliberately: a narrow select const, `NotFoundError` on a
 * miss, and an `auditLog` row carrying before/after on every write.
 *
 * FOUR DATABASE CHECKS govern a valid User row, and violating one gives a 500 rather than a
 * useful message, so every path here satisfies them by construction:
 *
 *   User_role_store_scope_check    STAFF ⟹ storeId NOT NULL;  ADMIN ⟹ storeId NULL
 *   User_pin_pairing_check         (pinHash IS NULL) = (pinLookup IS NULL)
 *   User_admin_credentials_check   ADMIN ⟹ email AND passwordHash NOT NULL
 *   User_staff_credentials_check   STAFF ⟹ pinHash NOT NULL AND passwordHash NULL
 */

/**
 * EXPLICIT, and it must stay that way. A bare `findUnique` on User returns `passwordHash`,
 * `pinHash` and `pinLookup`; `GET /auth/me` is the only other place in the codebase that
 * models a safe select, and this follows it. `pinHash` is read here ONLY to derive the
 * boolean `hasPin` — see `toRow`, which never lets the value itself escape.
 */
const userSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  role: true,
  active: true,
  mustChangePin: true,
  lockedUntil: true,
  failedPinAttempts: true,
  lastLoginAt: true,
  createdAt: true,
  pinHash: true,
  store: { select: { id: true, name: true } },
} as const

type Selected = Prisma.UserGetPayload<{ select: typeof userSelect }>

/**
 * Drops `pinHash` to a boolean on the way out. Nothing else in this file returns a row.
 *
 * Builds the object FIELD BY FIELD rather than spreading a rest object. A spread is
 * correct today and becomes a leak the moment someone adds a column to `userSelect`
 * without thinking about this function — which is exactly how a secret escapes.
 */
function toRow(user: Selected) {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    role: user.role,
    active: user.active,
    store: user.store,
    mustChangePin: user.mustChangePin,
    hasPin: user.pinHash !== null,
    lockedUntil: user.lockedUntil,
    failedPinAttempts: user.failedPinAttempts,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  }
}

export async function listUsers(includeInactive = false) {
  const users = await prisma.user.findMany({
    ...(includeInactive ? {} : { where: { active: true } }),
    select: userSelect,
    orderBy: [{ active: 'desc' }, { firstName: 'asc' }, { lastName: 'asc' }],
  })
  return users.map(toRow)
}

export async function getUser(id: string) {
  const user = await prisma.user.findUnique({ where: { id }, select: userSelect })
  if (!user) throw new NotFoundError('That person is not on the staff list.')
  return toRow(user)
}

/**
 * Assign a PIN, retrying past the global uniqueness collision.
 *
 * `pinLookup` is unique across EVERY user — deliberately, because the step-up gesture looks a
 * person up from a bare PIN, so one PIN must mean one person (see the schema comment on
 * `@@unique([pinLookup])`). At six digits a clash is unlikely; at the four digits a person may
 * later choose for themselves it is a one-in-ten-thousand event per user, which on a real
 * roster happens. Nothing in the codebase handled P2002 on this index before now.
 */
async function assignGeneratedPin(userId: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pin = tempPin()
    try {
      await prisma.user.update({
        where: { id: userId },
        data: {
          pinHash: await hashSecret(pin),
          pinLookup: pinLookup(pin),
          mustChangePin: true,
          failedPinAttempts: 0,
          lockedUntil: null,
        },
      })
      return pin
    }
    catch (error) {
      if (isPinCollision(error)) continue
      throw error
    }
  }
  throw new ConflictError('Could not allocate an unused PIN. Try again.')
}

/**
 * Duck-typed rather than `instanceof PrismaClientKnownRequestError`, matching how
 * `sales.service.ts` and `payments/webhook.ts` already test for P2002 — the generated client
 * is re-exported per build and an instanceof across that boundary is fragile.
 *
 * ⚠️ **Prisma 7 with the pg driver adapter does not populate `meta.target`.** It carries
 * `{ modelName, driverAdapterError }` and names the column only in the message
 * ("Unique constraint failed on the fields: (`pinLookup`)"). Checking `meta.target` alone —
 * the shape every Prisma 5/6 example uses — silently never matches, and the collision
 * surfaces as a 500. Both are checked so this keeps working if a future version restores it.
 */
function isPinCollision(error: unknown): boolean {
  const e = error as { code?: string, meta?: { target?: unknown }, message?: string }
  if (e.code !== 'P2002') return false
  return (
    String(e.meta?.target ?? '').includes('pinLookup')
    || String(e.message ?? '').includes('pinLookup')
  )
}

export interface StaffCreateInput {
  readonly firstName: string
  readonly lastName: string
  readonly email?: string | undefined
  readonly storeId: string
}

/**
 * Create a STAFF member and hand back a one-time PIN.
 *
 * Two statements rather than one: the row is created with a PIN already attached (the staff
 * CHECK requires `pinHash NOT NULL`, so there is no valid PIN-less intermediate state), and
 * `assignGeneratedPin` may need to retry, which it cannot do on a row that does not exist yet.
 * So the create seeds a PIN inline and the retry loop only runs if that first one collides.
 */
export async function createStaff(input: StaffCreateInput, actorId: string) {
  const store = await prisma.store.findUnique({
    where: { id: input.storeId },
    select: { active: true },
  })
  if (!store || !store.active) throw new NotFoundError('That store does not exist.')

  if (input.email) {
    const clash = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    })
    if (clash) throw new ConflictError('Someone already uses that email address.')
  }

  let created: Selected | null = null
  let pin = ''
  for (let attempt = 0; attempt < 5 && created === null; attempt += 1) {
    pin = tempPin()
    try {
      created = await prisma.user.create({
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email ?? null,
          role: 'STAFF',
          storeId: input.storeId,
          // The staff CHECK forbids a password and requires a PIN; the pairing CHECK
          // requires hash and lookup together.
          passwordHash: null,
          pinHash: await hashSecret(pin),
          pinLookup: pinLookup(pin),
          mustChangePin: true,
        },
        select: userSelect,
      })
    }
    catch (error) {
      if (isPinCollision(error)) continue
      throw error
    }
  }
  if (created === null) throw new ConflictError('Could not allocate an unused PIN. Try again.')

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action: 'auth.user.create',
      entityType: 'User',
      entityId: created.id,
      before: {},
      // Never the PIN, not even hashed.
      after: {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email ?? null,
        role: 'STAFF',
        storeId: input.storeId,
      },
    },
  })

  return { user: toRow(created), pin }
}

export interface UserPatch {
  readonly firstName?: string | undefined
  readonly lastName?: string | undefined
  readonly email?: string | null | undefined
  readonly storeId?: string | undefined
  readonly active?: boolean | undefined
}

/**
 * Edit a person. No role change — see the comment on `staffPatchSchema` in shared.
 *
 * DEACTIVATION ALSO REVOKES REFRESH TOKENS. `active: false` already stops new sessions and
 * kills existing ACCESS tokens, because `principalFromUser` re-reads the row on every request
 * — but a refresh token is good for seven days and nothing was checking `active` when one was
 * presented. Without this, a deactivated admin could mint a fresh access token for a week.
 */
export async function updateUser(id: string, patch: UserPatch, actorId: string) {
  const existing = await prisma.user.findUnique({
    where: { id },
    select: { id: true, firstName: true, lastName: true, email: true, role: true, active: true, storeId: true },
  })
  if (!existing) throw new NotFoundError('That person is not on the staff list.')

  // ⚠️ Do not let the back office be locked out of itself. Only an admin can reach this
  // endpoint, and an admin who deactivates themselves — or the last remaining admin — has
  // no way back in: staff hold no password, and there is no user-creation path that does
  // not require an existing admin. Recovering means editing the database by hand.
  if (patch.active === false) {
    if (id === actorId) {
      throw new ConflictError('You cannot deactivate yourself.')
    }
    if (existing.role === 'ADMIN') {
      const others = await prisma.user.count({
        where: { role: 'ADMIN', active: true, id: { not: id } },
      })
      if (others === 0) throw new ConflictError('You cannot deactivate the only administrator.')
    }
  }

  // An ADMIN must have storeId NULL and a STAFF must have one — the role/store CHECK. Rather
  // than let the database reject it, refuse with a sentence that says why.
  if (patch.storeId !== undefined && existing.role === 'ADMIN') {
    throw new ValidationError('An admin has no home store — they can act at any store.')
  }
  if (patch.email === null && existing.role === 'ADMIN') {
    throw new ValidationError('An admin must keep an email address to sign in with.')
  }

  if (patch.storeId !== undefined) {
    const store = await prisma.store.findUnique({
      where: { id: patch.storeId },
      select: { active: true },
    })
    if (!store || !store.active) throw new NotFoundError('That store does not exist.')
  }

  if (patch.email) {
    const clash = await prisma.user.findFirst({
      where: { email: patch.email, id: { not: id } },
      select: { id: true },
    })
    if (clash) throw new ConflictError('Someone already uses that email address.')
  }

  const data: Record<string, unknown> = {}
  if (patch.firstName !== undefined) data['firstName'] = patch.firstName
  if (patch.lastName !== undefined) data['lastName'] = patch.lastName
  if (patch.email !== undefined) data['email'] = patch.email
  if (patch.storeId !== undefined) data['storeId'] = patch.storeId
  if (patch.active !== undefined) data['active'] = patch.active

  const updated = await prisma.user.update({ where: { id }, data, select: userSelect })

  if (patch.active === false) {
    await prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    })
  }

  const keys = Object.keys(data) as Array<keyof typeof existing>
  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action: 'auth.user.update',
      entityType: 'User',
      entityId: id,
      // Changed keys only, matching the house pattern — an audit row that names fields
      // nobody touched is noise.
      before: Object.fromEntries(keys.map((k) => [k, existing[k] ?? null])),
      after: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v ?? null])),
    },
  })
  return toRow(updated)
}

/**
 * Reset to a system-generated PIN, shown to the admin exactly once.
 *
 * Also clears any lockout: someone who has forgotten their PIN has usually just locked
 * themselves out trying to remember it, and leaving them locked with a new PIN they cannot
 * use for fifteen minutes would be a strange thing to do.
 */
export async function resetPin(id: string, actorId: string) {
  const existing = await prisma.user.findUnique({ where: { id }, select: { id: true, active: true } })
  if (!existing) throw new NotFoundError('That person is not on the staff list.')
  if (!existing.active) {
    throw new ValidationError('Reactivate them before resetting a PIN.')
  }

  const pin = await assignGeneratedPin(id)

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action: 'auth.user.resetPin',
      entityType: 'User',
      entityId: id,
      before: {},
      // The fact of the reset, never the value.
      after: { mustChangePin: true },
    },
  })
  return { userId: id, pin }
}

/** Clear a lockout without waiting it out. The counter resets with it. */
export async function clearLockout(id: string, actorId: string) {
  const existing = await prisma.user.findUnique({
    where: { id },
    select: { id: true, lockedUntil: true, failedPinAttempts: true },
  })
  if (!existing) throw new NotFoundError('That person is not on the staff list.')

  const updated = await prisma.user.update({
    where: { id },
    data: { failedPinAttempts: 0, lockedUntil: null },
    select: userSelect,
  })

  await prisma.auditLog.create({
    data: {
      userId: actorId,
      action: 'auth.user.clearLockout',
      entityType: 'User',
      entityId: id,
      before: {
        lockedUntil: existing.lockedUntil?.toISOString() ?? null,
        failedPinAttempts: existing.failedPinAttempts,
      },
      after: { lockedUntil: null, failedPinAttempts: 0 },
    },
  })
  return toRow(updated)
}

/**
 * A person setting their OWN PIN, after a temporary one.
 *
 * ⚠️ The collision error must not name whoever holds that PIN — the exact opposite of the
 * barcode-collision message added the same day, because naming the owner hands the caller
 * that person's PIN. It must not say "already in use" either: with a small roster, someone
 * could probe live PINs by trying to SET them and reading which ones are refused. Refuse
 * without saying why.
 */
export async function changeOwnPin(userId: string, newPin: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, active: true, role: true },
  })
  if (!user || !user.active) throw new NotFoundError('That person is not on the staff list.')

  try {
    await prisma.user.update({
      where: { id: userId },
      data: {
        pinHash: await hashSecret(newPin),
        pinLookup: pinLookup(newPin),
        mustChangePin: false,
        failedPinAttempts: 0,
        lockedUntil: null,
      },
    })
  }
  catch (error) {
    if (isPinCollision(error)) {
      throw new ConflictError("That PIN can't be used. Please choose another.")
    }
    throw error
  }
}
