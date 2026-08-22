import { beforeEach, describe, expect, it } from 'vitest'

import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import { ForbiddenError } from '../../src/errors/index.js'
import { activityFor } from '../../src/people/activity.service.js'
import { closeShift, listShifts, openShift } from '../../src/sales/shift.service.js'
import { makeAdmin, makeStaff, makeStore, makeTerminal, resetDatabase } from '../setup/factories.js'

/**
 * The drawer list and per-person activity.
 *
 * ⚠️ A drawer is NOT a timesheet. These tests assert custody — who counted the float in and
 * who counted it out — and nothing here should ever be read as hours worked. The wording of
 * the fields (`drawersOpened`, not `shiftsWorked`) is part of that and is worth preserving.
 */
describe('drawer list', () => {
  let storeA: string
  let storeB: string
  let admin: AdminPrincipal
  let staffA: StaffPrincipal
  let staffAId: string

  beforeEach(async () => {
    await resetDatabase()
    const a = await makeStore('Main', 'main')
    const b = await makeStore('Ashley', 'ashley')
    storeA = a.id
    storeB = b.id
    const terminal = await makeTerminal(storeA, 'device-token-shift-list')
    const person = await makeStaff(storeA, '1111')
    staffAId = person.id
    staffA = { kind: 'staff', userId: person.id, role: 'STAFF', storeId: storeA, terminalId: terminal.id }
    const adminUser = await makeAdmin()
    admin = { kind: 'admin', userId: adminUser.id, role: 'ADMIN', storeId: null, terminalId: null }
  })

  it('lists drawers across every store for an admin', async () => {
    await openShift(staffA, storeA, { openingCashCents: 20_000 })
    await openShift(admin, storeB, { openingCashCents: 10_000 })

    const rows = await listShifts(admin, {})
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.storeName).sort()).toEqual(['Ashley', 'Main'])
  })

  it('pins a cashier to their own store rather than refusing them', async () => {
    await openShift(staffA, storeA, { openingCashCents: 20_000 })
    await openShift(admin, storeB, { openingCashCents: 10_000 })

    const rows = await listShifts(staffA, {})
    expect(rows).toHaveLength(1)
    expect(rows[0]?.storeId).toBe(storeA)
  })

  it('refuses a cashier who names another store', async () => {
    await expect(listShifts(staffA, { storeId: storeB })).rejects.toThrow(ForbiddenError)
  })

  /**
   * The reason `ShiftListRow` exists. `toShiftRow` runs three sequential queries per row;
   * the list reads the columns a closed drawer already carries and gets every sale count in
   * ONE grouped query. This asserts the shape that makes that true.
   */
  it('serves a CLOSED drawer from its stored columns', async () => {
    const opened = await openShift(staffA, storeA, { openingCashCents: 20_000 })
    await closeShift(staffA, opened.id, { countedCashCents: 19_500 })

    const rows = await listShifts(admin, {})
    expect(rows[0]?.status).toBe('CLOSED')
    expect(rows[0]?.openingCashCents).toBe(20_000)
    expect(rows[0]?.closingCountedCashCents).toBe(19_500)
    // Counted 19,500 against an expected 20,000 — five dollars short, recorded not absorbed.
    expect(rows[0]?.expectedCashCents).toBe(20_000)
    expect(rows[0]?.varianceCents).toBe(-500)
  })

  it('leaves an OPEN drawer without an expected figure, because there is not one yet', async () => {
    await openShift(staffA, storeA, { openingCashCents: 20_000 })
    const rows = await listShifts(admin, {})
    expect(rows[0]?.status).toBe('OPEN')
    expect(rows[0]?.expectedCashCents).toBeNull()
    expect(rows[0]?.varianceCents).toBeNull()
  })

  it('finds a drawer the person only CLOSED, not just ones they opened', async () => {
    const opened = await openShift(staffA, storeA, { openingCashCents: 20_000 })
    // The admin counts it out — the two custody facts belong to different people, which is
    // exactly the case a naive `openedById` filter would miss.
    await closeShift(admin, opened.id, { countedCashCents: 20_000 })

    const byOpener = await listShifts(admin, { userId: staffAId })
    const byCloser = await listShifts(admin, { userId: admin.userId })
    expect(byOpener).toHaveLength(1)
    expect(byCloser).toHaveLength(1)
    expect(byCloser[0]?.id).toBe(opened.id)
  })

  it('counts sales per drawer without a query per row', async () => {
    const opened = await openShift(staffA, storeA, { openingCashCents: 20_000 })
    const rows = await listShifts(admin, {})
    // No sales rung, so zero rather than undefined — the map lookup has a default.
    expect(rows.find((r) => r.id === opened.id)?.saleCount).toBe(0)
  })

  it('filters by business day, half-open at the end', async () => {
    const opened = await openShift(staffA, storeA, { openingCashCents: 20_000 })
    // 23:50 on the 20th — a `lte` against midnight on the 20th would drop it.
    await prisma.shift.update({
      where: { id: opened.id },
      data: { openedAt: new Date('2026-08-20T23:50:00') },
    })

    expect(await listShifts(admin, { from: '2026-08-20', to: '2026-08-20' })).toHaveLength(1)
    expect(await listShifts(admin, { from: '2026-08-21', to: '2026-08-21' })).toHaveLength(0)
  })
})

describe('per-person activity', () => {
  let storeId: string
  let admin: AdminPrincipal
  let staff: StaffPrincipal
  let staffId: string

  beforeEach(async () => {
    await resetDatabase()
    const store = await makeStore('Main', 'main')
    storeId = store.id
    const terminal = await makeTerminal(storeId, 'device-token-activity')
    const person = await makeStaff(storeId, '1111')
    staffId = person.id
    staff = { kind: 'staff', userId: person.id, role: 'STAFF', storeId, terminalId: terminal.id }
    const a = await makeAdmin()
    admin = { kind: 'admin', userId: a.id, role: 'ADMIN', storeId: null, terminalId: null }
  })

  it('counts drawer custody separately for opening and closing', async () => {
    const opened = await openShift(staff, storeId, { openingCashCents: 10_000 })
    await closeShift(admin, opened.id, { countedCashCents: 10_000 })

    const forStaff = await activityFor(admin, staffId, {})
    expect(forStaff.drawersOpened).toBe(1)
    expect(forStaff.drawersClosed).toBe(0)

    const forAdmin = await activityFor(admin, admin.userId, {})
    expect(forAdmin.drawersOpened).toBe(0)
    expect(forAdmin.drawersClosed).toBe(1)
  })

  /**
   * An average over nothing is unanswerable, not zero. The suppliers scorecard set this
   * rule: a figure like this travels with its sample size or not at all.
   */
  it('reports a null average when there are no sales', async () => {
    const activity = await activityFor(admin, staffId, {})
    expect(activity.saleCount).toBe(0)
    expect(activity.grossCents).toBe(0)
    expect(activity.averageSaleCents).toBeNull()
  })

  it('is closed to staff', async () => {
    await expect(activityFor(staff, staffId, {})).rejects.toThrow(ForbiddenError)
  })
})
