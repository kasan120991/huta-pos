import { beforeEach, describe, expect, it } from 'vitest'
import request from 'supertest'

import { createApp } from '../../src/app.js'

import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import { ConflictError, ForbiddenError } from '../../src/errors/index.js'
import { activityFor } from '../../src/people/activity.service.js'
import {
  addCashMovement,
  closeShift,
  listShifts,
  liveDrawers,
  openShift,
  reviewShift,
} from '../../src/sales/shift.service.js'
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

    const { shifts: rows } = await listShifts(admin, {})
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.storeName).sort()).toEqual(['Ashley', 'Main'])
  })

  it('pins a cashier to their own store rather than refusing them', async () => {
    await openShift(staffA, storeA, { openingCashCents: 20_000 })
    await openShift(admin, storeB, { openingCashCents: 10_000 })

    const { shifts: rows } = await listShifts(staffA, {})
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

    const { shifts: rows } = await listShifts(admin, {})
    expect(rows[0]?.status).toBe('CLOSED')
    expect(rows[0]?.openingCashCents).toBe(20_000)
    expect(rows[0]?.closingCountedCashCents).toBe(19_500)
    // Counted 19,500 against an expected 20,000 — five dollars short, recorded not absorbed.
    expect(rows[0]?.expectedCashCents).toBe(20_000)
    expect(rows[0]?.varianceCents).toBe(-500)
  })

  it('leaves an OPEN drawer without an expected figure, because there is not one yet', async () => {
    await openShift(staffA, storeA, { openingCashCents: 20_000 })
    const { shifts: rows } = await listShifts(admin, {})
    expect(rows[0]?.status).toBe('OPEN')
    expect(rows[0]?.expectedCashCents).toBeNull()
    expect(rows[0]?.varianceCents).toBeNull()
  })

  it('finds a drawer the person only CLOSED, not just ones they opened', async () => {
    const opened = await openShift(staffA, storeA, { openingCashCents: 20_000 })
    // The admin counts it out — the two custody facts belong to different people, which is
    // exactly the case a naive `openedById` filter would miss.
    await closeShift(admin, opened.id, { countedCashCents: 20_000 })

    const { shifts: byOpener } = await listShifts(admin, { userId: staffAId })
    const { shifts: byCloser } = await listShifts(admin, { userId: admin.userId })
    expect(byOpener).toHaveLength(1)
    expect(byCloser).toHaveLength(1)
    expect(byCloser[0]?.id).toBe(opened.id)
  })

  it('counts sales per drawer without a query per row', async () => {
    const opened = await openShift(staffA, storeA, { openingCashCents: 20_000 })
    const { shifts: rows } = await listShifts(admin, {})
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

    expect((await listShifts(admin, { from: '2026-08-20', to: '2026-08-20' })).shifts).toHaveLength(1)
    expect((await listShifts(admin, { from: '2026-08-21', to: '2026-08-21' })).shifts).toHaveLength(0)
  })

  /**
   * ⚠️ The regression this was written for. `listShifts` used to build its range with
   * `new Date(`${from}T00:00:00`)`, which parses in the SERVER's zone — so a drawer's
   * business day was decided by where the server happened to be running, against
   * `Store.timezone`'s explicit "never the server's timezone".
   *
   * Kiritimati is UTC+14 and Honolulu UTC-10: a full day apart, and neither can coincide
   * with the machine running the suite. One instant therefore falls on DIFFERENT business
   * days in the two stores, which no server-zone implementation can produce.
   */
  it('cuts the business day in each STORE\'s timezone, not the server\'s', async () => {
    const east = await makeStore('Kiritimati', 'kiritimati', 'Pacific/Kiritimati')
    const west = await makeStore('Honolulu', 'honolulu', 'Pacific/Honolulu')

    // 2026-08-20T12:00Z → 2026-08-21 02:00 in Kiritimati, 2026-08-20 02:00 in Honolulu.
    const instant = new Date('2026-08-20T12:00:00Z')
    for (const store of [east, west]) {
      const s = await openShift(admin, store.id, { openingCashCents: 1_000 })
      await prisma.shift.update({ where: { id: s.id }, data: { openedAt: instant } })
    }

    const eastOn21 = await listShifts(admin, { storeId: east.id, from: '2026-08-21', to: '2026-08-21' })
    expect(eastOn21.shifts).toHaveLength(1)
    expect(eastOn21.timezone).toBe('Pacific/Kiritimati')

    const westOn21 = await listShifts(admin, { storeId: west.id, from: '2026-08-21', to: '2026-08-21' })
    expect(westOn21.shifts).toHaveLength(0)
    // ...and the same instant IS on the 20th in Honolulu, so the row is found, not lost.
    expect((await listShifts(admin, { storeId: west.id, from: '2026-08-20', to: '2026-08-20' })).shifts)
      .toHaveLength(1)
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

/**
 * The drawer review record — an admin's account of WHY a variance happened.
 *
 * Deliberately separate from `Shift.notes`, which is the cashier's own words at the count.
 */
describe('drawer review', () => {
  let storeId: string
  let admin: AdminPrincipal
  let staff: StaffPrincipal

  beforeEach(async () => {
    await resetDatabase()
    const store = await makeStore('Main', 'main')
    storeId = store.id
    const terminal = await makeTerminal(storeId, 'device-token-review')
    const person = await makeStaff(storeId, '1111')
    staff = { kind: 'staff', userId: person.id, role: 'STAFF', storeId, terminalId: terminal.id }
    const a = await makeAdmin()
    admin = { kind: 'admin', userId: a.id, role: 'ADMIN', storeId: null, terminalId: null }
  })

  async function shortDrawer(): Promise<string> {
    const opened = await openShift(staff, storeId, { openingCashCents: 20_000 })
    await closeShift(staff, opened.id, { countedCashCents: 19_500 })
    return opened.id
  }

  it('records the note, the reviewer and the time together', async () => {
    const id = await shortDrawer()
    const row = await reviewShift(admin, id, 'Counted wrong — found $5 under the till.')

    expect(row.reviewNote).toBe('Counted wrong — found $5 under the till.')
    expect(row.reviewedByName).toBe('Test Admin')
    expect(row.reviewedAt).not.toBeNull()
  })

  it('surfaces the review on the LIST, so an explained drawer can leave the queue', async () => {
    const id = await shortDrawer()
    await reviewShift(admin, id, 'Till float miscounted at open.')

    const { shifts } = await listShifts(admin, {})
    expect(shifts[0]?.reviewNote).toBe('Till float miscounted at open.')
    expect(shifts[0]?.reviewedByName).toBe('Test Admin')
  })

  /**
   * Amend, not conflict — the divergence from the receipts queue. An annotation grows:
   * "investigating" becomes "found it". Locking the first sentence would be wrong, and
   * nothing is lost because AuditLog keeps every version.
   */
  it('amends on a second post and keeps the earlier note in the audit trail', async () => {
    const id = await shortDrawer()
    await reviewShift(admin, id, 'Investigating.')
    const row = await reviewShift(admin, id, 'Found it — a $5 change error.')

    expect(row.reviewNote).toBe('Found it — a $5 change error.')

    const audit = await prisma.auditLog.findMany({
      where: { entityType: 'Shift', entityId: id, action: 'shift.review' },
      orderBy: { createdAt: 'asc' },
    })
    expect(audit).toHaveLength(2)
    // The amend's `before` carries the sentence it replaced — that is what makes
    // overwriting acceptable rather than destructive.
    expect((audit[1]?.before as { reviewNote?: string }).reviewNote).toBe('Investigating.')
  })

  it('refuses an OPEN drawer — there is no variance to explain yet', async () => {
    const opened = await openShift(staff, storeId, { openingCashCents: 20_000 })
    await expect(reviewShift(admin, opened.id, 'Looks light.')).rejects.toThrow(ConflictError)
  })

  it('is closed to staff — opening a drawer is not the authority to judge one', async () => {
    const id = await shortDrawer()
    await expect(reviewShift(staff, id, 'It was fine.')).rejects.toThrow(ForbiddenError)
  })

  /** Each CHECK, driven directly, because a service message is not the same as an invariant. */
  it('refuses half a review record at the DATABASE', async () => {
    const id = await shortDrawer()

    // A timestamp with no reviewer.
    await expect(
      prisma.$executeRaw`UPDATE "Shift" SET "reviewedAt" = NOW() WHERE id = ${id}`,
    ).rejects.toThrow(/Shift_review_pairing_check/)

    // A note with nobody standing behind it.
    await expect(
      prisma.$executeRaw`UPDATE "Shift" SET "reviewNote" = 'anon' WHERE id = ${id}`,
    ).rejects.toThrow(/Shift_review_note_check/)
  })

  it('refuses a review on an OPEN drawer at the DATABASE too', async () => {
    const opened = await openShift(staff, storeId, { openingCashCents: 20_000 })
    const adminId = admin.userId
    await expect(
      prisma.$executeRaw`
        UPDATE "Shift" SET "reviewedById" = ${adminId}, "reviewedAt" = NOW()
         WHERE id = ${opened.id}`,
    ).rejects.toThrow(/Shift_review_closed_check/)
  })
})

/**
 * The list route's own guards, over HTTP.
 *
 * `GET /shifts` was the only route in `shift.routes.ts` with no `requireAuth`/`requirePerson`
 * — a bare terminal was refused one layer down by `assertCan(…, 'shift.manage')`, so nothing
 * leaked, but a money read should not depend on a service check to decide that an unattended
 * register may not ask. These pin the guard so it cannot quietly go missing again.
 *
 * The app is built PER TEST, not hoisted into the describe body: the house notes record a
 * supertest socket-reuse flake from exactly that pattern.
 */
describe('GET /api/shifts guards', () => {
  const DEVICE_TOKEN = 'device-token-shift-http'

  beforeEach(async () => {
    await resetDatabase()
    const store = await makeStore('Main', 'main')
    await makeTerminal(store.id, DEVICE_TOKEN)
  })

  /** Sign in and keep the cookies, the way a browser would. */
  async function adminCookies(app: ReturnType<typeof createApp>): Promise<string[]> {
    await makeAdmin('admin@test.local', 'test-password')
    const agent = request(app)
    const primed = await agent.get('/api/auth/me')
    const jar = (primed.headers['set-cookie'] as unknown as string[]) ?? []
    const csrf = jar
      .map((raw) => raw.split(';')[0]?.split('='))
      .find((pair) => pair?.[0] === 'huta_csrf')?.[1]

    const login = await agent
      .post('/api/auth/login')
      .set('Cookie', jar)
      .set('X-CSRF-Token', decodeURIComponent(csrf ?? ''))
      .send({ email: 'admin@test.local', password: 'test-password' })

    expect(login.status).toBe(200)
    return login.headers['set-cookie'] as unknown as string[]
  }

  /**
   * 401 rather than 403, and that is `requirePerson`'s deliberate wording: the remedy for an
   * unattended register is to sign in with a PIN, not to be told it lacks a permission.
   */
  it('refuses a bare terminal — an unattended register has nobody to hold accountable', async () => {
    const res = await request(createApp())
      .get('/api/shifts')
      .set('X-Device-Token', DEVICE_TOKEN)

    expect(res.status).toBe(401)
  })

  it('refuses a request with no session at all', async () => {
    const res = await request(createApp()).get('/api/shifts')
    expect(res.status).toBe(401)
  })

  /**
   * `z.iso.date()` replaced a hand-rolled `\d{4}-\d{2}-\d{2}` regex that happily accepted
   * `2026-99-99`. Driven as an ADMIN, because validation sits behind the person guard — a
   * bare terminal never reaches it.
   */
  it('rejects an impossible date rather than filtering by it', async () => {
    const app = createApp()
    const cookies = await adminCookies(app)
    const res = await request(app).get('/api/shifts?from=2026-99-99').set('Cookie', cookies)

    expect(res.status).toBe(400)
  })

  it('accepts a real date from the same admin, so the case above is not a blanket refusal', async () => {
    const app = createApp()
    const cookies = await adminCookies(app)
    const res = await request(app).get('/api/shifts?from=2026-08-20').set('Cookie', cookies)

    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('timezone')
  })
})

/**
 * Cash CARRIES OVER between shifts and days — the drawer is not emptied, and only the owner
 * collecting it takes money out. Kasan, 2026-08-22.
 *
 * The close arithmetic already chained correctly; what was missing was any check on the
 * OPENING figure, which under carry-over is the one place cash can vanish untraced.
 */
describe('drawer carry-over', () => {
  let storeId: string
  let otherStoreId: string
  let admin: AdminPrincipal
  let staff: StaffPrincipal

  beforeEach(async () => {
    await resetDatabase()
    const store = await makeStore('Main', 'main')
    const other = await makeStore('Ashley', 'ashley')
    storeId = store.id
    otherStoreId = other.id
    const terminal = await makeTerminal(storeId, 'device-token-carry')
    const person = await makeStaff(storeId, '1111')
    staff = { kind: 'staff', userId: person.id, role: 'STAFF', storeId, terminalId: terminal.id }
    const a = await makeAdmin()
    admin = { kind: 'admin', userId: a.id, role: 'ADMIN', storeId: null, terminalId: null }
  })

  it('opens the next drawer against what the last one left', async () => {
    const first = await openShift(staff, storeId, { openingCashCents: 20_000 })
    await closeShift(staff, first.id, { countedCashCents: 36_700 })

    // The next person counts $367.00 and finds it right.
    const second = await openShift(staff, storeId, { openingCashCents: 36_700 })
    expect(second.openingExpectedCents).toBe(36_700)
    expect(second.openingVarianceCents).toBe(0)
  })

  /**
   * The hole this closes. Before carry-over the opening figure was accepted without question,
   * so $50 going missing overnight produced NO variance anywhere: the next close simply
   * measured against the smaller opening and balanced perfectly.
   */
  it('records what went missing between two shifts', async () => {
    const first = await openShift(staff, storeId, { openingCashCents: 20_000 })
    await closeShift(staff, first.id, { countedCashCents: 36_700 })

    const second = await openShift(staff, storeId, { openingCashCents: 31_700 })
    expect(second.openingExpectedCents).toBe(36_700)
    expect(second.openingVarianceCents).toBe(-5_000)

    // ...and it stays OUT of the shift's own variance. The overnight loss belongs to the gap
    // between drawers, not to whoever opened next.
    await closeShift(staff, second.id, { countedCashCents: 31_700 })
    const { shifts } = await listShifts(admin, {})
    const closed = shifts.find((s) => s.id === second.id)
    expect(closed?.varianceCents).toBe(0)
    expect(closed?.openingVarianceCents).toBe(-5_000)
  })

  it('leaves the first drawer a store ever opens with NO expectation, not a zero', async () => {
    const first = await openShift(staff, storeId, { openingCashCents: 20_000 })
    expect(first.openingExpectedCents).toBeNull()
    expect(first.openingVarianceCents).toBeNull()
  })

  it('chains per STORE — one store\'s close is not another store\'s opening', async () => {
    const mine = await openShift(staff, storeId, { openingCashCents: 20_000 })
    await closeShift(staff, mine.id, { countedCashCents: 36_700 })

    const theirs = await openShift(admin, otherStoreId, { openingCashCents: 5_000 })
    expect(theirs.openingExpectedCents).toBeNull()
  })

  it('refuses an opening variance that does not match its own arithmetic', async () => {
    const first = await openShift(staff, storeId, { openingCashCents: 20_000 })
    await closeShift(staff, first.id, { countedCashCents: 36_700 })
    const second = await openShift(staff, storeId, { openingCashCents: 36_700 })

    await expect(
      prisma.$executeRaw`UPDATE "Shift" SET "openingVarianceCents" = 999 WHERE id = ${second.id}`,
    ).rejects.toThrow(/Shift_opening_variance_math_check/)
  })

  it('takes a PICKUP out of the drawer, so the close does not expect it', async () => {
    const shift = await openShift(staff, storeId, { openingCashCents: 100_000 })
    await addCashMovement(admin, shift.id, {
      type: 'PICKUP',
      amountCents: 80_000,
      reason: 'Collected for the bank',
    })

    // $1000 in, $800 collected, nothing sold — the drawer should expect $200 and balance.
    const closed = await closeShift(staff, shift.id, { countedCashCents: 20_000 })
    expect(closed.expectedCashCents).toBe(20_000)
    expect(closed.varianceCents).toBe(0)
  })

  it('lets only an admin record a pickup — a cashier could otherwise cover a shortfall', async () => {
    const shift = await openShift(staff, storeId, { openingCashCents: 100_000 })
    await expect(
      addCashMovement(staff, shift.id, { type: 'PICKUP', amountCents: 50_000, reason: 'oops' }),
    ).rejects.toThrow(ForbiddenError)

    // The other three stay staff-writable, so the check above is not a blanket refusal.
    const drop = await addCashMovement(staff, shift.id, {
      type: 'DROP',
      amountCents: 5_000,
      reason: 'Safe drop',
    })
    expect(drop.type).toBe('DROP')
  })
})

describe('live till balances', () => {
  let storeId: string
  let otherStoreId: string
  let admin: AdminPrincipal
  let staff: StaffPrincipal

  beforeEach(async () => {
    await resetDatabase()
    const store = await makeStore('Main', 'main')
    const other = await makeStore('Ashley', 'ashley')
    storeId = store.id
    otherStoreId = other.id
    const terminal = await makeTerminal(storeId, 'device-token-live')
    const person = await makeStaff(storeId, '1111')
    staff = { kind: 'staff', userId: person.id, role: 'STAFF', storeId, terminalId: terminal.id }
    const a = await makeAdmin()
    admin = { kind: 'admin', userId: a.id, role: 'ADMIN', storeId: null, terminalId: null }
  })

  it('reports a store with no open drawer rather than omitting it', async () => {
    const rows = await liveDrawers(admin)
    expect(rows).toHaveLength(2)
    // Nulls, not zeroes: "nobody has opened up" is not "the till is empty".
    expect(rows.every((r) => r.shiftId === null && r.balanceCents === null)).toBe(true)
  })

  it('runs the same arithmetic the close will, without the counting', async () => {
    const shift = await openShift(staff, storeId, { openingCashCents: 36_700 })
    await addCashMovement(staff, shift.id, {
      type: 'PAID_OUT',
      amountCents: 2_000,
      reason: 'Window cleaner',
    })
    await addCashMovement(admin, shift.id, {
      type: 'PICKUP',
      amountCents: 10_000,
      reason: 'Collected',
    })

    const rows = await liveDrawers(admin)
    const main = rows.find((r) => r.storeId === storeId)
    expect(main?.openingCashCents).toBe(36_700)
    // 367.00 − 20.00 − 100.00, no sales.
    expect(main?.balanceCents).toBe(24_700)
    expect(main?.saleCount).toBe(0)

    // And it agrees with the close, which is the whole point of sharing the arithmetic.
    const closed = await closeShift(staff, shift.id, { countedCashCents: 24_700 })
    expect(closed.expectedCashCents).toBe(24_700)
    expect(closed.varianceCents).toBe(0)
  })

  it('keeps each store\'s drawer to itself', async () => {
    await openShift(staff, storeId, { openingCashCents: 36_700 })
    await openShift(admin, otherStoreId, { openingCashCents: 5_000 })

    const rows = await liveDrawers(admin)
    expect(rows.find((r) => r.storeId === storeId)?.balanceCents).toBe(36_700)
    expect(rows.find((r) => r.storeId === otherStoreId)?.balanceCents).toBe(5_000)
  })

  it('pins a cashier to their own store', async () => {
    const rows = await liveDrawers(staff)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.storeId).toBe(storeId)
  })
})
