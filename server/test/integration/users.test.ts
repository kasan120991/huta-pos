import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal } from '../../src/auth/principal.js'
import { attachByPin, principalFromUser, roster } from '../../src/auth/auth.service.js'
import {
  changeOwnPin,
  clearLockout,
  createStaff,
  getUser,
  listUsers,
  resetPin,
  updateUser,
} from '../../src/auth/user.service.js'
import { prisma } from '../../src/db/client.js'
import {
  ConflictError,
  NotFoundError,
  PinChangeRequiredError,
  UnauthorizedError,
  ValidationError,
} from '../../src/errors/index.js'
import { makeAdmin, makeStaff, makeStore, makeTerminal, resetDatabase } from '../setup/factories.js'
import { findSecretKeys } from '../setup/secret-keys.js'

/**
 * Staff administration.
 *
 * Four DB CHECK constraints govern a valid User row and each gives a 500 rather than a
 * message when violated, so much of what is under test here is the service refusing FIRST,
 * with a sentence — the house rule that constraints are a backstop, not the validator.
 */
describe('staff administration', () => {
  let admin: AdminPrincipal
  let adminId: string
  let storeId: string

  beforeEach(async () => {
    await resetDatabase()
    const store = await makeStore('Main', 'main')
    storeId = store.id
    const a = await makeAdmin()
    adminId = a.id
    admin = { kind: 'admin', userId: a.id, role: 'ADMIN', storeId: null, terminalId: null }
  })

  it('creates a staff member with a PIN, satisfying every User CHECK at once', async () => {
    const { user, pin } = await createStaff(
      { firstName: 'Testy', lastName: 'McTemp', email: 'testy@test.local', storeId },
      adminId,
    )

    expect(pin).toMatch(/^\d{4}$/)
    expect(user.hasPin).toBe(true)
    expect(user.mustChangePin).toBe(true)

    // The row itself, because the CHECKs act on columns the payload deliberately omits.
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    expect(row.role).toBe('STAFF')
    expect(row.storeId).toBe(storeId) // User_role_store_scope_check
    expect(row.passwordHash).toBeNull() // User_staff_credentials_check
    expect(row.pinHash).not.toBeNull() // ditto
    expect(row.pinLookup).not.toBeNull() // User_pin_pairing_check — written together
  })

  it('refuses a store that does not exist, before the constraint can fire', async () => {
    await expect(
      createStaff({ firstName: 'No', lastName: 'Store', storeId: 'cmt0000000000000000000000' }, adminId),
    ).rejects.toThrow(NotFoundError)
  })

  it('refuses a duplicate email', async () => {
    await createStaff({ firstName: 'One', lastName: 'Person', email: 'dup@test.local', storeId }, adminId)
    await expect(
      createStaff({ firstName: 'Two', lastName: 'Person', email: 'dup@test.local', storeId }, adminId),
      ).rejects.toThrow(ConflictError)
  })

  /**
   * The cost-visibility rule's shape, applied to credentials: assert the absence AND assert
   * the payload is not simply empty, or the test passes vacuously forever.
   */
  it('never returns a password hash, PIN hash or PIN lookup', async () => {
    await createStaff({ firstName: 'Testy', lastName: 'McTemp', storeId }, adminId)
    const users = await listUsers(true)

    expect(findSecretKeys(users)).toEqual([])
    // Not vacuous: the payload really does carry the derived boolean and the identity.
    expect(users.some((u) => u.hasPin)).toBe(true)
    expect(users.some((u) => u.firstName === 'Testy')).toBe(true)
  })

  it('reports hasPin false for someone who has none', async () => {
    // makeAdmin creates an admin with NO pin — the false half of the boolean.
    const users = await listUsers(true)
    expect(users.find((u) => u.id === adminId)?.hasPin).toBe(false)
  })

  it('audits only the keys that changed', async () => {
    const { user } = await createStaff({ firstName: 'Testy', lastName: 'McTemp', storeId }, adminId)
    await updateUser(user.id, { firstName: 'Renamed' }, adminId)

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: user.id, action: 'auth.user.update' },
    })
    expect(audit.before).toHaveProperty('firstName', 'Testy')
    expect(audit.after).toHaveProperty('firstName', 'Renamed')
    expect(audit.before).not.toHaveProperty('storeId')
    expect(audit.after).not.toHaveProperty('storeId')
  })

  it('never writes PIN material into the audit trail', async () => {
    const { user, pin } = await createStaff({ firstName: 'Testy', lastName: 'McTemp', storeId }, adminId)
    const { pin: newPin } = await resetPin(user.id, adminId)

    const rows = await prisma.auditLog.findMany({ where: { entityId: user.id } })
    const blob = JSON.stringify(rows)
    expect(blob).not.toContain(pin)
    expect(blob).not.toContain(newPin)
  })

  describe('deactivation', () => {
    it('revokes refresh tokens, so a 7-day cookie cannot outlive the account', async () => {
      const { user } = await createStaff({ firstName: 'Testy', lastName: 'McTemp', storeId }, adminId)
      await prisma.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: 'test-hash',
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        },
      })

      await updateUser(user.id, { active: false }, adminId)

      const live = await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })
      expect(live).toBe(0)
    })

    it('refuses to deactivate the only administrator', async () => {
      const other = await makeAdmin('second@test.local')
      // Two admins: deactivating one is fine.
      await updateUser(other.id, { active: false }, adminId)
      // One left: refused, or the back office locks itself out.
      await expect(updateUser(adminId, { active: false }, other.id)).rejects.toThrow(ConflictError)
    })

    it('refuses self-deactivation', async () => {
      await expect(updateUser(adminId, { active: false }, adminId)).rejects.toThrow(ConflictError)
    })
  })

  it('refuses to give an admin a home store', async () => {
    await expect(updateUser(adminId, { storeId }, adminId)).rejects.toThrow(ValidationError)
  })

  describe('PIN reset and change', () => {
    it('refuses attach on a temporary PIN and creates NO session', async () => {
      const { user, pin } = await createStaff({ firstName: 'Testy', lastName: 'McTemp', storeId }, adminId)
      const terminal = await makeTerminal(storeId, 'device-token-users-test')

      // The attribution hole this closes: attaching here would mint a 12-hour session on a
      // PIN the admin who issued it knows.
      await expect(attachByPin(user.id, pin, terminal.id, storeId)).rejects.toThrow(
        PinChangeRequiredError,
      )
    })

    it('lets the person set their own PIN, after which attach works', async () => {
      const { user, pin } = await createStaff({ firstName: 'Testy', lastName: 'McTemp', storeId }, adminId)
      const terminal = await makeTerminal(storeId, 'device-token-users-test-2')

      await changeOwnPin(user.id, '4242')

      const attached = await attachByPin(user.id, '4242', terminal.id, storeId)
      expect(attached.principal.userId).toBe(user.id)
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).mustChangePin).toBe(false)
    })

    it('refuses a PIN another person already holds, without saying whose it is', async () => {
      const other = await makeStaff(storeId, '2222', 'other@test.local')
      const { user } = await createStaff({ firstName: 'Testy', lastName: 'McTemp', storeId }, adminId)

      const before = await prisma.user.findUniqueOrThrow({ where: { id: other.id } })
      await expect(changeOwnPin(user.id, '2222')).rejects.toThrow(ConflictError)

      // ⚠️ The message must not name the holder — that would hand over their PIN.
      await expect(changeOwnPin(user.id, '2222')).rejects.toThrow(/can't be used/i)
      await expect(changeOwnPin(user.id, '2222')).rejects.not.toThrow(/other@test.local/)

      // And the collision left the other person's credential untouched.
      const after = await prisma.user.findUniqueOrThrow({ where: { id: other.id } })
      expect(after.pinHash).toBe(before.pinHash)
    })

    it('reset issues a fresh PIN, flags the change and clears any lockout', async () => {
      const { user, pin } = await createStaff({ firstName: 'Testy', lastName: 'McTemp', storeId }, adminId)
      await changeOwnPin(user.id, '4242')
      await prisma.user.update({
        where: { id: user.id },
        data: { failedPinAttempts: 4, lockedUntil: new Date(Date.now() + 60_000) },
      })

      const { pin: fresh } = await resetPin(user.id, adminId)
      expect(fresh).toMatch(/^\d{4}$/)
      expect(fresh).not.toBe(pin)

      const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
      expect(row.mustChangePin).toBe(true)
      expect(row.failedPinAttempts).toBe(0)
      expect(row.lockedUntil).toBeNull()
    })

    it('refuses a reset on a deactivated person', async () => {
      const { user } = await createStaff({ firstName: 'Testy', lastName: 'McTemp', storeId }, adminId)
      await updateUser(user.id, { active: false }, adminId)
      await expect(resetPin(user.id, adminId)).rejects.toThrow(ValidationError)
    })
  })

  it('clears a lockout so the person can sign in immediately', async () => {
    const { user } = await createStaff({ firstName: 'Testy', lastName: 'McTemp', storeId }, adminId)
    await changeOwnPin(user.id, '4242')
    await prisma.user.update({
      where: { id: user.id },
      data: { failedPinAttempts: 5, lockedUntil: new Date(Date.now() + 15 * 60_000) },
    })

    const cleared = await clearLockout(user.id, adminId)
    expect(cleared.failedPinAttempts).toBe(0)
    expect(cleared.lockedUntil).toBeNull()

    const terminal = await makeTerminal(storeId, 'device-token-users-test-3')
    await expect(attachByPin(user.id, '4242', terminal.id, storeId)).resolves.toBeTruthy()
  })

  /**
   * REPLACES "de-authenticates a reassigned cashier at their old store", which asserted the
   * rule Kasan reversed on 2026-08-22. Moving someone's home store no longer bars them from
   * anywhere; it only changes where they are recorded as based.
   */
  it('keeps a reassigned cashier working at both stores', async () => {
    const other = await makeStore('Ashley', 'ashley')
    const { user } = await createStaff({ firstName: 'Testy', lastName: 'McTemp', storeId }, adminId)
    await changeOwnPin(user.id, '4242')
    const oldTerminal = await makeTerminal(storeId, 'device-token-users-test-4')

    await updateUser(user.id, { storeId: other.id }, adminId)

    const still = await attachByPin(user.id, '4242', oldTerminal.id, storeId)
    // ...and they are scoped to the till they are standing at, not to their new home store.
    expect(still.principal.storeId).toBe(storeId)
  })

  it('404s on an unknown person rather than leaking existence', async () => {
    await expect(getUser('cmt0000000000000000000000')).rejects.toThrow(NotFoundError)
  })
})

/**
 * Anyone works anywhere (Kasan, 2026-08-22). The terminal establishes WHICH STORE and the PIN
 * establishes WHO — which is what the three-layer auth model always claimed; a home-store
 * guard on attach was the one thing contradicting it.
 *
 * `User.storeId` survives as a HOME store: it records who is based where and orders the
 * sign-in roster, and governs nothing.
 */
describe('staff work at any store', () => {
  let home: string
  let away: string
  let adminId: string

  beforeEach(async () => {
    await resetDatabase()
    home = (await makeStore('Main', 'main')).id
    away = (await makeStore('Ashley', 'ashley')).id
    adminId = (await makeAdmin()).id
  })

  async function cashier(firstName: string, storeId: string, pin: string) {
    const { user } = await createStaff({ firstName, lastName: 'Tester', storeId }, adminId)
    await changeOwnPin(user.id, pin)
    return user
  }

  it('attaches a cashier at another store and scopes them to THAT store', async () => {
    const user = await cashier('Visitor', home, '4242')
    const awayTerminal = await makeTerminal(away, 'device-token-away-1')

    const attached = await attachByPin(user.id, '4242', awayTerminal.id, away)

    expect(attached.principal.storeId).toBe(away)
    expect(attached.principal.storeId).not.toBe(home)
  })

  /**
   * ⚠️ THE TRAP, and the reason this is more than deleting one guard.
   *
   * `attachByPin` and `principalFromUser` are two independent derivations of the same fact and
   * they used to disagree — attach read the terminal, this read the home store. They could not
   * be caught disagreeing because the removed guard forced them equal. Without fixing both, a
   * visiting cashier would be handed a session for the store they are standing in and then, on
   * their very NEXT request, be refused or silently moved home.
   */
  it('keeps the visiting cashier at that store on the next request, not their home one', async () => {
    const user = await cashier('Visitor', home, '4242')
    const awayTerminal = await makeTerminal(away, 'device-token-away-2')
    await attachByPin(user.id, '4242', awayTerminal.id, away)

    // What `authenticate` does on every subsequent request.
    const rebuilt = await principalFromUser(user.id, awayTerminal.id, away)

    expect(rebuilt).not.toBeNull()
    expect(rebuilt?.storeId).toBe(away)
  })

  /**
   * A staff session cannot exist away from a terminal — staff hold no password — so with no
   * device we cannot know which store they are at. Refusing is what sends a register to
   * /register/pair, the documented remedy for a device that has lost its token.
   */
  it('refuses a staff session with no terminal behind it', async () => {
    const user = await cashier('Deskless', home, '4242')
    expect(await principalFromUser(user.id, null, null)).toBeNull()
    expect(await principalFromUser(user.id, 'cmt0000000000000000000000', null)).toBeNull()
  })

  it('still refuses a wrong PIN, so the open door is the STORE and nothing else', async () => {
    const user = await cashier('Visitor', home, '4242')
    const awayTerminal = await makeTerminal(away, 'device-token-away-3')

    await expect(attachByPin(user.id, '9999', awayTerminal.id, away)).rejects.toThrow(
      UnauthorizedError,
    )
  })

  /**
   * The roster stays LOCAL by default. An unattended register is readable by anyone standing
   * in the shop, and listing every employee of the business on it is a wider disclosure than
   * the one this change replaced — so a visitor is reached deliberately, via `scope: 'all'`.
   */
  it('lists only this store by default, and everyone on request', async () => {
    const local = await cashier('Local', away, '1111')
    const visitor = await cashier('Visitor', home, '2222')

    // An admin needs a PIN to be on any roster — holding one is optional (see Auth), and
    // `makeAdmin` creates a password-only admin, which correctly does not appear.
    await changeOwnPin(adminId, '9000')

    const byDefault = await roster(away)
    const ids = byDefault.map((r) => r.userId)
    expect(ids).toContain(local.id)
    expect(ids).toContain(adminId) // admins could always attach anywhere
    expect(ids).not.toContain(visitor.id)

    const everyone = await roster(away, 'all')
    expect(everyone.map((r) => r.userId)).toContain(visitor.id)
  })

  it('never puts more than a first name and last initial on the roster', async () => {
    await cashier('Local', away, '1111')
    const entries = await roster(away, 'all')
    for (const e of entries) {
      expect(Object.keys(e).sort()).toEqual(['firstName', 'lastInitial', 'userId'])
      expect(e.lastInitial).toHaveLength(1)
    }
  })
})
