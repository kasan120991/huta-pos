import { Role } from '@huta/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import { ConflictError, ForbiddenError } from '../../src/errors/index.js'
import {
  addCashMovement,
  closeShift,
  currentShift,
  openShift,
} from '../../src/sales/shift.service.js'
import { makeAdmin, makeStaff, makeStore, makeTerminal, resetDatabase } from '../setup/factories.js'

/**
 * Shifts — the drawer's accountability record.
 *
 * The arithmetic under test is the whole point of the feature: expected cash is opening
 * float + CASH taken (Payment.amountCents, never tendered) + paid-ins − paid-outs −
 * drops, and variance is counted − expected, recorded rather than absorbed.
 */

let storeA: { id: string }
let storeB: { id: string }
let admin: AdminPrincipal
let staff: StaffPrincipal
let adminUser: { id: string }

beforeEach(async () => {
  await resetDatabase()
  storeA = await makeStore('Store A', 'store-a')
  storeB = await makeStore('Store B', 'store-b')
  adminUser = await makeAdmin()
  admin = { kind: 'admin', userId: adminUser.id, role: Role.ADMIN, storeId: null, terminalId: null }
  const staffUser = await makeStaff(storeA.id, '4321')
  // A REAL terminal row — Shift.terminalId is a foreign key, and real principals only
  // ever carry ids that exist.
  const terminal = await makeTerminal(storeA.id, 'shifts-test-device-token')
  staff = {
    kind: 'staff',
    userId: staffUser.id,
    role: Role.STAFF,
    storeId: storeA.id,
    terminalId: terminal.id,
  }
})

/** Seed a completed cash sale directly — checkout doesn't exist yet in this slice. */
async function seedCashSale(shiftId: string, storeId: string, cashierId: string, opts: {
  number: number
  totalCents: number
  tenderedCents?: number
}) {
  const sale = await prisma.sale.create({
    data: {
      number: opts.number,
      storeId,
      shiftId,
      cashierId,
      subtotalCents: opts.totalCents,
      discountCents: 0,
      taxCents: 0,
      totalCents: opts.totalCents,
      taxRateBps: 0,
    },
  })
  await prisma.payment.create({
    data: {
      saleId: sale.id,
      method: 'CASH',
      amountCents: opts.totalCents,
      status: 'SUCCEEDED',
      cashTenderedCents: opts.tenderedCents ?? opts.totalCents,
      cashChangeCents: (opts.tenderedCents ?? opts.totalCents) - opts.totalCents,
    },
  })
  return sale
}

describe('opening a shift', () => {
  it('opens with the float, the opener, and the terminal from the principal', async () => {
    const shift = await openShift(staff, storeA.id, { openingCashCents: 100_00 })
    expect(shift).toMatchObject({
      storeId: storeA.id,
      status: 'OPEN',
      openingCashCents: 100_00,
      terminalId: staff.terminalId,
      saleCount: 0,
      cashSalesCents: 0,
    })
    expect(shift.openedById).toBe(staff.userId)
  })

  it('refuses a second open at the same store but allows one at another', async () => {
    await openShift(staff, storeA.id, { openingCashCents: 100_00 })
    await expect(openShift(admin, storeA.id, { openingCashCents: 50_00 })).rejects.toThrow(
      ConflictError,
    )
    const other = await openShift(admin, storeB.id, { openingCashCents: 50_00 })
    expect(other.storeId).toBe(storeB.id)
  })

  it('serialises two CONCURRENT opens — exactly one wins', async () => {
    const results = await Promise.allSettled([
      openShift(staff, storeA.id, { openingCashCents: 100_00 }),
      openShift(admin, storeA.id, { openingCashCents: 100_00 }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)
    expect(await prisma.shift.count({ where: { storeId: storeA.id, status: 'OPEN' } })).toBe(1)
  })
})

describe('closing a shift', () => {
  it('computes expected from opening + cash AMOUNTS + movements, and the variance', async () => {
    const shift = await openShift(staff, storeA.id, { openingCashCents: 100_00 })
    // Tendered deliberately exceeds the amount: the drawer kept only amountCents — the
    // overage went back as change and must not inflate expected cash.
    await seedCashSale(shift.id, storeA.id, staff.userId, {
      number: 1,
      totalCents: 42_85,
      tenderedCents: 50_00,
    })
    await addCashMovement(staff, shift.id, { type: 'PAID_IN', amountCents: 20_00, reason: 'change run' })
    await addCashMovement(staff, shift.id, { type: 'PAID_OUT', amountCents: 5_00, reason: 'window cleaner' })
    await addCashMovement(staff, shift.id, { type: 'DROP', amountCents: 50_00, reason: 'safe drop' })

    const expected = 100_00 + 42_85 + 20_00 - 5_00 - 50_00
    const closed = await closeShift(staff, shift.id, { countedCashCents: expected - 3_00 })
    expect(closed).toMatchObject({
      status: 'CLOSED',
      expectedCashCents: expected,
      closingCountedCashCents: expected - 3_00,
      varianceCents: -3_00, // short — negative, recorded, not absorbed
      saleCount: 1,
      cashSalesCents: 42_85,
    })
    expect(closed.closedById).toBe(staff.userId)
  })

  it('records an over-count as a positive variance', async () => {
    const shift = await openShift(staff, storeA.id, { openingCashCents: 100_00 })
    const closed = await closeShift(staff, shift.id, { countedCashCents: 101_50 })
    expect(closed.varianceCents).toBe(1_50)
  })

  it('closes all-or-nothing and refuses a second close', async () => {
    const shift = await openShift(staff, storeA.id, { openingCashCents: 0 })
    const closed = await closeShift(staff, shift.id, { countedCashCents: 0, notes: 'quiet day' })
    expect(closed.closedAt).not.toBeNull()
    expect(closed.expectedCashCents).not.toBeNull()
    expect(closed.varianceCents).not.toBeNull()
    expect(closed.notes).toBe('quiet day')

    await expect(closeShift(staff, shift.id, { countedCashCents: 0 })).rejects.toThrow(ConflictError)
  })
})

describe('cash movements', () => {
  it('refuses movements on a closed shift', async () => {
    const shift = await openShift(staff, storeA.id, { openingCashCents: 0 })
    await closeShift(staff, shift.id, { countedCashCents: 0 })
    await expect(
      addCashMovement(staff, shift.id, { type: 'PAID_IN', amountCents: 1_00, reason: 'late' }),
    ).rejects.toThrow(ConflictError)
  })

  it('records who moved the cash and why', async () => {
    const shift = await openShift(staff, storeA.id, { openingCashCents: 0 })
    const movement = await addCashMovement(staff, shift.id, {
      type: 'DROP',
      amountCents: 200_00,
      reason: 'safe drop before close',
    })
    expect(movement.reason).toBe('safe drop before close')
    expect(movement.amountCents).toBe(200_00)
    expect(movement.userName.length).toBeGreaterThan(0)
  })
})

describe('scoping', () => {
  it('pins staff to their own store for open, close, and movements', async () => {
    await expect(openShift(staff, storeB.id, { openingCashCents: 0 })).rejects.toThrow(ForbiddenError)

    const otherShift = await openShift(admin, storeB.id, { openingCashCents: 0 })
    await expect(closeShift(staff, otherShift.id, { countedCashCents: 0 })).rejects.toThrow(
      ForbiddenError,
    )
    await expect(
      addCashMovement(staff, otherShift.id, { type: 'PAID_IN', amountCents: 1_00, reason: 'x' }),
    ).rejects.toThrow(ForbiddenError)
  })

  it('currentShift tracks the lifecycle: null → the open shift → null after close', async () => {
    expect(await currentShift(staff, storeA.id)).toBeNull()
    const shift = await openShift(staff, storeA.id, { openingCashCents: 25_00 })
    expect((await currentShift(staff, storeA.id))?.id).toBe(shift.id)
    await closeShift(staff, shift.id, { countedCashCents: 25_00 })
    expect(await currentShift(staff, storeA.id)).toBeNull()
  })
})
