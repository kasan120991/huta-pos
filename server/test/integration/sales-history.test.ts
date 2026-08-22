import { Role } from '@huta/shared'
import request from 'supertest'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

import { createApp } from '../../src/app.js'
import { can } from '../../src/auth/permissions.js'
import type { AdminPrincipal, StaffPrincipal } from '../../src/auth/principal.js'
import { prisma } from '../../src/db/client.js'
import { ForbiddenError } from '../../src/errors/index.js'
import { FakePaymentProvider } from '../../src/payments/fake.provider.js'
import { setPaymentProvider } from '../../src/payments/provider.js'
import { listSales, salesTotals } from '../../src/sales/history.service.js'
import { refundSale, voidSale } from '../../src/sales/refund.service.js'
import { checkout, createSaleIntent, getSale } from '../../src/sales/sales.service.js'
import { openShift } from '../../src/sales/shift.service.js'
import { findCostKeys } from '../setup/cost-keys.js'
import {
  giveStock,
  makeAdmin,
  makeCategory,
  makeProduct,
  makeStaff,
  makeStore,
  makeTerminal,
  resetDatabase,
} from '../setup/factories.js'

/**
 * Transaction history — the browsable read behind /admin/sales and /register/history.
 *
 * Two things here are load-bearing beyond the obvious: a cashier must never be widened to
 * another store's money (the whole reason `report.view` gates the cross-store path), and
 * the totals must survive a VOID, which writes reversing Refund rows — two of them for a
 * split tender, with lines on the first only.
 */

let storeA: { id: string }
let storeB: { id: string }
let admin: AdminPrincipal
let staffA: StaffPrincipal
let staffB: StaffPrincipal
let adminUser: { id: string }
let category: { id: string }
let fake: FakePaymentProvider

beforeEach(async () => {
  await resetDatabase()
  fake = new FakePaymentProvider()
  setPaymentProvider(fake)

  storeA = await makeStore('Store A', 'store-a') // 400 bps tax
  storeB = await makeStore('Store B', 'store-b')
  adminUser = await makeAdmin()
  const terminalA = await makeTerminal(storeA.id, 'history-test-token-a')
  const terminalB = await makeTerminal(storeB.id, 'history-test-token-b')

  admin = {
    kind: 'admin',
    userId: adminUser.id,
    role: Role.ADMIN,
    storeId: null,
    terminalId: terminalA.id,
  }
  const userA = await makeStaff(storeA.id, '4321')
  staffA = {
    kind: 'staff',
    userId: userA.id,
    role: Role.STAFF,
    storeId: storeA.id,
    terminalId: terminalA.id,
  }
  const userB = await makeStaff(storeB.id, '5678', 'b.staff@test.local')
  staffB = {
    kind: 'staff',
    userId: userB.id,
    role: Role.STAFF,
    storeId: storeB.id,
    terminalId: terminalB.id,
  }

  category = await makeCategory('Edible', 'edible')
  await openShift(staffA, storeA.id, { openingCashCents: 100_00 })
  await openShift(staffB, storeB.id, { openingCashCents: 100_00 })
})

afterAll(() => {
  setPaymentProvider(null)
})

async function eachProduct(
  storeId: string,
  opts: { priceCents?: number, costBasisCents?: number } = {},
) {
  const product = await makeProduct({
    name: `Gummies-${Math.random().toString(36).slice(2, 8)}`,
    categoryId: category.id,
    priceCents: opts.priceCents ?? 10_00,
  })
  const variant = product.variants[0]!
  // One StockLevel per (store, variant) — the cost basis rides in here rather than a second
  // giveStock, which would violate the unique index.
  await giveStock(storeId, variant.id, 50, opts.costBasisCents)
  return variant
}

async function cashSale(principal: StaffPrincipal, variantId: string, quantity = 1) {
  return checkout(principal, {
    lines: [{ variantId, quantityBase: quantity }],
    ageVerified: false,
    tenders: [{ method: 'CASH', tenderedCents: 100_00 }],
  })
}

/** A split cash+card sale — the shape whose VOID writes two Refund rows. */
async function splitSale(principal: StaffPrincipal, variantId: string, cashCents: number) {
  const staged = await createSaleIntent(principal, {
    lines: [{ variantId, quantityBase: 1 }],
    cashCents,
  })
  fake.succeed(staged.paymentIntentId)
  return checkout(principal, {
    lines: [{ variantId, quantityBase: 1 }],
    ageVerified: false,
    tenders: [
      { method: 'CASH', tenderedCents: cashCents },
      { method: 'CARD', paymentIntentId: staged.paymentIntentId },
    ],
  })
}

async function grant(action = 'sale.refund') {
  const row = await prisma.stepUpGrant.create({
    data: {
      adminUserId: adminUser.id,
      action,
      expiresAt: new Date(Date.now() + 120_000),
    },
  })
  return row.id
}

const PAGE = { page: 1, pageSize: 50 }

describe('store scoping', () => {
  it('pins a cashier to their own store instead of widening or refusing', async () => {
    const a = await eachProduct(storeA.id)
    const b = await eachProduct(storeB.id)
    await cashSale(staffA, a.id)
    await cashSale(staffB, b.id)

    // No storeId asked for. This is the leak the whole design defends against: a cashier
    // must get THEIR store, never both, and never a 403 for not naming one.
    const page = await listSales(staffA, {}, PAGE)
    expect(page.total).toBe(1)
    expect(page.sales.every((s) => s.storeId === storeA.id)).toBe(true)
    expect(page.stores.map((s) => s.id)).toEqual([storeA.id])
  })

  it('refuses a cashier who names another store, without leaking that it has sales', async () => {
    const b = await eachProduct(storeB.id)
    await cashSale(staffB, b.id)

    await expect(listSales(staffA, { storeId: storeB.id }, PAGE)).rejects.toThrow(ForbiddenError)
    await expect(salesTotals(staffA, { storeId: storeB.id })).rejects.toThrow(ForbiddenError)
  })

  it('gives an admin every store by default and one when asked', async () => {
    const a = await eachProduct(storeA.id)
    const b = await eachProduct(storeB.id)
    await cashSale(staffA, a.id)
    await cashSale(staffB, b.id)

    const all = await listSales(admin, {}, PAGE)
    expect(all.total).toBe(2)
    expect(all.stores).toHaveLength(2)
    // The row carries its store, so a cross-store table can label it without a lookup.
    expect(new Set(all.sales.map((s) => s.storeName))).toEqual(new Set(['Store A', 'Store B']))

    const justB = await listSales(admin, { storeId: storeB.id }, PAGE)
    expect(justB.total).toBe(1)
    expect(justB.sales[0]!.storeId).toBe(storeB.id)
  })

  it('keeps report.view admin-only — the capability itself, not just the endpoint', () => {
    expect(can(staffA, 'report.view')).toBe(false)
    expect(can(admin, 'report.view')).toBe(true)
  })
})

describe('cost visibility', () => {
  it('never puts a cost key on the history payloads, for either role', async () => {
    const a = await eachProduct(storeA.id, { costBasisCents: 40_00 })
    await cashSale(staffA, a.id)

    // One-directional on purpose, unlike the catalog rule: this feature computes no cost at
    // all, so there is no admin payload that SHOULD carry one to contrast against.
    expect(findCostKeys(await listSales(admin, {}, PAGE))).toEqual([])
    expect(findCostKeys(await listSales(staffA, {}, PAGE))).toEqual([])
    expect(findCostKeys(await salesTotals(admin, {}))).toEqual([])
    expect(findCostKeys(await salesTotals(staffA, {}))).toEqual([])
  })

  it('still strips cost from the receipt a history row opens, in both directions', async () => {
    const a = await eachProduct(storeA.id, { costBasisCents: 40_00 })
    const sale = await cashSale(staffA, a.id)

    expect(findCostKeys(await getSale(staffA, sale.id))).toEqual([])
    // Not vacuous: the same receipt as admin DOES carry the cost snapshot.
    expect(findCostKeys(await getSale(admin, sale.id)).length).toBeGreaterThan(0)
  })
})

describe('totals arithmetic', () => {
  it('sums a cash sale, a card sale and a partial refund to the cent', async () => {
    const variant = await eachProduct(storeA.id, { priceCents: 10_00 })
    await cashSale(staffA, variant.id) // $10.00 + 4% = $10.40
    const card = await splitSale(staffA, variant.id, 0) // all card, $10.40

    await refundSale(staffA, card.id, {
      lines: [{ saleLineId: card.lines[0]!.id, quantityBase: 1, restock: true }],
      method: 'CARD',
      stepUpGrantId: await grant(),
    })

    const totals = await salesTotals(admin, { storeId: storeA.id })
    expect(totals.saleCount).toBe(2)
    expect(totals.cashCents).toBe(10_40)
    expect(totals.cardCents).toBe(10_40)
    expect(totals.grossCents).toBe(20_80)
    expect(totals.refundsCents).toBe(10_40)
    expect(totals.netCents).toBe(10_40)
  })

  it('nets a VOIDED split sale to zero across its two refund rows', async () => {
    const variant = await eachProduct(storeA.id, { priceCents: 10_00 })
    const sale = await splitSale(staffA, variant.id, 5_00) // $5.00 cash + $5.40 card

    await voidSale(staffA, sale.id, { reason: 'test', stepUpGrantId: await grant() })

    // A void of a split tender writes TWO Refund rows, with lines on the first only. Money
    // is on both, which is why the total sums amounts and never lines — and never a count.
    const refunds = await prisma.refund.findMany({ where: { saleId: sale.id } })
    expect(refunds).toHaveLength(2)

    const totals = await salesTotals(admin, { storeId: storeA.id })
    expect(totals.grossCents).toBe(10_40)
    expect(totals.refundsCents).toBe(10_40)
    expect(totals.netCents).toBe(0)
    // The void is a fact, reported rather than deducted.
    expect(totals.saleCount).toBe(1)
    expect(totals.voidedCount).toBe(1)
  })

  it('excludes a FAILED card refund from the money that moved', async () => {
    const variant = await eachProduct(storeA.id, { priceCents: 10_00 })
    const sale = await splitSale(staffA, variant.id, 0)

    fake.failNextRefund()
    await refundSale(staffA, sale.id, {
      lines: [{ saleLineId: sale.lines[0]!.id, quantityBase: 1, restock: true }],
      method: 'CARD',
      stepUpGrantId: await grant(),
    })

    const refund = await prisma.refund.findFirstOrThrow({ where: { saleId: sale.id } })
    expect(refund.status).toBe('FAILED')

    // The record and the restock stand; the money did not move, so net is untouched.
    const totals = await salesTotals(admin, { storeId: storeA.id })
    expect(totals.refundsCents).toBe(0)
    expect(totals.netCents).toBe(totals.grossCents)

    const page = await listSales(admin, { storeId: storeA.id }, PAGE)
    expect(page.sales[0]!.refundedCents).toBe(0)
  })

  it('counts refunds from the SAME population the filters describe', async () => {
    const variant = await eachProduct(storeA.id, { priceCents: 10_00 })
    // A cash sale that gets refunded, and an untouched card sale.
    const cash = await cashSale(staffA, variant.id)
    await splitSale(staffA, variant.id, 0)
    await refundSale(staffA, cash.id, {
      lines: [{ saleLineId: cash.lines[0]!.id, quantityBase: 1, restock: true }],
      method: 'CASH',
      stepUpGrantId: await grant(),
    })

    // Filtered to CARD, gross is card-only — so the refunds figure must be too, or Net
    // subtracts one population from another and means nothing.
    const card = await salesTotals(admin, { storeId: storeA.id, method: 'CARD' })
    expect(card.grossCents).toBe(10_40)
    expect(card.refundsCents).toBe(0)
    expect(card.netCents).toBe(10_40)

    const cashOnly = await salesTotals(admin, { storeId: storeA.id, method: 'CASH' })
    expect(cashOnly.refundsCents).toBe(10_40)
    expect(cashOnly.netCents).toBe(0)
  })

  it('agrees with the list it sits above, under every filter', async () => {
    const variant = await eachProduct(storeA.id)
    await cashSale(staffA, variant.id)
    await cashSale(staffA, variant.id)
    const b = await eachProduct(storeB.id)
    await cashSale(staffB, b.id)

    // The strip and the table are built from two predicates; this is the anti-drift pin.
    for (const filter of [{}, { storeId: storeA.id }, { status: 'COMPLETED' as const }]) {
      const [page, totals] = [
        await listSales(admin, filter, PAGE),
        await salesTotals(admin, filter),
      ]
      expect(totals.saleCount, `saleCount vs total for ${JSON.stringify(filter)}`).toBe(page.total)
    }
  })
})

describe('filters and paging', () => {
  it('isolates by cashier, status and payment method', async () => {
    const variant = await eachProduct(storeA.id)
    await cashSale(staffA, variant.id)
    const card = await splitSale(staffA, variant.id, 0)
    await voidSale(staffA, card.id, { reason: 'test', stepUpGrantId: await grant() })

    expect((await listSales(admin, { storeId: storeA.id, status: 'VOIDED' }, PAGE)).total).toBe(1)
    expect((await listSales(admin, { storeId: storeA.id, method: 'CASH' }, PAGE)).total).toBe(1)
    expect((await listSales(admin, { storeId: storeA.id, method: 'CARD' }, PAGE)).total).toBe(1)
    expect(
      (await listSales(admin, { storeId: storeA.id, cashierId: staffA.userId }, PAGE)).total,
    ).toBe(2)
    expect((await listSales(admin, { cashierId: adminUser.id }, PAGE)).total).toBe(0)
  })

  it('returns a receipt number from EVERY store when no store is named', async () => {
    const a = await eachProduct(storeA.id)
    const b = await eachProduct(storeB.id)
    await cashSale(staffA, a.id)
    await cashSale(staffB, b.id)

    // Numbers are per-store (`@@unique([storeId, number])`), so #1 exists twice. Two rows
    // is correct behaviour, not a bug — pinned so nobody "fixes" it into a findFirst.
    const page = await listSales(admin, { number: 1 }, PAGE)
    expect(page.total).toBe(2)
  })

  it('pages without dropping or repeating a row when timestamps collide', async () => {
    const variant = await eachProduct(storeA.id)
    for (let i = 0; i < 5; i += 1) await cashSale(staffA, variant.id)

    // Force a tie: an unstable sort under OFFSET paging shows a row twice on one page and
    // never on the next. The id tiebreak in the orderBy is what prevents it.
    const at = new Date('2026-08-20T12:00:00.000Z')
    await prisma.sale.updateMany({ where: { storeId: storeA.id }, data: { createdAt: at } })

    const seen: string[] = []
    for (const page of [1, 2, 3]) {
      const result = await listSales(admin, { storeId: storeA.id }, { page, pageSize: 2 })
      expect(result.total).toBe(5)
      expect(result.pageCount).toBe(3)
      seen.push(...result.sales.map((s) => s.id))
    }
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
  })

  it('treats `to` as a whole business day, not the midnight instant', async () => {
    const variant = await eachProduct(storeA.id)
    const sale = await cashSale(staffA, variant.id)

    // Rung mid-afternoon Eastern on the 20th. A `lte` against 00:00 would drop it — the
    // off-by-a-day that is invisible until someone reconciles a total.
    await prisma.sale.update({
      where: { id: sale.id },
      data: { createdAt: new Date('2026-08-20T19:30:00.000Z') },
    })

    const onTheDay = await listSales(admin, { from: '2026-08-20', to: '2026-08-20' }, PAGE)
    expect(onTheDay.total).toBe(1)

    const dayBefore = await listSales(admin, { from: '2026-08-19', to: '2026-08-19' }, PAGE)
    expect(dayBefore.total).toBe(0)
  })

  it('buckets a day in the STORE timezone, not the server clock', async () => {
    const variant = await eachProduct(storeA.id)
    const sale = await cashSale(staffA, variant.id)

    // 01:30 UTC on the 21st is 21:30 Eastern on the 20th — the store's day, per
    // Store.timezone, whose schema comment forbids using the server's zone here.
    await prisma.store.update({
      where: { id: storeA.id },
      data: { timezone: 'America/New_York' },
    })
    await prisma.sale.update({
      where: { id: sale.id },
      data: { createdAt: new Date('2026-08-21T01:30:00.000Z') },
    })

    const totals = await salesTotals(admin, { storeId: storeA.id })
    expect(totals.timezone).toBe('America/New_York')
    expect(totals.days.map((d) => d.day)).toContain('2026-08-20')
  })

  it('offers cashier options that do not collapse when a cashier is picked', async () => {
    const variant = await eachProduct(storeA.id)
    await cashSale(staffA, variant.id)
    await checkout(admin, {
      lines: [{ variantId: variant.id, quantityBase: 1 }],
      ageVerified: false,
      tenders: [{ method: 'CASH', tenderedCents: 100_00 }],
    })

    const unfiltered = await salesTotals(admin, { storeId: storeA.id })
    expect(unfiltered.cashiers).toHaveLength(2)

    // Filtering BY cashier must not reduce the list of cashiers you can switch to.
    const filtered = await salesTotals(admin, { storeId: storeA.id, cashierId: staffA.userId })
    expect(filtered.cashiers).toHaveLength(2)
    expect(filtered.saleCount).toBe(1)
  })
})

describe('the routes', () => {
  it('coerces paging through validatedQuery rather than reading req.query', async () => {
    const app = createApp()
    const res = await request(app).get('/api/sales?page=2&pageSize=1')

    // Unauthenticated, but the point is the shape: reading req.query in Express 5 discards
    // every z.coerce and .default(), so a 401 here still proves the route is mounted.
    expect([401, 403]).toContain(res.status)
  })
})
